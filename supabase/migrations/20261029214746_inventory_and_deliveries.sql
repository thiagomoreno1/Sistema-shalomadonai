-- Owner-managed inventory, combo snapshots, purchasing records, and delivery workflow.
-- Inventory is append-only; balances are derived from signed movements.

create type public.inventory_movement_type as enum (
  'opening',
  'receipt',
  'adjustment',
  'loss',
  'dispatch',
  'return'
);

create type public.delivery_status as enum (
  'awaiting_separation',
  'ready',
  'dispatched',
  'delivered',
  'attempted',
  'rescheduled',
  'returned'
);

create type public.delivery_event_type as enum ('created', 'plan_updated', 'status_changed');

alter table public.products
  add column inventory_tracked boolean not null default false,
  add column minimum_stock numeric(12,3),
  add column is_combo boolean not null default false,
  add constraint products_minimum_stock_check
    check (minimum_stock is null or (inventory_tracked and minimum_stock >= 0)),
  add constraint products_inventory_tracking_check
    check (not inventory_tracked or (inventory_unit is not null and not is_combo)),
  add constraint products_combo_tracking_check
    check (not is_combo or not inventory_tracked);

alter table public.orders
  add column requires_delivery boolean not null default false;

alter table public.order_lines
  add constraint order_lines_business_order_id_key unique (business_id, order_id, id);

create table public.combo_components (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  combo_product_id uuid not null,
  component_product_id uuid not null,
  quantity_per_combo numeric(12,3) not null check (quantity_per_combo > 0),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, combo_product_id, component_product_id),
  foreign key (business_id, combo_product_id)
    references public.products (business_id, id) on delete restrict,
  foreign key (business_id, component_product_id)
    references public.products (business_id, id) on delete restrict,
  check (combo_product_id <> component_product_id)
);

create index combo_components_combo_idx
  on public.combo_components (business_id, combo_product_id, component_product_id);

create table public.order_line_components (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  order_line_id uuid not null,
  product_id uuid not null,
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 1 and 160),
  inventory_unit_snapshot text check (inventory_unit_snapshot is null or char_length(btrim(inventory_unit_snapshot)) between 1 and 32),
  quantity_snapshot numeric(12,3) not null check (quantity_snapshot > 0),
  inventory_tracked_snapshot boolean not null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, order_line_id, product_id),
  unique (business_id, order_id, order_line_id, product_id),
  foreign key (business_id, order_id, order_line_id)
    references public.order_lines (business_id, order_id, id) on delete restrict,
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict,
  check (not inventory_tracked_snapshot or inventory_unit_snapshot is not null)
);

create index order_line_components_order_idx
  on public.order_line_components (business_id, order_id, product_id);

create table public.inventory_receipts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  supplier_name text check (supplier_name is null or char_length(btrim(supplier_name)) <= 160),
  purchase_reference text check (purchase_reference is null or char_length(btrim(purchase_reference)) <= 120),
  received_on date not null,
  notes text check (notes is null or char_length(btrim(notes)) <= 2000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id)
);

create index inventory_receipts_history_idx
  on public.inventory_receipts (business_id, received_on desc, created_at desc);

