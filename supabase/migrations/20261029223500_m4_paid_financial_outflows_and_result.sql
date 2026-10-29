create type public.financial_outflow_type as enum (
  'purchase',
  'operating_expense',
  'delivery_cost'
);

-- One row is one amount that was already paid. Physical stock receipts remain
-- independent and are linked only as references, never as a payment signal.
create table public.financial_outflows (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  outflow_type public.financial_outflow_type not null,
  description text not null check (char_length(btrim(description)) between 1 and 200),
  category text check (category is null or char_length(btrim(category)) <= 120),
  counterparty_name text check (counterparty_name is null or char_length(btrim(counterparty_name)) <= 160),
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  order_id uuid,
  notes text check (notes is null or char_length(btrim(notes)) <= 2000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict,
  check (outflow_type = 'delivery_cost'::public.financial_outflow_type or order_id is null)
);

create index financial_outflows_business_paid_idx
  on public.financial_outflows (business_id, paid_on desc, id desc);
create index financial_outflows_business_type_paid_idx
  on public.financial_outflows (business_id, outflow_type, paid_on desc, id desc);
create index deliveries_completed_result_idx
  on public.deliveries (business_id, delivered_at, order_id)
  where status = 'delivered'::public.delivery_status and canceled_at is null;
create index order_events_pickup_result_idx
  on public.order_events (business_id, occurred_at, order_id)
  where event_type = 'picked_up'::public.order_event_type;
create index inventory_movements_order_returns_idx
  on public.inventory_movements (business_id, order_id)
  where movement_type = 'return'::public.inventory_movement_type and order_id is not null;

create table public.financial_outflow_inventory_receipts (
  business_id uuid not null,
  outflow_id uuid not null,
  inventory_receipt_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, outflow_id, inventory_receipt_id),
  foreign key (business_id, outflow_id)
    references public.financial_outflows (business_id, id) on delete restrict,
  foreign key (business_id, inventory_receipt_id)
    references public.inventory_receipts (business_id, id) on delete restrict
);
create index financial_outflow_inventory_receipts_by_outflow_idx
  on public.financial_outflow_inventory_receipts (outflow_id, inventory_receipt_id);

-- Financial entries stay immutable. If the owner records one incorrectly,
-- this separate audit event removes it from totals without erasing the record.
create table public.financial_outflow_voids (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  outflow_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, outflow_id),
  unique (business_id, request_id),
  foreign key (business_id, outflow_id)
    references public.financial_outflows (business_id, id) on delete restrict
);

alter table public.financial_outflows enable row level security;
alter table public.financial_outflow_inventory_receipts enable row level security;
alter table public.financial_outflow_voids enable row level security;

revoke all on table public.financial_outflows from public, anon, authenticated;
revoke all on table public.financial_outflow_inventory_receipts from public, anon, authenticated;
revoke all on table public.financial_outflow_voids from public, anon, authenticated;
grant select on table public.financial_outflows to authenticated;
grant select on table public.financial_outflow_inventory_receipts to authenticated;
grant select on table public.financial_outflow_voids to authenticated;

create policy financial_outflows_select_for_owners on public.financial_outflows
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy financial_outflow_inventory_receipts_select_for_owners on public.financial_outflow_inventory_receipts
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy financial_outflow_voids_select_for_owners on public.financial_outflow_voids
  for select to authenticated using ((select private.is_business_owner(business_id)));

create trigger financial_outflows_append_only
  before update or delete on public.financial_outflows
  for each row execute function private.reject_immutable_record_change();
create trigger financial_outflows_reject_truncate
  before truncate on public.financial_outflows
  for each statement execute function private.reject_immutable_record_change();
create trigger financial_outflow_inventory_receipts_append_only
  before update or delete on public.financial_outflow_inventory_receipts
  for each row execute function private.reject_immutable_record_change();
create trigger financial_outflow_inventory_receipts_reject_truncate
  before truncate on public.financial_outflow_inventory_receipts
  for each statement execute function private.reject_immutable_record_change();
create trigger financial_outflow_voids_append_only
  before update or delete on public.financial_outflow_voids
  for each row execute function private.reject_immutable_record_change();
