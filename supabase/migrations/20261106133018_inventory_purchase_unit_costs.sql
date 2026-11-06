-- Capture acquisition costs on stock receipts and carry a weighted average
-- forward to orders created after each receipt. Existing order snapshots stay
-- unchanged.

alter table public.inventory_receipt_lines
  add column unit_cost_cents bigint,
  add constraint inventory_receipt_lines_unit_cost_nonnegative
    check (unit_cost_cents is null or unit_cost_cents >= 0);

comment on column public.inventory_receipt_lines.unit_cost_cents is
  'Unit acquisition cost recorded when this stock receipt was confirmed; null only for receipts recorded before this field existed.';

create or replace function public.configure_product_inventory(
  p_business_id uuid,
  p_product_id uuid,
  p_inventory_unit text,
  p_opening_quantity numeric,
  p_minimum_stock numeric,
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
  v_product record;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory configuration access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  if p_product_id is null or p_inventory_unit is null
     or pg_catalog.char_length(pg_catalog.btrim(p_inventory_unit)) not between 1 and 32
     or p_opening_quantity is null or p_opening_quantity < 0
     or p_opening_quantity > 999999999.999
     or p_opening_quantity <> pg_catalog.round(p_opening_quantity, 3)
     or (p_minimum_stock is not null and (
       p_minimum_stock < 0 or p_minimum_stock > 999999999.999
       or p_minimum_stock <> pg_catalog.round(p_minimum_stock, 3)
     )) then
    raise exception using errcode = '22023', message = 'Inventory unit and opening count are invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'configure_product_inventory',
    'product_id', p_product_id,
    'inventory_unit', pg_catalog.btrim(p_inventory_unit),
    'opening_quantity', p_opening_quantity,
    'minimum_stock', p_minimum_stock
  )::text);

  select movement.id, movement.request_fingerprint
    into v_movement_id, v_existing_fingerprint
    from public.inventory_movements as movement
   where movement.business_id = p_business_id and movement.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different inventory details.';
    end if;
    return v_movement_id;
  end if;

  select product.inventory_tracked, product.is_combo, product.cost_cents
    into v_product
    from public.products as product
   where product.business_id = p_business_id and product.id = p_product_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected product does not exist in this business.';
  end if;
  if v_product.inventory_tracked or v_product.is_combo then
    raise exception using errcode = '22023', message = 'Stock tracking can only be started once for a non-combo product.';
  end if;
  if p_opening_quantity > 0 and v_product.cost_cents is null then
    raise exception using errcode = '22023', message = 'Opening stock requires a baseline unit cost.';
  end if;

  update public.products
     set inventory_tracked = true,
         inventory_unit = pg_catalog.btrim(p_inventory_unit),
         minimum_stock = p_minimum_stock,
         updated_at = pg_catalog.now()
   where business_id = p_business_id and id = p_product_id;

  insert into public.inventory_movements (
    business_id, product_id, movement_type, quantity_delta, reason,
    request_id, request_fingerprint, actor_id
  ) values (
    p_business_id, p_product_id, 'opening'::public.inventory_movement_type,
    p_opening_quantity, 'Contagem inicial',
    p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_movement_id;

  return v_movement_id;
end;
$function$;

revoke all on function public.configure_product_inventory(uuid, uuid, text, numeric, numeric, uuid) from public, anon, authenticated;
grant execute on function public.configure_product_inventory(uuid, uuid, text, numeric, numeric, uuid) to authenticated;

create or replace function public.record_inventory_receipt(
  p_business_id uuid,
  p_supplier_name text,
  p_purchase_reference text,
  p_received_on date,
  p_notes text,
  p_items jsonb,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receipt_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_items_count integer;
  v_item record;
  v_product record;
  v_lines jsonb := '[]'::jsonb;
  v_receipt_line_id uuid;
  v_previous_quantity numeric;
  v_updated_cost_cents bigint;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory receipt access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  if p_received_on is null
     or p_received_on > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
     or pg_catalog.char_length(pg_catalog.btrim(p_supplier_name)) > 160
     or pg_catalog.char_length(pg_catalog.btrim(p_purchase_reference)) > 120
     or pg_catalog.char_length(pg_catalog.btrim(p_notes)) > 2000
     or p_items is null or pg_catalog.jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Receipt details are invalid.';
  end if;
  if pg_catalog.jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'Receipt details are invalid.';
  end if;

  select pg_catalog.count(*) into v_items_count
    from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric, unit_cost_cents bigint);
  if v_items_count <> pg_catalog.jsonb_array_length(p_items)
     or exists (
       select 1 from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric, unit_cost_cents bigint)
        where item.product_id is null or item.quantity is null or item.quantity <= 0
           or item.quantity > 999999999.999 or item.quantity <> pg_catalog.round(item.quantity, 3)
     )
     or v_items_count <> (
       select pg_catalog.count(distinct item.product_id)
         from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric, unit_cost_cents bigint)
     ) then
    raise exception using errcode = '22023', message = 'Receipt products must be unique and quantities positive to three decimal places.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_inventory_receipt',
    'supplier_name', nullif(pg_catalog.btrim(p_supplier_name), ''),
    'purchase_reference', nullif(pg_catalog.btrim(p_purchase_reference), ''),
    'received_on', p_received_on,
    'notes', nullif(pg_catalog.btrim(p_notes), ''),
    'items', p_items
  )::text);

  select receipt.id, receipt.request_fingerprint
    into v_receipt_id, v_existing_fingerprint
    from public.inventory_receipts as receipt
   where receipt.business_id = p_business_id and receipt.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different receipt details.';
    end if;
    return v_receipt_id;
  end if;

  if exists (
    select 1 from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric, unit_cost_cents bigint)
     where item.unit_cost_cents is null or item.unit_cost_cents < 0
  ) then
    raise exception using errcode = '22023', message = 'Every received product needs a nonnegative unit acquisition cost.';
  end if;

  for v_item in
    select item.product_id, item.quantity, item.unit_cost_cents
      from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric, unit_cost_cents bigint)
     order by item.product_id
  loop
    select product.name, product.inventory_unit, product.inventory_tracked,
           product.is_combo, product.cost_cents
      into v_product
      from public.products as product
     where product.business_id = p_business_id and product.id = v_item.product_id
     for update;
    if not found or not v_product.inventory_tracked or v_product.inventory_unit is null or v_product.is_combo then
      raise exception using errcode = '22023', message = 'Every receipt product must have stock tracking configured in this business.';
    end if;

    select coalesce(pg_catalog.sum(movement.quantity_delta), 0)
      into v_previous_quantity
      from public.inventory_movements as movement
     where movement.business_id = p_business_id and movement.product_id = v_item.product_id;

    if v_previous_quantity > 0 and v_product.cost_cents is null then
      raise exception using errcode = '22023', message = 'Existing positive stock requires a baseline unit cost before receiving a purchase.';
    end if;

    if v_previous_quantity > 0 then
      v_updated_cost_cents := pg_catalog.round(
        (v_previous_quantity * v_product.cost_cents::numeric
          + v_item.quantity * v_item.unit_cost_cents::numeric)
        / (v_previous_quantity + v_item.quantity)
      )::bigint;
    else
      -- When the balance is zero or negative, the incoming purchase establishes
      -- the new cost baseline; a negative quantity has no weighted average.
      v_updated_cost_cents := v_item.unit_cost_cents;
    end if;

    update public.products
       set cost_cents = v_updated_cost_cents,
           updated_at = pg_catalog.now()
     where business_id = p_business_id and id = v_item.product_id;

    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'product_id', v_item.product_id,
      'product_name', v_product.name,
      'inventory_unit', v_product.inventory_unit,
      'quantity', v_item.quantity,
      'unit_cost_cents', v_item.unit_cost_cents
    ));
  end loop;

  insert into public.inventory_receipts (
    business_id, supplier_name, purchase_reference, received_on, notes,
    request_id, request_fingerprint, created_by
  ) values (
    p_business_id, nullif(pg_catalog.btrim(p_supplier_name), ''),
    nullif(pg_catalog.btrim(p_purchase_reference), ''), p_received_on,
    nullif(pg_catalog.btrim(p_notes), ''), p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_receipt_id;

  for v_item in
    select line.value ->> 'product_id' as product_id,
           line.value ->> 'product_name' as product_name,
           line.value ->> 'inventory_unit' as inventory_unit,
           line.value ->> 'quantity' as quantity,
           line.value ->> 'unit_cost_cents' as unit_cost_cents
      from pg_catalog.jsonb_array_elements(v_lines) as line(value)
     order by (line.value ->> 'product_id')::uuid
  loop
    insert into public.inventory_receipt_lines (
      business_id, receipt_id, product_id, product_name_snapshot, inventory_unit_snapshot,
      quantity, unit_cost_cents
    ) values (
      p_business_id, v_receipt_id, v_item.product_id::uuid, v_item.product_name,
      v_item.inventory_unit, v_item.quantity::numeric, v_item.unit_cost_cents::bigint
    ) returning id into v_receipt_line_id;

    insert into public.inventory_movements (
      business_id, product_id, movement_type, quantity_delta, reason,
      receipt_id, receipt_line_id, actor_id, occurred_at
    ) values (
      p_business_id, v_item.product_id::uuid, 'receipt'::public.inventory_movement_type,
      v_item.quantity::numeric, 'Recebimento de estoque', v_receipt_id, v_receipt_line_id,
      (select auth.uid()), p_received_on::timestamp at time zone 'America/Sao_Paulo'
    );
  end loop;

  return v_receipt_id;
end;
$function$;

revoke all on function public.record_inventory_receipt(uuid, text, text, date, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.record_inventory_receipt(uuid, text, text, date, text, jsonb, uuid) to authenticated;
