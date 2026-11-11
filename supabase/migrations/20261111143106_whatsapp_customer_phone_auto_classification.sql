-- Keep the WhatsApp "Clientes" list in step with a confirmed, unique
-- customer phone match. Explicitly chosen contact preferences always win.
create or replace function private.sync_whatsapp_customer_classification_from_phone_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if old.match_method = 'phone' then
      update public.whatsapp_conversations
         set contact_classification = 'unclassified'
       where business_id = old.business_id
         and id = old.conversation_id
         and contact_classification = 'customer'
         and contact_preferences_updated_at is null;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE'
     and old.match_method = 'phone'
     and (new.match_method <> 'phone' or new.customer_id is distinct from old.customer_id) then
    update public.whatsapp_conversations
       set contact_classification = 'unclassified'
     where business_id = old.business_id
       and id = old.conversation_id
       and contact_classification = 'customer'
       and contact_preferences_updated_at is null;
  end if;

  if new.match_method = 'phone' and new.customer_id is not null then
    update public.whatsapp_conversations
       set contact_classification = 'customer'
     where business_id = new.business_id
       and id = new.conversation_id
       and contact_classification = 'unclassified'
       and contact_preferences_updated_at is null;
  end if;

  return new;
end;
$function$;

revoke all on function private.sync_whatsapp_customer_classification_from_phone_context()
  from public, anon, authenticated;

create trigger whatsapp_context_sync_customer_classification
  after insert or update or delete on public.whatsapp_conversation_contexts
  for each row execute function private.sync_whatsapp_customer_classification_from_phone_context();

-- Backfill existing conversations by phone only. Groups, ambiguous phone
-- matches, manual links, and links that already have an order are preserved.
with customer_numbers as (
  select customer.business_id,
         customer.id as customer_id,
         private.canonical_whatsapp_phone(candidate.phone_value) as phone
    from public.customers as customer
    cross join lateral (values (customer.phone), (customer.whatsapp_phone)) as candidate(phone_value)
   where customer.is_active
     and candidate.phone_value is not null
), unique_matches as (
  select conversation.business_id,
         conversation.id as conversation_id,
         (array_agg(distinct customer_numbers.customer_id))[1] as customer_id
    from public.whatsapp_conversations as conversation
    join customer_numbers
      on customer_numbers.business_id = conversation.business_id
     and customer_numbers.phone = private.canonical_whatsapp_phone(conversation.contact_phone)
   where conversation.contact_phone is not null
     and conversation.remote_jid not like '%@g.us'
     and customer_numbers.phone is not null
   group by conversation.business_id, conversation.id
  having count(distinct customer_numbers.customer_id) = 1
)
insert into public.whatsapp_conversation_contexts (
  business_id,
  conversation_id,
  customer_id,
  order_id,
  match_method,
  updated_by
)
select business_id, conversation_id, customer_id, null, 'phone', null
  from unique_matches
on conflict (business_id, conversation_id) do update
  set customer_id = excluded.customer_id,
      match_method = 'phone',
      updated_by = null
  where public.whatsapp_conversation_contexts.match_method = 'phone'
    and public.whatsapp_conversation_contexts.order_id is null;
