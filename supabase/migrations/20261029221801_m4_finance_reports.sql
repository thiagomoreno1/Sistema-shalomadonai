-- Period summaries are computed from their source records in Postgres so the
-- app cannot silently truncate totals at the REST row limit.
create index order_payments_business_received_idx
  on public.order_payments (business_id, received_at desc, id desc);

create function public.get_financial_report_summary(
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
    )
  ) into v_summary;

  return v_summary;
end;
$function$;

revoke all on function public.get_financial_report_summary(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_financial_report_summary(uuid, date, date) to authenticated;
