-- Groups extend the append-only legacy links; null match_group_id retains 1:1 history.
create table public.bank_reconciliation_match_groups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bank_transaction_id uuid not null,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, bank_transaction_id, id),
  unique (business_id, request_id),
  foreign key (business_id, bank_transaction_id)
    references public.bank_transactions(business_id, id) on delete restrict
);
create index bank_reconciliation_match_groups_transaction_idx
  on public.bank_reconciliation_match_groups(business_id, bank_transaction_id, created_at desc);

alter table public.bank_reconciliation_matches add column match_group_id uuid;
alter table public.bank_reconciliation_matches add constraint bank_reconciliation_matches_group_fk
  foreign key (business_id, bank_transaction_id, match_group_id)
  references public.bank_reconciliation_match_groups(business_id, bank_transaction_id, id) on delete restrict;
create index bank_reconciliation_matches_group_idx
  on public.bank_reconciliation_matches(business_id, match_group_id, id) where match_group_id is not null;
create unique index bank_reconciliation_matches_group_payment_unique
  on public.bank_reconciliation_matches(match_group_id, order_payment_id) where match_group_id is not null;
create unique index bank_reconciliation_matches_group_outflow_unique
  on public.bank_reconciliation_matches(match_group_id, financial_outflow_id) where match_group_id is not null;

create table public.bank_reconciliation_match_group_reversals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  match_group_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, match_group_id),
  unique (business_id, request_id),
  foreign key (business_id, match_group_id)
    references public.bank_reconciliation_match_groups(business_id, id) on delete restrict
);
alter table public.bank_reconciliation_match_groups enable row level security;
alter table public.bank_reconciliation_match_group_reversals enable row level security;
revoke all on public.bank_reconciliation_match_groups, public.bank_reconciliation_match_group_reversals
  from public, anon, authenticated;
grant select on public.bank_reconciliation_match_groups, public.bank_reconciliation_match_group_reversals to authenticated;
create policy bank_reconciliation_match_groups_select_for_owners on public.bank_reconciliation_match_groups
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy bank_reconciliation_match_group_reversals_select_for_owners on public.bank_reconciliation_match_group_reversals
  for select to authenticated using ((select private.is_business_owner(business_id)));
create trigger bank_reconciliation_match_groups_append_only
  before update or delete on public.bank_reconciliation_match_groups
  for each row execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_match_groups_reject_truncate
  before truncate on public.bank_reconciliation_match_groups
  for each statement execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_match_group_reversals_append_only
  before update or delete on public.bank_reconciliation_match_group_reversals
  for each row execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_match_group_reversals_reject_truncate
  before truncate on public.bank_reconciliation_match_group_reversals
  for each statement execute function private.reject_immutable_record_change();

