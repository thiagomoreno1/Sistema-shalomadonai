-- Keep an immutable record when the business owner revokes a staff membership.
-- The removed user ID is a snapshot, not a foreign key, so account deletion
-- cannot erase the access history.
create table public.business_membership_removals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  removed_user_id uuid not null,
  removed_email text not null check (pg_catalog.char_length(pg_catalog.btrim(removed_email)) between 1 and 320),
  removed_by uuid not null references auth.users (id) on delete restrict,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id)
);

create index business_membership_removals_created_idx
  on public.business_membership_removals (business_id, created_at desc, id desc);

alter table public.business_membership_removals enable row level security;
revoke all on table public.business_membership_removals from public, anon, authenticated;
grant select on table public.business_membership_removals to authenticated;

create policy business_membership_removals_select_for_owners
  on public.business_membership_removals
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create trigger business_membership_removals_append_only
  before update or delete on public.business_membership_removals
  for each row execute function private.reject_immutable_record_change();
create trigger business_membership_removals_reject_truncate
  before truncate on public.business_membership_removals
  for each statement execute function private.reject_immutable_record_change();

-- Member email addresses are read from auth.users only for the owner of the
-- requested business. The table itself remains unavailable through the API.
create function public.list_business_members(p_business_id uuid)
returns table (
  member_user_id uuid,
  member_email text,
  member_role public.business_member_role,
  member_created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null
     or p_business_id is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Only the business owner can list team members.';
  end if;

  return query
  select membership.user_id,
         auth_user.email::text,
         membership.role,
         membership.created_at
    from public.business_memberships as membership
    left join auth.users as auth_user on auth_user.id = membership.user_id
   where membership.business_id = p_business_id
   order by case membership.role
              when 'owner'::public.business_member_role then 0
              else 1
            end,
            membership.created_at,
            membership.user_id;
end;
$function$;

revoke all on function public.list_business_members(uuid) from public, anon, authenticated;
grant execute on function public.list_business_members(uuid) to authenticated;

-- All authenticated deletions must go through this owner-checked, audited RPC.
drop policy if exists business_memberships_delete_staff_for_owners on public.business_memberships;
revoke delete on table public.business_memberships from authenticated;

-- Staff approvals must go through approve_business_access_request so its
-- access-request and single-business checks cannot be bypassed by direct INSERT.
drop policy if exists business_memberships_insert_staff_for_owners on public.business_memberships;
revoke insert on table public.business_memberships from authenticated;
revoke insert (business_id, user_id, role) on table public.business_memberships from authenticated;

create function public.revoke_business_staff_access(
  p_business_id uuid,
  p_user_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := (select auth.uid());
  v_member_role public.business_member_role;
  v_member_email text;
  v_fingerprint text;
  v_existing_fingerprint text;
  v_removal_id uuid;
  v_deleted_count integer;
begin
  if actor_id is null
     or p_business_id is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Only the business owner can revoke team access.';
  end if;

  if p_user_id is null or p_request_id is null or p_user_id = actor_id then
    raise exception using errcode = '22023', message = 'Choose another team member to revoke.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'revoke_business_staff_access',
    'business_id', p_business_id,
    'user_id', p_user_id
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text),
    pg_catalog.hashtext(p_request_id::text)
  );

  select removal.id, removal.request_fingerprint
    into v_removal_id, v_existing_fingerprint
    from public.business_membership_removals as removal
   where removal.business_id = p_business_id
     and removal.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for a different team member.';
    end if;
    return v_removal_id;
  end if;

  select membership.role,
         pg_catalog.lower(pg_catalog.btrim(auth_user.email))
    into v_member_role, v_member_email
    from public.business_memberships as membership
    left join auth.users as auth_user on auth_user.id = membership.user_id
   where membership.business_id = p_business_id
     and membership.user_id = p_user_id
   for update of membership;

  if not found then
    raise exception using errcode = 'P0002', message = 'The team member was not found.';
  end if;
  if v_member_role <> 'staff'::public.business_member_role then
    raise exception using errcode = '22023', message = 'The business owner membership cannot be removed.';
  end if;
  if v_member_email is null or pg_catalog.char_length(v_member_email) = 0 then
    raise exception using errcode = '23514', message = 'The team member email is unavailable for the access history.';
  end if;

  insert into public.business_membership_removals (
    business_id,
    removed_user_id,
    removed_email,
    removed_by,
    request_id,
    request_fingerprint
  ) values (
    p_business_id,
    p_user_id,
    v_member_email,
    actor_id,
    p_request_id,
    v_fingerprint
  ) returning id into v_removal_id;

  delete from public.business_memberships as membership
   where membership.business_id = p_business_id
     and membership.user_id = p_user_id
     and membership.role = 'staff'::public.business_member_role;
  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> 1 then
    raise exception using errcode = '40001', message = 'The team access changed before removal completed.';
  end if;

  return v_removal_id;
end;
$function$;

revoke all on function public.revoke_business_staff_access(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_business_staff_access(uuid, uuid, uuid) to authenticated;
