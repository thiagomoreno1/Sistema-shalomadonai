-- Keep inventory valuation separate from historical cash payments.
-- Physical corrections change the value currently held; actual losses are
-- reported separately from expenses that have been paid.

alter table public.inventory_movements
  add column inventory_value_delta_cents numeric(32,3);

comment on column public.inventory_movements.inventory_value_delta_cents is
  'Signed inventory value change at the movement unit cost snapshot. Null for legacy rows or when cost was unknown; this is not a cash payment.';

create function private.snapshot_inventory_movement_value()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_unit_cost_cents bigint;
begin
  if new.movement_type = 'receipt'::public.inventory_movement_type then
    select receipt_line.unit_cost_cents
      into v_unit_cost_cents
      from public.inventory_receipt_lines as receipt_line
     where receipt_line.business_id = new.business_id
       and receipt_line.receipt_id = new.receipt_id
       and receipt_line.id = new.receipt_line_id
       and receipt_line.product_id = new.product_id;
  else
    select product.cost_cents
      into v_unit_cost_cents
      from public.products as product
     where product.business_id = new.business_id
       and product.id = new.product_id;
  end if;

  if v_unit_cost_cents is null then
    new.inventory_value_delta_cents := null;
  else
    new.inventory_value_delta_cents := pg_catalog.round(
      new.quantity_delta * v_unit_cost_cents::numeric,
      3
    );
  end if;

  return new;
end;
$function$;

revoke all on function private.snapshot_inventory_movement_value() from public, anon, authenticated;

create trigger inventory_movements_snapshot_value
  before insert on public.inventory_movements
  for each row execute function private.snapshot_inventory_movement_value();

create index inventory_movements_loss_finance_period_idx
  on public.inventory_movements (business_id, occurred_at)
  where movement_type = 'loss'::public.inventory_movement_type;

-- Owner-managed monthly reminders. Completing one never records stock or
-- marks an expense paid; it only advances after a real receipt/outflow exists.
create type public.recurring_operation_kind as enum (
  'inventory_purchase',
  'operating_expense'
);

create table public.recurring_operation_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  kind public.recurring_operation_kind not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(btrim(description)) <= 200),
  category text check (category is null or char_length(btrim(category)) <= 120),
  counterparty_name text check (counterparty_name is null or char_length(btrim(counterparty_name)) <= 160),
  product_id uuid,
  quantity numeric(12,3),
  expected_unit_cost_cents bigint check (expected_unit_cost_cents is null or expected_unit_cost_cents >= 0),
  amount_cents bigint check (amount_cents is null or amount_cents > 0),
  day_of_month smallint not null check (day_of_month between 1 and 31),
  starts_on date not null,
  next_due_on date not null,
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict,
  check (starts_on <= next_due_on),
  check (
    (kind = 'inventory_purchase'::public.recurring_operation_kind
      and product_id is not null
      and quantity is not null and quantity > 0
      and description is null
      and amount_cents is null)
    or
    (kind = 'operating_expense'::public.recurring_operation_kind
      and product_id is null
      and quantity is null
      and expected_unit_cost_cents is null
      and description is not null and char_length(btrim(description)) between 1 and 200
      and amount_cents is not null and amount_cents > 0)
  )
);

create index recurring_operation_templates_due_idx
  on public.recurring_operation_templates (business_id, is_active, next_due_on, kind);

create function private.validate_recurring_purchase_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inventory_tracked boolean;
  v_is_combo boolean;
begin
  if new.kind = 'inventory_purchase'::public.recurring_operation_kind then
    select product.inventory_tracked, product.is_combo
      into v_inventory_tracked, v_is_combo
      from public.products as product
     where product.business_id = new.business_id
       and product.id = new.product_id
     for update;
    if not found or not v_inventory_tracked or v_is_combo then
      raise exception using errcode = '22023', message = 'A purchase reminder requires a stock-tracked, non-combo product in this business.';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.validate_recurring_purchase_product() from public, anon, authenticated;

create trigger recurring_operation_templates_validate_purchase_product
  before insert or update on public.recurring_operation_templates
  for each row execute function private.validate_recurring_purchase_product();

create function private.touch_recurring_operation_template()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

revoke all on function private.touch_recurring_operation_template() from public, anon, authenticated;

create trigger recurring_operation_templates_touch_updated_at
  before update on public.recurring_operation_templates
  for each row execute function private.touch_recurring_operation_template();

