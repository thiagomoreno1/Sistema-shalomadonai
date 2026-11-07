-- Store local WhatsApp contact preferences separately from provider data and
-- from the optional CRM customer/order link.
alter table public.whatsapp_conversations
  add column display_name_override text,
  add column contact_classification text not null default 'unclassified',
  add column hidden_from_inbox boolean not null default false,
  add column contact_preferences_updated_at timestamptz,
  add constraint whatsapp_conversations_display_name_override_check
    check (display_name_override is null or (
      char_length(btrim(display_name_override)) between 1 and 160
      and char_length(display_name_override) <= 160
    )),
  add constraint whatsapp_conversations_contact_classification_check
    check (contact_classification in ('unclassified', 'customer', 'personal'));

comment on column public.whatsapp_conversations.display_name_override is
  'Owner-configured local display name. It never changes the provider contact name or identity.';
comment on column public.whatsapp_conversations.contact_classification is
  'Local inbox classification independent of the CRM customer link.';
comment on column public.whatsapp_conversations.hidden_from_inbox is
  'Hides this conversation from active inbox segments without deleting its history.';
comment on column public.whatsapp_conversations.contact_preferences_updated_at is
  'Timestamp used to preserve the newest local contact preferences when canonical identities merge.';

create index whatsapp_conversations_contact_segment_idx
  on public.whatsapp_conversations (
    business_id, instance_name, hidden_from_inbox, contact_classification,
    last_activity_at desc, id asc
  );

