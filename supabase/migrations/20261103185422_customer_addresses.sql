-- Keep multiple labeled delivery addresses per customer while retaining the
-- legacy delivery_address field as a synchronized primary-address mirror.
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  customer_id uuid not null,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  address text not null check (char_length(btrim(address)) between 1 and 1000),
  is_default boolean not null default false,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, customer_id)
    references public.customers (business_id, id) on delete restrict
);

create index customer_addresses_customer_idx
  on public.customer_addresses (business_id, customer_id, is_default desc, label, id);
create unique index customer_addresses_retry_deduplication_idx
  on public.customer_addresses (business_id, customer_id, label, address);
create unique index customer_addresses_one_default_idx
  on public.customer_addresses (business_id, customer_id)
  where is_default;

alter table public.customer_addresses enable row level security;
revoke all on table public.customer_addresses from public, anon, authenticated;
grant select on table public.customer_addresses to authenticated;
grant insert (business_id, customer_id, label, address, is_default)
  on table public.customer_addresses to authenticated;
grant update (label, address, is_default)
  on table public.customer_addresses to authenticated;
grant delete on table public.customer_addresses to authenticated;

create policy customer_addresses_select_for_owners
  on public.customer_addresses for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy customer_addresses_insert_for_owners
  on public.customer_addresses for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
create policy customer_addresses_update_for_owners
  on public.customer_addresses for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
create policy customer_addresses_delete_for_owners
  on public.customer_addresses for delete to authenticated
  using ((select private.is_business_owner(business_id)));

-- Backfill every existing free-form address once per distinct address. The
-- NOT EXISTS guard makes the data copy safe to rerun without duplicating rows.
insert into public.customer_addresses (
  business_id, customer_id, label, address, is_default, created_by, created_at
)
select
  customer.business_id,
  customer.id,
  'Principal',
  btrim(customer.delivery_address),
  true,
  customer.created_by,
  customer.created_at
from public.customers as customer
where nullif(btrim(customer.delivery_address), '') is not null
  and not exists (
    select 1
    from public.customer_addresses as existing
    where existing.business_id = customer.business_id
      and existing.customer_id = customer.id
      and lower(btrim(existing.address)) = lower(btrim(customer.delivery_address))
  )
on conflict do nothing;

create function private.prepare_customer_address_default()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  -- Serialize changes to this customer's primary address.
  perform 1
    from public.customers as customer
   where customer.business_id = new.business_id
     and customer.id = new.customer_id
   for update;

  -- Directly clearing the only principal would leave the legacy mirror stale.
  -- A nested update from this trigger is the internal half of a principal switch.
  if tg_op = 'UPDATE'
    and old.is_default
    and not new.is_default
    and pg_catalog.pg_trigger_depth() = 1 then
    new.is_default := true;
  end if;

  if new.is_default or not exists (
    select 1
      from public.customer_addresses as address
     where address.business_id = new.business_id
       and address.customer_id = new.customer_id
  ) then
    update public.customer_addresses as sibling
       set is_default = false
     where sibling.business_id = new.business_id
       and sibling.customer_id = new.customer_id
       and sibling.id is distinct from new.id
       and sibling.is_default;
    new.is_default := true;
  end if;

  return new;
end;
$function$;
revoke all on function private.prepare_customer_address_default() from public, anon, authenticated;

create trigger customer_addresses_prepare_default
  before insert or update of is_default on public.customer_addresses
  for each row execute function private.prepare_customer_address_default();

create function private.sync_customer_default_address()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  target_business_id uuid;
  target_customer_id uuid;
  primary_address_id uuid;
  primary_address text;
begin
  -- A default switch first clears the previous row from inside the new row's
  -- BEFORE trigger. Do not promote a sibling during that brief transition.
  if tg_op = 'UPDATE' and old.is_default and not new.is_default then
    return null;
  end if;

  if tg_op = 'DELETE' then
    target_business_id := old.business_id;
    target_customer_id := old.customer_id;
  else
    target_business_id := new.business_id;
    target_customer_id := new.customer_id;
  end if;

  select address.id, address.address
    into primary_address_id, primary_address
    from public.customer_addresses as address
   where address.business_id = target_business_id
     and address.customer_id = target_customer_id
     and address.is_default
   order by address.created_at, address.id
   limit 1;

  if not found then
    select address.id, address.address
      into primary_address_id, primary_address
      from public.customer_addresses as address
     where address.business_id = target_business_id
       and address.customer_id = target_customer_id
     order by address.created_at, address.id
     limit 1;

    if found then
      update public.customer_addresses as address
         set is_default = true
       where address.business_id = target_business_id
         and address.id = primary_address_id
         and not address.is_default;
    end if;
  end if;

  update public.customers as customer
     set delivery_address = primary_address
   where customer.business_id = target_business_id
     and customer.id = target_customer_id
     and customer.delivery_address is distinct from primary_address;

  return null;
end;
$function$;
revoke all on function private.sync_customer_default_address() from public, anon, authenticated;

create trigger customer_addresses_sync_legacy_primary
  after insert or update of label, address, is_default or delete
  on public.customer_addresses
  for each row execute function private.sync_customer_default_address();

create function private.sync_legacy_customer_address()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  primary_address_id uuid;
  normalized_address text;
begin
  normalized_address := nullif(btrim(new.delivery_address), '');

  if normalized_address is null then
    if tg_op = 'UPDATE' and old.delivery_address is distinct from new.delivery_address then
      delete from public.customer_addresses as address
       where address.business_id = new.business_id
         and address.customer_id = new.id
         and address.is_default;
    end if;
    return null;
  end if;

  select address.id
    into primary_address_id
    from public.customer_addresses as address
   where address.business_id = new.business_id
     and address.customer_id = new.id
     and address.is_default
   order by address.created_at, address.id
   limit 1;

  if found then
    update public.customer_addresses as address
       set address = normalized_address
     where address.business_id = new.business_id
       and address.id = primary_address_id
       and address.address is distinct from normalized_address;
  else
    insert into public.customer_addresses (
      business_id, customer_id, label, address, is_default
    ) values (
      new.business_id, new.id, 'Principal', normalized_address, true
    )
    on conflict (business_id, customer_id, label, address)
    do update set is_default = true;
  end if;

  return null;
end;
$function$;
revoke all on function private.sync_legacy_customer_address() from public, anon, authenticated;

create trigger customers_sync_legacy_delivery_address
  after insert or update of delivery_address on public.customers
  for each row execute function private.sync_legacy_customer_address();

create trigger customer_addresses_touch_updated_at
  before update on public.customer_addresses
  for each row execute function private.touch_updated_at();
