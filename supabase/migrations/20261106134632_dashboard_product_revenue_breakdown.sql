-- Product-level financial detail for completed sales. Discounts are allocated
-- proportionally across item lines and the customer delivery fee, with any
-- leftover cents assigned by largest remainder so each order reconciles exactly.
create or replace function public.get_dashboard_product_revenue(
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

  return (
    with handoffs as (
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
      select handoff.order_id, pg_catalog.min(handoff.completed_at) as completed_at
        from handoffs as handoff
       group by handoff.order_id
    ), completed_orders as (
      select order_row.id as order_id,
             handoff.completed_at,
             order_row.subtotal_cents::numeric as subtotal_cents,
             order_row.delivery_fee_cents::numeric as delivery_fee_cents,
             order_row.discount_cents::numeric as discount_cents,
             order_row.total_cents::numeric as total_cents
        from one_handoff as handoff
        join public.orders as order_row
          on order_row.business_id = p_business_id
         and order_row.id = handoff.order_id
         and order_row.status = 'open'::public.order_status
    ), order_returns as (
      select completed.order_id,
             pg_catalog.count(movement.id) as return_movement_count
        from completed_orders as completed
        left join public.inventory_movements as movement
          on movement.business_id = p_business_id
         and movement.order_id = completed.order_id
         and movement.movement_type = 'return'::public.inventory_movement_type
         and movement.occurred_at > completed.completed_at
       group by completed.order_id
    ), discount_components as (
      select completed.order_id,
             'product'::text as component_type,
             line.id as order_line_id,
             line.product_id,
             line.product_name_snapshot as product_name,
             line.inventory_unit_snapshot as inventory_unit,
             line.line_number,
             line.quantity,
             line.line_total_cents::numeric as gross_cents,
             completed.discount_cents,
             completed.subtotal_cents + completed.delivery_fee_cents as order_gross_cents
        from completed_orders as completed
        join public.order_lines as line
          on line.business_id = p_business_id
         and line.order_id = completed.order_id
      union all
      select completed.order_id,
             'delivery'::text,
             null::uuid,
             null::uuid,
             'Taxa de entrega'::text,
             null::text,
             null::integer,
             null::numeric,
             completed.delivery_fee_cents,
             completed.discount_cents,
             completed.subtotal_cents + completed.delivery_fee_cents
        from completed_orders as completed
    ), discount_floors as (
      select component.*,
             case when component.order_gross_cents = 0 then 0::numeric
                  else pg_catalog.floor(component.discount_cents * component.gross_cents / component.order_gross_cents)
              end as discount_floor_cents,
             case when component.order_gross_cents = 0 then 0::numeric
                  else pg_catalog.mod(component.discount_cents * component.gross_cents, component.order_gross_cents)
              end as discount_remainder
        from discount_components as component
    ), discount_ranked as (
      select floor_row.*,
             pg_catalog.row_number() over (
               partition by floor_row.order_id
               order by floor_row.discount_remainder desc,
                        floor_row.component_type,
                        floor_row.line_number nulls last
             ) as remainder_rank,
             pg_catalog.sum(floor_row.discount_floor_cents) over (partition by floor_row.order_id) as allocated_floor_cents
        from discount_floors as floor_row
    ), discount_allocations as (
      select ranked.*,
             ranked.discount_floor_cents
             + case when ranked.remainder_rank <= ranked.discount_cents - ranked.allocated_floor_cents then 1 else 0 end
               as allocated_discount_cents
        from discount_ranked as ranked
    ), cost_ranked as (
      select line.order_id,
             line.id as order_line_id,
             line.product_id,
             line.unit_cost_snapshot_cents::numeric * line.quantity as raw_cost_cents,
             pg_catalog.floor(line.unit_cost_snapshot_cents::numeric * line.quantity) as cost_floor_cents,
             pg_catalog.row_number() over (
               partition by line.order_id
               order by (line.unit_cost_snapshot_cents::numeric * line.quantity)
                        - pg_catalog.floor(line.unit_cost_snapshot_cents::numeric * line.quantity) desc nulls last,
                        line.line_number
             ) as cost_remainder_rank,
             pg_catalog.round(pg_catalog.sum(line.unit_cost_snapshot_cents::numeric * line.quantity)
               over (partition by line.order_id), 0) as rounded_order_cost_cents,
             pg_catalog.sum(pg_catalog.floor(line.unit_cost_snapshot_cents::numeric * line.quantity))
               over (partition by line.order_id) as order_cost_floor_cents,
             pg_catalog.count(*) filter (where line.unit_cost_snapshot_cents is null)
               over (partition by line.order_id) as missing_cost_line_count
        from public.order_lines as line
        join completed_orders as completed
          on completed.order_id = line.order_id
         and line.business_id = p_business_id
    ), cost_allocations as (
      select ranked.order_id,
             ranked.order_line_id,
             ranked.product_id,
             case when ranked.raw_cost_cents is null then null
                  when ranked.missing_cost_line_count = 0 then
                    ranked.cost_floor_cents
                    + case when ranked.cost_remainder_rank <= ranked.rounded_order_cost_cents - ranked.order_cost_floor_cents
                           then 1 else 0 end
                  else pg_catalog.round(ranked.raw_cost_cents, 0)
              end as allocated_cost_cents,
             ranked.missing_cost_line_count
        from cost_ranked as ranked
    ), product_lines as (
      select allocation.order_id,
             allocation.order_line_id,
             allocation.product_id,
             allocation.product_name,
             allocation.inventory_unit,
             allocation.quantity,
             allocation.gross_cents,
             allocation.allocated_discount_cents,
             cost.allocated_cost_cents,
             (cost.allocated_cost_cents is null) as cost_missing,
             (returns.return_movement_count > 0) as return_pending
        from discount_allocations as allocation
        left join cost_allocations as cost
          on cost.order_id = allocation.order_id
         and cost.order_line_id = allocation.order_line_id
        left join order_returns as returns on returns.order_id = allocation.order_id
       where allocation.component_type = 'product'
    ), product_totals as (
      select line.product_id,
             line.product_name,
             line.inventory_unit,
             pg_catalog.round(pg_catalog.sum(line.quantity * 1000), 0)::bigint as quantity_milli,
             pg_catalog.sum(line.gross_cents) as gross_cents,
             pg_catalog.sum(line.allocated_discount_cents) as discount_cents,
             case when pg_catalog.bool_or(line.cost_missing) then null
                  else pg_catalog.sum(line.allocated_cost_cents) end as cost_cents,
             pg_catalog.count(*) filter (where line.cost_missing) as missing_cost_line_count,
             pg_catalog.count(*) filter (where line.return_pending) as return_pending_count,
             case when pg_catalog.bool_or(line.cost_missing) or pg_catalog.bool_or(line.return_pending) then null
                  else pg_catalog.sum(line.gross_cents - line.allocated_discount_cents - line.allocated_cost_cents)
              end as net_cents
        from product_lines as line
       group by line.product_id, line.product_name, line.inventory_unit
    ), product_json as (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'product_id', product.product_id,
            'product_name', product.product_name,
            'inventory_unit', product.inventory_unit,
            'quantity_milli', product.quantity_milli::text,
            'gross_cents', product.gross_cents::text,
            'discount_cents', product.discount_cents::text,
            'cost_cents', product.cost_cents::text,
            'net_cents', product.net_cents::text,
            'missing_cost_line_count', product.missing_cost_line_count::text,
            'return_pending_count', product.return_pending_count::text
          ) order by product.gross_cents desc, product.product_name
        ), '[]'::jsonb
      ) as products
        from product_totals as product
    ), order_cost_totals as (
      select cost.order_id,
             pg_catalog.sum(cost.allocated_cost_cents) as item_cost_cents,
             pg_catalog.max(cost.missing_cost_line_count) as missing_cost_line_count
        from cost_allocations as cost
       group by cost.order_id
    ), order_stats as (
      select pg_catalog.count(*) as order_count,
             coalesce(pg_catalog.sum(completed.subtotal_cents + completed.delivery_fee_cents), 0) as gross_sales_cents,
             coalesce(pg_catalog.sum(completed.discount_cents), 0) as discount_cents,
             coalesce(pg_catalog.sum(completed.total_cents), 0) as net_sales_cents,
             coalesce(pg_catalog.sum(completed.delivery_fee_cents), 0) as delivery_fee_gross_cents,
             coalesce(pg_catalog.sum(cost.item_cost_cents), 0) as known_item_cost_cents,
             coalesce(pg_catalog.sum(coalesce(cost.missing_cost_line_count, 0)), 0) as missing_cost_line_count,
             coalesce(pg_catalog.sum(case when returns.return_movement_count > 0 then 1 else 0 end), 0) as returned_order_count
        from completed_orders as completed
        left join order_cost_totals as cost on cost.order_id = completed.order_id
        left join order_returns as returns on returns.order_id = completed.order_id
    ), delivery_stats as (
      select coalesce(pg_catalog.sum(allocation.gross_cents), 0) as delivery_fee_gross_cents,
             coalesce(pg_catalog.sum(allocation.allocated_discount_cents), 0) as delivery_fee_discount_cents
        from discount_allocations as allocation
       where allocation.component_type = 'delivery'
    )
    select pg_catalog.jsonb_build_object(
      'products', product_json.products,
      'order_count', order_stats.order_count::text,
      'gross_sales_cents', order_stats.gross_sales_cents::text,
      'discount_cents', order_stats.discount_cents::text,
      'net_sales_cents', order_stats.net_sales_cents::text,
      'delivery_fee_gross_cents', delivery_stats.delivery_fee_gross_cents::text,
      'delivery_fee_discount_cents', delivery_stats.delivery_fee_discount_cents::text,
      'item_cost_cents', case when order_stats.missing_cost_line_count = 0 and order_stats.returned_order_count = 0
                              then order_stats.known_item_cost_cents::text else null end,
      'net_billing_cents', case when order_stats.missing_cost_line_count = 0 and order_stats.returned_order_count = 0
                                then (order_stats.net_sales_cents - order_stats.known_item_cost_cents)::text else null end,
      'missing_cost_line_count', order_stats.missing_cost_line_count::text,
      'returned_order_count', order_stats.returned_order_count::text
    )
      from product_json
      cross join order_stats
      cross join delivery_stats
  );
end;
$function$;

revoke all on function public.get_dashboard_product_revenue(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_dashboard_product_revenue(uuid, date, date) to authenticated;
