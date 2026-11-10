-- Persist provider address-book labels independently from conversations.
-- The directory is scoped to the business and Evolution instance, so a newly
-- paired number never inherits contacts from an archived/test number.
create table public.whatsapp_contact_directory (
  business_id uuid not null,
  instance_name text not null,
  remote_jid text not null check (char_length(btrim(remote_jid)) between 1 and 256),
  remote_jid_alt text check (remote_jid_alt is null or char_length(btrim(remote_jid_alt)) between 1 and 256),
  contact_name text check (contact_name is null or char_length(contact_name) <= 160),
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 32),
  group_subject text check (group_subject is null or char_length(group_subject) <= 160),
  updated_at timestamptz not null default now(),
  primary key (business_id, instance_name, remote_jid),
  constraint whatsapp_contact_directory_connection_fkey
    foreign key (business_id, instance_name)
    references public.whatsapp_connections (business_id, instance_name)
    on delete restrict,
  constraint whatsapp_contact_directory_group_identity_check
    check (group_subject is null or remote_jid ~* '@g\.us$')
);

create index whatsapp_contact_directory_phone_idx
  on public.whatsapp_contact_directory (business_id, instance_name, contact_phone)
  where contact_phone is not null;

create index whatsapp_contact_directory_alt_jid_idx
  on public.whatsapp_contact_directory (business_id, instance_name, remote_jid_alt)
  where remote_jid_alt is not null;

alter table public.whatsapp_contact_directory enable row level security;
revoke all on table public.whatsapp_contact_directory from public, anon, authenticated;
grant all on table public.whatsapp_contact_directory to service_role;

-- Keep call records linkable when contact JID aliases arrive after a CALL event.
-- This remains tied to a verified LID/phone mapping and the current instance.
create index if not exists whatsapp_call_events_identity_lookup_idx
  on public.whatsapp_call_events (business_id, instance_name, caller_jid)
  where caller_phone is null and caller_jid is not null;

create or replace function public.backfill_whatsapp_call_identity_phones(
  p_business_id uuid,
  p_instance_name text,
  p_identities jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  updated_rows integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Not authorized to backfill WhatsApp call identities.';
  end if;

  if p_business_id is null
     or p_instance_name is null
     or char_length(btrim(p_instance_name)) not between 1 and 120
     or p_identities is null
     or jsonb_typeof(p_identities) <> 'array'
     or jsonb_array_length(p_identities) > 3000 then
    raise exception using errcode = '22023', message = 'Invalid WhatsApp call identity backfill request.';
  end if;

  with requested_pairs as (
    select distinct lower(btrim(identity_row.lid_jid)) as lid_jid,
           lower(btrim(identity_row.phone_jid)) as phone_jid
      from jsonb_to_recordset(p_identities) as identity_row(lid_jid text, phone_jid text)
     where identity_row.lid_jid ~* '^[a-z0-9._:-]{1,128}@lid$'
       and identity_row.phone_jid ~* '^[0-9]{8,15}@s\.whatsapp\.net$'
  ), confirmed_pairs as (
    select requested.lid_jid, requested.phone_jid
      from requested_pairs requested
      join public.whatsapp_contact_jid_mappings mapping
        on mapping.business_id = p_business_id
       and mapping.instance_name = p_instance_name
       and mapping.lid_jid = requested.lid_jid
       and mapping.phone_jid = requested.phone_jid
       and not mapping.identity_conflict
  ), candidate_jids as (
    select pair.lid_jid as caller_jid, pair.phone_jid from confirmed_pairs pair
    union all
    select pair.phone_jid as caller_jid, pair.phone_jid from confirmed_pairs pair
  ), unique_jids as (
    select candidate.caller_jid, min(candidate.phone_jid) as phone_jid
      from candidate_jids candidate
     group by candidate.caller_jid
    having count(distinct candidate.phone_jid) = 1
  )
  update public.whatsapp_call_events call_event
     set caller_phone = case
       when char_length(split_part(identity.phone_jid, '@', 1)) in (10, 11)
         then '+55' || split_part(identity.phone_jid, '@', 1)
       else '+' || split_part(identity.phone_jid, '@', 1)
     end
    from unique_jids identity
   where call_event.business_id = p_business_id
     and call_event.instance_name = p_instance_name
     and call_event.caller_phone is null
     and lower(call_event.caller_jid) = identity.caller_jid;

  get diagnostics updated_rows = row_count;
  return updated_rows;
end;
$function$;

revoke all on function public.backfill_whatsapp_call_identity_phones(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.backfill_whatsapp_call_identity_phones(uuid, text, jsonb)
  to service_role;
