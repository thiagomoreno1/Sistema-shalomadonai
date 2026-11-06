-- Native WhatsApp inbox backed by Evolution API.
-- Provider secrets and raw webhook bodies are never stored in these tables.

create table public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  instance_name text not null check (char_length(btrim(instance_name)) between 1 and 120),
  remote_jid text not null check (char_length(btrim(remote_jid)) between 1 and 256),
  remote_jid_alt text check (remote_jid_alt is null or char_length(btrim(remote_jid_alt)) <= 256),
  contact_name text check (contact_name is null or char_length(btrim(contact_name)) <= 160),
  contact_phone text check (contact_phone is null or char_length(btrim(contact_phone)) <= 64),
  status text not null default 'open' check (status in ('open', 'resolved')),
  unread_count integer not null default 0 check (unread_count >= 0),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, instance_name, remote_jid)
);

create index whatsapp_conversations_inbox_idx
  on public.whatsapp_conversations (business_id, status, last_activity_at desc, id desc);

create index whatsapp_conversations_phone_idx
  on public.whatsapp_conversations (business_id, contact_phone)
  where contact_phone is not null;

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  conversation_id uuid not null,
  instance_name text not null check (char_length(btrim(instance_name)) between 1 and 120),
  provider_message_id text not null check (char_length(btrim(provider_message_id)) between 1 and 256),
  direction text not null check (direction in ('incoming', 'outgoing', 'system')),
  message_kind text not null default 'unknown' check (message_kind in (
    'text', 'image', 'audio', 'video', 'document', 'sticker', 'location',
    'contact', 'interactive', 'reaction', 'unknown'
  )),
  content text check (content is null or char_length(content) <= 65535),
  delivery_status text check (delivery_status is null or delivery_status in (
    'pending', 'sent', 'delivered', 'read', 'played', 'failed', 'deleted'
  )),
  count_as_unread boolean not null default true,
  media_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(media_metadata) = 'object'),
  provider_timestamp timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, instance_name, provider_message_id),
  foreign key (business_id, conversation_id)
    references public.whatsapp_conversations (business_id, id) on delete cascade
);

create index whatsapp_messages_history_idx
  on public.whatsapp_messages (business_id, conversation_id, provider_timestamp, id);

create function private.update_whatsapp_conversation_after_message()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  update public.whatsapp_conversations
     set last_activity_at = greatest(last_activity_at, new.provider_timestamp),
         unread_count = unread_count + case when new.direction = 'incoming' and new.count_as_unread then 1 else 0 end
   where business_id = new.business_id
     and id = new.conversation_id;
  return new;
end;
$function$;

revoke all on function private.update_whatsapp_conversation_after_message() from public, anon, authenticated;

create trigger whatsapp_messages_update_conversation
  after insert on public.whatsapp_messages
  for each row execute function private.update_whatsapp_conversation_after_message();

create table public.whatsapp_call_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  conversation_id uuid not null,
  instance_name text not null check (char_length(btrim(instance_name)) between 1 and 120),
  provider_event_key text not null check (char_length(btrim(provider_event_key)) between 1 and 128),
  provider_call_id text check (provider_call_id is null or char_length(provider_call_id) <= 256),
  caller_jid text check (caller_jid is null or char_length(caller_jid) <= 256),
  caller_phone text check (caller_phone is null or char_length(caller_phone) <= 64),
  event_name text not null default 'CALL' check (event_name = 'CALL'),
  call_state text check (call_state is null or char_length(call_state) <= 64),
  is_video boolean,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (business_id, instance_name, provider_event_key),
  foreign key (business_id, conversation_id)
    references public.whatsapp_conversations (business_id, id) on delete cascade
);

create index whatsapp_call_events_history_idx
  on public.whatsapp_call_events (business_id, occurred_at desc, id desc);

create function private.update_whatsapp_conversation_after_call()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  update public.whatsapp_conversations
     set last_activity_at = greatest(last_activity_at, new.occurred_at)
   where business_id = new.business_id
     and id = new.conversation_id;
  return new;
end;
$function$;

revoke all on function private.update_whatsapp_conversation_after_call() from public, anon, authenticated;

