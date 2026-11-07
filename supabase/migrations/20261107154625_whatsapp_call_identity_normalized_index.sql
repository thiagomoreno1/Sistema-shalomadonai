drop index if exists public.whatsapp_call_events_identity_lookup_idx;

create index if not exists whatsapp_call_events_identity_lookup_idx
  on public.whatsapp_call_events (business_id, instance_name, lower(caller_jid))
  where caller_phone is null and caller_jid is not null;
