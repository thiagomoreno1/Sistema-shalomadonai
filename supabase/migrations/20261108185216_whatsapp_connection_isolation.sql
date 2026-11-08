-- Give each business WhatsApp number its own Evolution instance namespace.
-- Prior conversations stay in place but the old test instance is archived.

create table public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  instance_name text not null unique
    check (char_length(btrim(instance_name)) between 1 and 120),
  status text not null default 'pending'
    check (status in ('pending', 'active', 'archived')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  archived_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (business_id, instance_name),
  check ((status = 'archived') = (archived_at is not null))
);

create unique index whatsapp_connections_one_current_per_business_idx
  on public.whatsapp_connections (business_id)
  where status in ('pending', 'active');

create index whatsapp_connections_business_status_idx
  on public.whatsapp_connections (business_id, status, created_at desc);

alter table public.whatsapp_connections enable row level security;
revoke all on table public.whatsapp_connections from public, anon, authenticated;
grant all on table public.whatsapp_connections to service_role;

-- Register every legacy instance found in stored inbox data, not just the
-- current Vault value. They remain archived so the next pairing starts fresh.
insert into public.whatsapp_connections (business_id, instance_name, status, archived_at)
select distinct legacy.business_id, legacy.instance_name, 'archived', now()
  from (
    select business_id, instance_name from public.whatsapp_conversations
    union
    select business_id, instance_name from public.whatsapp_messages
    union
    select business_id, instance_name from public.whatsapp_call_events
    union
    select business_id, instance_name from public.whatsapp_conversation_jid_aliases
    union
    select business_secret.decrypted_secret::uuid, instance_secret.decrypted_secret
      from vault.decrypted_secrets as business_secret
      join vault.decrypted_secrets as instance_secret on true
     where business_secret.name = 'evolution_business_id'
       and instance_secret.name = 'evolution_instance_name'
       and business_secret.decrypted_secret ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       and char_length(btrim(instance_secret.decrypted_secret)) between 1 and 120
  ) as legacy
  join public.businesses as business_row on business_row.id = legacy.business_id
 where char_length(btrim(legacy.instance_name)) between 1 and 120
on conflict do nothing;

-- Make the provider instance part of every inbox relationship. NOT VALID
-- keeps the migration safe if older rows contain inconsistent tags; new writes
-- are enforced immediately and RLS below hides any inconsistent legacy child.
alter table public.whatsapp_conversations
  add constraint whatsapp_conversations_business_instance_id_key
  unique (business_id, instance_name, id);

alter table public.whatsapp_conversations
  add constraint whatsapp_conversations_connection_fkey
  foreign key (business_id, instance_name)
  references public.whatsapp_connections (business_id, instance_name)
  on delete restrict;

alter table public.whatsapp_messages
  drop constraint if exists whatsapp_messages_business_id_conversation_id_fkey;
alter table public.whatsapp_messages
  add constraint whatsapp_messages_connection_conversation_fkey
  foreign key (business_id, instance_name, conversation_id)
  references public.whatsapp_conversations (business_id, instance_name, id)
  on delete cascade not valid;

alter table public.whatsapp_call_events
  drop constraint if exists whatsapp_call_events_business_id_conversation_id_fkey;
alter table public.whatsapp_call_events
  add constraint whatsapp_call_events_connection_conversation_fkey
  foreign key (business_id, instance_name, conversation_id)
  references public.whatsapp_conversations (business_id, instance_name, id)
  on delete cascade not valid;

alter table public.whatsapp_conversation_jid_aliases
  drop constraint if exists whatsapp_conversation_jid_aliases_business_id_conversation_id_fkey;
alter table public.whatsapp_conversation_jid_aliases
  add constraint whatsapp_jid_aliases_connection_conversation_fkey
  foreign key (business_id, instance_name, conversation_id)
  references public.whatsapp_conversations (business_id, instance_name, id)
  on delete cascade not valid;

-- Used by authenticated RLS policies. The private SECURITY DEFINER helper
-- reads the server-only registry, then still verifies business membership.
create or replace function private.is_active_whatsapp_instance(
  p_business_id uuid,
  p_instance_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select private.is_business_member(p_business_id))
    and exists (
      select 1
        from public.whatsapp_connections as connection_row
       where connection_row.business_id = p_business_id
         and connection_row.instance_name = p_instance_name
         and connection_row.status in ('pending', 'active')
    );
$function$;