create trigger whatsapp_call_events_update_conversation
  after insert on public.whatsapp_call_events
  for each row execute function private.update_whatsapp_conversation_after_call();

create table public.whatsapp_conversation_contexts (
  business_id uuid not null,
  conversation_id uuid not null,
  customer_id uuid,
  order_id uuid,
  match_method text not null default 'manual' check (match_method in ('phone', 'manual')),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, conversation_id),
  foreign key (business_id, conversation_id)
    references public.whatsapp_conversations (business_id, id) on delete cascade,
  foreign key (business_id, customer_id)
    references public.customers (business_id, id) on delete restrict,
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict,
  check (order_id is null or customer_id is not null)
);

create function private.canonical_whatsapp_phone(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when pg_catalog.char_length(digits) in (10, 11) then '+55' || digits
    when pg_catalog.char_length(digits) in (12, 13) and pg_catalog.left(digits, 2) = '55' then '+' || digits
    else null
  end
    from (
      select pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
    ) as normalized;
$function$;

revoke all on function private.canonical_whatsapp_phone(text) from public, anon, authenticated;
grant execute on function private.canonical_whatsapp_phone(text) to service_role;

-- The resolver is callable only by the server-side webhook client or the
-- protected customer trigger. A per-business/phone transaction lock keeps a
-- concurrent customer registration from creating a false unique match.
create function public.resolve_whatsapp_customer_phone_match(
  p_business_id uuid,
  p_phone text
)
returns table (matched_customer_id uuid, matches_count bigint)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  canonical_phone text;
begin
  canonical_phone := private.canonical_whatsapp_phone(p_phone);
  if p_business_id is null or canonical_phone is null then
    return query select null::uuid, 0::bigint;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text || ':' || canonical_phone, 0)
  );

  return query
  with candidate_numbers as (
    select customer.id as customer_id
      from public.customers as customer
      cross join lateral (values (customer.phone), (customer.whatsapp_phone)) as candidate(phone_value)
     where customer.business_id = p_business_id
       and customer.is_active
       and candidate.phone_value is not null
       and private.canonical_whatsapp_phone(candidate.phone_value) = canonical_phone
     group by customer.id
  )
  select case when pg_catalog.count(*) = 1 then (pg_catalog.array_agg(customer_id))[1] else null end,
         pg_catalog.count(*)
    from candidate_numbers;
end;
$function$;

