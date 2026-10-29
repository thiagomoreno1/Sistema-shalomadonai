-- Owner-operated customer, catalog, interaction, and follow-up foundations.
-- Business rules such as phone uniqueness, product units, and stock handling
-- remain configurable until confirmed with the owner.

create type public.customer_interaction_type as enum (
  'call',
  'note',
  'whatsapp_manual',
  'other'
);

create type public.interaction_direction as enum (
  'incoming',
  'outgoing',
  'not_applicable'
);

create type public.call_outcome as enum ('answered', 'missed', 'other');

create type public.follow_up_priority as enum ('low', 'normal', 'high');
create type public.follow_up_status as enum ('pending', 'completed', 'cancelled');

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  phone text check (phone is null or char_length(btrim(phone)) <= 64),
  delivery_address text check (delivery_address is null or char_length(btrim(delivery_address)) <= 1000),
  notes text check (notes is null or char_length(btrim(notes)) <= 4000),
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.product_categories (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id)
);

create unique index product_categories_name_per_business_idx
  on public.product_categories (business_id, lower(btrim(name)));

create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  category_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (description is null or char_length(btrim(description)) <= 2000),
  inventory_unit text check (inventory_unit is null or char_length(btrim(inventory_unit)) between 1 and 32),
  sale_price_cents bigint check (sale_price_cents is null or sale_price_cents >= 0),
  cost_cents bigint check (cost_cents is null or cost_cents >= 0),
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  check (not is_active or sale_price_cents is not null),
  foreign key (business_id, category_id)
    references public.product_categories (business_id, id)
    on delete restrict
);

create index products_category_per_business_idx
  on public.products (business_id, category_id)
  where category_id is not null;

create table public.customer_interactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  customer_id uuid,
  interaction_type public.customer_interaction_type not null,
  direction public.interaction_direction not null default 'not_applicable',
  call_outcome public.call_outcome,
  outcome text check (outcome is null or char_length(btrim(outcome)) <= 240),
  notes text check (notes is null or char_length(btrim(notes)) <= 4000),
  occurred_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  check (
    (interaction_type = 'call'::public.customer_interaction_type and call_outcome is not null)
    or (interaction_type <> 'call'::public.customer_interaction_type and call_outcome is null)
  ),
  foreign key (business_id, customer_id)
    references public.customers (business_id, id)
    on delete restrict
);

create index customer_interactions_history_idx
  on public.customer_interactions (business_id, customer_id, occurred_at desc);

create table public.follow_up_tasks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  customer_id uuid,
  interaction_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 240),
  due_on date not null,
  priority public.follow_up_priority not null default 'normal',
  status public.follow_up_status not null default 'pending',
  closed_at timestamptz,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  check (
    (status = 'pending'::public.follow_up_status and closed_at is null)
    or (status <> 'pending'::public.follow_up_status and closed_at is not null)
  ),
  foreign key (business_id, customer_id)
    references public.customers (business_id, id)
    on delete restrict,
  foreign key (business_id, interaction_id)
    references public.customer_interactions (business_id, id)
    on delete restrict
);

create index follow_up_tasks_due_queue_idx
  on public.follow_up_tasks (business_id, status, due_on);

create index follow_up_tasks_customer_history_idx
  on public.follow_up_tasks (business_id, customer_id, due_on desc)
  where customer_id is not null;

create function private.validate_follow_up_interaction_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  interaction_customer_id uuid;
begin
  if new.interaction_id is null then
    return new;
  end if;

  if not (select private.is_business_owner(new.business_id)) then
    raise exception using errcode = '42501', message = 'Follow-up access denied.';
  end if;

  select interaction.customer_id
    into interaction_customer_id
    from public.customer_interactions as interaction
   where interaction.business_id = new.business_id
     and interaction.id = new.interaction_id;

  if not found or interaction_customer_id is distinct from new.customer_id then
    raise exception using
      errcode = '23503',
      message = 'A follow-up must match the customer linked to its interaction.';
  end if;

  return new;
end;
$function$;

revoke all on function private.validate_follow_up_interaction_customer() from public, anon, authenticated;

create trigger follow_up_tasks_validate_interaction_customer
  before insert or update of business_id, customer_id, interaction_id on public.follow_up_tasks
  for each row execute function private.validate_follow_up_interaction_customer();

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

revoke all on function private.touch_updated_at() from public, anon, authenticated;

create trigger customers_touch_updated_at
  before update on public.customers
  for each row execute function private.touch_updated_at();

create trigger product_categories_touch_updated_at
  before update on public.product_categories
  for each row execute function private.touch_updated_at();

create trigger products_touch_updated_at
  before update on public.products
  for each row execute function private.touch_updated_at();

create trigger follow_up_tasks_touch_updated_at
  before update on public.follow_up_tasks
  for each row execute function private.touch_updated_at();

alter table public.customers enable row level security;
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.customer_interactions enable row level security;
alter table public.follow_up_tasks enable row level security;

revoke all on table public.customers from public, anon, authenticated;
revoke all on table public.product_categories from public, anon, authenticated;
revoke all on table public.products from public, anon, authenticated;
revoke all on table public.customer_interactions from public, anon, authenticated;
revoke all on table public.follow_up_tasks from public, anon, authenticated;

grant select on table public.customers to authenticated;
grant insert (business_id, name, phone, delivery_address, notes) on table public.customers to authenticated;
grant update (name, phone, delivery_address, notes, is_active) on table public.customers to authenticated;

