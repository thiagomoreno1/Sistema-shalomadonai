-- Keep the WhatsApp group subject separate from a participant's push name.
alter table public.whatsapp_conversations
  add column group_subject text
  check (group_subject is null or char_length(btrim(group_subject)) <= 160);

comment on column public.whatsapp_conversations.group_subject is
  'Authoritative WhatsApp group subject. Participant names stay on individual messages.';

-- Merge only a confirmed LID/phone duplicate. This is restricted to the
-- server-side service role and refuses ambiguous identities or conflicting
-- history/context so callers cannot discard data by guessing.
create function public.merge_whatsapp_conversation_pair(
  p_business_id uuid,
  p_instance_name text,
  p_source_conversation_id uuid,
  p_target_conversation_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  source_row public.whatsapp_conversations%rowtype;
  target_row public.whatsapp_conversations%rowtype;
  source_context public.whatsapp_conversation_contexts%rowtype;
  target_context public.whatsapp_conversation_contexts%rowtype;
  source_has_context boolean := false;
  target_has_context boolean := false;
  direct_match_count bigint;
  duplicate_messages bigint;
  duplicate_calls bigint;
begin
  if p_business_id is null or p_instance_name is null
     or p_source_conversation_id is null or p_target_conversation_id is null
     or p_source_conversation_id = p_target_conversation_id then
    raise exception using errcode = '22023', message = 'Invalid WhatsApp conversation merge request.';
  end if;

  select * into source_row
    from public.whatsapp_conversations
   where business_id = p_business_id
     and instance_name = p_instance_name
     and id = p_source_conversation_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WhatsApp source conversation was not found.';
  end if;

  select * into target_row
    from public.whatsapp_conversations
   where business_id = p_business_id
     and instance_name = p_instance_name
     and id = p_target_conversation_id
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WhatsApp target conversation was not found.';
  end if;

  if source_row.remote_jid ilike '%@g.us'
     or target_row.remote_jid ilike '%@g.us'
     or source_row.contact_name is null
     or lower(btrim(source_row.contact_name)) <> lower(btrim(target_row.contact_name))
     or source_row.last_activity_at is distinct from target_row.last_activity_at
     or not (
       (source_row.remote_jid ilike '%@lid' and target_row.remote_jid ilike '%@s.whatsapp.net'
         and source_row.contact_phone is null and target_row.contact_phone is not null)
       or
       (target_row.remote_jid ilike '%@lid' and source_row.remote_jid ilike '%@s.whatsapp.net'
         and target_row.contact_phone is null and source_row.contact_phone is not null)
     ) then
    raise exception using errcode = '22023', message = 'WhatsApp conversations do not meet safe LID duplicate criteria.';
  end if;

  select count(*) into direct_match_count
    from public.whatsapp_conversations conversation_row
   where conversation_row.business_id = p_business_id
     and conversation_row.instance_name = p_instance_name
     and conversation_row.remote_jid not ilike '%@g.us'
     and lower(btrim(conversation_row.contact_name)) = lower(btrim(source_row.contact_name));
  if direct_match_count <> 2 then
    raise exception using errcode = '22023', message = 'WhatsApp contact name is ambiguous; no conversations were merged.';
  end if;

  select count(*) into duplicate_messages
    from public.whatsapp_messages source_message
    join public.whatsapp_messages target_message
      on target_message.business_id = source_message.business_id
     and target_message.instance_name = source_message.instance_name
     and target_message.provider_message_id = source_message.provider_message_id
   where source_message.business_id = p_business_id
     and source_message.conversation_id = p_source_conversation_id
     and target_message.conversation_id = p_target_conversation_id;
  if duplicate_messages > 0 then
    raise exception using errcode = '23505', message = 'WhatsApp histories contain duplicate provider message IDs; no conversations were merged.';
  end if;

  select count(*) into duplicate_calls
    from public.whatsapp_call_events source_call
    join public.whatsapp_call_events target_call
      on target_call.business_id = source_call.business_id
     and target_call.instance_name = source_call.instance_name
     and target_call.provider_event_key = source_call.provider_event_key
   where source_call.business_id = p_business_id
     and source_call.conversation_id = p_source_conversation_id
     and target_call.conversation_id = p_target_conversation_id;
  if duplicate_calls > 0 then
    raise exception using errcode = '23505', message = 'WhatsApp histories contain duplicate call event IDs; no conversations were merged.';
  end if;

  select * into source_context
    from public.whatsapp_conversation_contexts
   where business_id = p_business_id and conversation_id = p_source_conversation_id
   for update;
  source_has_context := found;

  select * into target_context
    from public.whatsapp_conversation_contexts
   where business_id = p_business_id and conversation_id = p_target_conversation_id
   for update;
  target_has_context := found;

  if source_has_context and target_has_context
     and source_context.match_method = 'manual'
     and target_context.match_method = 'manual'
     and (source_context.customer_id is distinct from target_context.customer_id
       or source_context.order_id is distinct from target_context.order_id) then
    raise exception using errcode = '23505', message = 'WhatsApp conversations have conflicting manual links; no conversations were merged.';
  end if;

  update public.whatsapp_messages
     set conversation_id = p_target_conversation_id
   where business_id = p_business_id
     and conversation_id = p_source_conversation_id;

  update public.whatsapp_call_events
     set conversation_id = p_target_conversation_id
   where business_id = p_business_id
     and conversation_id = p_source_conversation_id;

  if source_has_context and not target_has_context then
    update public.whatsapp_conversation_contexts
       set conversation_id = p_target_conversation_id
     where business_id = p_business_id
       and conversation_id = p_source_conversation_id;
  elsif source_has_context and target_has_context then
    if source_context.match_method = 'manual' and target_context.match_method = 'phone' then
      update public.whatsapp_conversation_contexts
         set customer_id = source_context.customer_id,
             order_id = source_context.order_id,
             match_method = source_context.match_method,
             updated_by = source_context.updated_by,
             updated_at = source_context.updated_at
       where business_id = p_business_id
         and conversation_id = p_target_conversation_id;
    end if;
    delete from public.whatsapp_conversation_contexts
     where business_id = p_business_id
       and conversation_id = p_source_conversation_id;
  end if;

  update public.whatsapp_conversations
     set contact_name = coalesce(target_row.contact_name, source_row.contact_name),
         contact_phone = coalesce(target_row.contact_phone, source_row.contact_phone),
         remote_jid_alt = coalesce(target_row.remote_jid_alt, source_row.remote_jid_alt),
         status = case when target_row.status = 'open' or source_row.status = 'open' then 'open' else 'resolved' end,
         unread_count = target_row.unread_count + source_row.unread_count,
         last_activity_at = greatest(target_row.last_activity_at, source_row.last_activity_at)
   where business_id = p_business_id and id = p_target_conversation_id;

  delete from public.whatsapp_conversations
   where business_id = p_business_id and id = p_source_conversation_id;

  return p_target_conversation_id;
end;
$function$;

revoke all on function public.merge_whatsapp_conversation_pair(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_whatsapp_conversation_pair(uuid, text, uuid, uuid) to service_role;