create function public.match_bank_transaction_group(
  p_business_id uuid, p_bank_transaction_id uuid, p_items jsonb, p_request_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_items jsonb;
  v_item record;
  v_amount bigint;
  v_bank_amount bigint;
  -- Numeric avoids bigint overflow when summing up to 50 full source records.
  v_total numeric := 0;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode='42501', message='Bank reconciliation access denied.';
  end if;
  if p_request_id is null or p_bank_transaction_id is null or p_items is null
     or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode='22023', message='Select a bank transaction and an array of financial records.';
  end if;
  if pg_catalog.jsonb_array_length(p_items) not between 1 and 50 then
    raise exception using errcode='22023', message='Select between 1 and 50 financial records.';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) as item(value)
    where pg_catalog.jsonb_typeof(value) <> 'object'
       or (value->>'kind') is null or (value->>'kind') not in ('receipt','outflow')
       or pg_catalog.jsonb_typeof(value->'id') is distinct from 'string'
       or (value->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (value - 'kind' - 'id') <> '{}'::jsonb
  ) then
    raise exception using errcode='22023', message='Each financial record requires a kind and a UUID id.';
  end if;
  if (select count(distinct (value->>'id')::uuid) from pg_catalog.jsonb_array_elements(p_items) item(value))
     <> pg_catalog.jsonb_array_length(p_items) then
    raise exception using errcode='22023', message='A financial record cannot appear twice in a group.';
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind',value->>'kind','id',(value->>'id')::uuid)
                            order by value->>'kind',(value->>'id')::uuid)
    into v_items from pg_catalog.jsonb_array_elements(p_items) item(value);
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation','match_bank_transaction_group','business_id',p_business_id,
    'bank_transaction_id',p_bank_transaction_id,'items',v_items)::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_business_id::text),pg_catalog.hashtext(p_request_id::text));
  select g.id,g.request_fingerprint into v_id,v_existing_fingerprint
    from public.bank_reconciliation_match_groups g where g.business_id=p_business_id and g.request_id=p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode='22023', message='This request id was already used for different reconciliation group details.';
    end if;
    return v_id;
  end if;
  -- Same movement/source row locks as legacy match and duplicate/void operations.
  select t.amount_cents into v_bank_amount from public.bank_transactions t
    where t.business_id=p_business_id and t.id=p_bank_transaction_id for update;
  if not found then
    raise exception using errcode='23503', message='The bank transaction does not exist in this business.';
  end if;
  if exists (select 1 from public.bank_reconciliation_matches m
    where m.business_id=p_business_id and m.bank_transaction_id=p_bank_transaction_id
      and not exists (select 1 from public.bank_reconciliation_match_reversals r where r.business_id=m.business_id and r.match_id=m.id)) then
    raise exception using errcode='23505', message='This bank transaction is already reconciled.';
  end if;
  if exists (select 1 from public.bank_transaction_duplicates d
    where d.business_id=p_business_id and d.duplicate_transaction_id=p_bank_transaction_id
      and not exists (select 1 from public.bank_transaction_duplicate_clears c where c.business_id=d.business_id and c.duplicate_id=d.id)) then
    raise exception using errcode='23514', message='A duplicate bank transaction cannot be reconciled.';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_items) item(value)
    where (v_bank_amount>0 and value->>'kind'<>'receipt') or (v_bank_amount<0 and value->>'kind'<>'outflow')) then
    raise exception using errcode='22023', message='Credits require receipts and debits require paid outflows.';
  end if;
  for v_item in select value->>'kind' as kind,(value->>'id')::uuid as id
    from pg_catalog.jsonb_array_elements(v_items) item(value) order by value->>'kind',(value->>'id')::uuid
  loop
    if v_item.kind='receipt' then
      select p.amount_cents into v_amount from public.order_payments p
        where p.business_id=p_business_id and p.id=v_item.id for update;
    else
      select o.amount_cents into v_amount from public.financial_outflows o
        where o.business_id=p_business_id and o.id=v_item.id for update;
    end if;
    if not found then
      raise exception using errcode='23503', message='The financial record does not exist in this business.';
    end if;
    if v_item.kind='outflow' and exists (select 1 from public.financial_outflow_voids v
      where v.business_id=p_business_id and v.outflow_id=v_item.id) then
      raise exception using errcode='23514', message='A voided paid outflow cannot be reconciled.';
    end if;
    if exists (select 1 from public.bank_reconciliation_matches m
      where m.business_id=p_business_id
        and ((v_item.kind='receipt' and m.order_payment_id=v_item.id) or (v_item.kind='outflow' and m.financial_outflow_id=v_item.id))
        and not exists (select 1 from public.bank_reconciliation_match_reversals r where r.business_id=m.business_id and r.match_id=m.id)) then
      raise exception using errcode='23505', message='This financial record is already reconciled.';
    end if;
    v_total := v_total+v_amount;
  end loop;
  if v_total <> pg_catalog.abs(v_bank_amount::numeric) then
    raise exception using errcode='22023', message='The selected financial records must exactly equal the bank amount.';
  end if;
  insert into public.bank_reconciliation_match_groups
    (business_id,bank_transaction_id,request_id,request_fingerprint,created_by)
    values (p_business_id,p_bank_transaction_id,p_request_id,v_fingerprint,(select auth.uid())) returning id into v_id;
  insert into public.bank_reconciliation_matches
    (business_id,bank_transaction_id,order_payment_id,financial_outflow_id,request_id,request_fingerprint,created_by,match_group_id)
    select p_business_id,p_bank_transaction_id,
      case when value->>'kind'='receipt' then (value->>'id')::uuid end,
      case when value->>'kind'='outflow' then (value->>'id')::uuid end,
      gen_random_uuid(),v_fingerprint,(select auth.uid()),v_id
    from pg_catalog.jsonb_array_elements(v_items) item(value);
  return v_id;
end;
$function$;