revoke all on function private.is_active_whatsapp_instance(uuid, text) from public, anon, authenticated;
grant execute on function private.is_active_whatsapp_instance(uuid, text) to authenticated;

-- Keep the existing no-argument RPC contract for already deployed callers.
create or replace function public.get_evolution_runtime_config(p_business_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  secrets jsonb;
  configured_business_id uuid;
  selected_instance text;
  selected_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    into secrets
    from vault.decrypted_secrets
   where name in (
     'evolution_api_url',
     'evolution_api_key',
     'evolution_instance_name',
     'evolution_business_id',
     'evolution_webhook_url',
     'evolution_webhook_secret'
   );

  configured_business_id := coalesce(
    p_business_id,
    case
      when secrets->>'evolution_business_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (secrets->>'evolution_business_id')::uuid
      else null
    end
  );

  if configured_business_id is not null then
    select connection_row.instance_name, connection_row.status
      into selected_instance, selected_status
      from public.whatsapp_connections as connection_row
     where connection_row.business_id = configured_business_id
       and connection_row.status in ('pending', 'active')
     limit 1;
  end if;

  secrets := secrets - 'evolution_instance_name';
  return secrets || jsonb_build_object(
    'evolution_instance_name', coalesce(selected_instance, ''),
    'evolution_connection_status', selected_status,
    'evolution_business_id', configured_business_id
  );
end;
$function$;

create or replace function public.get_evolution_runtime_config()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return public.get_evolution_runtime_config(null::uuid);
end;
$function$;

revoke all on function public.get_evolution_runtime_config(uuid) from public, anon, authenticated;
revoke all on function public.get_evolution_runtime_config() from public, anon, authenticated;
grant execute on function public.get_evolution_runtime_config(uuid) to service_role;
grant execute on function public.get_evolution_runtime_config() to service_role;

create or replace function public.start_evolution_connection(p_business_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  selected_instance text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_business_id is null then
    raise exception 'business id is required' using errcode = '22023';
  end if;

  -- Serialize retries and simultaneous connect clicks for this business.
  perform 1 from public.businesses where id = p_business_id for update;
  if not found then
    raise exception 'business not found' using errcode = '23503';
  end if;

  select instance_name
    into selected_instance
    from public.whatsapp_connections
   where business_id = p_business_id
     and status = 'pending'
   limit 1;

  if selected_instance is null and exists (
    select 1 from public.whatsapp_connections
     where business_id = p_business_id and status = 'active'
  ) then
    raise exception 'connection_must_be_archived_first' using errcode = '55000';
  end if;

  if selected_instance is null then
    selected_instance := 'shalom-' || replace(gen_random_uuid()::text, '-', '');
    insert into public.whatsapp_connections (business_id, instance_name, status)
    values (p_business_id, selected_instance, 'pending');
  end if;

  return selected_instance;
end;
$function$;

create or replace function public.activate_evolution_connection(
  p_business_id uuid,
  p_instance_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  rows_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.whatsapp_connections
     set status = 'active',
         activated_at = coalesce(activated_at, now()),
         archived_at = null,
         updated_at = now()
   where business_id = p_business_id
     and instance_name = p_instance_name
     and status in ('pending', 'active');
  get diagnostics rows_updated = row_count;
  return rows_updated = 1;
end;
$function$;

create or replace function public.archive_evolution_connection(
  p_business_id uuid,
  p_instance_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  rows_updated integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform 1 from public.businesses where id = p_business_id for update;
  if not found then
    return false;
  end if;

  update public.whatsapp_connections
     set status = 'archived', archived_at = now(), updated_at = now()
   where business_id = p_business_id
     and instance_name = p_instance_name
     and status in ('pending', 'active');
  get diagnostics rows_updated = row_count;
  if rows_updated = 1 then return true; end if;
  return exists (
    select 1 from public.whatsapp_connections
     where business_id = p_business_id
       and instance_name = p_instance_name
       and status = 'archived'
  );
end;
$function$;

create or replace function public.get_evolution_webhook_connection(p_instance_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  connection_row record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select business_id, status
    into connection_row
    from public.whatsapp_connections
   where instance_name = p_instance_name
   limit 1;

  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'business_id', connection_row.business_id,
    'status', connection_row.status
  );
end;
$function$;

revoke all on function public.start_evolution_connection(uuid) from public, anon, authenticated;
revoke all on function public.activate_evolution_connection(uuid, text) from public, anon, authenticated;
revoke all on function public.archive_evolution_connection(uuid, text) from public, anon, authenticated;
revoke all on function public.get_evolution_webhook_connection(text) from public, anon, authenticated;
grant execute on function public.start_evolution_connection(uuid) to service_role;
grant execute on function public.activate_evolution_connection(uuid, text) to service_role;
grant execute on function public.archive_evolution_connection(uuid, text) to service_role;
grant execute on function public.get_evolution_webhook_connection(text) to service_role;

drop policy whatsapp_conversations_select_for_members on public.whatsapp_conversations;
create policy whatsapp_conversations_select_for_active_connection
  on public.whatsapp_conversations
  for select to authenticated
  using ((select private.is_active_whatsapp_instance(business_id, instance_name)));

drop policy whatsapp_messages_select_for_members on public.whatsapp_messages;
create policy whatsapp_messages_select_for_active_connection
  on public.whatsapp_messages
  for select to authenticated
  using (
    (select private.is_active_whatsapp_instance(business_id, instance_name))
    and exists (
      select 1 from public.whatsapp_conversations as conversation_row
       where conversation_row.business_id = whatsapp_messages.business_id
         and conversation_row.instance_name = whatsapp_messages.instance_name
         and conversation_row.id = whatsapp_messages.conversation_id
         and (select private.is_active_whatsapp_instance(conversation_row.business_id, conversation_row.instance_name))
    )
  );

drop policy whatsapp_call_events_select_for_members on public.whatsapp_call_events;
create policy whatsapp_call_events_select_for_active_connection
  on public.whatsapp_call_events
  for select to authenticated
  using (
    (select private.is_active_whatsapp_instance(business_id, instance_name))
    and exists (
      select 1 from public.whatsapp_conversations as conversation_row
       where conversation_row.business_id = whatsapp_call_events.business_id
         and conversation_row.instance_name = whatsapp_call_events.instance_name
         and conversation_row.id = whatsapp_call_events.conversation_id
         and (select private.is_active_whatsapp_instance(conversation_row.business_id, conversation_row.instance_name))
    )
  );

drop policy whatsapp_contexts_select_for_members on public.whatsapp_conversation_contexts;
create policy whatsapp_contexts_select_for_active_connection
  on public.whatsapp_conversation_contexts
  for select to authenticated
  using (
    (select private.is_business_member(business_id))
    and exists (
      select 1
        from public.whatsapp_conversations as conversation_row
       where conversation_row.business_id = whatsapp_conversation_contexts.business_id
         and conversation_row.id = whatsapp_conversation_contexts.conversation_id
         and (select private.is_active_whatsapp_instance(
           conversation_row.business_id,
           conversation_row.instance_name
         ))
    )
  );

drop policy whatsapp_contexts_insert_for_owners on public.whatsapp_conversation_contexts;
create policy whatsapp_contexts_insert_for_active_connection_owners
  on public.whatsapp_conversation_contexts
  for insert to authenticated
  with check (
    updated_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
    and exists (
      select 1
        from public.whatsapp_conversations as conversation_row
       where conversation_row.business_id = whatsapp_conversation_contexts.business_id
         and conversation_row.id = whatsapp_conversation_contexts.conversation_id
         and (select private.is_active_whatsapp_instance(
           conversation_row.business_id,
           conversation_row.instance_name
         ))
    )
  );

drop policy whatsapp_contexts_update_for_owners on public.whatsapp_conversation_contexts;
create policy whatsapp_contexts_update_for_active_connection_owners
  on public.whatsapp_conversation_contexts
  for update to authenticated
  using (
    (select private.is_business_owner(business_id))
    and exists (
      select 1
        from public.whatsapp_conversations as conversation_row
       where conversation_row.business_id = whatsapp_conversation_contexts.business_id
         and conversation_row.id = whatsapp_conversation_contexts.conversation_id
         and (select private.is_active_whatsapp_instance(
           conversation_row.business_id,
           conversation_row.instance_name
         ))
    )
  )
  with check (
    updated_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
    and exists (
      select 1
        from public.whatsapp_conversations as conversation_row
       where conversation_row.business_id = whatsapp_conversation_contexts.business_id
         and conversation_row.id = whatsapp_conversation_contexts.conversation_id
         and (select private.is_active_whatsapp_instance(
           conversation_row.business_id,
           conversation_row.instance_name
         ))
    )
  );
