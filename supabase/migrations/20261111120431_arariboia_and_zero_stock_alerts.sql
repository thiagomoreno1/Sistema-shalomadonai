alter table public.customers
  add column is_arariboia boolean not null default false,
  add column arariboia_limit_cents bigint,
  add constraint customers_arariboia_limit_nonnegative
    check (arariboia_limit_cents is null or arariboia_limit_cents >= 0);

grant insert (is_arariboia, arariboia_limit_cents)
  on table public.customers to authenticated;
grant update (is_arariboia, arariboia_limit_cents)
  on table public.customers to authenticated;

-- Stop creating combos. Existing combo catalog entries become countable
-- products; historical order component snapshots remain intact.
revoke all on function public.set_combo_components(uuid, uuid, jsonb)
  from public, anon, authenticated;

create or replace function private.guard_inventory_product_configuration()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if old.inventory_tracked and not new.inventory_tracked then
    raise exception using errcode = '22023', message = 'Stock tracking cannot be disabled after the opening count.';
  end if;
  if old.inventory_tracked and new.inventory_unit is distinct from old.inventory_unit then
    raise exception using errcode = '22023', message = 'The unit cannot be changed after stock tracking begins.';
  end if;
  return new;
end;
$function$;

with converted_combos as (
  update public.products
     set is_combo = false,
         inventory_tracked = true,
         inventory_unit = coalesce(nullif(pg_catalog.btrim(inventory_unit), ''), 'un'),
         minimum_stock = null,
         updated_at = pg_catalog.now()
   where is_combo
  returning business_id, id
)
insert into public.inventory_movements (
  business_id, product_id, movement_type, quantity_delta, reason, actor_id
)
select converted.business_id,
       converted.id,
       'opening'::public.inventory_movement_type,
       0,
       'Saldo inicial zero; conferir quantidade física',
       owner_membership.user_id
  from converted_combos as converted
  join public.business_memberships as owner_membership
    on owner_membership.business_id = converted.business_id
   and owner_membership.role = 'owner'::public.business_member_role;

-- Products without a recorded unit/count must be configured before selling.
-- Pause legacy untracked products instead of quietly selling without stock.
update public.products
   set is_active = false,
       updated_at = pg_catalog.now()
 where not inventory_tracked
   and not is_combo
   and is_active;

create function private.enforce_product_stock_and_combo()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.is_combo then
      raise exception using errcode = '22023', message = 'New combo products are no longer supported.';
    end if;
  elsif new.is_combo and not old.is_combo then
    raise exception using errcode = '22023', message = 'New combo products are no longer supported.';
  end if;
  if new.is_active and not new.is_combo and not new.inventory_tracked then
    raise exception using errcode = '22023', message = 'Set the stock unit and opening count before activating this product.';
  end if;
  return new;
end;
$function$;

revoke all on function private.enforce_product_stock_and_combo() from public, anon, authenticated;

create trigger products_reject_new_combo
  before insert or update of is_combo, inventory_tracked, is_active on public.products
  for each row execute function private.enforce_product_stock_and_combo();

