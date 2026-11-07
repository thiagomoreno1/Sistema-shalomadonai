-- The conversation's canonical remote_jid is authoritative when a historical
-- alias row was attached to a different conversation. This repairs only the
-- alias owner; messages and conversation records are not merged or moved.
update public.whatsapp_conversation_jid_aliases as alias_row
   set conversation_id = canonical.id
  from public.whatsapp_conversations as canonical
 where canonical.business_id = alias_row.business_id
   and canonical.instance_name = alias_row.instance_name
   and lower(canonical.remote_jid) = alias_row.remote_jid
   and canonical.id <> alias_row.conversation_id;
