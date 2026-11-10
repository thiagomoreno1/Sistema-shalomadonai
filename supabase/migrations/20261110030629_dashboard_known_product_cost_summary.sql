-- Known product costs for completed sales, with missing historic costs and
-- later returns reported separately instead of suppressing known amounts.
create function public.get_dashboard_known_product_cost_summary(
  p_business_id uuid,
  p_start_on date,
  p_end_on date
)
returns table (
  known_item_cost_cents text,
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
    raise exception using errcode = '42501', message = 'Dashboard product cost summary access denied.';
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
  ), completed_order_costs as (
    select order_row.id,
           coalesce(costs.known_item_cost_cents, 0) as known_item_cost_cents,
           coalesce(costs.missing_cost_line_count, 0) as missing_cost_line_count,
           coalesce(returns.return_movement_count, 0) as return_movement_count
      from completed_handoffs as handoff
      join public.orders as order_row
        on order_row.business_id = p_business_id
       and order_row.id = handoff.order_id
       and order_row.status = 'open'::public.order_status
      cross join lateral (
        select coalesce(sum(line.unit_cost_snapshot_cents::numeric * line.quantity)
                 filter (where line.unit_cost_snapshot_cents is not null), 0) as known_item_cost_cents,
               count(*) filter (where line.unit_cost_snapshot_cents is null) as missing_cost_line_count
          from public.order_lines as line
         where line.business_id = p_business_id
           and line.order_id = order_row.id
      ) as costs
      cross join lateral (
        select count(*) as return_movement_count
          from public.inventory_movements as movement
         where movement.business_id = p_business_id
           and movement.order_id = order_row.id
           and movement.movement_type = 'return'::public.inventory_movement_type
           and movement.occurred_at > handoff.completed_at
      ) as returns
  )
  select pg_catalog.round(coalesce(sum(order_cost.known_item_cost_cents), 0), 0)::text,
         coalesce(sum(order_cost.missing_cost_line_count), 0)::bigint,
         count(*) filter (where order_cost.return_movement_count > 0)::bigint
    from completed_order_costs as order_cost;
end;
$function$;

revoke all on function public.get_dashboard_known_product_cost_summary(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.get_dashboard_known_product_cost_summary(uuid, date, date)
  to authenticated;
