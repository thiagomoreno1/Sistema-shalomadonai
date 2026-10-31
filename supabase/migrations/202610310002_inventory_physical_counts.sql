-- Physical inventory counts use a start-time balance snapshot. Differences are
-- applied on completion, so stock movements recorded while staff are counting
-- remain reflected in the final on-hand balance.

create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  counted_on date not null,
  request_id uuid not null,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed')),
  completion_fingerprint text
    check (completion_fingerprint is null or completion_fingerprint ~ '^[0-9a-f]{32}$'),
  actor_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (business_id, id),
  unique (business_id, request_id),
  check (
    (status = 'in_progress' and completion_fingerprint is null and completed_at is null)
    or (status = 'completed' and completion_fingerprint is not null and completed_at is not null)
  )
);

create index inventory_counts_history_idx
  on public.inventory_counts (business_id, counted_on desc, created_at desc);

create unique index inventory_counts_one_in_progress_per_business_idx
  on public.inventory_counts (business_id)
  where status = 'in_progress';

create table public.inventory_count_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  inventory_count_id uuid not null,
  product_id uuid not null,
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 1 and 160),
  inventory_unit_snapshot text not null check (char_length(btrim(inventory_unit_snapshot)) between 1 and 32),
  expected_quantity numeric(18,3) not null,
  counted_quantity numeric(12,3),
  quantity_delta numeric(18,3),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, inventory_count_id, product_id),
  foreign key (business_id, inventory_count_id)
    references public.inventory_counts (business_id, id) on delete restrict,
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict,
  check (
    (counted_quantity is null and quantity_delta is null)
    or (counted_quantity >= 0 and quantity_delta = counted_quantity - expected_quantity)
  )
);

create index inventory_count_lines_count_idx
  on public.inventory_count_lines (business_id, inventory_count_id, product_name_snapshot);

alter table public.inventory_movements
  add column inventory_count_id uuid;

alter table public.inventory_movements
  add constraint inventory_movements_count_fk
  foreign key (business_id, inventory_count_id)
  references public.inventory_counts (business_id, id) on delete restrict;

create index inventory_movements_count_idx
  on public.inventory_movements (business_id, inventory_count_id)
  where inventory_count_id is not null;

alter table public.inventory_counts enable row level security;
alter table public.inventory_count_lines enable row level security;

revoke all on table public.inventory_counts from public, anon, authenticated;
revoke all on table public.inventory_count_lines from public, anon, authenticated;
grant select on table public.inventory_counts to authenticated;
grant select on table public.inventory_count_lines to authenticated;

