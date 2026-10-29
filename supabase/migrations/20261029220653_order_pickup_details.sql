alter table public.order_events
  add column request_id uuid,
  add column request_fingerprint text,
  add column stock_warnings jsonb not null default '[]'::jsonb,
  add constraint order_events_request_fingerprint_check
    check (
      (request_id is null and request_fingerprint is null)
      or (request_id is not null and request_fingerprint is not null
        and request_fingerprint ~ '^[0-9a-f]{32}$')
    ),
  add constraint order_events_pickup_request_check
    check (
      (event_type = 'picked_up'::public.order_event_type and request_id is not null)
      or (event_type <> 'picked_up'::public.order_event_type and request_id is null)
    ),
  add constraint order_events_stock_warnings_check
    check (pg_catalog.jsonb_typeof(stock_warnings) = 'array');

create unique index order_events_request_idx
  on public.order_events (business_id, request_id)
  where request_id is not null;

grant select (stock_warnings)
  on table public.order_events to authenticated;

create function public.record_order_pickup(
  p_business_id uuid,
  p_order_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_event_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_order record;
  v_component record;
  v_net_issued numeric;
  v_quantity_to_issue numeric;
  v_chunk numeric;
  v_stock_warnings jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Order pickup access denied.';
  end if;
  if p_order_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'Order pickup details are invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_order_pickup',
    'order_id', p_order_id
  )::text);

  select event.id, event.request_fingerprint
    into v_event_id, v_existing_fingerprint
    from public.order_events as event
   where event.business_id = p_business_id and event.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different order details.';
    end if;
    return v_event_id;
  end if;

  select order_row.id, order_row.status, order_row.requires_delivery
    into v_order
    from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.id = p_order_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected order does not exist in this business.';
  end if;
  if v_order.status <> 'open'::public.order_status then
    raise exception using errcode = '22023', message = 'A canceled order cannot be picked up.';
  end if;
  if v_order.requires_delivery then
    raise exception using errcode = '22023', message = 'Only an order not marked for delivery can be picked up.';
  end if;
  select event.id into v_event_id
    from public.order_events as event
   where event.business_id = p_business_id
     and event.order_id = p_order_id
     and event.event_type = 'picked_up'::public.order_event_type;
  if found then
    raise exception using errcode = '22023', message = 'This order was already picked up.';
  end if;

  for v_component in
    select component.product_id
      from public.order_line_components as component
     where component.business_id = p_business_id
       and component.order_id = p_order_id
       and component.inventory_tracked_snapshot
     group by component.product_id
     order by component.product_id
  loop
    perform 1 from public.products as product
     where product.business_id = p_business_id and product.id = v_component.product_id
     for update;
  end loop;

  for v_component in
    select component.product_id,
           pg_catalog.sum(component.quantity_snapshot) as ordered_quantity
      from public.order_line_components as component
     where component.business_id = p_business_id
       and component.order_id = p_order_id
       and component.inventory_tracked_snapshot
     group by component.product_id
     order by component.product_id
  loop
    select coalesce(-pg_catalog.sum(movement.quantity_delta), 0)
      into v_net_issued
      from public.inventory_movements as movement
     where movement.business_id = p_business_id
       and movement.order_id = p_order_id
       and movement.product_id = v_component.product_id
       and movement.movement_type in (
         'dispatch'::public.inventory_movement_type,
         'return'::public.inventory_movement_type
       );
    v_quantity_to_issue := greatest(v_component.ordered_quantity - v_net_issued, 0);
    while v_quantity_to_issue > 0 loop
      v_chunk := least(v_quantity_to_issue, 999999999.999);
      insert into public.inventory_movements (
        business_id, product_id, movement_type, quantity_delta, reason, order_id, actor_id
      ) values (
        p_business_id, v_component.product_id, 'dispatch'::public.inventory_movement_type,
        -v_chunk, 'Retirada pelo cliente', p_order_id, (select auth.uid())
      );
      v_quantity_to_issue := v_quantity_to_issue - v_chunk;
    end loop;
  end loop;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'product_id', stock.product_id,
           'product_name', stock.product_name,
           'inventory_unit', stock.inventory_unit,
           'quantity_on_hand', stock.quantity_on_hand
         ) order by stock.product_id), '[]'::jsonb)
    into v_stock_warnings
    from (
      select product.id as product_id, product.name as product_name,
             product.inventory_unit,
             coalesce(balance.quantity_on_hand, 0) as quantity_on_hand
        from (
          select distinct component.product_id
            from public.order_line_components as component
           where component.business_id = p_business_id
             and component.order_id = p_order_id
             and component.inventory_tracked_snapshot
        ) as affected
        join public.products as product
          on product.business_id = p_business_id and product.id = affected.product_id
        left join (
          select movement.product_id, pg_catalog.sum(movement.quantity_delta) as quantity_on_hand
            from public.inventory_movements as movement
           where movement.business_id = p_business_id
           group by movement.product_id
        ) as balance on balance.product_id = product.id
       where coalesce(balance.quantity_on_hand, 0) < 0
    ) as stock;

  insert into public.order_events (
    business_id, order_id, event_type, reason,
    request_id, request_fingerprint, stock_warnings, actor_id
  ) values (
    p_business_id, p_order_id, 'picked_up'::public.order_event_type,
    'Retirada pelo cliente', p_request_id, v_fingerprint,
    v_stock_warnings, (select auth.uid())
  ) returning id into v_event_id;

  return v_event_id;
end;
$function$;

create or replace function public.cancel_order(
  p_business_id uuid,
  p_order_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_status public.order_status;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Order cancellation access denied.';
  end if;
  if p_order_id is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) > 1000 then
    raise exception using errcode = '22023', message = 'Cancellation details are invalid.';
  end if;

  select order_row.status into v_order_status
    from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.id = p_order_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected order does not exist in this business.';
  end if;
  if v_order_status = 'cancelled'::public.order_status then
    return p_order_id;
  end if;
  if exists (
    select 1 from public.order_payments as payment
     where payment.business_id = p_business_id and payment.order_id = p_order_id
  ) then
    raise exception using errcode = '22023', message = 'An order with a receipt cannot be cancelled.';
  end if;
  if exists (
    select 1 from public.deliveries as delivery
     where delivery.business_id = p_business_id and delivery.order_id = p_order_id
       and delivery.status not in (
         'awaiting_separation'::public.delivery_status,
         'ready'::public.delivery_status
       )
  ) then
    raise exception using errcode = '22023', message = 'An order cannot be cancelled after dispatch or a delivery attempt.';
  end if;
  if exists (
    select 1 from public.order_events as event
     where event.business_id = p_business_id and event.order_id = p_order_id
       and event.event_type = 'picked_up'::public.order_event_type
  ) then
    raise exception using errcode = '22023', message = 'An order cannot be cancelled after customer pickup.';
  end if;

  update public.orders
     set status = 'cancelled'::public.order_status,
         cancelled_at = pg_catalog.now(),
         cancellation_reason = nullif(pg_catalog.btrim(p_reason), '')
   where business_id = p_business_id and id = p_order_id;

  update public.deliveries
     set canceled_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where business_id = p_business_id and order_id = p_order_id
     and canceled_at is null;

  insert into public.order_events (business_id, order_id, event_type, reason, actor_id)
  values (p_business_id, p_order_id, 'cancelled'::public.order_event_type,
          nullif(pg_catalog.btrim(p_reason), ''), (select auth.uid()));

  return p_order_id;
end;
$function$;

revoke all on function public.record_order_pickup(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_order_pickup(uuid, uuid, uuid) to authenticated;