-- Give the owner one bounded, consistent view of the operational work that
-- needs attention, without loading every financial or inventory row in React.
create or replace function public.get_dashboard_priorities(p_business_id uuid, p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_priorities jsonb;
begin
  if (select auth.uid()) is null
     or p_business_id is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Dashboard access denied.';
  end if;
  if p_today is null then
    raise exception using errcode = '22023', message = 'A dashboard business date is required.';
  end if;

  with receivable_balances as (
    select installment.id as installment_id,
           installment.order_id,
           installment.installment_number,
           installment.due_on,
           order_row.customer_name_snapshot as customer_name,
           balance.balance_cents
      from public.order_installments as installment
      join public.orders as order_row
        on order_row.business_id = installment.business_id
       and order_row.id = installment.order_id
      cross join lateral (
        select greatest(
          installment.amount_cents::numeric - coalesce(pg_catalog.sum(allocation.amount_cents), 0),
          0
        ) as balance_cents
          from public.order_payment_allocations as allocation
         where allocation.business_id = installment.business_id
           and allocation.order_id = installment.order_id
           and allocation.installment_id = installment.id
      ) as balance
     where installment.business_id = p_business_id
       and order_row.status = 'open'::public.order_status
       and installment.due_on <= p_today
       and balance.balance_cents > 0
  ),
  active_deliveries as (
    select delivery.id as delivery_id,
           delivery.order_id,
           order_row.customer_name_snapshot as customer_name,
           delivery.status,
           delivery.scheduled_on,
           delivery.time_window,
           worker.name as delivery_worker_name,
           delivery.created_at,
           case delivery.status
             when 'attempted'::public.delivery_status then 1
             when 'awaiting_separation'::public.delivery_status then 2
             when 'ready'::public.delivery_status then 3
             when 'rescheduled'::public.delivery_status then 4
             when 'dispatched'::public.delivery_status then 5
             else 6
           end as priority_rank
      from public.deliveries as delivery
      join public.orders as order_row
        on order_row.business_id = delivery.business_id
       and order_row.id = delivery.order_id
      left join public.delivery_workers as worker
        on worker.business_id = delivery.business_id
       and worker.id = delivery.delivery_worker_id
     where delivery.business_id = p_business_id
       and delivery.canceled_at is null
       and delivery.status not in (
         'delivered'::public.delivery_status,
         'returned'::public.delivery_status
       )
       and order_row.status = 'open'::public.order_status
       and (
         delivery.status in (
           'dispatched'::public.delivery_status,
           'attempted'::public.delivery_status
         )
         or delivery.scheduled_on is null
         or delivery.scheduled_on <= p_today
       )
  ),
  tracked_stock as (
    select balance.product_id,
           balance.product_name,
           balance.inventory_unit,
           balance.minimum_stock,
           balance.quantity_on_hand
      from public.inventory_balances as balance
     where balance.business_id = p_business_id
  ),
  stock_attention as (
    select *
      from tracked_stock
     where quantity_on_hand <= 0
        or (minimum_stock is not null and quantity_on_hand < minimum_stock)
  )
  select pg_catalog.jsonb_build_object(
    'as_of_on', p_today,
    'follow_ups', pg_catalog.jsonb_build_object(
      'pending_count', (
        select count(*)
          from public.follow_up_tasks as task
         where task.business_id = p_business_id
           and task.status = 'pending'::public.follow_up_status
           and task.due_on <= p_today
      ),
      'items', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', item.id,
            'title', item.title,
            'due_on', item.due_on,
            'priority', item.priority,
            'customer_id', item.customer_id,
            'customer_name', item.customer_name
          ) order by item.due_on,
                     case item.priority
                       when 'high'::public.follow_up_priority then 1
                       when 'normal'::public.follow_up_priority then 2
                       else 3
                     end,
                     item.id
        )
          from (
            select task.id,
                   task.title,
                   task.due_on,
                   task.priority,
                   task.customer_id,
                   customer.name as customer_name
              from public.follow_up_tasks as task
              left join public.customers as customer
                on customer.business_id = task.business_id
               and customer.id = task.customer_id
             where task.business_id = p_business_id
               and task.status = 'pending'::public.follow_up_status
               and task.due_on <= p_today
             order by task.due_on,
                      case task.priority
                        when 'high'::public.follow_up_priority then 1
                        when 'normal'::public.follow_up_priority then 2
                        else 3
                      end,
                      task.id
             limit 4
          ) as item
      ), '[]'::jsonb)
    ),
    'receivables', pg_catalog.jsonb_build_object(
      'overdue_count', (
        select count(*) from receivable_balances where due_on < p_today
      ),
      'overdue_balance_cents', coalesce((
        select pg_catalog.sum(balance_cents) from receivable_balances where due_on < p_today
      ), 0)::text,
      'due_today_count', (
        select count(*) from receivable_balances where due_on = p_today
      ),
      'due_today_balance_cents', coalesce((
        select pg_catalog.sum(balance_cents) from receivable_balances where due_on = p_today
      ), 0)::text,
      'items', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'installment_id', item.installment_id,
            'order_id', item.order_id,
            'installment_number', item.installment_number,
            'due_on', item.due_on,
            'customer_name', item.customer_name,
            'balance_cents', item.balance_cents::text,
            'overdue', item.due_on < p_today
          ) order by item.due_on, item.customer_name, item.installment_number, item.installment_id
        )
          from (
            select *
              from receivable_balances
             order by due_on, customer_name, installment_number, installment_id
             limit 4
          ) as item
      ), '[]'::jsonb)
    ),
    'deliveries', pg_catalog.jsonb_build_object(
      'pending_count', (select count(*) from active_deliveries),
      'items', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'delivery_id', item.delivery_id,
            'order_id', item.order_id,
            'customer_name', item.customer_name,
            'status', item.status,
            'scheduled_on', item.scheduled_on,
            'time_window', item.time_window,
            'delivery_worker_name', item.delivery_worker_name
          ) order by item.priority_rank, item.scheduled_on nulls first, item.created_at, item.delivery_id
        )
          from (
            select *
              from active_deliveries
             order by priority_rank, scheduled_on nulls first, created_at, delivery_id
             limit 4
          ) as item
      ), '[]'::jsonb)
    ),
    'inventory', pg_catalog.jsonb_build_object(
      'tracked_product_count', (select count(*) from tracked_stock),
      'without_minimum_count', (
        select count(*) from tracked_stock where minimum_stock is null
      ),
      'attention_count', (select count(*) from stock_attention),
      'items', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'product_id', item.product_id,
            'product_name', item.product_name,
            'inventory_unit', item.inventory_unit,
            'minimum_stock', item.minimum_stock,
            'quantity_on_hand', item.quantity_on_hand
          ) order by item.quantity_on_hand, item.product_name, item.product_id
        )
          from (
            select *
          from stock_attention
             order by quantity_on_hand, product_name, product_id
             limit 4
          ) as item
      ), '[]'::jsonb)
    )
  ) into v_priorities;

  return v_priorities;
end;
$function$;

revoke all on function public.get_dashboard_priorities(uuid, date) from public, anon, authenticated;
grant execute on function public.get_dashboard_priorities(uuid, date) to authenticated;
