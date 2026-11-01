-- One bounded daily series for the operational dashboard. Orders measure
-- registered demand by creation date, including orders cancelled later;
-- monetary movement uses reported receipts and non-voided paid outflows.
create function public.get_dashboard_daily_trends(
  p_business_id uuid,
  p_start_on date,
  p_end_on date
)
returns table (
  business_date date,
  order_count bigint,
  receipts_cents bigint,
  paid_outflows_cents bigint
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
    raise exception using errcode = '42501', message = 'Dashboard access denied.';
  end if;

  if p_start_on is null or p_end_on is null
     or not pg_catalog.isfinite(p_start_on)
     or not pg_catalog.isfinite(p_end_on) then
    raise exception using errcode = '22023', message = 'A finite dashboard period is required.';
  end if;
  if p_end_on < p_start_on or p_end_on > v_today
     or p_end_on - p_start_on > 29 then
    raise exception using errcode = '22023', message = 'The dashboard period must contain 1 to 30 days and cannot end in the future.';
  end if;

  v_start_at := p_start_on::timestamp without time zone at time zone 'America/Sao_Paulo';
  v_end_at := (p_end_on + 1)::timestamp without time zone at time zone 'America/Sao_Paulo';

  return query
  with calendar as (
    select p_start_on + day_offset.value as day_on
      from pg_catalog.generate_series(0, p_end_on - p_start_on) as day_offset(value)
  ), orders_daily as (
    select (order_row.created_at at time zone 'America/Sao_Paulo')::date as day_on,
           pg_catalog.count(*) as registered_count
      from public.orders as order_row
     where order_row.business_id = p_business_id
       and order_row.created_at >= v_start_at
       and order_row.created_at < v_end_at
     group by (order_row.created_at at time zone 'America/Sao_Paulo')::date
  ), receipts_daily as (
    select (payment.received_at at time zone 'America/Sao_Paulo')::date as day_on,
           pg_catalog.sum(payment.amount_cents)::bigint as amount_cents
      from public.order_payments as payment
     where payment.business_id = p_business_id
       and payment.received_at >= v_start_at
       and payment.received_at < v_end_at
     group by (payment.received_at at time zone 'America/Sao_Paulo')::date
  ), outflows_daily as (
    select outflow.paid_on as day_on,
           pg_catalog.sum(outflow.amount_cents)::bigint as amount_cents
      from public.financial_outflows as outflow
     where outflow.business_id = p_business_id
       and outflow.paid_on between p_start_on and p_end_on
       and not exists (
         select 1
           from public.financial_outflow_voids as void_event
          where void_event.business_id = outflow.business_id
            and void_event.outflow_id = outflow.id
       )
     group by outflow.paid_on
  )
  select calendar.day_on,
         coalesce(orders_daily.registered_count, 0::bigint),
         coalesce(receipts_daily.amount_cents, 0::bigint),
         coalesce(outflows_daily.amount_cents, 0::bigint)
    from calendar
    left join orders_daily on orders_daily.day_on = calendar.day_on
    left join receipts_daily on receipts_daily.day_on = calendar.day_on
    left join outflows_daily on outflows_daily.day_on = calendar.day_on
   order by calendar.day_on;
end;
$function$;

revoke all on function public.get_dashboard_daily_trends(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_dashboard_daily_trends(uuid, date, date) to authenticated;
