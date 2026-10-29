-- Orders snapshot the catalog and customer values used at the time of sale.
-- Payment terms, allocations, and receipts are entered manually by the owner.

create type public.order_status as enum ('open', 'cancelled');
create type public.order_event_type as enum ('created', 'cancelled');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  customer_id uuid not null,
  customer_name_snapshot text not null check (char_length(btrim(customer_name_snapshot)) between 1 and 160),
  delivery_address_snapshot text check (delivery_address_snapshot is null or char_length(btrim(delivery_address_snapshot)) <= 1000),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  delivery_fee_cents bigint not null default 0 check (delivery_fee_cents >= 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  total_cents bigint not null check (total_cents > 0),
  notes text check (notes is null or char_length(btrim(notes)) <= 4000),
  status public.order_status not null default 'open',
  cancelled_at timestamptz,
  cancellation_reason text check (cancellation_reason is null or char_length(btrim(cancellation_reason)) <= 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  check (total_cents::numeric = subtotal_cents::numeric + delivery_fee_cents::numeric - discount_cents::numeric),
  check (
    (status = 'open'::public.order_status and cancelled_at is null and cancellation_reason is null)
    or (status = 'cancelled'::public.order_status and cancelled_at is not null)
  ),
  foreign key (business_id, customer_id)
    references public.customers (business_id, id) on delete restrict
);

create index orders_business_created_idx on public.orders (business_id, created_at desc);
create index orders_business_customer_idx on public.orders (business_id, customer_id, created_at desc);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  line_number integer not null check (line_number > 0),
  product_id uuid not null,
  product_name_snapshot text not null check (char_length(btrim(product_name_snapshot)) between 1 and 160),
  inventory_unit_snapshot text check (inventory_unit_snapshot is null or char_length(btrim(inventory_unit_snapshot)) between 1 and 32),
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price_snapshot_cents bigint not null check (unit_price_snapshot_cents >= 0),
  unit_cost_snapshot_cents bigint check (unit_cost_snapshot_cents is null or unit_cost_snapshot_cents >= 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, order_id, line_number),
  unique (business_id, order_id, product_id),
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict,
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict
);

create index order_lines_order_idx on public.order_lines (business_id, order_id);

create table public.order_installments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  installment_number integer not null check (installment_number > 0),
  amount_cents bigint not null check (amount_cents > 0),
  due_on date not null,
  payment_method text check (payment_method is null or char_length(btrim(payment_method)) between 1 and 64),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, order_id, id),
  unique (business_id, order_id, installment_number),
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict
);

create index order_installments_due_idx on public.order_installments (business_id, due_on, order_id);

create table public.order_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  received_at timestamptz not null default now(),
  payment_method text check (payment_method is null or char_length(btrim(payment_method)) between 1 and 64),
  notes text check (notes is null or char_length(btrim(notes)) <= 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, order_id, id),
  unique (business_id, request_id),
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict
);

create index order_payments_order_idx on public.order_payments (business_id, order_id, received_at desc);

create table public.order_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  payment_id uuid not null,
  installment_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, payment_id, installment_id),
  foreign key (business_id, order_id, payment_id)
    references public.order_payments (business_id, order_id, id) on delete restrict,
  foreign key (business_id, order_id, installment_id)
    references public.order_installments (business_id, order_id, id) on delete restrict
);

create index order_payment_allocations_installment_idx
  on public.order_payment_allocations (business_id, order_id, installment_id);

create table public.order_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  event_type public.order_event_type not null,
  reason text check (reason is null or char_length(btrim(reason)) <= 1000),
  actor_id uuid not null references auth.users (id) on delete restrict,
  occurred_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, order_id, event_type),
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict
);

create index order_events_history_idx on public.order_events (business_id, order_id, occurred_at);

alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.order_installments enable row level security;
alter table public.order_payments enable row level security;
alter table public.order_payment_allocations enable row level security;
alter table public.order_events enable row level security;

revoke all on table public.orders from public, anon, authenticated;
revoke all on table public.order_lines from public, anon, authenticated;
revoke all on table public.order_installments from public, anon, authenticated;
revoke all on table public.order_payments from public, anon, authenticated;
revoke all on table public.order_payment_allocations from public, anon, authenticated;
revoke all on table public.order_events from public, anon, authenticated;

