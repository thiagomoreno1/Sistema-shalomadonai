create table if not exists public.whatsapp_message_status_buffer (
  business_id uuid not null,
  instance_name text not null,
  provider_message_id text not null,
  delivery_status text not null check (delivery_status in ('pending', 'sent', 'delivered', 'read', 'played', 'failed', 'deleted')),
  updated_at timestamptz not null default now(),
  primary key (business_id, instance_name, provider_message_id)
);

create index if not exists whatsapp_message_status_buffer_updated_at_idx
  on public.whatsapp_message_status_buffer (updated_at);

alter table public.whatsapp_message_status_buffer enable row level security;
revoke all on table public.whatsapp_message_status_buffer from public, anon, authenticated;
grant all on table public.whatsapp_message_status_buffer to service_role;

create or replace function public.apply_whatsapp_delivery_status_event(
  p_business_id uuid,
  p_instance_name text,
  p_provider_message_id text,
  p_delivery_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_status text;
  v_buffered_status text;
  v_candidate_status text;
  v_final_status text;
begin
  if p_business_id is null
     or nullif(btrim(p_instance_name), '') is null
     or nullif(btrim(p_provider_message_id), '') is null
     or p_delivery_status is null
     or p_delivery_status not in ('pending', 'sent', 'delivered', 'read', 'played', 'failed', 'deleted') then
    raise exception using errcode = '22023', message = 'Invalid WhatsApp delivery status event.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_business_id::text || ':' || p_instance_name || ':' || p_provider_message_id, 0
  ));

  delete from public.whatsapp_message_status_buffer
   where updated_at < pg_catalog.now() - interval '7 days';

  select message.delivery_status into v_current_status
    from public.whatsapp_messages as message
   where message.business_id = p_business_id
     and message.instance_name = p_instance_name
     and message.provider_message_id = p_provider_message_id
   for update;

  if not found then
    insert into public.whatsapp_message_status_buffer as buffered (
      business_id, instance_name, provider_message_id, delivery_status, updated_at
    ) values (
      p_business_id, p_instance_name, p_provider_message_id, p_delivery_status, pg_catalog.now()
    )
    on conflict (business_id, instance_name, provider_message_id) do update
      set delivery_status = case
        when buffered.delivery_status = 'deleted' or excluded.delivery_status = 'deleted' then 'deleted'
        when buffered.delivery_status in ('pending', 'sent') and excluded.delivery_status = 'failed' then 'failed'
        when buffered.delivery_status = 'failed' and excluded.delivery_status in ('pending', 'sent') then 'failed'
        when (case buffered.delivery_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end)
           < (case excluded.delivery_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end)
          then excluded.delivery_status
        else buffered.delivery_status
      end,
      updated_at = pg_catalog.now();
    return false;
  end if;

  select buffered.delivery_status into v_buffered_status
    from public.whatsapp_message_status_buffer as buffered
   where buffered.business_id = p_business_id
     and buffered.instance_name = p_instance_name
     and buffered.provider_message_id = p_provider_message_id
   for update;

  v_candidate_status := p_delivery_status;
  if v_buffered_status is not null then
    if v_buffered_status = 'deleted'
       or (v_buffered_status = 'failed' and v_candidate_status in ('pending', 'sent'))
       or (case v_buffered_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end)
          > (case v_candidate_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end) then
      v_candidate_status := v_buffered_status;
    end if;
  end if;

  if v_candidate_status = 'deleted' or v_current_status = 'deleted' then
    v_final_status := 'deleted';
  elsif v_candidate_status = 'failed' and v_current_status in ('pending', 'sent') then
    v_final_status := 'failed';
  elsif v_current_status = 'failed' and v_candidate_status in ('pending', 'sent') then
    v_final_status := 'failed';
  elsif v_current_status is null
     or (case v_candidate_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end)
        > (case v_current_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end) then
    v_final_status := v_candidate_status;
  else
    v_final_status := v_current_status;
  end if;

  update public.whatsapp_messages
     set delivery_status = v_final_status,
         deleted_at = case when v_final_status = 'deleted' then coalesce(deleted_at, pg_catalog.now()) else deleted_at end
   where business_id = p_business_id
     and instance_name = p_instance_name
     and provider_message_id = p_provider_message_id;

  delete from public.whatsapp_message_status_buffer
   where business_id = p_business_id
     and instance_name = p_instance_name
     and provider_message_id = p_provider_message_id;

  return true;
end;
$$;

create or replace function public.apply_buffered_whatsapp_delivery_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_buffered_status text;
  v_final_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    new.business_id::text || ':' || new.instance_name || ':' || new.provider_message_id, 0
  ));

  select buffered.delivery_status into v_buffered_status
    from public.whatsapp_message_status_buffer as buffered
   where buffered.business_id = new.business_id
     and buffered.instance_name = new.instance_name
     and buffered.provider_message_id = new.provider_message_id
   for update;

  if not found then return new; end if;

  if v_buffered_status = 'deleted' or new.delivery_status = 'deleted' then
    v_final_status := 'deleted';
  elsif v_buffered_status = 'failed' and new.delivery_status in ('pending', 'sent') then
    v_final_status := 'failed';
  elsif new.delivery_status is null
     or (case v_buffered_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else 5 end)
        > (case new.delivery_status when 'pending' then 0 when 'failed' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 when 'played' then 4 else -1 end) then
    v_final_status := v_buffered_status;
  else
    v_final_status := new.delivery_status;
  end if;

  update public.whatsapp_messages
     set delivery_status = v_final_status,
         deleted_at = case when v_final_status = 'deleted' then coalesce(deleted_at, pg_catalog.now()) else deleted_at end
   where id = new.id;

  delete from public.whatsapp_message_status_buffer
   where business_id = new.business_id
     and instance_name = new.instance_name
     and provider_message_id = new.provider_message_id;

  return new;
end;
$$;

drop trigger if exists whatsapp_message_status_buffer_after_insert on public.whatsapp_messages;
create trigger whatsapp_message_status_buffer_after_insert
after insert on public.whatsapp_messages
for each row execute function public.apply_buffered_whatsapp_delivery_status();

revoke all on function public.apply_whatsapp_delivery_status_event(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_whatsapp_delivery_status_event(uuid, text, text, text) to service_role;
revoke all on function public.apply_buffered_whatsapp_delivery_status() from public, anon, authenticated;
grant execute on function public.apply_buffered_whatsapp_delivery_status() to service_role;
