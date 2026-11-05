-- Secure identity and minimal data access for the delivery-driver portal.
-- Drivers are deliberately not business_memberships: they cannot read general
-- customer, order, payment, inventory, or financial tables through the API.

alter table public.delivery_workers
  add column user_id uuid unique references auth.users (id) on delete set null;

comment on column public.delivery_workers.user_id is
  'Supabase Auth identity allowed to access only this worker''s assigned deliveries through driver RPCs.';

create function public.link_delivery_worker_account(
  p_business_id uuid,
  p_worker_id uuid,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
  v_existing_user_id uuid;
  v_email_match_count bigint;
begin
  if (select auth.uid()) is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Delivery worker account linking is restricted to business owners.';
  end if;
  if p_worker_id is null or p_email is null
     or pg_catalog.char_length(pg_catalog.btrim(p_email)) not between 3 and 320 then
    raise exception using errcode = '22023', message = 'Enter the email used by the delivery worker account.';
  end if;

  select worker.user_id
    into v_existing_user_id
    from public.delivery_workers as worker
   where worker.business_id = p_business_id
     and worker.id = p_worker_id
     and worker.is_active
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'Choose an active delivery worker in this business.';
  end if;

  select pg_catalog.count(*), (pg_catalog.array_agg(user_row.id))[1]
    into v_email_match_count, v_user_id
    from auth.users as user_row
   where pg_catalog.lower(user_row.email) = pg_catalog.lower(pg_catalog.btrim(p_email))
     and user_row.email_confirmed_at is not null;
  if v_email_match_count = 0 then
    raise exception using errcode = 'P0002', message = 'No account with this confirmed email was found.';
  end if;
  if v_email_match_count <> 1 then
    raise exception using errcode = '22023', message = 'This email matches more than one authenticated account.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('driver-membership-guard'),
    pg_catalog.hashtext(v_user_id::text)
  );

  if exists (
    select 1 from public.business_memberships as membership
     where membership.user_id = v_user_id
  ) then
    raise exception using errcode = '22023', message = 'This account already has business access. Use a separate driver account.';
  end if;

  if exists (
    select 1 from public.delivery_workers as other_worker
     where other_worker.user_id = v_user_id
       and (other_worker.business_id, other_worker.id) is distinct from (p_business_id, p_worker_id)
  ) then
    raise exception using errcode = '23505', message = 'This account is already linked to another delivery worker.';
  end if;
  if v_existing_user_id is not null and v_existing_user_id is distinct from v_user_id then
    raise exception using errcode = '23505', message = 'Unlink the current account before assigning a different one.';
  end if;

  update public.delivery_workers as worker
     set user_id = v_user_id,
         updated_at = pg_catalog.now()
   where worker.business_id = p_business_id
     and worker.id = p_worker_id
     and worker.is_active;
  if not found then
    raise exception using errcode = '23503', message = 'Choose an active delivery worker in this business.';
  end if;

  -- Linking is the owner's decision to use this identity only as a driver.
  -- Remove a still-pending management request for this same business in the
  -- same transaction so it cannot later be approved by mistake.
  delete from public.business_access_requests as request
   where request.business_id = p_business_id
     and request.user_id = v_user_id;

  return p_worker_id;
end;
$function$;

create function public.unlink_delivery_worker_account(
  p_business_id uuid,
  p_worker_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid;
begin
  if (select auth.uid()) is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Delivery worker account unlinking is restricted to business owners.';
  end if;
  if p_worker_id is null then
    raise exception using errcode = '22023', message = 'A delivery worker is required.';
  end if;

  select worker.user_id
    into v_user_id
    from public.delivery_workers as worker
   where worker.business_id = p_business_id
     and worker.id = p_worker_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The selected delivery worker does not exist in this business.';
  end if;

  if v_user_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('driver-membership-guard'),
      pg_catalog.hashtext(v_user_id::text)
    );
  end if;

  update public.delivery_workers as worker
     set user_id = null,
         updated_at = pg_catalog.now()
   where worker.business_id = p_business_id
     and worker.id = p_worker_id;
  if not found then
    raise exception using errcode = '23503', message = 'The selected delivery worker does not exist in this business.';
  end if;