-- Keep the exact canonical merge guard: the source and target must already be
-- linked by a confirmed provider-supplied LID/phone mapping. Preserve the
-- latest owner-configured display/classification/visibility preferences.
create or replace function public.merge_whatsapp_conversations_by_identity(
  p_business_id uuid,
  p_instance_name text,
  p_lid_jid text,
  p_phone_jid text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_conversation_id uuid;
  target_conversation_id uuid;
  source_row public.whatsapp_conversations%rowtype;
  target_row public.whatsapp_conversations%rowtype;
  source_context public.whatsapp_conversation_contexts%rowtype;
  target_context public.whatsapp_conversation_contexts%rowtype;
  source_has_context boolean := false;
  target_has_context boolean := false;
  duplicate_messages bigint;
  duplicate_calls bigint;
  source_preferences_are_newer boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Not authorized to merge WhatsApp conversations.';
  end if;
  if p_business_id is null or p_instance_name is null
     or p_lid_jid !~* '^[a-z0-9._:-]{1,128}@lid$'
     or p_phone_jid !~* '^[0-9]{8,15}@(s\.whatsapp\.net)$' then
    raise exception using errcode = '22023', message = 'Invalid WhatsApp identity merge request.';
  end if;
  if not exists (
    select 1 from public.whatsapp_contact_jid_mappings identity_row
     where identity_row.business_id = p_business_id
       and identity_row.instance_name = p_instance_name
       and identity_row.lid_jid = lower(p_lid_jid)
       and identity_row.phone_jid = lower(p_phone_jid)
       and not identity_row.identity_conflict
  ) then
    raise exception using errcode = '42501', message = 'WhatsApp identity mapping was not confirmed by the provider.';
  end if;

  select alias_row.conversation_id into source_conversation_id
    from public.whatsapp_conversation_jid_aliases alias_row
   where alias_row.business_id = p_business_id
     and alias_row.instance_name = p_instance_name
     and alias_row.remote_jid = lower(p_lid_jid);
  select alias_row.conversation_id into target_conversation_id
    from public.whatsapp_conversation_jid_aliases alias_row
   where alias_row.business_id = p_business_id
     and alias_row.instance_name = p_instance_name
     and alias_row.remote_jid = lower(p_phone_jid);
  if source_conversation_id is null or target_conversation_id is null then
    return coalesce(target_conversation_id, source_conversation_id);
  end if;
  if source_conversation_id = target_conversation_id then
    return target_conversation_id;
  end if;

  select * into source_row
    from public.whatsapp_conversations
   where business_id = p_business_id and instance_name = p_instance_name
     and id = source_conversation_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WhatsApp LID conversation was not found.';
  end if;
  select * into target_row
    from public.whatsapp_conversations
   where business_id = p_business_id and instance_name = p_instance_name
     and id = target_conversation_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WhatsApp phone conversation was not found.';
  end if;
  if source_row.remote_jid ilike '%@g.us' or target_row.remote_jid ilike '%@g.us' then
    raise exception using errcode = '22023', message = 'Group conversations cannot be joined to contacts.';
  end if;

  select count(*) into duplicate_messages
    from public.whatsapp_messages source_message
    join public.whatsapp_messages target_message
      on target_message.business_id = source_message.business_id
     and target_message.instance_name = source_message.instance_name
     and target_message.provider_message_id = source_message.provider_message_id
   where source_message.business_id = p_business_id
     and source_message.conversation_id = source_conversation_id
     and target_message.conversation_id = target_conversation_id;
  if duplicate_messages > 0 then
    raise exception using errcode = '23505', message = 'WhatsApp histories contain duplicate message IDs.';
  end if;
  select count(*) into duplicate_calls
    from public.whatsapp_call_events source_call
    join public.whatsapp_call_events target_call
      on target_call.business_id = source_call.business_id
     and target_call.instance_name = source_call.instance_name
     and target_call.provider_event_key = source_call.provider_event_key
   where source_call.business_id = p_business_id
     and source_call.conversation_id = source_conversation_id
     and target_call.conversation_id = target_conversation_id;
  if duplicate_calls > 0 then
    raise exception using errcode = '23505', message = 'WhatsApp histories contain duplicate call event IDs.';
  end if;

  select * into source_context
    from public.whatsapp_conversation_contexts
   where business_id = p_business_id and conversation_id = source_conversation_id
   for update;
  source_has_context := found;
  select * into target_context
    from public.whatsapp_conversation_contexts
   where business_id = p_business_id and conversation_id = target_conversation_id
   for update;
  target_has_context := found;
  if source_has_context and target_has_context
     and source_context.match_method = 'manual'
     and target_context.match_method = 'manual'
     and (source_context.customer_id is distinct from target_context.customer_id
       or source_context.order_id is distinct from target_context.order_id) then
    raise exception using errcode = '23505', message = 'WhatsApp conversations have conflicting manual links.';
  end if;

  source_preferences_are_newer := source_row.contact_preferences_updated_at is not null
    and (target_row.contact_preferences_updated_at is null
      or source_row.contact_preferences_updated_at > target_row.contact_preferences_updated_at);

  update public.whatsapp_messages
     set conversation_id = target_conversation_id
   where business_id = p_business_id and conversation_id = source_conversation_id;
  update public.whatsapp_call_events
     set conversation_id = target_conversation_id
   where business_id = p_business_id and conversation_id = source_conversation_id;
  update public.whatsapp_conversation_jid_aliases
     set conversation_id = target_conversation_id
   where business_id = p_business_id and instance_name = p_instance_name
     and conversation_id = source_conversation_id;

  if source_has_context and not target_has_context then
    update public.whatsapp_conversation_contexts
       set conversation_id = target_conversation_id
     where business_id = p_business_id and conversation_id = source_conversation_id;
  elsif source_has_context and target_has_context then
    if source_context.match_method = 'manual' and target_context.match_method = 'phone' then
      update public.whatsapp_conversation_contexts
         set customer_id = source_context.customer_id,
             order_id = source_context.order_id,
             match_method = source_context.match_method,
             updated_by = source_context.updated_by,
             updated_at = source_context.updated_at
       where business_id = p_business_id and conversation_id = target_conversation_id;
    end if;
    delete from public.whatsapp_conversation_contexts
     where business_id = p_business_id and conversation_id = source_conversation_id;
  end if;

  update public.whatsapp_conversations
     set contact_name = coalesce(target_row.contact_name, source_row.contact_name),
         contact_phone = coalesce(target_row.contact_phone, source_row.contact_phone),
         remote_jid_alt = coalesce(target_row.remote_jid_alt, source_row.remote_jid_alt, lower(p_lid_jid)),
         display_name_override = case when source_preferences_are_newer then source_row.display_name_override else target_row.display_name_override end,
         contact_classification = case when source_preferences_are_newer then source_row.contact_classification else target_row.contact_classification end,
         hidden_from_inbox = case when source_preferences_are_newer then source_row.hidden_from_inbox else target_row.hidden_from_inbox end,
         contact_preferences_updated_at = greatest(target_row.contact_preferences_updated_at, source_row.contact_preferences_updated_at),
         status = case when target_row.status = 'open' or source_row.status = 'open' then 'open' else 'resolved' end,
         unread_count = target_row.unread_count + source_row.unread_count,
         last_activity_at = greatest(target_row.last_activity_at, source_row.last_activity_at)
   where business_id = p_business_id and id = target_conversation_id;
  delete from public.whatsapp_conversations
   where business_id = p_business_id and id = source_conversation_id;
  return target_conversation_id;
end;
$function$;

revoke all on function public.merge_whatsapp_conversations_by_identity(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.merge_whatsapp_conversations_by_identity(uuid, text, text, text) to service_role;