alter table public.recurring_operation_templates enable row level security;
revoke all on table public.recurring_operation_templates from public, anon, authenticated;
grant select on table public.recurring_operation_templates to authenticated;
grant insert (
  business_id, kind, name, description, category, counterparty_name,
  product_id, quantity, expected_unit_cost_cents, amount_cents,
  day_of_month, starts_on, next_due_on, is_active
) on table public.recurring_operation_templates to authenticated;
grant update (
  kind, name, description, category, counterparty_name,
  product_id, quantity, expected_unit_cost_cents, amount_cents,
  day_of_month, starts_on, next_due_on, is_active
) on table public.recurring_operation_templates to authenticated;

create policy recurring_operation_templates_select_for_owners
  on public.recurring_operation_templates
  for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy recurring_operation_templates_insert_for_owners
  on public.recurring_operation_templates
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
create policy recurring_operation_templates_update_for_owners
  on public.recurring_operation_templates
  for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check ((select private.is_business_owner(business_id)));

create table public.recurring_operation_completions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  template_id uuid not null,
  due_on date not null,
  inventory_receipt_id uuid,
  financial_outflow_id uuid,
  completed_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  completed_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, template_id, due_on),
  foreign key (business_id, template_id)
    references public.recurring_operation_templates (business_id, id) on delete restrict,
  foreign key (business_id, inventory_receipt_id)
    references public.inventory_receipts (business_id, id) on delete restrict,
  foreign key (business_id, financial_outflow_id)
    references public.financial_outflows (business_id, id) on delete restrict,
  check (
    (inventory_receipt_id is not null and financial_outflow_id is null)
    or (inventory_receipt_id is null and financial_outflow_id is not null)
  )
);

create index recurring_operation_completions_template_idx
  on public.recurring_operation_completions (business_id, template_id, due_on desc);

alter table public.recurring_operation_completions enable row level security;
revoke all on table public.recurring_operation_completions from public, anon, authenticated;
grant select on table public.recurring_operation_completions to authenticated;
create policy recurring_operation_completions_select_for_owners
  on public.recurring_operation_completions
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create trigger recurring_operation_completions_append_only
  before update or delete on public.recurring_operation_completions
  for each row execute function private.reject_immutable_record_change();
create trigger recurring_operation_completions_reject_truncate
  before truncate on public.recurring_operation_completions
  for each statement execute function private.reject_immutable_record_change();

create function public.complete_recurring_operation_template(
  p_business_id uuid,
  p_template_id uuid,
  p_due_on date,
  p_inventory_receipt_id uuid,
  p_financial_outflow_id uuid
)
returns date
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_template public.recurring_operation_templates%rowtype;
  v_existing public.recurring_operation_completions%rowtype;
  v_next_month date;
  v_next_due_on date;
  v_received_quantity numeric;
begin
  if (select auth.uid()) is null
     or p_business_id is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Recurring schedule access denied.';
  end if;
  if p_template_id is null or p_due_on is null
     or ((p_inventory_receipt_id is null) = (p_financial_outflow_id is null)) then
    raise exception using errcode = '22023', message = 'A due date and exactly one confirmed operation are required.';
  end if;

  select template.*
    into v_template
    from public.recurring_operation_templates as template
   where template.business_id = p_business_id
     and template.id = p_template_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The recurring schedule does not exist in this business.';
  end if;

  select completion.*
    into v_existing
    from public.recurring_operation_completions as completion
   where completion.business_id = p_business_id
     and completion.template_id = p_template_id
     and completion.due_on = p_due_on;
  if found then
    if v_existing.inventory_receipt_id is distinct from p_inventory_receipt_id
       or v_existing.financial_outflow_id is distinct from p_financial_outflow_id then
      raise exception using errcode = '23505', message = 'This recurring cycle was already linked to another confirmed operation.';
    end if;
    return v_template.next_due_on;
  end if;

  if v_template.next_due_on <> p_due_on then
    raise exception using errcode = '22023', message = 'The recurring schedule changed. Refresh it before completing this cycle.';
  end if;

  if v_template.kind = 'inventory_purchase'::public.recurring_operation_kind then
    if p_inventory_receipt_id is null then
      raise exception using errcode = '22023', message = 'A purchase reminder must link to a confirmed stock receipt.';
    end if;
    select coalesce(pg_catalog.sum(line.quantity), 0)
      into v_received_quantity
      from public.inventory_receipt_lines as line
     where line.business_id = p_business_id
       and line.receipt_id = p_inventory_receipt_id
       and line.product_id = v_template.product_id;
    if v_received_quantity <= 0 then
      raise exception using errcode = '22023', message = 'The receipt must include the scheduled product.';
    end if;
  else
    if p_financial_outflow_id is null
       or not exists (
         select 1
           from public.financial_outflows as outflow
          where outflow.business_id = p_business_id
            and outflow.id = p_financial_outflow_id
            and outflow.outflow_type = 'operating_expense'::public.financial_outflow_type
            and not exists (
              select 1
                from public.financial_outflow_voids as void_event
               where void_event.business_id = outflow.business_id
                 and void_event.outflow_id = outflow.id
            )
       ) then
      raise exception using errcode = '22023', message = 'An expense reminder must link to an active, confirmed operating expense.';
    end if;
  end if;

  insert into public.recurring_operation_completions (
    business_id, template_id, due_on, inventory_receipt_id,
    financial_outflow_id, completed_by
  ) values (
    p_business_id, p_template_id, p_due_on, p_inventory_receipt_id,
    p_financial_outflow_id, (select auth.uid())
  );

  v_next_month := (pg_catalog.date_trunc('month', p_due_on::timestamp) + interval '1 month')::date;
  v_next_due_on := v_next_month + (
    least(
      v_template.day_of_month::integer,
      extract(day from (v_next_month + interval '1 month - 1 day'))::integer
    ) - 1
  );

  update public.recurring_operation_templates
     set next_due_on = v_next_due_on
   where business_id = p_business_id and id = p_template_id;

  return v_next_due_on;
