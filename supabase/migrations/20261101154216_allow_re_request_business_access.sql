-- Let an authenticated account retry its access request after the owner removes it.
create function public.request_business_access()
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

  select business.id
  into target_business_id
  from public.businesses as business
  order by business.created_at asc
  limit 1;

  select auth_user.email
  into actor_email
  from auth.users as auth_user
  where auth_user.id = actor_id;

  if target_business_id is null or actor_email is null then
    raise exception using errcode = 'P0002', message = 'The business or account email was not found.';
  end if;

  if exists (
    select 1
    from public.business_memberships as membership
    where membership.user_id = actor_id
  ) then
    raise exception using errcode = '23505', message = 'This account already has business access.';
  end if;

  insert into public.business_access_requests (business_id, user_id, email)
  values (target_business_id, actor_id, lower(actor_email))
  on conflict (business_id, user_id) do update
    set email = excluded.email;
end;
$function$;

revoke all on function public.request_business_access() from public, anon, authenticated;
grant execute on function public.request_business_access() to authenticated;