grant select (
  id, business_id, customer_id, customer_name_snapshot, delivery_address_snapshot,
  subtotal_cents, delivery_fee_cents, discount_cents, total_cents, notes, status,
  cancelled_at, cancellation_reason, created_at
) on table public.orders to authenticated;
grant select (
  id, business_id, order_id, line_number, product_name_snapshot, inventory_unit_snapshot, quantity,
  unit_price_snapshot_cents, line_total_cents, created_at
) on table public.order_lines to authenticated;
grant select (id, business_id, order_id, installment_number, amount_cents, due_on, payment_method, created_at)
  on table public.order_installments to authenticated;
grant select (id, business_id, order_id, amount_cents, received_at, payment_method, notes, created_at)
  on table public.order_payments to authenticated;
grant select (id, business_id, order_id, payment_id, installment_id, amount_cents, created_at)
  on table public.order_payment_allocations to authenticated;
grant select (id, business_id, order_id, event_type, reason, occurred_at)
  on table public.order_events to authenticated;

create policy orders_select_for_owners on public.orders
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy order_lines_select_for_owners on public.order_lines
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy order_installments_select_for_owners on public.order_installments
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy order_payments_select_for_owners on public.order_payments
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy order_payment_allocations_select_for_owners on public.order_payment_allocations
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy order_events_select_for_owners on public.order_events
  for select to authenticated using ((select private.is_business_owner(business_id)));

