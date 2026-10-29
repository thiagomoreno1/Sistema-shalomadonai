-- Allow the same inspected, quantity-capped return after an explicit customer
-- pickup. Pickup movements already use the order-linked dispatch ledger.

create or replace function public.record_inventory_movement(
  p_business_id uuid,
  p_product_id uuid,
  p_movement_type public.inventory_movement_type,
  p_quantity numeric,
  p_direction text,
  p_reason text,
  p_order_id uuid,
  p_occurred_at timestamptz,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_movement_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_quantity_delta numeric(12,3);
  v_order_status public.order_status;
  v_order_requires_delivery boolean;
  v_return_eligible boolean := false;
  v_net_issued numeric;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory movement access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  if p_product_id is null or p_movement_type is null
     or p_movement_type not in (
       'adjustment'::public.inventory_movement_type,
       'loss'::public.inventory_movement_type,
       'return'::public.inventory_movement_type
     )
     or p_quantity is null or p_quantity <= 0 or p_quantity > 999999999.999
     or p_quantity <> pg_catalog.round(p_quantity, 3)
     or p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 1 and 1000
     or (p_occurred_at is not null and p_occurred_at > pg_catalog.now()) then
    raise exception using errcode = '22023', message = 'Inventory movement details are invalid.';
  end if;
  if (p_movement_type = 'adjustment'::public.inventory_movement_type
      and (p_direction is null or p_direction not in ('increase', 'decrease')))
     or (p_movement_type <> 'adjustment'::public.inventory_movement_type and p_direction is not null)
     or (p_movement_type = 'return'::public.inventory_movement_type and p_order_id is null)
     or (p_movement_type <> 'return'::public.inventory_movement_type and p_order_id is not null) then
    raise exception using errcode = '22023', message = 'Movement direction and order reference do not match the movement type.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_inventory_movement',
    'product_id', p_product_id,
    'movement_type', p_movement_type,
    'quantity', p_quantity,
    'direction', p_direction,
    'reason', pg_catalog.btrim(p_reason),
    'order_id', p_order_id,
    'occurred_at', p_occurred_at
  )::text);
  select movement.id, movement.request_fingerprint
    into v_movement_id, v_existing_fingerprint
    from public.inventory_movements as movement
   where movement.business_id = p_business_id and movement.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different movement details.';
    end if;
    return v_movement_id;
  end if;

  if p_movement_type = 'return'::public.inventory_movement_type then
    select order_row.status, order_row.requires_delivery
      into v_order_status, v_order_requires_delivery
      from public.orders as order_row
     where order_row.business_id = p_business_id and order_row.id = p_order_id
     for update;
    if not found or v_order_status <> 'open'::public.order_status then
      raise exception using errcode = '22023', message = 'A return must reference an open order in this business.';
    end if;

    select exists (
      select 1 from public.deliveries as delivery
       where delivery.business_id = p_business_id and delivery.order_id = p_order_id
         and delivery.canceled_at is null
         and delivery.status in (
           'attempted'::public.delivery_status,
           'rescheduled'::public.delivery_status,
           'delivered'::public.delivery_status,
           'returned'::public.delivery_status
         )
    ) into v_return_eligible;
    if not v_return_eligible and not v_order_requires_delivery then
      select exists (
        select 1 from public.order_events as event
         where event.business_id = p_business_id and event.order_id = p_order_id
           and event.event_type = 'picked_up'::public.order_event_type
      ) into v_return_eligible;
    end if;
    if not v_return_eligible then
      raise exception using errcode = '22023', message = 'A return can only be recorded after an inspected delivery or customer pickup.';
    end if;
    if not exists (
      select 1 from public.order_line_components as component
       where component.business_id = p_business_id
         and component.order_id = p_order_id
         and component.product_id = p_product_id
         and component.inventory_tracked_snapshot
    ) then
      raise exception using errcode = '23503', message = 'The selected tracked product is not part of this order.';
    end if;
  end if;

  perform 1 from public.products as product
   where product.business_id = p_business_id and product.id = p_product_id
     and product.inventory_tracked
   for update;
  if not found then
    raise exception using errcode = '22023', message = 'The selected product does not have stock tracking configured.';
  end if;

  if p_movement_type = 'return'::public.inventory_movement_type then
    select coalesce(-pg_catalog.sum(movement.quantity_delta), 0)
      into v_net_issued
      from public.inventory_movements as movement
     where movement.business_id = p_business_id
       and movement.order_id = p_order_id
       and movement.product_id = p_product_id
       and movement.movement_type in (
         'dispatch'::public.inventory_movement_type,
         'return'::public.inventory_movement_type
       );
    if p_quantity > greatest(v_net_issued, 0) then
      raise exception using errcode = '22023', message = 'The inspected return cannot exceed the quantity previously sent and still out for this order.';
    end if;
    v_quantity_delta := p_quantity;
  elsif p_movement_type = 'loss'::public.inventory_movement_type
     or p_direction = 'decrease' then
    v_quantity_delta := -p_quantity;
  else
    v_quantity_delta := p_quantity;
  end if;

  insert into public.inventory_movements (
    business_id, product_id, movement_type, quantity_delta, reason,
    order_id, request_id, request_fingerprint, actor_id, occurred_at
  ) values (
    p_business_id, p_product_id, p_movement_type, v_quantity_delta,
    pg_catalog.btrim(p_reason), p_order_id, p_request_id, v_fingerprint,
    (select auth.uid()), coalesce(p_occurred_at, pg_catalog.now())
  ) returning id into v_movement_id;

  return v_movement_id;
end;
$function$;