create policy inventory_counts_select_for_owners
  on public.inventory_counts
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create policy inventory_count_lines_select_for_owners
  on public.inventory_count_lines
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create function public.begin_inventory_count(
  p_business_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_timezone text;
  v_count_id uuid;
  v_counted_on date;
  v_product_id uuid;
  v_product_count integer;
  v_product_ids uuid[] := array[]::uuid[];
begin
  if (select auth.uid()) is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory count access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required to begin a physical count.';
  end if;

  select business.timezone
    into v_timezone
    from public.businesses as business
   where business.id = p_business_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected business does not exist.';
  end if;
  v_counted_on := (pg_catalog.now() at time zone v_timezone)::date;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text),
    pg_catalog.hashtext(p_request_id::text)
  );

  select count_row.id
    into v_count_id
    from public.inventory_counts as count_row
   where count_row.business_id = p_business_id
     and count_row.request_id = p_request_id;
  if found then
    return v_count_id;
  end if;

  select count_row.id
    into v_count_id
    from public.inventory_counts as count_row
   where count_row.business_id = p_business_id
     and count_row.status = 'in_progress';
  if found then
    return v_count_id;
  end if;

  -- Every stock-changing RPC locks product rows. Lock the complete snapshot in
  -- stable order before calculating balances to avoid racing concurrent sales.
  v_product_count := 0;
  for v_product_id in
    select product.id
      from public.products as product
     where product.business_id = p_business_id
       and product.inventory_tracked
       and not product.is_combo
     order by product.id
  loop
    v_product_count := v_product_count + 1;
    if v_product_count > 500 then
      raise exception using errcode = '22023', message = 'Physical counts support at most 500 tracked products at a time.';
    end if;

    perform 1
      from public.products as product
     where product.business_id = p_business_id
       and product.id = v_product_id
     for update;
    v_product_ids := pg_catalog.array_append(v_product_ids, v_product_id);
  end loop;
  if v_product_count = 0 then
    raise exception using errcode = '22023', message = 'There are no stock-tracked products to count.';
  end if;

  insert into public.inventory_counts (
    business_id, counted_on, request_id, actor_id
  ) values (
    p_business_id, v_counted_on, p_request_id, (select auth.uid())
  ) returning id into v_count_id;

  insert into public.inventory_count_lines (
    business_id, inventory_count_id, product_id,
    product_name_snapshot, inventory_unit_snapshot, expected_quantity
  )
  select product.business_id,
         v_count_id,
         product.id,
         product.name,
         product.inventory_unit,
         coalesce(pg_catalog.sum(movement.quantity_delta), 0)
    from public.products as product
    left join public.inventory_movements as movement
      on movement.business_id = product.business_id
     and movement.product_id = product.id
   where product.business_id = p_business_id
     and product.id = any(v_product_ids)
     and product.inventory_tracked
     and not product.is_combo
   group by product.business_id, product.id, product.name, product.inventory_unit
   order by product.id;

  return v_count_id;
end;
$function$;