create table public.inventory_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  receipt_id uuid not null,
  product_id uuid not null,
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 1 and 160),
  inventory_unit_snapshot text not null check (char_length(btrim(inventory_unit_snapshot)) between 1 and 32),
  quantity numeric(12,3) not null check (quantity > 0),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, receipt_id, id),
  unique (business_id, receipt_id, product_id),
  foreign key (business_id, receipt_id)
    references public.inventory_receipts (business_id, id) on delete restrict,
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null,
  movement_type public.inventory_movement_type not null,
  quantity_delta numeric(12,3) not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  order_id uuid,
  receipt_id uuid,
  receipt_line_id uuid,
  request_id uuid,
  request_fingerprint text,
  actor_id uuid not null references auth.users (id) on delete restrict,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict,
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict,
  foreign key (business_id, receipt_id, receipt_line_id)
    references public.inventory_receipt_lines (business_id, receipt_id, id) on delete restrict,
  check (
    (request_id is null and request_fingerprint is null)
    or (request_id is not null and request_fingerprint is not null and request_fingerprint ~ '^[0-9a-f]{32}$')
  ),
  check (
    (movement_type = 'opening'::public.inventory_movement_type
      and quantity_delta >= 0 and order_id is null and receipt_id is null and receipt_line_id is null)
    or (movement_type = 'receipt'::public.inventory_movement_type
      and quantity_delta > 0 and order_id is null and receipt_id is not null and receipt_line_id is not null)
    or (movement_type = 'adjustment'::public.inventory_movement_type
      and quantity_delta <> 0 and order_id is null and receipt_id is null and receipt_line_id is null)
    or (movement_type = 'loss'::public.inventory_movement_type
      and quantity_delta < 0 and order_id is null and receipt_id is null and receipt_line_id is null)
    or (movement_type = 'dispatch'::public.inventory_movement_type
      and quantity_delta < 0 and order_id is not null and receipt_id is null and receipt_line_id is null)
    or (movement_type = 'return'::public.inventory_movement_type
      and quantity_delta > 0 and order_id is not null and receipt_id is null and receipt_line_id is null)
  )
);

create index inventory_movements_product_history_idx
  on public.inventory_movements (business_id, product_id, occurred_at desc, id desc);
create index inventory_movements_order_idx
  on public.inventory_movements (business_id, order_id, product_id)
  where order_id is not null;
create index inventory_movements_receipt_idx
  on public.inventory_movements (business_id, receipt_id, receipt_line_id)
  where receipt_id is not null;

create table public.delivery_workers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  phone text check (phone is null or char_length(btrim(phone)) <= 64),
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create index delivery_workers_active_idx on public.delivery_workers (business_id, name) where is_active;

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  status public.delivery_status not null default 'awaiting_separation',
  delivery_worker_id uuid,
  scheduled_on date,
  time_window text check (time_window is null or char_length(btrim(time_window)) <= 120),
  notes text check (notes is null or char_length(btrim(notes)) <= 2000),
  canceled_at timestamptz,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  attempted_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, order_id),
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict,
  foreign key (business_id, delivery_worker_id)
    references public.delivery_workers (business_id, id) on delete restrict,
  check (canceled_at is null or status in (
    'awaiting_separation'::public.delivery_status,
    'ready'::public.delivery_status
  ))
);

create index deliveries_queue_idx
  on public.deliveries (business_id, status, scheduled_on, created_at)
  where canceled_at is null;

create table public.delivery_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_id uuid not null,
  event_type public.delivery_event_type not null,
  from_status public.delivery_status,
  to_status public.delivery_status not null,
  delivery_worker_id uuid,
  scheduled_on date,
  time_window text check (time_window is null or char_length(btrim(time_window)) <= 120),
  note text check (note is null or char_length(btrim(note)) <= 2000),
  next_step text check (next_step is null or char_length(btrim(next_step)) <= 1000),
  stock_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(stock_warnings) = 'array'),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  actor_id uuid not null references auth.users (id) on delete restrict,
  occurred_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, delivery_id)
    references public.deliveries (business_id, id) on delete restrict,
  foreign key (business_id, delivery_worker_id)
    references public.delivery_workers (business_id, id) on delete restrict,
  check (
    (event_type = 'created'::public.delivery_event_type and from_status is null)
    or (event_type <> 'created'::public.delivery_event_type and from_status is not null)
  )
);

create index delivery_events_history_idx
  on public.delivery_events (business_id, delivery_id, occurred_at, id);

alter table public.combo_components enable row level security;
alter table public.order_line_components enable row level security;
alter table public.inventory_receipts enable row level security;
alter table public.inventory_receipt_lines enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.delivery_workers enable row level security;
alter table public.deliveries enable row level security;
alter table public.delivery_events enable row level security;

