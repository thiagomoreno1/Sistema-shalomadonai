-- The adjusted stock-purchase metric is separate from cash outflows.
-- Sales/dispatches do not reduce it; stock adjustments (manual or counted) and
-- recorded losses change its value using each movement's cost snapshot.
create function public.get_inventory_purchase_count_summary(
  p_business_id uuid,
  p_start_on date,
  p_end_on date
)
returns table (
  adjusted_purchase_cents text,
  missing_cost_movement_count bigint
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
    raise exception using errcode = '42501', message = 'Inventory purchase summary access denied.';
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
  with eligible_movements as (
    select movement.product_id,
           movement.inventory_value_delta_cents
      from public.inventory_movements as movement
      left join public.inventory_receipts as receipt
        on receipt.business_id = movement.business_id
       and receipt.id = movement.receipt_id
     where movement.business_id = p_business_id
       and (
         (
           movement.movement_type = 'receipt'::public.inventory_movement_type
           and receipt.received_on between p_start_on and p_end_on
         )
         or (
           movement.movement_type = 'loss'::public.inventory_movement_type
           and movement.occurred_at >= v_start_at
           and movement.occurred_at < v_end_at
         )
         or (
           movement.movement_type = 'adjustment'::public.inventory_movement_type
           and movement.occurred_at >= v_start_at
           and movement.occurred_at < v_end_at
         )
       )
  ), per_product as (
    select movement.product_id,
           coalesce(sum(movement.inventory_value_delta_cents)
             filter (where movement.inventory_value_delta_cents is not null), 0) as known_value_cents,
           count(*) filter (where movement.inventory_value_delta_cents is null) as missing_cost_count
      from eligible_movements as movement
     group by movement.product_id
  )
  select pg_catalog.round(coalesce(sum(greatest(product.known_value_cents, 0)), 0), 0)::text,
         coalesce(sum(product.missing_cost_count), 0)::bigint
    from per_product as product;
end;
$function$;

revoke all on function public.get_inventory_purchase_count_summary(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.get_inventory_purchase_count_summary(uuid, date, date)
  to authenticated;