create trigger financial_outflow_voids_reject_truncate
  before truncate on public.financial_outflow_voids
  for each statement execute function private.reject_immutable_record_change();

create function public.record_financial_outflow(
  p_business_id uuid,
  p_outflow_type public.financial_outflow_type,
  p_description text,
  p_category text,
  p_counterparty_name text,
  p_amount_cents bigint,
  p_paid_on date,
  p_order_id uuid,
  p_notes text,
  p_inventory_receipt_ids uuid[],
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_receipt_ids uuid[];
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Financial outflow access denied.';
  end if;
  if p_request_id is null
     or p_outflow_type is null
     or p_description is null
     or char_length(btrim(p_description)) not between 1 and 200
     or (p_category is not null and char_length(btrim(p_category)) > 120)
     or (p_counterparty_name is not null and char_length(btrim(p_counterparty_name)) > 160)
     or p_amount_cents is null or p_amount_cents <= 0
     or p_paid_on is null
     or p_paid_on > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
     or (p_notes is not null and char_length(btrim(p_notes)) > 2000)
     or (p_outflow_type <> 'delivery_cost'::public.financial_outflow_type and p_order_id is not null)
     or (p_outflow_type <> 'purchase'::public.financial_outflow_type
       and coalesce(pg_catalog.cardinality(p_inventory_receipt_ids), 0) > 0) then
    raise exception using errcode = '22023', message = 'Financial outflow details are invalid.';
  end if;

  select coalesce(pg_catalog.array_agg(receipt_id order by receipt_id), '{}'::uuid[])
    into v_receipt_ids
    from (
      select distinct requested.receipt_id
        from pg_catalog.unnest(coalesce(p_inventory_receipt_ids, '{}'::uuid[])) as requested(receipt_id)
       where requested.receipt_id is not null
    ) as requested_receipts;

  if exists (
    select 1
      from pg_catalog.unnest(v_receipt_ids) as requested(receipt_id)
      left join public.inventory_receipts as receipt
        on receipt.business_id = p_business_id and receipt.id = requested.receipt_id
     where receipt.id is null
  ) then
    raise exception using errcode = '22023', message = 'A linked inventory receipt does not exist in this business.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_financial_outflow',
    'business_id', p_business_id,
    'outflow_type', p_outflow_type,
    'description', btrim(p_description),
    'category', nullif(btrim(p_category), ''),
    'counterparty_name', nullif(btrim(p_counterparty_name), ''),
    'amount_cents', p_amount_cents,
    'paid_on', p_paid_on,
    'order_id', p_order_id,
    'notes', nullif(btrim(p_notes), ''),
    'inventory_receipt_ids', v_receipt_ids
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select outflow.id, outflow.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.financial_outflows as outflow
   where outflow.business_id = p_business_id and outflow.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different financial details.';
    end if;
    return v_id;
  end if;

  insert into public.financial_outflows (
    business_id, outflow_type, description, category, counterparty_name,
    amount_cents, paid_on, order_id, notes, request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_outflow_type, btrim(p_description), nullif(btrim(p_category), ''),
    nullif(btrim(p_counterparty_name), ''), p_amount_cents, p_paid_on, p_order_id,
    nullif(btrim(p_notes), ''), p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_id;

  insert into public.financial_outflow_inventory_receipts (
    business_id, outflow_id, inventory_receipt_id
  )
  select p_business_id, v_id, requested.receipt_id
    from pg_catalog.unnest(v_receipt_ids) as requested(receipt_id);

  return v_id;
end;
$function$;

revoke all on function public.record_financial_outflow(
  uuid, public.financial_outflow_type, text, text, text, bigint, date, uuid, text, uuid[], uuid
) from public, anon, authenticated;
grant execute on function public.record_financial_outflow(
  uuid, public.financial_outflow_type, text, text, text, bigint, date, uuid, text, uuid[], uuid
) to authenticated;

create function public.void_financial_outflow(
  p_business_id uuid,
  p_outflow_id uuid,
  p_reason text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Financial outflow correction access denied.';
  end if;
  if p_outflow_id is null or p_request_id is null
     or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'A correction reason is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'void_financial_outflow',
    'business_id', p_business_id,
    'outflow_id', p_outflow_id,
    'reason', btrim(p_reason)
  )::text);

  select void_event.id, void_event.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.financial_outflow_voids as void_event
   where void_event.business_id = p_business_id
     and void_event.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different correction details.';
    end if;
    return v_id;
  end if;

  perform 1 from public.financial_outflows as outflow
   where outflow.business_id = p_business_id and outflow.id = p_outflow_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected financial outflow does not exist in this business.';
  end if;
  if exists (
    select 1 from public.financial_outflow_voids as void_event
     where void_event.business_id = p_business_id and void_event.outflow_id = p_outflow_id
  ) then
    raise exception using errcode = '22023', message = 'This financial outflow was already voided.';
  end if;

  insert into public.financial_outflow_voids (
    business_id, outflow_id, reason, request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_outflow_id, btrim(p_reason), p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function public.void_financial_outflow(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.void_financial_outflow(uuid, uuid, text, uuid) to authenticated;

-- Keep the original receipts/receivables/sales summary, adding paid outflows,
-- known net cash movement, and the owner-approved result formula.
create or replace function public.get_financial_report_summary(
  p_business_id uuid,
  p_start_on date,
  p_end_on date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_as_of date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_summary jsonb;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Financial report access denied.';
  end if;

  if p_start_on is null or p_end_on is null or p_end_on < p_start_on then
    raise exception using errcode = '22023', message = 'A valid financial report period is required.';
  end if;

  v_start_at := p_start_on::timestamp without time zone at time zone 'America/Sao_Paulo';
  v_end_at := (p_end_on + 1)::timestamp without time zone at time zone 'America/Sao_Paulo';

  select pg_catalog.jsonb_build_object(
    'start_on', p_start_on,
    'end_on', p_end_on,
    'as_of_on', v_as_of,
    'sales', (
      select pg_catalog.jsonb_build_object(
        'record_count', count(*),
        'active_order_count', count(*) filter (where order_row.status = 'open'::public.order_status),
        'active_subtotal_cents', coalesce(sum(order_row.subtotal_cents) filter (where order_row.status = 'open'::public.order_status), 0)::text,
        'active_delivery_fee_cents', coalesce(sum(order_row.delivery_fee_cents) filter (where order_row.status = 'open'::public.order_status), 0)::text,
        'active_discount_cents', coalesce(sum(order_row.discount_cents) filter (where order_row.status = 'open'::public.order_status), 0)::text,
        'active_total_cents', coalesce(sum(order_row.total_cents) filter (where order_row.status = 'open'::public.order_status), 0)::text,
        'cancelled_order_count', count(*) filter (where order_row.status = 'cancelled'::public.order_status),
        'cancelled_total_cents', coalesce(sum(order_row.total_cents) filter (where order_row.status = 'cancelled'::public.order_status), 0)::text
      )
      from public.orders as order_row
      where order_row.business_id = p_business_id
        and order_row.created_at >= v_start_at
        and order_row.created_at < v_end_at
    ),
    'receipts', (
      select pg_catalog.jsonb_build_object(
        'record_count', count(*),
        'amount_cents', coalesce(sum(payment.amount_cents), 0)::text
      )
      from public.order_payments as payment
      where payment.business_id = p_business_id
        and payment.received_at >= v_start_at
        and payment.received_at < v_end_at
    ),
    'receivables', (
      select pg_catalog.jsonb_build_object(
        'installment_count', count(*),
        'open_balance_cents', coalesce(sum(balance.balance_cents), 0)::text,
        'overdue_balance_cents', coalesce(sum(balance.balance_cents) filter (where installment.due_on < v_as_of), 0)::text
      )
      from public.order_installments as installment
      join public.orders as order_row
        on order_row.business_id = installment.business_id
       and order_row.id = installment.order_id
      cross join lateral (
        select greatest(
          installment.amount_cents::numeric - coalesce(sum(allocation.amount_cents), 0),
          0
        ) as balance_cents
        from public.order_payment_allocations as allocation
        where allocation.business_id = installment.business_id
          and allocation.order_id = installment.order_id
          and allocation.installment_id = installment.id
      ) as balance
      where installment.business_id = p_business_id
        and order_row.status = 'open'::public.order_status
        and installment.due_on between p_start_on and p_end_on
        and balance.balance_cents > 0
    ),
    'outflows', (
      select pg_catalog.jsonb_build_object(
        'record_count', count(*),
        'purchase_count', count(*) filter (where outflow.outflow_type = 'purchase'::public.financial_outflow_type),
        'purchase_cents', coalesce(sum(outflow.amount_cents) filter (where outflow.outflow_type = 'purchase'::public.financial_outflow_type), 0)::text,
        'operating_expense_count', count(*) filter (where outflow.outflow_type = 'operating_expense'::public.financial_outflow_type),
        'operating_expense_cents', coalesce(sum(outflow.amount_cents) filter (where outflow.outflow_type = 'operating_expense'::public.financial_outflow_type), 0)::text,
        'delivery_cost_count', count(*) filter (where outflow.outflow_type = 'delivery_cost'::public.financial_outflow_type),
        'delivery_cost_cents', coalesce(sum(outflow.amount_cents) filter (where outflow.outflow_type = 'delivery_cost'::public.financial_outflow_type), 0)::text,
        'total_cents', coalesce(sum(outflow.amount_cents), 0)::text
      )
      from public.financial_outflows as outflow
      where outflow.business_id = p_business_id
        and outflow.paid_on between p_start_on and p_end_on
        and not exists (
          select 1 from public.financial_outflow_voids as void_event
           where void_event.business_id = outflow.business_id and void_event.outflow_id = outflow.id
        )
    ),
    'cash_movement', (
      select pg_catalog.jsonb_build_object(
        'reported_receipts_cents', coalesce((
          select sum(payment.amount_cents)
            from public.order_payments as payment
           where payment.business_id = p_business_id
             and payment.received_at >= v_start_at and payment.received_at < v_end_at
        ), 0)::text,
        'paid_outflows_cents', coalesce((
          select sum(outflow.amount_cents)
            from public.financial_outflows as outflow
           where outflow.business_id = p_business_id
             and outflow.paid_on between p_start_on and p_end_on
             and not exists (
               select 1 from public.financial_outflow_voids as void_event
                where void_event.business_id = outflow.business_id and void_event.outflow_id = outflow.id
             )
        ), 0)::text,
        'net_recorded_cents', (
          coalesce((
            select sum(payment.amount_cents)
              from public.order_payments as payment
             where payment.business_id = p_business_id
               and payment.received_at >= v_start_at and payment.received_at < v_end_at
          ), 0) - coalesce((
            select sum(outflow.amount_cents)
              from public.financial_outflows as outflow
             where outflow.business_id = p_business_id
               and outflow.paid_on between p_start_on and p_end_on
               and not exists (
                 select 1 from public.financial_outflow_voids as void_event
                  where void_event.business_id = outflow.business_id and void_event.outflow_id = outflow.id
               )
          ), 0)
        )::text
      )
    ),
    'managerial_result', (
      with completed_handoffs as (
        select delivery.order_id, delivery.delivered_at as completed_at
          from public.deliveries as delivery
         where delivery.business_id = p_business_id
           and delivery.status = 'delivered'::public.delivery_status
           and delivery.canceled_at is null
           and delivery.delivered_at >= v_start_at
           and delivery.delivered_at < v_end_at
        union
        select event.order_id, event.occurred_at as completed_at
          from public.order_events as event
         where event.business_id = p_business_id
           and event.event_type = 'picked_up'::public.order_event_type
           and event.occurred_at >= v_start_at
           and event.occurred_at < v_end_at
      ),
      completed_order_costs as (
        select order_row.id,
               order_row.total_cents::numeric as sales_cents,
               order_row.subtotal_cents::numeric as product_subtotal_cents,
               order_row.delivery_fee_cents::numeric as customer_delivery_fee_cents,
               order_row.discount_cents::numeric as discount_cents,
               coalesce(pg_catalog.round(costs.item_cost_cents, 0), 0) as item_cost_cents,
               coalesce(costs.missing_cost_line_count, 0) as missing_cost_line_count,
               coalesce(returns.return_movement_count, 0) as return_movement_count
          from completed_handoffs as handoff
          join public.orders as order_row
            on order_row.business_id = p_business_id
           and order_row.id = handoff.order_id
           and order_row.status = 'open'::public.order_status
          cross join lateral (
            select sum(line.unit_cost_snapshot_cents::numeric * line.quantity) as item_cost_cents,
                   count(*) filter (where line.unit_cost_snapshot_cents is null) as missing_cost_line_count
              from public.order_lines as line
             where line.business_id = p_business_id and line.order_id = order_row.id
          ) as costs
          cross join lateral (
            select count(*) as return_movement_count
              from public.inventory_movements as movement
             where movement.business_id = p_business_id
               and movement.order_id = order_row.id
               and movement.movement_type = 'return'::public.inventory_movement_type
               and movement.occurred_at > handoff.completed_at
          ) as returns
      ),
      result_totals as (
        select count(*) as order_count,
               coalesce(sum(sales_cents), 0) as sales_cents,
               coalesce(sum(product_subtotal_cents), 0) as product_subtotal_cents,
               coalesce(sum(customer_delivery_fee_cents), 0) as customer_delivery_fee_cents,
               coalesce(sum(discount_cents), 0) as discount_cents,
               coalesce(sum(item_cost_cents), 0) as item_cost_cents,
               coalesce(sum(missing_cost_line_count), 0) as missing_cost_line_count,
               count(*) filter (where return_movement_count > 0) as returned_order_count
          from completed_order_costs
      ),
      result_expenses as (
        select coalesce(sum(outflow.amount_cents) filter (
                 where outflow.outflow_type = 'operating_expense'::public.financial_outflow_type
               ), 0) as operating_expense_cents,
               coalesce(sum(outflow.amount_cents) filter (
                 where outflow.outflow_type = 'delivery_cost'::public.financial_outflow_type
               ), 0) as delivery_cost_cents
          from public.financial_outflows as outflow
         where outflow.business_id = p_business_id
           and outflow.paid_on between p_start_on and p_end_on
           and not exists (
             select 1 from public.financial_outflow_voids as void_event
              where void_event.business_id = outflow.business_id and void_event.outflow_id = outflow.id
           )
      )
      select pg_catalog.jsonb_build_object(
        'completed_order_count', result_totals.order_count,
        'sales_cents', result_totals.sales_cents::text,
        'product_subtotal_cents', result_totals.product_subtotal_cents::text,
        'customer_delivery_fee_cents', result_totals.customer_delivery_fee_cents::text,
        'discount_cents', result_totals.discount_cents::text,
        'item_cost_cents', case when result_totals.missing_cost_line_count = 0 and result_totals.returned_order_count = 0 then result_totals.item_cost_cents::text else null end,
        'missing_cost_line_count', result_totals.missing_cost_line_count,
        'returned_order_count', result_totals.returned_order_count,
        'operating_expense_cents', result_expenses.operating_expense_cents::text,
        'delivery_cost_cents', result_expenses.delivery_cost_cents::text,
        'available', result_totals.missing_cost_line_count = 0 and result_totals.returned_order_count = 0,
        'result_cents', case when result_totals.missing_cost_line_count = 0 and result_totals.returned_order_count = 0 then
          (result_totals.sales_cents - result_totals.item_cost_cents
            - result_expenses.operating_expense_cents - result_expenses.delivery_cost_cents)::text
          else null end,
        'sales_date_basis', 'Data de entrega concluída ou retirada pelo cliente',
        'cost_date_basis', 'Data da entrega concluída ou retirada pelo cliente',
        'expense_date_basis', 'Data do pagamento informado',
        'inventory_purchase_treatment', 'Compra paga aparece no caixa; o resultado reconhece o custo congelado nos itens vendidos.'
      )
        from result_totals cross join result_expenses
    )
  ) into v_summary;

  return v_summary;
end;
$function$;

revoke all on function public.get_financial_report_summary(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_financial_report_summary(uuid, date, date) to authenticated;