revoke all on table public.combo_components from public, anon, authenticated;
revoke all on table public.order_line_components from public, anon, authenticated;
revoke all on table public.inventory_receipts from public, anon, authenticated;
revoke all on table public.inventory_receipt_lines from public, anon, authenticated;
revoke all on table public.inventory_movements from public, anon, authenticated;
revoke all on table public.delivery_workers from public, anon, authenticated;
revoke all on table public.deliveries from public, anon, authenticated;
revoke all on table public.delivery_events from public, anon, authenticated;

grant select on table public.combo_components to authenticated;
grant select on table public.order_line_components to authenticated;
grant select on table public.inventory_receipts to authenticated;
grant select on table public.inventory_receipt_lines to authenticated;
grant select on table public.inventory_movements to authenticated;
grant select on table public.delivery_workers to authenticated;
grant insert (business_id, name, phone, is_active) on table public.delivery_workers to authenticated;
grant update (name, phone, is_active) on table public.delivery_workers to authenticated;
grant select on table public.deliveries to authenticated;
grant select on table public.delivery_events to authenticated;
grant select (requires_delivery) on table public.orders to authenticated;
grant update (minimum_stock) on table public.products to authenticated;

create policy combo_components_select_for_owners on public.combo_components
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy order_line_components_select_for_owners on public.order_line_components
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy inventory_receipts_select_for_owners on public.inventory_receipts
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy inventory_receipt_lines_select_for_owners on public.inventory_receipt_lines
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy inventory_movements_select_for_owners on public.inventory_movements
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy delivery_workers_select_for_owners on public.delivery_workers
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy delivery_workers_insert_for_owners on public.delivery_workers
  for insert to authenticated with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
create policy delivery_workers_update_for_owners on public.delivery_workers
  for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check ((select private.is_business_owner(business_id)));
create policy deliveries_select_for_owners on public.deliveries
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy delivery_events_select_for_owners on public.delivery_events
  for select to authenticated using ((select private.is_business_owner(business_id)));

create view public.inventory_balances with (security_invoker = true) as
select product.business_id,
       product.id as product_id,
       product.name as product_name,
       product.inventory_unit,
       product.minimum_stock,
       coalesce(pg_catalog.sum(movement.quantity_delta), 0) as quantity_on_hand
  from public.products as product
  left join public.inventory_movements as movement
    on movement.business_id = product.business_id
   and movement.product_id = product.id
 where product.inventory_tracked
 group by product.business_id, product.id, product.name, product.inventory_unit, product.minimum_stock;

revoke all on table public.inventory_balances from public, anon, authenticated;
grant select on table public.inventory_balances to authenticated;

create function private.guard_inventory_product_configuration()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.inventory_tracked and not new.inventory_tracked then
    raise exception using errcode = '22023', message = 'Stock tracking cannot be disabled after the opening count.';
  end if;
  if old.inventory_tracked and new.inventory_unit is distinct from old.inventory_unit then
    raise exception using errcode = '22023', message = 'The unit cannot be changed after stock tracking begins.';
  end if;
  if old.is_combo and not new.is_combo then
    raise exception using errcode = '22023', message = 'A saved combo cannot be converted back to a regular product.';
  end if;
  return new;
end;
$function$;

create trigger products_guard_inventory_configuration
  before update of inventory_tracked, inventory_unit, is_combo on public.products
  for each row execute function private.guard_inventory_product_configuration();

create function private.reject_immutable_record_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '55000', message = 'This record is append-only.';
end;
$function$;

create trigger inventory_movements_append_only
  before update or delete on public.inventory_movements
  for each row execute function private.reject_immutable_record_change();
create trigger inventory_receipts_append_only
  before update or delete on public.inventory_receipts
  for each row execute function private.reject_immutable_record_change();
create trigger inventory_receipt_lines_append_only
  before update or delete on public.inventory_receipt_lines
  for each row execute function private.reject_immutable_record_change();
create trigger order_line_components_append_only
  before update or delete on public.order_line_components
  for each row execute function private.reject_immutable_record_change();
create trigger delivery_events_append_only
  before update or delete on public.delivery_events
  for each row execute function private.reject_immutable_record_change();

revoke all on function private.guard_inventory_product_configuration() from public, anon, authenticated;
revoke all on function private.reject_immutable_record_change() from public, anon, authenticated;