end;
$function$;

-- Make membership and driver identity mutually exclusive even when a future
-- membership-creation path bypasses the current approval RPC.
create function private.reject_business_membership_for_delivery_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.user_id is null then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('driver-membership-guard'),
    pg_catalog.hashtext(new.user_id::text)
  );

  if exists (
    select 1
      from public.delivery_workers as worker
     where worker.user_id = new.user_id
  ) then
    raise exception using errcode = '23505', message = 'A delivery worker account cannot receive business membership.';
  end if;

  return new;
end;
$function$;

revoke all on function private.reject_business_membership_for_delivery_worker() from public, anon, authenticated;

create trigger business_memberships_reject_delivery_worker_account
  before insert or update on public.business_memberships
  for each row execute function private.reject_business_membership_for_delivery_worker();

create or replace function public.request_business_access()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := (select auth.uid());
  target_business_id uuid;
  actor_email text;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'Sign in before requesting business access.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('driver-membership-guard'),
    pg_catalog.hashtext(actor_id::text)
  );

  if exists (
    select 1 from public.delivery_workers as worker where worker.user_id = actor_id
  ) then
    raise exception using errcode = '42501', message = 'Delivery worker accounts cannot request business access.';
  end if;

  select business.id into target_business_id
    from public.businesses as business
   order by business.created_at asc
   limit 1;

  select auth_user.email into actor_email
    from auth.users as auth_user
   where auth_user.id = actor_id;

  if target_business_id is null or actor_email is null then
    raise exception using errcode = 'P0002', message = 'The business or account email was not found.';
  end if;

  if exists (
    select 1 from public.business_memberships as membership where membership.user_id = actor_id
  ) then
    raise exception using errcode = '23505', message = 'This account already has business access.';
  end if;

  insert into public.business_access_requests (business_id, user_id, email)
  values (target_business_id, actor_id, pg_catalog.lower(actor_email))
  on conflict (business_id, user_id) do update set email = excluded.email;
end;
$function$;

revoke all on function public.request_business_access() from public, anon, authenticated;
grant execute on function public.request_business_access() to authenticated;

create function public.get_my_delivery_worker_context()
returns table (
  business_id uuid,
  worker_id uuid,
  worker_name text,
  business_name text,
  is_active boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  select worker.business_id, worker.id, worker.name, business.name, worker.is_active
    from public.delivery_workers as worker
    join public.businesses as business on business.id = worker.business_id
   where worker.user_id = (select auth.uid())
   limit 1;
$function$;

create function public.get_my_delivery_driver_queue()
returns table (
  delivery_id uuid,
  order_id uuid,
  status public.delivery_status,
  scheduled_on date,
  time_window text,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  customer_name text,
  customer_phone text,
  delivery_address text,
  order_created_at timestamptz,
  items jsonb
)
language sql
stable
security definer
set search_path = ''
as $function$
  with current_worker as (
    select worker.business_id, worker.id
      from public.delivery_workers as worker
     where worker.user_id = (select auth.uid())
       and worker.is_active
  )
  select delivery.id,
         order_row.id,
         delivery.status,
         delivery.scheduled_on,
         delivery.time_window,
         delivery.dispatched_at,
         delivery.delivered_at,
         order_row.customer_name_snapshot,
         customer.phone,
         order_row.delivery_address_snapshot,
         order_row.created_at,
         coalesce((
           select pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'name', line.product_name_snapshot,
               'quantity', line.quantity,
               'unit', line.inventory_unit_snapshot
             ) order by line.line_number
           )
             from public.order_lines as line
            where line.business_id = delivery.business_id
              and line.order_id = delivery.order_id
         ), '[]'::jsonb)
    from current_worker as worker
    join public.deliveries as delivery
      on delivery.business_id = worker.business_id
     and delivery.delivery_worker_id = worker.id
    join public.orders as order_row
      on order_row.business_id = delivery.business_id
     and order_row.id = delivery.order_id
    join public.customers as customer
      on customer.business_id = order_row.business_id
     and customer.id = order_row.customer_id
   where delivery.canceled_at is null
     and order_row.status = 'open'::public.order_status
     and (
       delivery.status not in (
         'delivered'::public.delivery_status,
         'returned'::public.delivery_status
       )
       or coalesce(delivery.delivered_at, delivery.returned_at) >= pg_catalog.now() - interval '30 days'
     )
   order by case when delivery.status in (
                  'delivered'::public.delivery_status,
                  'returned'::public.delivery_status
                ) then 1 else 0 end,
            delivery.scheduled_on asc nulls last,
            delivery.created_at desc
   limit 100;
