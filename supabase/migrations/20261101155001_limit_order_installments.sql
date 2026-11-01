-- Bound installment arrays before converting JSON into rows. Preserve the active
-- create_order implementation and its existing authorization/idempotency behavior.

create or replace function public.create_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_delivery_address text,
  p_delivery_fee_cents bigint,
  p_discount_cents bigint,
  p_notes text,
  p_items jsonb,
  p_installments jsonb,
  p_requires_delivery boolean,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_customer_name text;
  v_items_count integer;
  v_schedule_count integer;
  v_subtotal numeric := 0;
  v_total numeric;
  v_schedule_total numeric := 0;
  v_line_total numeric;
  v_item record;
  v_product record;
  v_component_product record;
  v_recipe record;
  v_schedule record;
  v_lines jsonb := '[]'::jsonb;
  v_components jsonb;
  v_installments jsonb := '[]'::jsonb;
  v_component_count integer;
  v_extended_quantity numeric;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Order access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  if p_requires_delivery then
    v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
      'customer_id', p_customer_id,
      'delivery_address', pg_catalog.btrim(p_delivery_address),
      'delivery_fee_cents', p_delivery_fee_cents,
      'discount_cents', p_discount_cents,
      'notes', pg_catalog.btrim(p_notes),
      'items', p_items,
      'installments', p_installments,
      'requires_delivery', true
    )::text);
  else
    -- Keep idempotent retries for orders created before this migration valid.
    v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
      'customer_id', p_customer_id,
      'delivery_address', pg_catalog.btrim(p_delivery_address),
      'delivery_fee_cents', p_delivery_fee_cents,
      'discount_cents', p_discount_cents,
      'notes', pg_catalog.btrim(p_notes),
      'items', p_items,
      'installments', p_installments
    )::text);
  end if;

  select order_row.id, order_row.request_fingerprint
    into v_order_id, v_existing_fingerprint
    from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different order details.';
    end if;
    return v_order_id;
  end if;

  if p_customer_id is null or p_delivery_fee_cents is null or p_delivery_fee_cents < 0
     or p_discount_cents is null or p_discount_cents < 0 or p_requires_delivery is null
     or pg_catalog.char_length(pg_catalog.btrim(p_delivery_address)) > 1000
     or pg_catalog.char_length(pg_catalog.btrim(p_notes)) > 4000 then
    raise exception using errcode = '22023', message = 'Order details are invalid.';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) is distinct from 'array'
     or p_installments is null or pg_catalog.jsonb_typeof(p_installments) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Add at least one product and one payment installment.';
  end if;
  if pg_catalog.jsonb_array_length(p_items) = 0 or pg_catalog.jsonb_array_length(p_installments) = 0 then
    raise exception using errcode = '22023', message = 'Add at least one product and one payment installment.';
  end if;

  if pg_catalog.jsonb_array_length(p_installments) > 120 then
    raise exception using errcode = '22023', message = 'An order cannot contain more than 120 installments.';
  end if;
  select customer.name into v_customer_name
    from public.customers as customer
   where customer.business_id = p_business_id
     and customer.id = p_customer_id and customer.is_active
   for share;
  if not found then
    raise exception using errcode = '23503', message = 'The selected customer is not active in this business.';
  end if;

  select pg_catalog.count(*) into v_items_count
    from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric);
  if v_items_count <> pg_catalog.jsonb_array_length(p_items)
     or exists (
       select 1 from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric)
        where item.product_id is null or item.quantity is null or item.quantity <= 0
           or item.quantity > 99999999.999 or item.quantity <> pg_catalog.round(item.quantity, 3)
     )
     or v_items_count <> (
       select pg_catalog.count(distinct item.product_id)
         from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric)
     ) then
    raise exception using errcode = '22023', message = 'Product quantities must be positive, unique, and limited to three decimal places.';
  end if;

  for v_item in
    select item.product_id, item.quantity, item.ordinality
      from pg_catalog.jsonb_to_recordset(p_items) with ordinality
        as item(product_id uuid, quantity numeric, ordinality bigint)
     order by item.product_id
  loop
    select product.name, product.inventory_unit, product.sale_price_cents,
           product.cost_cents, product.is_combo, product.inventory_tracked
      into v_product
      from public.products as product
     where product.business_id = p_business_id
       and product.id = v_item.product_id
       and product.is_active
       and product.sale_price_cents is not null
     for share;
    if not found then
      raise exception using errcode = '23503', message = 'Every order product must be active, priced, and in this business.';
    end if;

    v_components := '[]'::jsonb;
    if v_product.is_combo then
      select pg_catalog.count(*) into v_component_count
        from public.combo_components as component
       where component.business_id = p_business_id
         and component.combo_product_id = v_item.product_id;
      if v_component_count = 0 then
        raise exception using errcode = '22023', message = 'Every combo needs a saved component composition before it can be ordered.';
      end if;

      for v_recipe in
        select component.component_product_id, component.quantity_per_combo
          from public.combo_components as component
         where component.business_id = p_business_id
           and component.combo_product_id = v_item.product_id
         order by component.component_product_id
         for share
      loop
        select product.name, product.inventory_unit, product.is_active,
               product.is_combo, product.inventory_tracked
          into v_component_product
          from public.products as product
         where product.business_id = p_business_id
           and product.id = v_recipe.component_product_id
         for share;
        if not found or not v_component_product.is_active or v_component_product.is_combo
           or not v_component_product.inventory_tracked or v_component_product.inventory_unit is null then
          raise exception using errcode = '22023', message = 'A combo component is no longer active and stock-tracked.';
        end if;
        if v_item.quantity > 999999999.999 / v_recipe.quantity_per_combo then
          raise exception using errcode = '22003', message = 'An ordered combo component quantity exceeds the supported stock amount.';
        end if;
        v_extended_quantity := pg_catalog.round(v_recipe.quantity_per_combo * v_item.quantity, 3);
        if v_extended_quantity <= 0 then
          raise exception using errcode = '22023', message = 'An ordered combo component quantity is smaller than the supported stock precision.';
        end if;
        v_components := v_components || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'product_id', v_recipe.component_product_id,
          'product_name', v_component_product.name,
          'inventory_unit', v_component_product.inventory_unit,
          'quantity', v_extended_quantity,
          'inventory_tracked', true
        ));
      end loop;
    else
      v_components := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'product_id', v_item.product_id,
        'product_name', v_product.name,
        'inventory_unit', v_product.inventory_unit,
        'quantity', v_item.quantity,
        'inventory_tracked', v_product.inventory_tracked
      ));
    end if;

    v_line_total := pg_catalog.round(v_product.sale_price_cents::numeric * v_item.quantity);
    if v_line_total > 9223372036854775807 then
      raise exception using errcode = '22003', message = 'An order line exceeds the supported amount.';
    end if;
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'product_id', v_item.product_id,
      'line_number', v_item.ordinality,
      'product_name', v_product.name,
      'inventory_unit', v_product.inventory_unit,
      'quantity', v_item.quantity,
      'unit_price_cents', v_product.sale_price_cents,
      'unit_cost_cents', v_product.cost_cents,
      'line_total_cents', v_line_total::bigint,
      'components', v_components
    ));
  end loop;

  v_total := v_subtotal + p_delivery_fee_cents::numeric - p_discount_cents::numeric;
  if v_total <= 0 or v_total > 9223372036854775807
     or p_discount_cents::numeric > v_subtotal + p_delivery_fee_cents::numeric then
    raise exception using errcode = '22023', message = 'The discount and delivery fee must leave a positive order total.';
  end if;

  select pg_catalog.count(*) into v_schedule_count
    from pg_catalog.jsonb_to_recordset(p_installments)
      as schedule(amount_cents bigint, due_on date, payment_method text);
  if v_schedule_count <> pg_catalog.jsonb_array_length(p_installments)
     or exists (
       select 1 from pg_catalog.jsonb_to_recordset(p_installments)
         as schedule(amount_cents bigint, due_on date, payment_method text)
        where schedule.amount_cents is null or schedule.amount_cents <= 0
           or schedule.due_on is null
           or (schedule.payment_method is not null and char_length(btrim(schedule.payment_method)) > 64)
     ) then
    raise exception using errcode = '22023', message = 'Each installment needs a positive whole-cent amount and a due date.';
  end if;
  select coalesce(pg_catalog.sum(schedule.amount_cents::numeric), 0) into v_schedule_total
    from pg_catalog.jsonb_to_recordset(p_installments)
      as schedule(amount_cents bigint, due_on date, payment_method text);
  if v_schedule_total <> v_total then
    raise exception using errcode = '22023', message = 'Installment amounts must add up exactly to the order total.';
  end if;

  for v_schedule in
    select schedule.amount_cents, schedule.due_on, schedule.payment_method
      from pg_catalog.jsonb_to_recordset(p_installments) with ordinality
        as schedule(amount_cents bigint, due_on date, payment_method text, ordinal bigint)
     order by schedule.ordinal
  loop
    v_installments := v_installments || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'amount_cents', v_schedule.amount_cents,
      'due_on', v_schedule.due_on,
      'payment_method', nullif(pg_catalog.btrim(v_schedule.payment_method), '')
    ));
  end loop;

  insert into public.orders (
    business_id, customer_id, customer_name_snapshot, delivery_address_snapshot,
    subtotal_cents, delivery_fee_cents, discount_cents, total_cents, notes,
    requires_delivery, request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_customer_id, v_customer_name, nullif(pg_catalog.btrim(p_delivery_address), ''),
    v_subtotal::bigint, p_delivery_fee_cents, p_discount_cents, v_total::bigint,
    nullif(pg_catalog.btrim(p_notes), ''), p_requires_delivery, p_request_id,
    v_fingerprint, (select auth.uid())
  ) on conflict (business_id, request_id) do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select order_row.id, order_row.request_fingerprint
      into v_order_id, v_existing_fingerprint
      from public.orders as order_row
     where order_row.business_id = p_business_id and order_row.request_id = p_request_id;
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different order details.';
    end if;
    return v_order_id;
  end if;

  insert into public.order_lines (
    business_id, order_id, line_number, product_id, product_name_snapshot,
    inventory_unit_snapshot, quantity, unit_price_snapshot_cents,
    unit_cost_snapshot_cents, line_total_cents
  )
  select p_business_id, v_order_id,
         (line.value ->> 'line_number')::integer,
         (line.value ->> 'product_id')::uuid,
         line.value ->> 'product_name',
         line.value ->> 'inventory_unit',
         (line.value ->> 'quantity')::numeric,
         (line.value ->> 'unit_price_cents')::bigint,
         nullif(line.value ->> 'unit_cost_cents', '')::bigint,
         (line.value ->> 'line_total_cents')::bigint
    from pg_catalog.jsonb_array_elements(v_lines) as line(value);

  insert into public.order_line_components (
    business_id, order_id, order_line_id, product_id, product_name_snapshot,
    inventory_unit_snapshot, quantity_snapshot, inventory_tracked_snapshot
  )
  select p_business_id, v_order_id, order_line.id,
         (component.value ->> 'product_id')::uuid,
         component.value ->> 'product_name',
         component.value ->> 'inventory_unit',
         (component.value ->> 'quantity')::numeric,
         (component.value ->> 'inventory_tracked')::boolean
    from pg_catalog.jsonb_array_elements(v_lines) as line(value)
    join public.order_lines as order_line
      on order_line.business_id = p_business_id
     and order_line.order_id = v_order_id
     and order_line.line_number = (line.value ->> 'line_number')::integer
    cross join lateral pg_catalog.jsonb_array_elements(line.value -> 'components') as component(value);

  insert into public.order_installments (
    business_id, order_id, installment_number, amount_cents, due_on, payment_method
  )
  select p_business_id, v_order_id, schedule.ordinality::integer,
         (schedule.value ->> 'amount_cents')::bigint,
         (schedule.value ->> 'due_on')::date,
         nullif(schedule.value ->> 'payment_method', '')
    from pg_catalog.jsonb_array_elements(v_installments) with ordinality as schedule(value, ordinality);

  insert into public.order_events (business_id, order_id, event_type, actor_id)
  values (p_business_id, v_order_id, 'created'::public.order_event_type, (select auth.uid()));

  if p_requires_delivery then
    insert into public.deliveries (business_id, order_id, status)
    values (p_business_id, v_order_id, 'awaiting_separation'::public.delivery_status);

    insert into public.delivery_events (
      business_id, delivery_id, event_type, from_status, to_status,
      request_id, request_fingerprint, actor_id
    )
    select p_business_id, delivery.id, 'created'::public.delivery_event_type, null,
           'awaiting_separation'::public.delivery_status,
           p_request_id, v_fingerprint, (select auth.uid())
      from public.deliveries as delivery
     where delivery.business_id = p_business_id and delivery.order_id = v_order_id;
  end if;

  return v_order_id;
end;
$function$;

revoke all on function public.create_order(uuid, uuid, text, bigint, bigint, text, jsonb, jsonb, boolean, uuid) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, text, bigint, bigint, text, jsonb, jsonb, boolean, uuid) to authenticated;