create function public.configure_product_inventory(
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

  select product.inventory_tracked, product.is_combo
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

create function public.set_combo_components(
  p_business_id uuid,
  p_combo_product_id uuid,
  p_components jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_combo record;
  v_component record;
  v_component_id uuid;
  v_component_count integer;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Combo configuration access denied.';
  end if;
  if p_combo_product_id is null or p_components is null
     or pg_catalog.jsonb_typeof(p_components) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'A combo needs at least one component.';
  end if;
  if pg_catalog.jsonb_array_length(p_components) = 0 then
    raise exception using errcode = '22023', message = 'A combo needs at least one component.';
  end if;

  select product.is_active, product.inventory_tracked
    into v_combo
    from public.products as product
   where product.business_id = p_business_id and product.id = p_combo_product_id
   for update;
  if not found or not v_combo.is_active or v_combo.inventory_tracked then
    raise exception using errcode = '22023', message = 'Choose an active, untracked combo product.';
  end if;

  select pg_catalog.count(*) into v_component_count
    from pg_catalog.jsonb_to_recordset(p_components)
      as component(component_product_id uuid, quantity_per_combo numeric);
  if v_component_count <> pg_catalog.jsonb_array_length(p_components)
     or exists (
       select 1
         from pg_catalog.jsonb_to_recordset(p_components)
           as component(component_product_id uuid, quantity_per_combo numeric)
        where component.component_product_id is null
           or component.quantity_per_combo is null
           or component.quantity_per_combo <= 0
           or component.quantity_per_combo > 999999999.999
           or component.quantity_per_combo <> pg_catalog.round(component.quantity_per_combo, 3)
     )
     or v_component_count <> (
       select pg_catalog.count(distinct component.component_product_id)
         from pg_catalog.jsonb_to_recordset(p_components)
           as component(component_product_id uuid, quantity_per_combo numeric)
     ) then
    raise exception using errcode = '22023', message = 'Combo components must be unique with positive quantities to three decimal places.';
  end if;

  for v_component_id in
    select component.component_product_id
      from pg_catalog.jsonb_to_recordset(p_components)
        as component(component_product_id uuid, quantity_per_combo numeric)
     order by component.component_product_id
  loop
    select product.is_active, product.is_combo, product.inventory_tracked, product.inventory_unit
      into v_component
      from public.products as product
     where product.business_id = p_business_id
       and product.id = v_component_id
     for share;
    if not found or not v_component.is_active or v_component.is_combo
       or not v_component.inventory_tracked or v_component.inventory_unit is null then
      raise exception using errcode = '22023', message = 'Each combo component must be an active, stock-tracked, non-combo product in this business.';
    end if;
  end loop;

  delete from public.combo_components
   where business_id = p_business_id and combo_product_id = p_combo_product_id;

  insert into public.combo_components (
    business_id, combo_product_id, component_product_id, quantity_per_combo
  )
  select p_business_id, p_combo_product_id,
         component.component_product_id, component.quantity_per_combo
    from pg_catalog.jsonb_to_recordset(p_components)
      as component(component_product_id uuid, quantity_per_combo numeric);
  get diagnostics v_component_count = row_count;

  update public.products
     set is_combo = true, updated_at = pg_catalog.now()
   where business_id = p_business_id and id = p_combo_product_id;

  return v_component_count;
end;
$function$;

revoke all on function public.configure_product_inventory(uuid, uuid, text, numeric, numeric, uuid) from public, anon, authenticated;
revoke all on function public.set_combo_components(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.configure_product_inventory(uuid, uuid, text, numeric, numeric, uuid) to authenticated;
grant execute on function public.set_combo_components(uuid, uuid, jsonb) to authenticated;

create function public.record_inventory_receipt(
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
    from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric);
  if v_items_count <> pg_catalog.jsonb_array_length(p_items)
     or exists (
       select 1 from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric)
        where item.product_id is null or item.quantity is null or item.quantity <= 0
           or item.quantity > 999999999.999 or item.quantity <> pg_catalog.round(item.quantity, 3)
     )
     or v_items_count <> (
       select pg_catalog.count(distinct item.product_id)
         from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric)
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

  for v_item in
    select item.product_id, item.quantity
      from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric)
     order by item.product_id
  loop
    select product.name, product.inventory_unit, product.inventory_tracked
      into v_product
      from public.products as product
     where product.business_id = p_business_id and product.id = v_item.product_id
     for update;
    if not found or not v_product.inventory_tracked or v_product.inventory_unit is null then
      raise exception using errcode = '22023', message = 'Every receipt product must have stock tracking configured in this business.';
    end if;
    v_lines := v_lines || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'product_id', v_item.product_id,
      'product_name', v_product.name,
      'inventory_unit', v_product.inventory_unit,
      'quantity', v_item.quantity
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
           line.value ->> 'quantity' as quantity
      from pg_catalog.jsonb_array_elements(v_lines) as line(value)
     order by (line.value ->> 'product_id')::uuid
  loop
    insert into public.inventory_receipt_lines (
      business_id, receipt_id, product_id, product_name_snapshot, inventory_unit_snapshot, quantity
    ) values (
      p_business_id, v_receipt_id, v_item.product_id::uuid, v_item.product_name,
      v_item.inventory_unit, v_item.quantity::numeric
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

create function public.record_inventory_movement(
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
  v_delivery_status public.delivery_status;
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
    select order_row.status into v_order_status
      from public.orders as order_row
     where order_row.business_id = p_business_id and order_row.id = p_order_id
     for update;
    if not found or v_order_status <> 'open'::public.order_status then
      raise exception using errcode = '22023', message = 'A return must reference an open order in this business.';
    end if;
    select delivery.status into v_delivery_status
      from public.deliveries as delivery
     where delivery.business_id = p_business_id and delivery.order_id = p_order_id
       and delivery.canceled_at is null;
    if not found or v_delivery_status not in (
      'attempted'::public.delivery_status,
      'rescheduled'::public.delivery_status,
      'delivered'::public.delivery_status,
      'returned'::public.delivery_status
    ) then
      raise exception using errcode = '22023', message = 'A return can only be recorded after an attempted, rescheduled, delivered, or returned delivery has been inspected.';
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
      raise exception using errcode = '22023', message = 'The inspected return cannot exceed the quantity previously dispatched and still out for this order.';
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

revoke all on function public.record_inventory_receipt(uuid, text, text, date, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.record_inventory_movement(uuid, uuid, public.inventory_movement_type, numeric, text, text, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.record_inventory_receipt(uuid, text, text, date, text, jsonb, uuid) to authenticated;
grant execute on function public.record_inventory_movement(uuid, uuid, public.inventory_movement_type, numeric, text, text, uuid, timestamptz, uuid) to authenticated;

drop function public.create_order(uuid, uuid, text, bigint, bigint, text, jsonb, jsonb, uuid);

create function public.create_order(
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

create function public.update_delivery_plan(
  p_business_id uuid,
  p_delivery_id uuid,
  p_delivery_worker_id uuid,
  p_scheduled_on date,
  p_time_window text,
  p_notes text,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_delivery record;
  v_event_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Delivery plan access denied.';
  end if;
  if p_delivery_id is null or p_request_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_time_window)) > 120
     or pg_catalog.char_length(pg_catalog.btrim(p_notes)) > 2000 then
    raise exception using errcode = '22023', message = 'Delivery plan details are invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'update_delivery_plan',
    'delivery_id', p_delivery_id,
    'delivery_worker_id', p_delivery_worker_id,
    'scheduled_on', p_scheduled_on,
    'time_window', nullif(pg_catalog.btrim(p_time_window), ''),
    'notes', nullif(pg_catalog.btrim(p_notes), '')
  )::text);
  select event.id, event.request_fingerprint
    into v_event_id, v_existing_fingerprint
    from public.delivery_events as event
   where event.business_id = p_business_id and event.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different delivery plan details.';
    end if;
    return;
  end if;

  select delivery.id, delivery.order_id, delivery.status, delivery.delivery_worker_id,
         delivery.scheduled_on, delivery.time_window, delivery.notes, delivery.canceled_at
    into v_delivery
    from public.deliveries as delivery
   where delivery.business_id = p_business_id and delivery.id = p_delivery_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected delivery does not exist in this business.';
  end if;
  if v_delivery.canceled_at is not null
     or v_delivery.status in ('delivered'::public.delivery_status, 'returned'::public.delivery_status) then
    raise exception using errcode = '22023', message = 'A canceled or completed delivery plan cannot be changed.';
  end if;
  if p_delivery_worker_id is not null and not exists (
    select 1 from public.delivery_workers as worker
     where worker.business_id = p_business_id
       and worker.id = p_delivery_worker_id and worker.is_active
  ) then
    raise exception using errcode = '23503', message = 'Choose an active delivery worker in this business.';
  end if;

  update public.deliveries
     set delivery_worker_id = p_delivery_worker_id,
         scheduled_on = p_scheduled_on,
         time_window = nullif(pg_catalog.btrim(p_time_window), ''),
         notes = nullif(pg_catalog.btrim(p_notes), ''),
         updated_at = pg_catalog.now()
   where business_id = p_business_id and id = p_delivery_id;

  insert into public.delivery_events (
    business_id, delivery_id, event_type, from_status, to_status,
    delivery_worker_id, scheduled_on, time_window, note,
    request_id, request_fingerprint, actor_id
  ) values (
    p_business_id, p_delivery_id, 'plan_updated'::public.delivery_event_type,
    v_delivery.status, v_delivery.status, p_delivery_worker_id, p_scheduled_on,
    nullif(pg_catalog.btrim(p_time_window), ''), nullif(pg_catalog.btrim(p_notes), ''),
    p_request_id, v_fingerprint, (select auth.uid())
  );
end;
$function$;

create function public.transition_delivery(
  p_business_id uuid,
  p_delivery_id uuid,
  p_status public.delivery_status,
  p_note text,
  p_next_step text,
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
  v_order_id uuid;
  v_order_status public.order_status;
  v_delivery record;
  v_component record;
  v_net_issued numeric;
  v_quantity_to_issue numeric;
  v_chunk numeric;
  v_stock_warnings jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Delivery transition access denied.';
  end if;
  if p_delivery_id is null or p_status is null or p_request_id is null
     or pg_catalog.char_length(pg_catalog.btrim(p_note)) > 1000
     or pg_catalog.char_length(pg_catalog.btrim(p_next_step)) > 1000 then
    raise exception using errcode = '22023', message = 'Delivery transition details are invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'transition_delivery',
    'delivery_id', p_delivery_id,
    'status', p_status,
    'note', nullif(pg_catalog.btrim(p_note), ''),
    'next_step', nullif(pg_catalog.btrim(p_next_step), '')
  )::text);
  select event.id, event.request_fingerprint
    into v_event_id, v_existing_fingerprint
    from public.delivery_events as event
   where event.business_id = p_business_id and event.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for a different delivery transition.';
    end if;
    return v_event_id;
  end if;

  select delivery.order_id into v_order_id
    from public.deliveries as delivery
   where delivery.business_id = p_business_id and delivery.id = p_delivery_id;
  if not found then
    raise exception using errcode = '23503', message = 'The selected delivery does not exist in this business.';
  end if;
  select order_row.status into v_order_status
    from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.id = v_order_id
   for update;
  if not found or v_order_status <> 'open'::public.order_status then
    raise exception using errcode = '22023', message = 'A canceled order cannot change delivery status.';
  end if;

  select delivery.* into v_delivery
    from public.deliveries as delivery
   where delivery.business_id = p_business_id and delivery.id = p_delivery_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected delivery does not exist in this business.';
  end if;
  if v_delivery.canceled_at is not null then
    raise exception using errcode = '22023', message = 'A canceled delivery cannot change status.';
  end if;

  if not (
    (v_delivery.status = 'awaiting_separation'::public.delivery_status
      and p_status = 'ready'::public.delivery_status)
    or (v_delivery.status = 'ready'::public.delivery_status
      and p_status in ('awaiting_separation'::public.delivery_status, 'dispatched'::public.delivery_status))
    or (v_delivery.status = 'dispatched'::public.delivery_status
      and p_status in ('delivered'::public.delivery_status, 'attempted'::public.delivery_status))
    or (v_delivery.status = 'attempted'::public.delivery_status
      and p_status in ('rescheduled'::public.delivery_status, 'returned'::public.delivery_status))
    or (v_delivery.status = 'rescheduled'::public.delivery_status
      and p_status = 'ready'::public.delivery_status)
  ) then
    raise exception using errcode = '22023', message = 'This delivery status transition is not allowed.';
  end if;
  if p_status = 'attempted'::public.delivery_status
     and (nullif(pg_catalog.btrim(p_note), '') is null
       or nullif(pg_catalog.btrim(p_next_step), '') is null) then
    raise exception using errcode = '22023', message = 'An attempted delivery needs a note and a next step.';
  end if;

  if p_status = 'dispatched'::public.delivery_status then
    for v_component in
      select component.product_id
        from public.order_line_components as component
       where component.business_id = p_business_id
         and component.order_id = v_order_id
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
         and component.order_id = v_order_id
         and component.inventory_tracked_snapshot
       group by component.product_id
       order by component.product_id
    loop
      select coalesce(-pg_catalog.sum(movement.quantity_delta), 0)
        into v_net_issued
        from public.inventory_movements as movement
       where movement.business_id = p_business_id
         and movement.order_id = v_order_id
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
          -v_chunk, 'Expedição de pedido', v_order_id, (select auth.uid())
        );
        v_quantity_to_issue := v_quantity_to_issue - v_chunk;
      end loop;
    end loop;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'product_id', balance.product_id,
             'product_name', balance.name,
             'inventory_unit', balance.inventory_unit,
             'quantity_on_hand', balance.quantity_on_hand
           ) order by balance.product_id), '[]'::jsonb)
      into v_stock_warnings
      from (
        select product.id as product_id, product.name, product.inventory_unit,
               coalesce(balance.quantity_on_hand, 0) as quantity_on_hand
          from (
            select distinct component.product_id
              from public.order_line_components as component
             where component.business_id = p_business_id
               and component.order_id = v_order_id
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
      ) as balance;
  end if;

  update public.deliveries
     set status = p_status,
         dispatched_at = case when p_status = 'dispatched'::public.delivery_status then pg_catalog.now() else dispatched_at end,
         delivered_at = case when p_status = 'delivered'::public.delivery_status then pg_catalog.now() else delivered_at end,
         attempted_at = case when p_status = 'attempted'::public.delivery_status then pg_catalog.now() else attempted_at end,
         returned_at = case when p_status = 'returned'::public.delivery_status then pg_catalog.now() else returned_at end,
         updated_at = pg_catalog.now()
   where business_id = p_business_id and id = p_delivery_id;

  insert into public.delivery_events (
    business_id, delivery_id, event_type, from_status, to_status,
    delivery_worker_id, scheduled_on, time_window, note, next_step, stock_warnings,
    request_id, request_fingerprint, actor_id
  ) values (
    p_business_id, p_delivery_id, 'status_changed'::public.delivery_event_type,
    v_delivery.status, p_status, v_delivery.delivery_worker_id,
    v_delivery.scheduled_on, v_delivery.time_window,
    nullif(pg_catalog.btrim(p_note), ''), nullif(pg_catalog.btrim(p_next_step), ''),
    v_stock_warnings, p_request_id, v_fingerprint, (select auth.uid())
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

revoke all on function public.update_delivery_plan(uuid, uuid, uuid, date, text, text, uuid) from public, anon, authenticated;
revoke all on function public.transition_delivery(uuid, uuid, public.delivery_status, text, text, uuid) from public, anon, authenticated;
revoke all on function public.cancel_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.update_delivery_plan(uuid, uuid, uuid, date, text, text, uuid) to authenticated;
grant execute on function public.transition_delivery(uuid, uuid, public.delivery_status, text, text, uuid) to authenticated;
grant execute on function public.cancel_order(uuid, uuid, text) to authenticated;