revoke all on function public.resolve_whatsapp_customer_phone_match(uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_whatsapp_customer_phone_match(uuid, text) to service_role;

-- If a customer is created or their phone changes after a WhatsApp event,
-- attach any matching conversations immediately. Ambiguous or manual links
-- are handled safely and never overwritten.
create function private.refresh_whatsapp_customer_phone_matches()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected_numbers text[];
  conversation_row record;
  existing_link record;
  resolved_customer_id uuid;
  resolved_count bigint;
begin
  if tg_op = 'UPDATE' then
    affected_numbers := array_remove(array[
      private.canonical_whatsapp_phone(old.phone),
      private.canonical_whatsapp_phone(old.whatsapp_phone),
      private.canonical_whatsapp_phone(new.phone),
      private.canonical_whatsapp_phone(new.whatsapp_phone)
    ], null);
  else
    affected_numbers := array_remove(array[
      private.canonical_whatsapp_phone(new.phone),
      private.canonical_whatsapp_phone(new.whatsapp_phone)
    ], null);
  end if;

  if coalesce(cardinality(affected_numbers), 0) = 0 then
    return new;
  end if;

  for conversation_row in
    select id, contact_phone
      from public.whatsapp_conversations
     where business_id = new.business_id
       and contact_phone = any(affected_numbers)
  loop
    select matched_customer_id, matches_count
      into resolved_customer_id, resolved_count
      from public.resolve_whatsapp_customer_phone_match(new.business_id, conversation_row.contact_phone);

    select customer_id, order_id, match_method
      into existing_link
      from public.whatsapp_conversation_contexts
     where business_id = new.business_id
       and conversation_id = conversation_row.id;

    if found then
      if existing_link.match_method = 'manual' or existing_link.order_id is not null then
        continue;
      end if;
    end if;

    if resolved_count = 1 and resolved_customer_id is not null then
      insert into public.whatsapp_conversation_contexts (
        business_id, conversation_id, customer_id, order_id, match_method, updated_by
      ) values (
        new.business_id, conversation_row.id, resolved_customer_id, null, 'phone', null
      )
      on conflict (business_id, conversation_id) do update
        set customer_id = excluded.customer_id,
            match_method = 'phone',
            updated_by = null
        where public.whatsapp_conversation_contexts.match_method = 'phone'
          and public.whatsapp_conversation_contexts.order_id is null;
    else
      delete from public.whatsapp_conversation_contexts
       where business_id = new.business_id
         and conversation_id = conversation_row.id
         and match_method = 'phone'
         and order_id is null;
    end if;
  end loop;

  return new;
end;
$function$;

revoke all on function private.refresh_whatsapp_customer_phone_matches() from public, anon, authenticated;

create trigger customers_refresh_whatsapp_phone_matches
  after insert or update of phone, whatsapp_phone, is_active
  on public.customers
  for each row execute function private.refresh_whatsapp_customer_phone_matches();

create index whatsapp_contexts_customer_idx
  on public.whatsapp_conversation_contexts (business_id, customer_id)
  where customer_id is not null;

create function private.validate_whatsapp_context_order()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  order_customer_id uuid;
begin
  if new.order_id is null then
    return new;
  end if;

  select customer_id
    into order_customer_id
    from public.orders
   where business_id = new.business_id
     and id = new.order_id;

  if not found or order_customer_id is distinct from new.customer_id then
    raise exception using
      errcode = '23503',
      message = 'A WhatsApp conversation order must belong to its linked customer.';
  end if;

  return new;
end;
$function$;

revoke all on function private.validate_whatsapp_context_order() from public, anon, authenticated;

create trigger whatsapp_contexts_validate_order
  before insert or update of business_id, customer_id, order_id
  on public.whatsapp_conversation_contexts
  for each row execute function private.validate_whatsapp_context_order();

create trigger whatsapp_conversations_touch_updated_at
  before update on public.whatsapp_conversations
  for each row execute function private.touch_updated_at();

create trigger whatsapp_contexts_touch_updated_at
  before update on public.whatsapp_conversation_contexts
  for each row execute function private.touch_updated_at();

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_call_events enable row level security;
alter table public.whatsapp_conversation_contexts enable row level security;

revoke all on table public.whatsapp_conversations from public, anon, authenticated;
revoke all on table public.whatsapp_messages from public, anon, authenticated;
revoke all on table public.whatsapp_call_events from public, anon, authenticated;
revoke all on table public.whatsapp_conversation_contexts from public, anon, authenticated;

grant select on table public.whatsapp_conversations to authenticated;
grant select on table public.whatsapp_messages to authenticated;
grant select on table public.whatsapp_call_events to authenticated;
grant select on table public.whatsapp_conversation_contexts to authenticated;
grant insert (business_id, conversation_id, customer_id, order_id, match_method, updated_by)
  on table public.whatsapp_conversation_contexts to authenticated;
grant update (customer_id, order_id, match_method, updated_by)
  on table public.whatsapp_conversation_contexts to authenticated;

create policy whatsapp_conversations_select_for_members
  on public.whatsapp_conversations
  for select to authenticated
  using ((select private.is_business_member(business_id)));

create policy whatsapp_messages_select_for_members
  on public.whatsapp_messages
  for select to authenticated
  using ((select private.is_business_member(business_id)));

create policy whatsapp_call_events_select_for_members
  on public.whatsapp_call_events
  for select to authenticated
  using ((select private.is_business_member(business_id)));

create policy whatsapp_contexts_select_for_members
  on public.whatsapp_conversation_contexts
  for select to authenticated
  using ((select private.is_business_member(business_id)));

create policy whatsapp_contexts_insert_for_owners
  on public.whatsapp_conversation_contexts
  for insert to authenticated
  with check (
    updated_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );

create policy whatsapp_contexts_update_for_owners
  on public.whatsapp_conversation_contexts
  for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (
    updated_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
