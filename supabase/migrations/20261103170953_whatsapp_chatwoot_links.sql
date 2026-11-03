-- Link a Chatwoot conversation to a Shalom customer and, optionally, an order.
-- The provider owns message history; this table stores only the local context link.

create table public.whatsapp_conversation_links (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  conversation_id text not null
    check (conversation_id ~ '^[0-9]{1,32}$'),
  inbox_id text not null
    check (inbox_id ~ '^[0-9]{1,32}$'),
  customer_id uuid,
  order_id uuid,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, conversation_id),
  foreign key (business_id, customer_id)
    references public.customers (business_id, id) on delete restrict,
  foreign key (business_id, order_id)
    references public.orders (business_id, id) on delete restrict,
  check (order_id is null or customer_id is not null)
);

create index whatsapp_conversation_links_customer_idx
  on public.whatsapp_conversation_links (business_id, customer_id)
  where customer_id is not null;
create index whatsapp_conversation_links_order_idx
  on public.whatsapp_conversation_links (business_id, order_id)
  where order_id is not null;

-- Keep the selected order consistent with the linked customer. SECURITY DEFINER
-- is used only for this trigger's same-business lookup; direct execution is revoked.
create function private.validate_whatsapp_conversation_link_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  order_customer_id uuid;
begin
  if not (select private.is_business_owner(new.business_id)) then
    raise exception using errcode = '42501', message = 'WhatsApp conversation link access denied.';
  end if;

  if new.order_id is null then
    return new;
  end if;

  select order_row.customer_id
    into order_customer_id
    from public.orders as order_row
   where order_row.business_id = new.business_id
     and order_row.id = new.order_id;

  if not found or order_customer_id is distinct from new.customer_id then
    raise exception using
      errcode = '23503',
      message = 'A WhatsApp conversation order must belong to its linked customer.';
  end if;

  return new;
end;
$function$;

revoke all on function private.validate_whatsapp_conversation_link_order() from public, anon, authenticated;

create trigger whatsapp_conversation_links_validate_order
  before insert or update of business_id, customer_id, order_id
  on public.whatsapp_conversation_links
  for each row execute function private.validate_whatsapp_conversation_link_order();

create trigger whatsapp_conversation_links_touch_updated_at
  before update on public.whatsapp_conversation_links
  for each row execute function private.touch_updated_at();

alter table public.whatsapp_conversation_links enable row level security;
revoke all on table public.whatsapp_conversation_links from public, anon, authenticated;

grant select on table public.whatsapp_conversation_links to authenticated;
grant insert (business_id, conversation_id, inbox_id, customer_id, order_id)
  on table public.whatsapp_conversation_links to authenticated;
grant update (inbox_id, customer_id, order_id)
  on table public.whatsapp_conversation_links to authenticated;

create policy whatsapp_conversation_links_select_for_owners
  on public.whatsapp_conversation_links
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create policy whatsapp_conversation_links_insert_for_owners
  on public.whatsapp_conversation_links
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );

create policy whatsapp_conversation_links_update_for_owners
  on public.whatsapp_conversation_links
  for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );
