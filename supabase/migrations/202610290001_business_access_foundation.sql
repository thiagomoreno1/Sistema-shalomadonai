-- Business ownership and membership boundary for private business records.
-- A newly authenticated creator gets one owner membership automatically.

create type public.business_member_role as enum ('owner', 'staff');

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) > 0),
  timezone text not null default 'America/Sao_Paulo',
  currency text not null default 'BRL',
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.business_memberships (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.business_member_role not null,
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

-- A business has exactly one owner membership. The role cannot be changed
-- through the authenticated API; ownership transfer requires a deliberate migration.
create unique index business_memberships_one_owner_per_business_idx
  on public.business_memberships (business_id)
  where role = 'owner'::public.business_member_role;

alter table public.businesses enable row level security;
alter table public.business_memberships enable row level security;

-- This schema is intentionally omitted from the Data API's exposed schemas.
create schema private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- SECURITY DEFINER keeps policy lookups from recursively re-entering RLS on
-- business_memberships. Pin search_path to empty and qualify every reference.
create function private.is_business_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.business_memberships as membership
    where membership.business_id = p_business_id
      and membership.user_id = (select auth.uid())
  );
$function$;

create function private.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.business_memberships as membership
    where membership.business_id = p_business_id
      and membership.user_id = (select auth.uid())
      and membership.role = 'owner'::public.business_member_role
  );
$function$;

-- The AFTER INSERT trigger runs in the same transaction as business creation.
-- If initial membership creation fails, the business insert is rolled back too.
create function private.add_creator_as_business_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_user_id uuid := (select auth.uid());
begin
  -- API requests must bind the creator to the authenticated JWT subject. A
  -- SQL Editor session connects as postgres and has no auth.uid(), so it may
  -- supply an explicit created_by; the NOT NULL and foreign key still apply.
  if authenticated_user_id is null then
    if session_user <> 'postgres' then
      raise exception using
        errcode = '42501',
        message = 'Business creation requires an authenticated user or trusted SQL Editor session.';
    end if;
  elsif new.created_by is distinct from authenticated_user_id then
    raise exception using
      errcode = '42501',
      message = 'The business creator must match the authenticated user.';
  end if;

  insert into public.business_memberships (business_id, user_id, role)
  values (new.id, new.created_by, 'owner'::public.business_member_role);

  return new;
end;
$function$;

create trigger businesses_add_creator_as_owner
  after insert on public.businesses
  for each row
  execute function private.add_creator_as_business_owner();

-- Remove default PUBLIC execution. RLS uses the two helper functions only for
-- authenticated sessions; the trigger function is callable only by the trigger.
revoke all on function private.is_business_member(uuid) from public, anon, authenticated;
revoke all on function private.is_business_owner(uuid) from public, anon, authenticated;
revoke all on function private.add_creator_as_business_owner() from public, anon, authenticated;
grant execute on function private.is_business_member(uuid) to authenticated;
grant execute on function private.is_business_owner(uuid) to authenticated;

-- Explicit least-privilege Data API grants. No anonymous privileges, no business
-- deletion, no membership role updates, and no direct owner-membership inserts.
revoke all on table public.businesses from public, anon, authenticated;
revoke all on table public.business_memberships from public, anon, authenticated;
grant select on table public.businesses to authenticated;
grant insert (name, timezone, currency) on table public.businesses to authenticated;
grant update (name, timezone, currency) on table public.businesses to authenticated;
grant select on table public.business_memberships to authenticated;
grant insert (business_id, user_id, role) on table public.business_memberships to authenticated;
grant delete on table public.business_memberships to authenticated;

create policy businesses_select_for_members
  on public.businesses
  for select
  to authenticated
  using ((select private.is_business_member(id)));

create policy businesses_insert_for_authenticated_creator
  on public.businesses
  for insert
  to authenticated
  with check (created_by = (select auth.uid()));

create policy businesses_update_for_owners
  on public.businesses
  for update
  to authenticated
  using ((select private.is_business_owner(id)))
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(id))
  );

create policy business_memberships_select_for_members
  on public.business_memberships
  for select
  to authenticated
  using ((select private.is_business_member(business_id)));

create policy business_memberships_insert_staff_for_owners
  on public.business_memberships
  for insert
  to authenticated
  with check (
    role = 'staff'::public.business_member_role
    and user_id <> (select auth.uid())
    and (select private.is_business_owner(business_id))
  );

create policy business_memberships_delete_staff_for_owners
  on public.business_memberships
  for delete
  to authenticated
  using (
    role = 'staff'::public.business_member_role
    and user_id <> (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
