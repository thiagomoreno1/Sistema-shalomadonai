-- Owner-defined, business-scoped installment schedules. These are editable
-- suggestions only; they never record a receipt or choose a schedule for an order.

create function private.is_valid_payment_schedule(p_schedule jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_entry jsonb;
  v_ordinality bigint;
  v_ordinal integer;
  v_amount_bps integer;
  v_days_after_base integer;
  v_method text;
  v_total_bps integer := 0;
  v_count integer;
begin
  if p_schedule is null or pg_catalog.jsonb_typeof(p_schedule) is distinct from 'array' then
    return false;
  end if;

  v_count := pg_catalog.jsonb_array_length(p_schedule);
  if v_count < 1 or v_count > 120 then
    return false;
  end if;

  for v_entry, v_ordinality in
    select entry.value, entry.ordinality
      from pg_catalog.jsonb_array_elements(p_schedule) with ordinality as entry(value, ordinality)
  loop
    if pg_catalog.jsonb_typeof(v_entry) is distinct from 'object'
       or not (v_entry ? 'ordinal')
       or not (v_entry ? 'amount_bps')
       or not (v_entry ? 'days_after_base')
       or (v_entry - 'ordinal' - 'amount_bps' - 'days_after_base' - 'payment_method') <> '{}'::jsonb then
      return false;
    end if;

    if not coalesce((v_entry ->> 'ordinal') ~ '^[0-9]+$', false)
       or not coalesce((v_entry ->> 'amount_bps') ~ '^[0-9]+$', false)
       or not coalesce((v_entry ->> 'days_after_base') ~ '^[0-9]+$', false) then
      return false;
    end if;

    v_ordinal := (v_entry ->> 'ordinal')::integer;
    v_amount_bps := (v_entry ->> 'amount_bps')::integer;
    v_days_after_base := (v_entry ->> 'days_after_base')::integer;
    v_method := v_entry ->> 'payment_method';

    if v_ordinal <> v_ordinality
       or v_amount_bps < 1 or v_amount_bps > 10000
       or v_days_after_base > 36500
       or (v_entry ? 'payment_method'
           and pg_catalog.jsonb_typeof(v_entry -> 'payment_method') not in ('null', 'string'))
       or (v_method is not null and pg_catalog.char_length(v_method) > 64) then
      return false;
    end if;

    v_total_bps := v_total_bps + v_amount_bps;
  end loop;

  return v_total_bps = 10000;
exception
  when others then
    return false;
end;
$function$;

revoke all on function private.is_valid_payment_schedule(jsonb) from public, anon, authenticated;
grant execute on function private.is_valid_payment_schedule(jsonb) to authenticated;

create table public.payment_schedule_templates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 80),
  schedule jsonb not null check (private.is_valid_payment_schedule(schedule)),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, name)
);

create trigger payment_schedule_templates_touch_updated_at
  before update on public.payment_schedule_templates
  for each row execute function private.touch_updated_at();

alter table public.payment_schedule_templates enable row level security;

revoke all on table public.payment_schedule_templates from public, anon, authenticated;
grant select on table public.payment_schedule_templates to authenticated;
grant insert (business_id, name, schedule) on table public.payment_schedule_templates to authenticated;
grant update (name, schedule) on table public.payment_schedule_templates to authenticated;
grant delete on table public.payment_schedule_templates to authenticated;

create policy payment_schedule_templates_select_for_owners
  on public.payment_schedule_templates
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create policy payment_schedule_templates_insert_for_owners
  on public.payment_schedule_templates
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );

create policy payment_schedule_templates_update_for_owners
  on public.payment_schedule_templates
  for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check (
    created_by = (select auth.uid())
    and (select private.is_business_owner(business_id))
  );

create policy payment_schedule_templates_delete_for_owners
  on public.payment_schedule_templates
  for delete to authenticated
  using ((select private.is_business_owner(business_id)));