grant select on table public.product_categories to authenticated;
grant insert (business_id, name) on table public.product_categories to authenticated;
grant update (name, is_active) on table public.product_categories to authenticated;

grant select on table public.products to authenticated;
grant insert (business_id, category_id, name, description, inventory_unit, sale_price_cents, cost_cents)
  on table public.products to authenticated;
grant update (category_id, name, description, inventory_unit, sale_price_cents, cost_cents, is_active)
  on table public.products to authenticated;

grant select on table public.customer_interactions to authenticated;
-- Interactions are append-only through the checked, atomic RPC below so missed
-- calls cannot bypass their required follow-up task.

grant select on table public.follow_up_tasks to authenticated;
grant insert (business_id, customer_id, interaction_id, title, due_on, priority)
  on table public.follow_up_tasks to authenticated;
grant update (title, due_on, priority, status, closed_at) on table public.follow_up_tasks to authenticated;

create policy customers_select_for_owners
  on public.customers for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy customers_insert_for_owners
  on public.customers for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));
create policy customers_update_for_owners
  on public.customers for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));

create policy product_categories_select_for_owners
  on public.product_categories for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy product_categories_insert_for_owners
  on public.product_categories for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));
create policy product_categories_update_for_owners
  on public.product_categories for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));

create policy products_select_for_owners
  on public.products for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy products_insert_for_owners
  on public.products for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));
create policy products_update_for_owners
  on public.products for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));

create policy customer_interactions_select_for_owners
  on public.customer_interactions for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy customer_interactions_insert_for_owners
  on public.customer_interactions for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));

create policy follow_up_tasks_select_for_owners
  on public.follow_up_tasks for select to authenticated
  using ((select private.is_business_owner(business_id)));
create policy follow_up_tasks_insert_for_owners
  on public.follow_up_tasks for insert to authenticated
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));
create policy follow_up_tasks_update_for_owners
  on public.follow_up_tasks for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (created_by = (select auth.uid()) and (select private.is_business_owner(business_id)));

-- Record an interaction and its optional follow-up atomically. Direct table
-- inserts are withheld from authenticated clients; this function checks the
-- caller's owner membership before its privileged writes.
create function public.record_customer_interaction(
  p_business_id uuid,
  p_customer_id uuid,
  p_interaction_type public.customer_interaction_type,
  p_direction public.interaction_direction,
  p_call_outcome public.call_outcome,
  p_outcome text,
  p_notes text,
  p_occurred_at timestamptz,
  p_follow_up_title text,
  p_follow_up_due_on date,
  p_follow_up_priority public.follow_up_priority
)
returns table (interaction_id uuid, follow_up_task_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_interaction_id uuid;
  v_follow_up_task_id uuid;
  v_follow_up_title text := nullif(btrim(p_follow_up_title), '');
  v_follow_up_due_on date := p_follow_up_due_on;
  v_follow_up_priority public.follow_up_priority := p_follow_up_priority;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Interaction access denied.';
  end if;

  if p_interaction_type = 'call'::public.customer_interaction_type and p_call_outcome is null then
    raise exception using errcode = '22023', message = 'A call outcome is required.';
  end if;
  if p_interaction_type <> 'call'::public.customer_interaction_type and p_call_outcome is not null then
    raise exception using errcode = '22023', message = 'Call outcome can only be recorded for calls.';
  end if;

  if p_interaction_type = 'call'::public.customer_interaction_type and p_call_outcome = 'missed'::public.call_outcome then
    v_follow_up_title := coalesce(v_follow_up_title, 'Retornar ligação não atendida');
    v_follow_up_due_on := coalesce(v_follow_up_due_on, (now() at time zone 'America/Sao_Paulo')::date);
    v_follow_up_priority := coalesce(v_follow_up_priority, 'high'::public.follow_up_priority);
  end if;

  if v_follow_up_title is null and v_follow_up_due_on is not null then
    raise exception using errcode = '22023', message = 'A follow-up title is required when a due date is provided.';
  end if;
  if v_follow_up_title is not null and v_follow_up_due_on is null then
    raise exception using errcode = '22023', message = 'A follow-up due date is required when a title is provided.';
  end if;

  insert into public.customer_interactions (
    business_id,
    customer_id,
    interaction_type,
    direction,
    call_outcome,
    outcome,
    notes,
    occurred_at
  )
  values (
    p_business_id,
    p_customer_id,
    p_interaction_type,
    p_direction,
    p_call_outcome,
    nullif(btrim(p_outcome), ''),
    nullif(btrim(p_notes), ''),
    coalesce(p_occurred_at, now())
  )
  returning id into v_interaction_id;

  if v_follow_up_title is not null then
    insert into public.follow_up_tasks (
      business_id,
      customer_id,
      interaction_id,
      title,
      due_on,
      priority
    )
    values (
      p_business_id,
      p_customer_id,
      v_interaction_id,
      v_follow_up_title,
      v_follow_up_due_on,
      coalesce(v_follow_up_priority, 'normal'::public.follow_up_priority)
    )
    returning id into v_follow_up_task_id;
  end if;

  return query select v_interaction_id, v_follow_up_task_id;
end;
$function$;

revoke all on function public.record_customer_interaction(
  uuid, uuid, public.customer_interaction_type, public.interaction_direction,
  public.call_outcome, text, text, timestamptz, text, date, public.follow_up_priority
) from public, anon, authenticated;
grant execute on function public.record_customer_interaction(
  uuid, uuid, public.customer_interaction_type, public.interaction_direction,
  public.call_outcome, text, text, timestamptz, text, date, public.follow_up_priority
) to authenticated;
