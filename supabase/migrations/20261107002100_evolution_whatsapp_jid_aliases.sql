-- Keep every known WhatsApp JID attached to one conversation. Evolution can
-- switch a direct chat between LID and phone JIDs as profile data is resolved.
create table public.whatsapp_conversation_jid_aliases (
  business_id uuid not null,
  instance_name text not null check (char_length(btrim(instance_name)) between 1 and 120),
  remote_jid text not null check (char_length(btrim(remote_jid)) between 1 and 256),
  conversation_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (business_id, instance_name, remote_jid),
  foreign key (business_id, conversation_id)
    references public.whatsapp_conversations (business_id, id) on delete cascade
);

create index whatsapp_conversation_jid_aliases_conversation_idx
  on public.whatsapp_conversation_jid_aliases (business_id, conversation_id);

alter table public.whatsapp_conversation_jid_aliases enable row level security;
revoke all on table public.whatsapp_conversation_jid_aliases from public, anon, authenticated;
grant all on table public.whatsapp_conversation_jid_aliases to service_role;

insert into public.whatsapp_conversation_jid_aliases (business_id, instance_name, remote_jid, conversation_id)
select business_id, instance_name, remote_jid, id
  from public.whatsapp_conversations
on conflict (business_id, instance_name, remote_jid) do nothing;

insert into public.whatsapp_conversation_jid_aliases (business_id, instance_name, remote_jid, conversation_id)
select business_id, instance_name, remote_jid_alt, id
  from public.whatsapp_conversations
 where remote_jid_alt is not null
on conflict (business_id, instance_name, remote_jid) do nothing;
