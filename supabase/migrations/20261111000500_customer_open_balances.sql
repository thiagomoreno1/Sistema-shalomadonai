create function public.get_customer_open_balances(p_business_id uuid)
returns table (
  customer_id uuid,
  balance_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select order_balances.customer_id,
         pg_catalog.sum(order_balances.balance_cents)::bigint as balance_cents
    from (
      select order_row.customer_id,
             greatest(
               0::numeric,
               order_row.total_cents::numeric
                 - coalesce(pg_catalog.sum(payment.amount_cents), 0::numeric)
             )::bigint as balance_cents
        from public.orders as order_row
        left join public.order_payments as payment
          on payment.business_id = order_row.business_id
         and payment.order_id = order_row.id
       where order_row.business_id = p_business_id
         and order_row.status = 'open'::public.order_status
       group by order_row.business_id, order_row.id, order_row.customer_id, order_row.total_cents
    ) as order_balances
   group by order_balances.customer_id;
$function$;

comment on function public.get_customer_open_balances(uuid) is
  'Returns per-customer outstanding balances for open orders; caller RLS scopes the business rows.';

revoke all on function public.get_customer_open_balances(uuid) from public, anon, authenticated;
grant execute on function public.get_customer_open_balances(uuid) to authenticated;