end;
$function$;

revoke all on function public.complete_recurring_operation_template(uuid, uuid, date, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_recurring_operation_template(uuid, uuid, date, uuid, uuid)
  to authenticated;

create function public.get_inventory_finance_summary(
  p_business_id uuid,
  p_start_on date,
  p_end_on date
)
returns table (
  inventory_value_cents text,
  inventory_value_missing_cost_products bigint,
  inventory_loss_cents text,
  inventory_loss_movement_count bigint,
  inventory_loss_missing_cost_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_start_at timestamptz;
  v_end_at timestamptz;
begin
  if (select auth.uid()) is null
     or p_business_id is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory finance access denied.';
  end if;
  if p_start_on is null or p_end_on is null
     or not pg_catalog.isfinite(p_start_on)
     or not pg_catalog.isfinite(p_end_on)
     or p_end_on < p_start_on
     or p_end_on > v_today then
    raise exception using errcode = '22023', message = 'The period must be valid and cannot end in the future.';
  end if;

  v_start_at := p_start_on::timestamp without time zone at time zone 'America/Sao_Paulo';
  v_end_at := (p_end_on + 1)::timestamp without time zone at time zone 'America/Sao_Paulo';

  return query
  with stock as (
    select coalesce(
             pg_catalog.sum(greatest(coalesce(balance.quantity_on_hand, 0), 0)
               * product.cost_cents::numeric) filter (where product.cost_cents is not null),
             0
           ) as known_value_cents,
           pg_catalog.count(*) filter (
             where greatest(coalesce(balance.quantity_on_hand, 0), 0) > 0
               and product.cost_cents is null
           ) as missing_cost_products
      from public.products as product
      left join (
        select movement.business_id, movement.product_id,
               pg_catalog.sum(movement.quantity_delta) as quantity_on_hand
          from public.inventory_movements as movement
         where movement.business_id = p_business_id
         group by movement.business_id, movement.product_id
      ) as balance
        on balance.business_id = product.business_id
       and balance.product_id = product.id
     where product.business_id = p_business_id
       and product.inventory_tracked
  ), losses as (
    select coalesce(pg_catalog.sum(-movement.inventory_value_delta_cents), 0) as known_loss_cents,
           pg_catalog.count(*) as loss_movement_count,
           pg_catalog.count(*) filter (where movement.inventory_value_delta_cents is null)
             as missing_cost_count
      from public.inventory_movements as movement
     where movement.business_id = p_business_id
       and movement.movement_type = 'loss'::public.inventory_movement_type
       and movement.occurred_at >= v_start_at
       and movement.occurred_at < v_end_at
  )
  select case when stock.missing_cost_products = 0
              then pg_catalog.round(stock.known_value_cents, 0)::text
              else null end,
         stock.missing_cost_products,
         case when losses.missing_cost_count = 0
              then pg_catalog.round(losses.known_loss_cents, 0)::text
              else null end,
         losses.loss_movement_count,
         losses.missing_cost_count
    from stock cross join losses;
end;
$function$;

revoke all on function public.get_inventory_finance_summary(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.get_inventory_finance_summary(uuid, date, date)
  to authenticated;