-- The snapshot and schedule are assembled exclusively from the live, same-business
-- catalog and the owner's explicit order input. Current values never overwrite them.
create function public.create_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_delivery_address text,
  p_delivery_fee_cents bigint,
  p_discount_cents bigint,
  p_notes text,
  p_items jsonb,
  p_installments jsonb,
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
  v_schedule record;
  v_lines jsonb := '[]'::jsonb;
  v_installments jsonb := '[]'::jsonb;
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
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'customer_id', p_customer_id,
    'delivery_address', pg_catalog.btrim(p_delivery_address),
    'delivery_fee_cents', p_delivery_fee_cents,
    'discount_cents', p_discount_cents,
    'notes', pg_catalog.btrim(p_notes),
    'items', p_items,
    'installments', p_installments
  )::text);

  select order_row.id, order_row.request_fingerprint
    into v_order_id, v_existing_fingerprint
    from public.orders as order_row
   where order_row.business_id = p_business_id
     and order_row.request_id = p_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different order details.';
    end if;
    return v_order_id;
  end if;

  if p_customer_id is null or p_delivery_fee_cents is null or p_delivery_fee_cents < 0
     or p_discount_cents is null or p_discount_cents < 0
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
     and customer.id = p_customer_id
     and customer.is_active
   for share;
  if not found then
    raise exception using errcode = '23503', message = 'The selected customer is not active in this business.';
  end if;

  select pg_catalog.count(*) into v_items_count
    from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric);
  if v_items_count <> pg_catalog.jsonb_array_length(p_items)
     or exists (
       select 1
         from pg_catalog.jsonb_to_recordset(p_items) as item(product_id uuid, quantity numeric)
        where item.product_id is null
           or item.quantity is null
           or item.quantity <= 0
           or item.quantity > 99999999.999
           or item.quantity <> pg_catalog.round(item.quantity, 3)
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
    select product.name, product.inventory_unit, product.sale_price_cents, product.cost_cents
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
      'line_total_cents', v_line_total::bigint
    ));
  end loop;

  v_total := v_subtotal + p_delivery_fee_cents::numeric - p_discount_cents::numeric;
  if v_total <= 0 or v_total > 9223372036854775807 or p_discount_cents::numeric > v_subtotal + p_delivery_fee_cents::numeric then
    raise exception using errcode = '22023', message = 'The discount and delivery fee must leave a positive order total.';
  end if;

  select pg_catalog.count(*) into v_schedule_count
    from pg_catalog.jsonb_to_recordset(p_installments) as schedule(amount_cents bigint, due_on date, payment_method text);
  if v_schedule_count <> pg_catalog.jsonb_array_length(p_installments)
     or exists (
       select 1
         from pg_catalog.jsonb_to_recordset(p_installments) as schedule(amount_cents bigint, due_on date, payment_method text)
        where schedule.amount_cents is null or schedule.amount_cents <= 0
           or schedule.due_on is null
           or (schedule.payment_method is not null and pg_catalog.char_length(pg_catalog.btrim(schedule.payment_method)) > 64)
     ) then
    raise exception using errcode = '22023', message = 'Each installment needs a positive whole-cent amount and a due date.';
  end if;
  select coalesce(pg_catalog.sum(schedule.amount_cents::numeric), 0) into v_schedule_total
    from pg_catalog.jsonb_to_recordset(p_installments) as schedule(amount_cents bigint, due_on date, payment_method text);
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
    request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_customer_id, v_customer_name, nullif(pg_catalog.btrim(p_delivery_address), ''),
    v_subtotal::bigint, p_delivery_fee_cents, p_discount_cents, v_total::bigint,
    nullif(pg_catalog.btrim(p_notes), ''), p_request_id, v_fingerprint, (select auth.uid())
  ) on conflict (business_id, request_id) do nothing
  returning id into v_order_id;

  if v_order_id is null then
    select order_row.id, order_row.request_fingerprint
      into v_order_id, v_existing_fingerprint
      from public.orders as order_row
     where order_row.business_id = p_business_id
       and order_row.request_id = p_request_id;
    if v_existing_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different order details.';
    end if;
    return v_order_id;
  end if;

  insert into public.order_lines (
    business_id, order_id, line_number, product_id, product_name_snapshot, inventory_unit_snapshot,
    quantity, unit_price_snapshot_cents, unit_cost_snapshot_cents, line_total_cents
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

  return v_order_id;
end;
$function$;

create function public.record_order_payment(
  p_business_id uuid,
  p_order_id uuid,
  p_amount_cents bigint,
  p_received_at timestamptz,
  p_payment_method text,
  p_notes text,
  p_allocations jsonb,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payment_id uuid;
  v_order_status public.order_status;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_allocations_count integer;
  v_allocations_total numeric;
  v_paid_amount numeric;
  v_order_total bigint;
  v_allocation record;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Order payment access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'A request id is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'order_id', p_order_id,
    'amount_cents', p_amount_cents,
    'received_at', p_received_at,
    'payment_method', pg_catalog.btrim(p_payment_method),
    'notes', pg_catalog.btrim(p_notes),
    'allocations', p_allocations
  )::text);

  select payment.id, payment.request_fingerprint
    into v_payment_id, v_existing_fingerprint
    from public.order_payments as payment
   where payment.business_id = p_business_id
     and payment.request_id = p_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different receipt details.';
    end if;
    return v_payment_id;
  end if;

  if p_received_at is not null and p_received_at > pg_catalog.now() then
    raise exception using errcode = '22023', message = 'A received time cannot be in the future.';
  end if;

  if p_order_id is null or p_amount_cents is null or p_amount_cents <= 0
     or pg_catalog.char_length(pg_catalog.btrim(p_payment_method)) > 64
     or pg_catalog.char_length(pg_catalog.btrim(p_notes)) > 1000
     or p_allocations is null
     or pg_catalog.jsonb_typeof(p_allocations) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Receipt details are invalid.';
  end if;
  if pg_catalog.jsonb_array_length(p_allocations) = 0 then
    raise exception using errcode = '22023', message = 'Receipt details are invalid.';
  end if;

  select order_row.status, order_row.total_cents into v_order_status, v_order_total
    from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.id = p_order_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected order does not exist in this business.';
  end if;

  -- A retry can wait for the previous request's order lock. Recheck its key
  -- after acquiring that lock so it returns the original receipt idempotently.
  select payment.id, payment.request_fingerprint
    into v_payment_id, v_existing_fingerprint
    from public.order_payments as payment
   where payment.business_id = p_business_id
     and payment.request_id = p_request_id;
  if found then
    if v_existing_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different receipt details.';
    end if;
    return v_payment_id;
  end if;
  if v_order_status <> 'open'::public.order_status then
    raise exception using errcode = '22023', message = 'A cancelled order cannot receive a payment.';
  end if;

  select pg_catalog.count(*) into v_allocations_count
    from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint);
  if v_allocations_count <> pg_catalog.jsonb_array_length(p_allocations)
     or exists (
       select 1
         from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint)
        where allocation.installment_id is null or allocation.amount_cents is null or allocation.amount_cents <= 0
     )
     or v_allocations_count <> (
       select pg_catalog.count(distinct allocation.installment_id)
         from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint)
     ) then
    raise exception using errcode = '22023', message = 'Choose each installment once and allocate a positive amount.';
  end if;
  select pg_catalog.sum(allocation.amount_cents::numeric) into v_allocations_total
    from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint);
  if v_allocations_total <> p_amount_cents::numeric then
    raise exception using errcode = '22023', message = 'Allocations must add up exactly to the received amount.';
  end if;

  -- The order row lock serializes every receipt for this order. Lock the selected
  -- schedule rows in a stable order as a second guard for balance calculations.
  perform installment.id
    from public.order_installments as installment
   where installment.business_id = p_business_id
     and installment.order_id = p_order_id
     and installment.id in (
       select allocation.installment_id
         from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint)
     )
   order by installment.id
   for update;

  for v_allocation in
    select allocation.installment_id, allocation.amount_cents
      from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint)
     order by allocation.installment_id
  loop
    select installment.amount_cents::numeric - coalesce(pg_catalog.sum(prior_allocation.amount_cents::numeric), 0)
      into v_paid_amount
      from public.order_installments as installment
      left join public.order_payment_allocations as prior_allocation
        on prior_allocation.business_id = installment.business_id
       and prior_allocation.order_id = installment.order_id
       and prior_allocation.installment_id = installment.id
     where installment.business_id = p_business_id
       and installment.order_id = p_order_id
       and installment.id = v_allocation.installment_id
     group by installment.amount_cents;
    if v_paid_amount is null then
      raise exception using errcode = '23503', message = 'Every allocation must target an installment in this order.';
    end if;
    if v_allocation.amount_cents::numeric > v_paid_amount then
      raise exception using errcode = '22023', message = 'An allocation cannot exceed the selected installment balance.';
    end if;
  end loop;

  if p_amount_cents::numeric > v_order_total::numeric - (
    select coalesce(pg_catalog.sum(allocation.amount_cents::numeric), 0)
      from public.order_payment_allocations as allocation
     where allocation.business_id = p_business_id and allocation.order_id = p_order_id
  ) then
    raise exception using errcode = '22023', message = 'The receipt exceeds the order balance.';
  end if;

  insert into public.order_payments (
    business_id, order_id, amount_cents, received_at, payment_method, notes,
    request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_order_id, p_amount_cents, coalesce(p_received_at, pg_catalog.now()),
    nullif(pg_catalog.btrim(p_payment_method), ''), nullif(pg_catalog.btrim(p_notes), ''),
    p_request_id, v_fingerprint, (select auth.uid())
  ) on conflict (business_id, request_id) do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    select payment.id, payment.request_fingerprint
      into v_payment_id, v_existing_fingerprint
      from public.order_payments as payment
     where payment.business_id = p_business_id and payment.request_id = p_request_id;
    if v_existing_fingerprint <> v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different receipt details.';
    end if;
    return v_payment_id;
  end if;

  insert into public.order_payment_allocations (business_id, order_id, payment_id, installment_id, amount_cents)
  select p_business_id, p_order_id, v_payment_id, allocation.installment_id, allocation.amount_cents
    from pg_catalog.jsonb_to_recordset(p_allocations) as allocation(installment_id uuid, amount_cents bigint);

  return v_payment_id;
end;
$function$;

create function public.cancel_order(
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

  update public.orders
     set status = 'cancelled'::public.order_status,
         cancelled_at = pg_catalog.now(),
         cancellation_reason = nullif(pg_catalog.btrim(p_reason), '')
   where business_id = p_business_id and id = p_order_id;

  insert into public.order_events (business_id, order_id, event_type, reason, actor_id)
  values (p_business_id, p_order_id, 'cancelled'::public.order_event_type,
          nullif(pg_catalog.btrim(p_reason), ''), (select auth.uid()));

  return p_order_id;
end;
$function$;

revoke all on function public.create_order(uuid, uuid, text, bigint, bigint, text, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.record_order_payment(uuid, uuid, bigint, timestamptz, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.cancel_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_order(uuid, uuid, text, bigint, bigint, text, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.record_order_payment(uuid, uuid, bigint, timestamptz, text, text, jsonb, uuid) to authenticated;
grant execute on function public.cancel_order(uuid, uuid, text) to authenticated;
