-- Import a bounded customer batch atomically. Idempotency metadata stores only
-- the request UUID, row count, and an HMAC fingerprint. The private key prevents
-- offline guessing of customer data from the fingerprint.
create extension if not exists pgcrypto with schema extensions;

create table private.customer_import_request_hmac_keys (
  id boolean primary key default true check (id),
  secret bytea not null check (pg_catalog.octet_length(secret) = 32)
);

revoke all on table private.customer_import_request_hmac_keys from public, anon, authenticated;

insert into private.customer_import_request_hmac_keys (id, secret)
values (true, extensions.gen_random_bytes(32));

create table private.customer_import_requests (
  business_id uuid not null references public.businesses (id) on delete restrict,
  request_id uuid not null,
  imported_count integer not null check (imported_count between 1 and 2000),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id)
);

revoke all on table private.customer_import_requests from public, anon, authenticated;

create function public.import_customers(
  p_request_id uuid,
  p_customers jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_business_id uuid;
  v_membership_count integer;
  v_existing_count integer;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_customer_count integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Customer import access denied.';
  end if;

  -- The application currently supports one business membership per user.
  -- Derive it here rather than accepting a caller-selected tenant identifier.
  select pg_catalog.min(membership.business_id::text)::uuid,
         pg_catalog.count(*)::integer
    into v_business_id, v_membership_count
    from public.business_memberships as membership
   where membership.user_id = v_user_id;

  if v_membership_count <> 1
     or not (select private.is_business_owner(v_business_id)) then
    raise exception using errcode = '42501', message = 'Customer import access denied.';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'An import request id is required.';
  end if;
  if p_customers is null or pg_catalog.jsonb_typeof(p_customers) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'The customer import must be a JSON array.';
  end if;
  if pg_catalog.jsonb_array_length(p_customers) < 1
     or pg_catalog.jsonb_array_length(p_customers) > 2000 then
    raise exception using errcode = '22023', message = 'The import must contain between 1 and 2000 customers.';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_customers) as item(value)
     where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
  ) or exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_customers) as item(value)
      cross join lateral pg_catalog.jsonb_each(
        case when pg_catalog.jsonb_typeof(item.value) = 'object'
             then item.value else '{}'::jsonb end
      ) as property(key, value)
     where property.key not in ('name', 'phone', 'whatsapp_phone', 'delivery_address', 'notes')
        or pg_catalog.jsonb_typeof(property.value) not in ('string', 'null')
  ) or exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_customers) as item(value)
     where pg_catalog.jsonb_typeof(item.value -> 'name') is distinct from 'string'
        or (item.value ? 'phone' and pg_catalog.jsonb_typeof(item.value -> 'phone') not in ('string', 'null'))
        or (item.value ? 'whatsapp_phone' and pg_catalog.jsonb_typeof(item.value -> 'whatsapp_phone') not in ('string', 'null'))
        or (item.value ? 'delivery_address' and pg_catalog.jsonb_typeof(item.value -> 'delivery_address') not in ('string', 'null'))
        or (item.value ? 'notes' and pg_catalog.jsonb_typeof(item.value -> 'notes') not in ('string', 'null'))
  ) then
    raise exception using errcode = '22023', message = 'The customer import contains an invalid row shape.';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_to_recordset(p_customers) as customer(
        name text, phone text, whatsapp_phone text, delivery_address text, notes text
      )
     where customer.name is null
        or pg_catalog.char_length(pg_catalog.btrim(customer.name)) not between 1 and 160
        or (customer.phone is not null and (
          customer.phone !~ '^[+][1-9][0-9]{7,14}$'
          or pg_catalog.char_length(customer.phone) > 64
        ))
        or (customer.whatsapp_phone is not null and (
          customer.whatsapp_phone !~ '^[+][1-9][0-9]{7,14}$'
          or pg_catalog.char_length(customer.whatsapp_phone) > 64
        ))
        or (customer.delivery_address is not null and pg_catalog.char_length(customer.delivery_address) > 1000)
        or (customer.notes is not null and pg_catalog.char_length(customer.notes) > 4000)
  ) then
    raise exception using errcode = '22023', message = 'The customer import contains invalid names, phones, or oversized fields.';
  end if;

  select pg_catalog.encode(
           extensions.hmac(
             pg_catalog.convert_to(pg_catalog.jsonb_build_object(
               'operation', 'customer-import-v1',
               'business_id', v_business_id,
               'customers', p_customers
             )::text, 'UTF8'),
             key.secret,
             'sha256'
           ),
           'hex'
         )
    into v_fingerprint
    from private.customer_import_request_hmac_keys as key
   where key.id;
  if v_fingerprint is null then
    raise exception using errcode = '55000', message = 'Customer import idempotency is not configured.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(v_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );
  select request.imported_count, request.request_fingerprint
    into v_existing_count, v_existing_fingerprint
    from private.customer_import_requests as request
   where request.business_id = v_business_id
     and request.request_id = p_request_id;
  if found then
    if v_existing_count <> pg_catalog.jsonb_array_length(p_customers)
       or v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This import request id was already used for a different customer batch.';
    end if;
    return v_existing_count;
  end if;

  select pg_catalog.count(*)::integer into v_customer_count
    from pg_catalog.jsonb_array_elements(p_customers);

  insert into public.customers (
    business_id, name, phone, whatsapp_phone, delivery_address, notes, created_by
  )
  select v_business_id,
         pg_catalog.btrim(customer.name),
         nullif(pg_catalog.btrim(customer.phone), ''),
         nullif(pg_catalog.btrim(customer.whatsapp_phone), ''),
         nullif(pg_catalog.btrim(customer.delivery_address), ''),
         nullif(pg_catalog.btrim(customer.notes), ''),
         v_user_id
    from pg_catalog.jsonb_to_recordset(p_customers) as customer(
      name text, phone text, whatsapp_phone text, delivery_address text, notes text
    );

  insert into private.customer_import_requests (
    business_id, request_id, imported_count, request_fingerprint, created_by
  ) values (
    v_business_id, p_request_id, v_customer_count, v_fingerprint, v_user_id
  );

  return v_customer_count;
end;
$function$;

revoke all on function public.import_customers(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_customers(uuid, jsonb) to authenticated;
