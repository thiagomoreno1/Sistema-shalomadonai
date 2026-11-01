-- Public registration creates an access request, never business access.
-- An owner must explicitly approve every new account before it can read data.

create table public.business_access_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  unique (business_id, user_id)
);

alter table public.business_access_requests enable row level security;

revoke all on table public.business_access_requests from public, anon, authenticated;
grant select, delete on table public.business_access_requests to authenticated;

create policy business_access_requests_select_for_owners
  on public.business_access_requests
  for select
  to authenticated
  using ((select private.is_business_owner(business_id)));

create policy business_access_requests_delete_for_owners
  on public.business_access_requests
  for delete
  to authenticated
  using ((select private.is_business_owner(business_id)));

-- The public signup screen needs only the business name and ID. No customer or
-- operational data is exposed by this function.
create function public.get_signup_business()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $function$
  select business.id, business.name
  from public.businesses as business
  order by business.created_at asc
  limit 1;
$function$;

revoke all on function public.get_signup_business() from public, anon, authenticated;
grant execute on function public.get_signup_business() to anon, authenticated;

-- A new user can request access to the business named in signup metadata.
-- The request grants no access by itself; the owner must approve it later.
create function private.record_business_access_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requested_business_id uuid;
begin
  begin
    requested_business_id := nullif(new.raw_user_meta_data ->> 'requested_business_id', '')::uuid;
  exception when invalid_text_representation then
    return new;
  end;

  if requested_business_id is null or new.email is null then
    return new;
  end if;

  insert into public.business_access_requests (business_id, user_id, email)
  select business.id, new.id, lower(new.email)
  from public.businesses as business
  where business.id = requested_business_id
    and not exists (
      select 1
      from public.business_memberships as membership
      where membership.business_id = business.id
        and membership.user_id = new.id
    )
  on conflict (business_id, user_id) do update
    set email = excluded.email;

  return new;
end;
$function$;

revoke all on function private.record_business_access_request() from public, anon, authenticated;

create trigger auth_users_record_business_access_request
  after insert on auth.users
  for each row
  execute function private.record_business_access_request();

-- Approve and attach an account in one transaction. The RPC rechecks owner
-- access even if a caller bypasses the interface.
create function public.approve_business_access_request(p_business_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null
    or not (select private.is_business_owner(p_business_id)) then
    raise exception using
      errcode = '42501',
      message = 'Only a business owner can approve access requests.';
  end if;

  if not exists (
    select 1
    from public.business_access_requests as request
    where request.business_id = p_business_id
      and request.user_id = p_user_id
  ) then
    raise exception using
      errcode = 'P0002',
      message = 'The access request was not found.';
  end if;

  if exists (
    select 1
    from public.business_memberships as membership
    where membership.user_id = p_user_id
      and membership.business_id <> p_business_id
  ) then
    raise exception using
      errcode = '23505',
      message = 'This account already belongs to another business.';
  end if;

  insert into public.business_memberships (business_id, user_id, role)
  values (p_business_id, p_user_id, 'staff'::public.business_member_role)
  on conflict (business_id, user_id) do nothing;

  delete from public.business_access_requests as request
  where request.business_id = p_business_id
    and request.user_id = p_user_id;
end;
$function$;

revoke all on function public.approve_business_access_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_business_access_request(uuid, uuid) to authenticated;
