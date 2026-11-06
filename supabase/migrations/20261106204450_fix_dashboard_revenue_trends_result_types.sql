-- Daily sales and product-cost series for the management dashboard.
-- Sales are recognized on delivery or customer pickup, independently of bank
-- statements or manually reported payment dates.
create or replace function public.get_dashboard_revenue_trends(
  p_business_id uuid,
  p_start_on date,
  p_end_on date
)
returns table (
  business_date date,
  completed_order_count bigint,
  gross_sales_cents text,
  discount_cents text,
  net_sales_cents text,
  item_cost_cents text,
  gross_profit_cents text,
  missing_cost_line_count bigint,
  returned_order_count bigint
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
     or not pg_catalog.isfinite(p_end_on)
     or p_end_on < p_start_on
     or p_end_on > v_today
     or p_end_on - p_start_on > 29 then
    raise exception using errcode = '22023', message = 'The dashboard period must contain 1 to 30 days and cannot end in the future.';
  end if;

  v_start_at := p_start_on::timestamp without time zone at time zone 'America/Sao_Paulo';
  v_end_at := (p_end_on + 1)::timestamp without time zone at time zone 'America/Sao_Paulo';

  return query
  with calendar as (
    select p_start_on + day_offset.value as day_on
      from pg_catalog.generate_series(0, p_end_on - p_start_on) as day_offset(value)
  ), handoffs as (
    select delivery.order_id, delivery.delivered_at as completed_at
      from public.deliveries as delivery
     where delivery.business_id = p_business_id
       and delivery.status = 'delivered'::public.delivery_status
       and delivery.canceled_at is null
       and delivery.delivered_at >= v_start_at
       and delivery.delivered_at < v_end_at
    union all
    select event.order_id, event.occurred_at as completed_at
      from public.order_events as event
     where event.business_id = p_business_id
       and event.event_type = 'picked_up'::public.order_event_type
       and event.occurred_at >= v_start_at
       and event.occurred_at < v_end_at
  ), one_handoff as (
    select handoff.order_id, min(handoff.completed_at) as completed_at
      from handoffs as handoff
     group by handoff.order_id
  ), completed_orders as (
    select order_row.id,
           (handoff.completed_at at time zone 'America/Sao_Paulo')::date as day_on,
           order_row.subtotal_cents::numeric + order_row.delivery_fee_cents::numeric as gross_sales_cents,
           order_row.discount_cents::numeric as discount_cents,
           order_row.total_cents::numeric as net_sales_cents,
           pg_catalog.round(coalesce(costs.item_cost_cents, 0), 0) as item_cost_cents,
           coalesce(costs.missing_cost_line_count, 0) as missing_cost_line_count,
           coalesce(returns.return_movement_count, 0) as return_movement_count
      from one_handoff as handoff
      join public.orders as order_row
        on order_row.business_id = p_business_id
       and order_row.id = handoff.order_id
       and order_row.status = 'open'::public.order_status
      cross join lateral (
        select pg_catalog.sum(line.unit_cost_snapshot_cents::numeric * line.quantity) as item_cost_cents,
               pg_catalog.count(*) filter (where line.unit_cost_snapshot_cents is null) as missing_cost_line_count
          from public.order_lines as line
         where line.business_id = p_business_id
           and line.order_id = order_row.id
      ) as costs
      cross join lateral (
        select pg_catalog.count(*) as return_movement_count
          from public.inventory_movements as movement
         where movement.business_id = p_business_id
           and movement.order_id = order_row.id
           and movement.movement_type = 'return'::public.inventory_movement_type
           and movement.occurred_at > handoff.completed_at
      ) as returns
  ), daily as (
    select order_row.day_on,
           pg_catalog.count(*) as completed_order_count,
           pg_catalog.sum(order_row.gross_sales_cents) as gross_sales_cents,
           pg_catalog.sum(order_row.discount_cents) as discount_cents,
           pg_catalog.sum(order_row.net_sales_cents) as net_sales_cents,
           pg_catalog.sum(order_row.item_cost_cents) as known_item_cost_cents,
           pg_catalog.sum(order_row.missing_cost_line_count)::bigint as missing_cost_line_count,
           pg_catalog.count(*) filter (where order_row.return_movement_count > 0) as returned_order_count
      from completed_orders as order_row
     group by order_row.day_on
  )
  select calendar.day_on,
         coalesce(daily.completed_order_count, 0::bigint),
         coalesce(daily.gross_sales_cents, 0)::text,
         coalesce(daily.discount_cents, 0)::text,
         coalesce(daily.net_sales_cents, 0)::text,
         case when coalesce(daily.missing_cost_line_count, 0) = 0
                    and coalesce(daily.returned_order_count, 0) = 0
              then coalesce(daily.known_item_cost_cents, 0)::text else null end,
         case when coalesce(daily.missing_cost_line_count, 0) = 0
                    and coalesce(daily.returned_order_count, 0) = 0
              then (coalesce(daily.net_sales_cents, 0) - coalesce(daily.known_item_cost_cents, 0))::text else null end,
         coalesce(daily.missing_cost_line_count, 0::bigint),
         coalesce(daily.returned_order_count, 0::bigint)
    from calendar
    left join daily on daily.day_on = calendar.day_on
   order by calendar.day_on;
end;
$function$;

revoke all on function public.get_dashboard_revenue_trends(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_dashboard_revenue_trends(uuid, date, date) to authenticated;
