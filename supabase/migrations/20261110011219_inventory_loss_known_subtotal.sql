-- Return the costed subset of stock losses even when older loss movements
-- have no stored cost. The missing-cost count lets the UI mark profit as a
-- partial estimate instead of hiding all otherwise known financial data.
create or replace function public.get_inventory_finance_summary(
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
         pg_catalog.round(losses.known_loss_cents, 0)::text,
         losses.loss_movement_count,
         losses.missing_cost_count
    from stock cross join losses;
end;
$function$;

revoke all on function public.get_inventory_finance_summary(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.get_inventory_finance_summary(uuid, date, date)
  to authenticated;