create function public.complete_inventory_count(
  p_business_id uuid,
  p_inventory_count_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_status text;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_normalized_items jsonb;
  v_count_id uuid;
  v_item jsonb;
  v_product_id uuid;
  v_product record;
  v_counted_quantity numeric;
  v_expected_quantity numeric;
  v_quantity_delta numeric;
  v_seen_products uuid[] := array[]::uuid[];
  v_item_count integer;
  v_snapshot_count integer;
begin
  if (select auth.uid()) is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory count access denied.';
  end if;
  if p_inventory_count_id is null or p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'A count id and item list are required.';
  end if;

  select count_row.status, count_row.completion_fingerprint
    into v_status, v_existing_fingerprint
    from public.inventory_counts as count_row
   where count_row.business_id = p_business_id
     and count_row.id = p_inventory_count_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected physical count does not exist in this business.';
  end if;

  v_item_count := pg_catalog.jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 500 then
    raise exception using errcode = '22023', message = 'A physical count must include between 1 and 500 products.';
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_items) as entry(value)
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or not (v_item ? 'product_id')
       or not (v_item ? 'counted_quantity')
       or pg_catalog.jsonb_typeof(v_item -> 'product_id') <> 'string'
       or pg_catalog.jsonb_typeof(v_item -> 'counted_quantity') <> 'number' then
      raise exception using errcode = '22023', message = 'Each count item must include a product id and numeric counted quantity.';
    end if;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
      v_counted_quantity := (v_item ->> 'counted_quantity')::numeric;
    exception when others then
      raise exception using errcode = '22023', message = 'A count item has an invalid product id or quantity.';
    end;

    if v_product_id = any(v_seen_products) then
      raise exception using errcode = '22023', message = 'A product may appear only once in a physical count.';
    end if;
    v_seen_products := pg_catalog.array_append(v_seen_products, v_product_id);

    if v_counted_quantity < 0
       or v_counted_quantity > 99999999.999
       or pg_catalog.scale(v_counted_quantity) > 3 then
      raise exception using errcode = '22023', message = 'Counted quantities must be between zero and 99,999,999.999 with at most three decimal places.';
    end if;

    if not exists (
      select 1
        from public.inventory_count_lines as count_line
       where count_line.business_id = p_business_id
         and count_line.inventory_count_id = p_inventory_count_id
         and count_line.product_id = v_product_id
    ) then
      raise exception using errcode = '22023', message = 'The submitted products do not match the count snapshot.';
    end if;
  end loop;

  select pg_catalog.count(*)::integer
    into v_snapshot_count
    from public.inventory_count_lines as count_line
   where count_line.business_id = p_business_id
     and count_line.inventory_count_id = p_inventory_count_id;
  if v_item_count <> v_snapshot_count then
    raise exception using errcode = '22023', message = 'Every product in the count snapshot must be included.';
  end if;

  select pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'product_id', (entry.value ->> 'product_id')::uuid,
             'counted_quantity', (entry.value ->> 'counted_quantity')::numeric
           ) order by (entry.value ->> 'product_id')::uuid
         )
    into v_normalized_items
    from pg_catalog.jsonb_array_elements(p_items) as entry(value);

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'complete_inventory_count',
    'business_id', p_business_id,
    'inventory_count_id', p_inventory_count_id,
    'items', v_normalized_items
  )::text);

  if v_status = 'completed' then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This count was already completed with different quantities.';
    end if;
    return p_inventory_count_id;
  end if;

  -- Snapshot rows include every stock-tracked product. Lock them in the same
  -- stable order as begin_inventory_count() before recording adjustments.
  for v_product_id in
    select count_line.product_id
      from public.inventory_count_lines as count_line
     where count_line.business_id = p_business_id
       and count_line.inventory_count_id = p_inventory_count_id
     order by count_line.product_id
  loop
    select product.id, product.inventory_tracked, product.is_combo
      into v_product
      from public.products as product
     where product.business_id = p_business_id
       and product.id = v_product_id
     for update;
    if not found or not v_product.inventory_tracked or v_product.is_combo then
      raise exception using errcode = '22023', message = 'A snapshot product is no longer available for stock reconciliation.';
    end if;
  end loop;

  for v_item in select value from pg_catalog.jsonb_array_elements(v_normalized_items) as entry(value)
  loop
    v_product_id := (v_item ->> 'product_id')::uuid;
    v_counted_quantity := (v_item ->> 'counted_quantity')::numeric;

    select count_line.expected_quantity
      into v_expected_quantity
      from public.inventory_count_lines as count_line
     where count_line.business_id = p_business_id
       and count_line.inventory_count_id = p_inventory_count_id
       and count_line.product_id = v_product_id;

    v_quantity_delta := v_counted_quantity - v_expected_quantity;

    update public.inventory_count_lines
       set counted_quantity = v_counted_quantity,
           quantity_delta = v_quantity_delta
     where business_id = p_business_id
       and inventory_count_id = p_inventory_count_id
       and product_id = v_product_id;

    if v_quantity_delta <> 0 then
      insert into public.inventory_movements (
        business_id, product_id, movement_type, quantity_delta, reason,
        actor_id, occurred_at, inventory_count_id
      ) values (
        p_business_id, v_product_id,
        'adjustment'::public.inventory_movement_type,
        v_quantity_delta,
        pg_catalog.format('Contagem física · %s', (
          select count_row.counted_on
            from public.inventory_counts as count_row
           where count_row.business_id = p_business_id
             and count_row.id = p_inventory_count_id
        )),
        (select auth.uid()), pg_catalog.now(), p_inventory_count_id
      );
    end if;
  end loop;

  update public.inventory_counts
     set status = 'completed',
         completion_fingerprint = v_fingerprint,
         completed_at = pg_catalog.now()
   where business_id = p_business_id
     and id = p_inventory_count_id;

  return p_inventory_count_id;
end;
$function$;

revoke all on function public.begin_inventory_count(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_inventory_count(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.begin_inventory_count(uuid, uuid) to authenticated;
grant execute on function public.complete_inventory_count(uuid, uuid, jsonb) to authenticated;