create function public.unmatch_bank_transaction_group(
  p_business_id uuid, p_group_id uuid, p_reason text, p_request_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_id uuid;
  v_bank_id uuid;
  v_fingerprint text;
  v_existing_fingerprint text;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode='42501', message='Bank reconciliation correction access denied.';
  end if;
  if p_group_id is null or p_request_id is null or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode='22023', message='A reconciliation correction reason is required.';
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object('operation','unmatch_bank_transaction_group',
    'business_id',p_business_id,'group_id',p_group_id,'reason',btrim(p_reason))::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_business_id::text),pg_catalog.hashtext(p_request_id::text));
  select r.id,r.request_fingerprint into v_id,v_existing_fingerprint
    from public.bank_reconciliation_match_group_reversals r where r.business_id=p_business_id and r.request_id=p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode='22023', message='This request id was already used for different reconciliation correction details.';
    end if;
    return v_id;
  end if;
  select g.bank_transaction_id into v_bank_id from public.bank_reconciliation_match_groups g
    where g.business_id=p_business_id and g.id=p_group_id;
  if not found then
    raise exception using errcode='23503', message='The reconciliation group does not exist in this business.';
  end if;
  perform 1 from public.bank_transactions t where t.business_id=p_business_id and t.id=v_bank_id for update;
  -- Lock sources in the same order as matching; this also serializes with outflow voids.
  perform 1 from public.order_payments p where p.business_id=p_business_id
    and p.id in (select m.order_payment_id from public.bank_reconciliation_matches m where m.business_id=p_business_id and m.match_group_id=p_group_id)
    order by p.id for update;
  perform 1 from public.financial_outflows o where o.business_id=p_business_id
    and o.id in (select m.financial_outflow_id from public.bank_reconciliation_matches m where m.business_id=p_business_id and m.match_group_id=p_group_id)
    order by o.id for update;
  perform 1 from public.bank_reconciliation_match_groups g where g.business_id=p_business_id and g.id=p_group_id for update;
  perform 1 from public.bank_reconciliation_matches m where m.business_id=p_business_id and m.match_group_id=p_group_id order by m.id for update;
  if exists (select 1 from public.bank_reconciliation_match_group_reversals r where r.business_id=p_business_id and r.match_group_id=p_group_id) then
    raise exception using errcode='23514', message='This reconciliation group was already undone.';
  end if;
  insert into public.bank_reconciliation_match_group_reversals
    (business_id,match_group_id,reason,request_id,request_fingerprint,created_by)
    values (p_business_id,p_group_id,btrim(p_reason),p_request_id,v_fingerprint,(select auth.uid())) returning id into v_id;
  insert into public.bank_reconciliation_match_reversals
    (business_id,match_id,reason,request_id,request_fingerprint,created_by)
    select p_business_id,m.id,btrim(p_reason),gen_random_uuid(),v_fingerprint,(select auth.uid())
    from public.bank_reconciliation_matches m where m.business_id=p_business_id and m.match_group_id=p_group_id order by m.id;
  return v_id;
end;
$function$;

revoke all on function public.match_bank_transaction_group(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.unmatch_bank_transaction_group(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.match_bank_transaction_group(uuid,uuid,jsonb,uuid) to authenticated;
grant execute on function public.unmatch_bank_transaction_group(uuid,uuid,text,uuid) to authenticated;
create or replace function public.unmatch_bank_transaction(
  p_business_id uuid,
  p_match_id uuid,
  p_reason text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_group_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Bank reconciliation correction access denied.';
  end if;
  if p_match_id is null or p_request_id is null
     or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'A reconciliation correction reason is required.';
  end if;

  -- Route grouped children before acquiring a child lock, preserving movement-first order.
  select m.match_group_id into v_group_id from public.bank_reconciliation_matches m
   where m.business_id = p_business_id and m.id = p_match_id;
  if v_group_id is not null then
    perform public.unmatch_bank_transaction_group(p_business_id, v_group_id, p_reason, p_request_id);
    select r.id into v_id from public.bank_reconciliation_match_reversals r
     where r.business_id = p_business_id and r.match_id = p_match_id;
    return v_id;
  end if;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'unmatch_bank_transaction',
    'business_id', p_business_id,
    'match_id', p_match_id,
    'reason', btrim(p_reason)
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select reversal.id, reversal.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.bank_reconciliation_match_reversals as reversal
   where reversal.business_id = p_business_id and reversal.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different reconciliation correction details.';
    end if;
    return v_id;
  end if;

  perform 1 from public.bank_reconciliation_matches as match_record
   where match_record.business_id = p_business_id and match_record.id = p_match_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The bank reconciliation match does not exist in this business.';
  end if;
  if exists (
    select 1 from public.bank_reconciliation_match_reversals as reversal
     where reversal.business_id = p_business_id and reversal.match_id = p_match_id
  ) then
    raise exception using errcode = '23514', message = 'This bank reconciliation match was already undone.';
  end if;

  insert into public.bank_reconciliation_match_reversals (
    business_id, match_id, reason, request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_match_id, btrim(p_reason), p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_id;

  return v_id;
end;
$function$;
