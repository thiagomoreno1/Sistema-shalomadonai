-- Owner-only, tenant-scoped duplicate suggestions. This lookup is advisory:
-- it never creates, blocks, merges, or changes customer records.

create function public.find_customer_phone_matches(
  p_phone text,
  p_whatsapp_phone text
)
returns table (
  id uuid,
  name text,
  matched_phone_masked text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_authenticated_user_id uuid := (select auth.uid());
  v_business_id uuid;
  v_owner_count bigint;
  v_phone_digits text;
  v_whatsapp_digits text;
begin
  if v_authenticated_user_id is null then
    raise exception using errcode = '42501', message = 'Customer lookup access denied.';
  end if;

  if pg_catalog.char_length(coalesce(p_phone, '')) > 64
     or pg_catalog.char_length(coalesce(p_whatsapp_phone, '')) > 64 then
    raise exception using errcode = '22023', message = 'Phone input is too long.';
  end if;

  select pg_catalog.count(*)
    into v_owner_count
    from public.business_memberships as membership
   where membership.user_id = v_authenticated_user_id
     and membership.role = 'owner'::public.business_member_role;

  if v_owner_count <> 1 then
    raise exception using errcode = '42501', message = 'Customer lookup access denied.';
  end if;

  select membership.business_id
    into v_business_id
    from public.business_memberships as membership
   where membership.user_id = v_authenticated_user_id
     and membership.role = 'owner'::public.business_member_role
   order by membership.business_id
   limit 1;

  if not (select private.is_business_owner(v_business_id)) then
    raise exception using errcode = '42501', message = 'Customer lookup access denied.';
  end if;

  v_phone_digits := pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_whatsapp_digits := pg_catalog.regexp_replace(coalesce(p_whatsapp_phone, ''), '[^0-9]', '', 'g');

  return query
  with input_numbers as (
    select distinct candidate.digits
      from (values (v_phone_digits), (v_whatsapp_digits)) as candidate(digits)
     where pg_catalog.char_length(candidate.digits) between 8 and 15
  ), matching_numbers as (
    select customer.id as customer_id,
           customer.name as customer_name,
           pg_catalog.regexp_replace(saved.phone_value, '[^0-9]', '', 'g') as saved_digits
      from public.customers as customer
      cross join lateral (values (customer.phone), (customer.whatsapp_phone)) as saved(phone_value)
      cross join input_numbers as input
     where customer.business_id = v_business_id
       and customer.is_active
       and saved.phone_value is not null
       and pg_catalog.regexp_replace(saved.phone_value, '[^0-9]', '', 'g') = input.digits
  ), one_match_per_customer as (
    select distinct on (matching.customer_id)
           matching.customer_id,
           matching.customer_name,
           '•••• ' || pg_catalog.right(matching.saved_digits, 4) as phone_masked
      from matching_numbers as matching
     order by matching.customer_id, matching.saved_digits
  )
  select match.customer_id,
         match.customer_name,
         match.phone_masked
    from one_match_per_customer as match
   order by match.customer_name, match.customer_id
   limit 5;
end;
$function$;

revoke all on function public.find_customer_phone_matches(text, text) from public, anon, authenticated;
grant execute on function public.find_customer_phone_matches(text, text) to authenticated;
