-- Serialize alternate-JID registration so webhook and history sync cannot
-- attach the same WhatsApp identity to two conversations concurrently.
create or replace function public.register_whatsapp_conversation_jid_aliases(
  p_business_id uuid,
  p_instance_name text,
  p_conversation_id uuid,
  p_remote_jids text[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  alias_jid text;
begin
  if p_business_id is null
     or p_conversation_id is null
     or p_instance_name is null
     or char_length(btrim(p_instance_name)) not between 1 and 120
     or p_remote_jids is null
     or cardinality(p_remote_jids) > 4 then
    raise exception using errcode = '22023', message = 'Invalid WhatsApp JID alias request.';
  end if;

  if exists (
    select 1
      from unnest(p_remote_jids) as input(remote_jid)
     where input.remote_jid is null
        or input.remote_jid !~* '^[a-z0-9._:-]{1,128}@(s\.whatsapp\.net|lid)$'
  ) then
    raise exception using errcode = '22023', message = 'Invalid WhatsApp JID alias.';
  end if;

  for alias_jid in
    select distinct input.remote_jid
      from unnest(p_remote_jids) as input(remote_jid)
     order by input.remote_jid
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_business_id::text || chr(31) || p_instance_name || chr(31) || lower(alias_jid),
        0
      )
    );
  end loop;

  if exists (
    select 1
      from public.whatsapp_conversation_jid_aliases as alias_row
     where alias_row.business_id = p_business_id
       and alias_row.instance_name = p_instance_name
       and alias_row.remote_jid = any(p_remote_jids)
       and alias_row.conversation_id <> p_conversation_id
  ) then
    raise exception using errcode = 'P0001', message = 'WhatsApp JID alias belongs to another conversation.';
  end if;

  insert into public.whatsapp_conversation_jid_aliases (
    business_id, instance_name, remote_jid, conversation_id
  )
  select p_business_id, p_instance_name, input.remote_jid, p_conversation_id
    from unnest(p_remote_jids) as input(remote_jid)
  on conflict (business_id, instance_name, remote_jid) do nothing;
end;
$function$;

revoke all on function public.register_whatsapp_conversation_jid_aliases(uuid, text, uuid, text[]) from public, anon, authenticated;
grant execute on function public.register_whatsapp_conversation_jid_aliases(uuid, text, uuid, text[]) to service_role;

-- The one-off, manually checked duplicate has already been consolidated.
-- Remove the broad service-role merge primitive so future duplicates require
-- an explicit review instead of a name/timestamp-based deletion path.
drop function if exists public.merge_whatsapp_conversation_pair(uuid, text, uuid, uuid);