$function$;

create function public.transition_my_delivery(
  p_delivery_id uuid,
  p_status public.delivery_status,
  p_note text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker record;
  v_delivery record;
  v_order_id uuid;
  v_order_status public.order_status;
  v_event_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_component record;
  v_net_issued numeric;
  v_quantity_to_issue numeric;
  v_chunk numeric;
  v_stock_warnings jsonb := '[]'::jsonb;
begin
  if (select auth.uid()) is null
     or p_delivery_id is null
     or p_request_id is null
     or p_status is null
     or p_status not in (
       'dispatched'::public.delivery_status,
       'delivered'::public.delivery_status
     )
     or pg_catalog.char_length(pg_catalog.btrim(p_note)) > 1000 then
    raise exception using errcode = '22023', message = 'Delivery update details are invalid.';
  end if;

  select worker.business_id, worker.id
    into v_worker
    from public.delivery_workers as worker
   where worker.user_id = (select auth.uid())
     and worker.is_active;
  if not found then
    raise exception using errcode = '42501', message = 'An active delivery worker account is required.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_worker.business_id::text),
    pg_catalog.hashtext(p_request_id::text)
  );
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'transition_my_delivery',
    'delivery_id', p_delivery_id,
    'status', p_status,
    'note', nullif(pg_catalog.btrim(p_note), '')
  )::text);

  select delivery.order_id
    into v_order_id
    from public.deliveries as delivery
   where delivery.business_id = v_worker.business_id
     and delivery.id = p_delivery_id
     and delivery.delivery_worker_id = v_worker.id;
  if not found then
    raise exception using errcode = '42501', message = 'This delivery is not assigned to your account.';
  end if;

  select order_row.status
    into v_order_status
    from public.orders as order_row
   where order_row.business_id = v_worker.business_id
     and order_row.id = v_order_id
   for update;
  if not found or v_order_status <> 'open'::public.order_status then
    raise exception using errcode = '22023', message = 'A canceled order cannot change delivery status.';
  end if;

  select delivery.*
    into v_delivery
    from public.deliveries as delivery
   where delivery.business_id = v_worker.business_id
     and delivery.id = p_delivery_id
   for update;
  if not found
     or v_delivery.delivery_worker_id is distinct from v_worker.id
     or v_delivery.canceled_at is not null then
    raise exception using errcode = '42501', message = 'This delivery is no longer assigned to your account.';
  end if;

  select event.id, event.request_fingerprint
    into v_event_id, v_existing_fingerprint
    from public.delivery_events as event
   where event.business_id = v_worker.business_id
     and event.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for a different delivery update.';
    end if;
    return v_event_id;
  end if;

  if not (
    (v_delivery.status = 'ready'::public.delivery_status
      and p_status = 'dispatched'::public.delivery_status)
    or (v_delivery.status = 'dispatched'::public.delivery_status
      and p_status = 'delivered'::public.delivery_status)
  ) then
    raise exception using errcode = '22023', message = 'Drivers can mark a ready delivery as dispatched and an in-route delivery as delivered.';
  end if;

  if p_status = 'dispatched'::public.delivery_status then
    for v_component in
      select component.product_id
        from public.order_line_components as component
       where component.business_id = v_worker.business_id
         and component.order_id = v_order_id
         and component.inventory_tracked_snapshot
       group by component.product_id
       order by component.product_id
    loop
      perform 1 from public.products as product
       where product.business_id = v_worker.business_id
         and product.id = v_component.product_id
       for update;
    end loop;

    for v_component in
      select component.product_id,
             pg_catalog.sum(component.quantity_snapshot) as ordered_quantity
        from public.order_line_components as component
       where component.business_id = v_worker.business_id
         and component.order_id = v_order_id
         and component.inventory_tracked_snapshot
       group by component.product_id
       order by component.product_id
    loop
      select coalesce(-pg_catalog.sum(movement.quantity_delta), 0)
        into v_net_issued
        from public.inventory_movements as movement
       where movement.business_id = v_worker.business_id
         and movement.order_id = v_order_id
         and movement.product_id = v_component.product_id
         and movement.movement_type in (
           'dispatch'::public.inventory_movement_type,
           'return'::public.inventory_movement_type
         );
      v_quantity_to_issue := greatest(v_component.ordered_quantity - v_net_issued, 0);
      while v_quantity_to_issue > 0 loop
        v_chunk := least(v_quantity_to_issue, 999999999.999);
        insert into public.inventory_movements (
          business_id, product_id, movement_type, quantity_delta, reason, order_id, actor_id
        ) values (
          v_worker.business_id, v_component.product_id,
          'dispatch'::public.inventory_movement_type, -v_chunk,
          'Expedição de pedido', v_order_id, (select auth.uid())
        );
        v_quantity_to_issue := v_quantity_to_issue - v_chunk;
      end loop;
    end loop;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'product_id', balance.product_id,
             'product_name', balance.name,
             'inventory_unit', balance.inventory_unit,
             'quantity_on_hand', balance.quantity_on_hand
           ) order by balance.product_id), '[]'::jsonb)
      into v_stock_warnings
      from (
        select product.id as product_id, product.name, product.inventory_unit,
               coalesce(balance.quantity_on_hand, 0) as quantity_on_hand
          from (
            select distinct component.product_id
              from public.order_line_components as component
             where component.business_id = v_worker.business_id
               and component.order_id = v_order_id
               and component.inventory_tracked_snapshot
          ) as affected
          join public.products as product
            on product.business_id = v_worker.business_id
           and product.id = affected.product_id
          left join (
            select movement.product_id,
                   pg_catalog.sum(movement.quantity_delta) as quantity_on_hand
              from public.inventory_movements as movement
             where movement.business_id = v_worker.business_id
             group by movement.product_id
          ) as balance on balance.product_id = product.id
         where coalesce(balance.quantity_on_hand, 0) < 0
      ) as balance;
  end if;

  update public.deliveries
     set status = p_status,
         dispatched_at = case when p_status = 'dispatched'::public.delivery_status then pg_catalog.now() else dispatched_at end,
         delivered_at = case when p_status = 'delivered'::public.delivery_status then pg_catalog.now() else delivered_at end,
         updated_at = pg_catalog.now()
   where business_id = v_worker.business_id
     and id = p_delivery_id;

  insert into public.delivery_events (
    business_id, delivery_id, event_type, from_status, to_status,
    delivery_worker_id, scheduled_on, time_window, note, next_step, stock_warnings,
    request_id, request_fingerprint, actor_id
  ) values (
    v_worker.business_id, p_delivery_id,
    'status_changed'::public.delivery_event_type,
    v_delivery.status, p_status, v_delivery.delivery_worker_id,
    v_delivery.scheduled_on, v_delivery.time_window,
    nullif(pg_catalog.btrim(p_note), ''), null, v_stock_warnings,
    p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_event_id;

  return v_event_id;
end;
$function$;

revoke all on function public.link_delivery_worker_account(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.unlink_delivery_worker_account(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_my_delivery_worker_context() from public, anon, authenticated;
revoke all on function public.get_my_delivery_driver_queue() from public, anon, authenticated;
revoke all on function public.transition_my_delivery(uuid, public.delivery_status, text, uuid) from public, anon, authenticated;

grant execute on function public.link_delivery_worker_account(uuid, uuid, text) to authenticated;
grant execute on function public.unlink_delivery_worker_account(uuid, uuid) to authenticated;
grant execute on function public.get_my_delivery_worker_context() to authenticated;
grant execute on function public.get_my_delivery_driver_queue() to authenticated;
grant execute on function public.transition_my_delivery(uuid, public.delivery_status, text, uuid) to authenticated;
