create type public.bank_movement_direction as enum ('credit', 'debit');
create type public.bank_transaction_source as enum (
  'manual',
  'statement_file',
  'open_finance_sandbox',
  'open_finance_production'
);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  institution_name text not null check (char_length(btrim(institution_name)) between 1 and 120),
  account_label text not null check (char_length(btrim(account_label)) between 1 and 120),
  account_last_four text check (account_last_four is null or account_last_four ~ '^[0-9]{4}$'),
  is_active boolean not null default true,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create index bank_accounts_business_active_idx
  on public.bank_accounts (business_id, is_active, institution_name, account_label);
create unique index bank_accounts_business_natural_key_idx
  on public.bank_accounts (
    business_id,
    pg_catalog.lower(pg_catalog.btrim(institution_name)),
    pg_catalog.lower(pg_catalog.btrim(account_label)),
    coalesce(account_last_four, '')
  );

create table public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bank_account_id uuid not null,
  transaction_date date not null,
  description text not null check (char_length(btrim(description)) between 1 and 200),
  counterparty_name text check (counterparty_name is null or char_length(btrim(counterparty_name)) between 1 and 160),
  -- Credits are positive and debits are negative. Reconciliation is exact and 1:1 in this first slice.
  amount_cents bigint not null check (amount_cents <> 0),
  source public.bank_transaction_source not null,
  external_transaction_id text check (external_transaction_id is null or char_length(btrim(external_transaction_id)) between 1 and 200),
  notes text check (notes is null or char_length(btrim(notes)) <= 2000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, bank_account_id)
    references public.bank_accounts (business_id, id) on delete restrict
);

create index bank_transactions_account_date_idx
  on public.bank_transactions (business_id, bank_account_id, transaction_date desc, created_at desc, id desc);
create index bank_transactions_business_date_idx
  on public.bank_transactions (business_id, transaction_date desc, created_at desc, id desc);
create unique index bank_transactions_external_id_unique
  on public.bank_transactions (business_id, bank_account_id, source, external_transaction_id)
  where external_transaction_id is not null;

create table public.bank_reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  bank_transaction_id uuid not null,
  order_payment_id uuid,
  financial_outflow_id uuid,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, bank_transaction_id)
    references public.bank_transactions (business_id, id) on delete restrict,
  foreign key (business_id, order_payment_id)
    references public.order_payments (business_id, id) on delete restrict,
  foreign key (business_id, financial_outflow_id)
    references public.financial_outflows (business_id, id) on delete restrict,
  check (
    (order_payment_id is not null and financial_outflow_id is null)
    or (order_payment_id is null and financial_outflow_id is not null)
  )
);

create index bank_reconciliation_matches_transaction_idx
  on public.bank_reconciliation_matches (business_id, bank_transaction_id, created_at desc);
create index bank_reconciliation_matches_payment_idx
  on public.bank_reconciliation_matches (business_id, order_payment_id)
  where order_payment_id is not null;
create index bank_reconciliation_matches_outflow_idx
  on public.bank_reconciliation_matches (business_id, financial_outflow_id)
  where financial_outflow_id is not null;

create table public.bank_reconciliation_match_reversals (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  match_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, match_id),
  unique (business_id, request_id),
  foreign key (business_id, match_id)
    references public.bank_reconciliation_matches (business_id, id) on delete restrict
);

create table public.bank_transaction_duplicates (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  duplicate_transaction_id uuid not null,
  original_transaction_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, duplicate_transaction_id)
    references public.bank_transactions (business_id, id) on delete restrict,
  foreign key (business_id, original_transaction_id)
    references public.bank_transactions (business_id, id) on delete restrict,
  check (duplicate_transaction_id <> original_transaction_id)
);

create index bank_transaction_duplicates_active_idx
  on public.bank_transaction_duplicates (business_id, duplicate_transaction_id, created_at desc);

create table public.bank_transaction_duplicate_clears (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  duplicate_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, duplicate_id),
  unique (business_id, request_id),
  foreign key (business_id, duplicate_id)
    references public.bank_transaction_duplicates (business_id, id) on delete restrict
);

create index bank_transaction_duplicate_clears_history_idx
  on public.bank_transaction_duplicate_clears (business_id, duplicate_id, created_at desc);

alter table public.bank_accounts enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.bank_reconciliation_matches enable row level security;
alter table public.bank_reconciliation_match_reversals enable row level security;
alter table public.bank_transaction_duplicates enable row level security;
alter table public.bank_transaction_duplicate_clears enable row level security;

revoke all on table public.bank_accounts from public, anon, authenticated;
revoke all on table public.bank_transactions from public, anon, authenticated;
revoke all on table public.bank_reconciliation_matches from public, anon, authenticated;
revoke all on table public.bank_reconciliation_match_reversals from public, anon, authenticated;
revoke all on table public.bank_transaction_duplicates from public, anon, authenticated;
revoke all on table public.bank_transaction_duplicate_clears from public, anon, authenticated;

grant select on table public.bank_accounts to authenticated;
grant insert (business_id, institution_name, account_label, account_last_four)
  on table public.bank_accounts to authenticated;
grant update (institution_name, account_label, account_last_four, is_active)
  on table public.bank_accounts to authenticated;
grant select on table public.bank_transactions to authenticated;
grant select on table public.bank_reconciliation_matches to authenticated;
grant select on table public.bank_reconciliation_match_reversals to authenticated;
grant select on table public.bank_transaction_duplicates to authenticated;
grant select on table public.bank_transaction_duplicate_clears to authenticated;

create policy bank_accounts_select_for_owners on public.bank_accounts
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy bank_accounts_insert_for_owners on public.bank_accounts
  for insert to authenticated
  with check ((select private.is_business_owner(business_id)) and created_by = (select auth.uid()));
create policy bank_accounts_update_for_owners on public.bank_accounts
  for update to authenticated
  using ((select private.is_business_owner(business_id)))
  with check ((select private.is_business_owner(business_id)) and created_by = (select auth.uid()));
create policy bank_transactions_select_for_owners on public.bank_transactions
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy bank_reconciliation_matches_select_for_owners on public.bank_reconciliation_matches
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy bank_reconciliation_match_reversals_select_for_owners on public.bank_reconciliation_match_reversals
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy bank_transaction_duplicates_select_for_owners on public.bank_transaction_duplicates
  for select to authenticated using ((select private.is_business_owner(business_id)));
create policy bank_transaction_duplicate_clears_select_for_owners on public.bank_transaction_duplicate_clears
  for select to authenticated using ((select private.is_business_owner(business_id)));

create trigger bank_accounts_reject_truncate
  before truncate on public.bank_accounts
  for each statement execute function private.reject_immutable_record_change();
create trigger bank_transactions_append_only
  before update or delete on public.bank_transactions
  for each row execute function private.reject_immutable_record_change();
create trigger bank_transactions_reject_truncate
  before truncate on public.bank_transactions
  for each statement execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_matches_append_only
  before update or delete on public.bank_reconciliation_matches
  for each row execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_matches_reject_truncate
  before truncate on public.bank_reconciliation_matches
  for each statement execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_match_reversals_append_only
  before update or delete on public.bank_reconciliation_match_reversals
  for each row execute function private.reject_immutable_record_change();
create trigger bank_reconciliation_match_reversals_reject_truncate
  before truncate on public.bank_reconciliation_match_reversals
  for each statement execute function private.reject_immutable_record_change();
create trigger bank_transaction_duplicates_append_only
  before update or delete on public.bank_transaction_duplicates
  for each row execute function private.reject_immutable_record_change();
create trigger bank_transaction_duplicates_reject_truncate
  before truncate on public.bank_transaction_duplicates
  for each statement execute function private.reject_immutable_record_change();
create trigger bank_transaction_duplicate_clears_append_only
  before update or delete on public.bank_transaction_duplicate_clears
  for each row execute function private.reject_immutable_record_change();
create trigger bank_transaction_duplicate_clears_reject_truncate
  before truncate on public.bank_transaction_duplicate_clears
  for each statement execute function private.reject_immutable_record_change();

-- A stock/expense correction must not make a previously reconciled bank movement look unmatched.
-- Both this trigger and match_bank_transaction lock the outflow row before checking the other side.
create function private.guard_financial_outflow_not_reconciled_before_void()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform 1
    from public.financial_outflows as outflow
   where outflow.business_id = new.business_id and outflow.id = new.outflow_id
   for update;

  if not found then
    raise exception using errcode = '23503', message = 'The financial outflow to void does not exist in this business.';
  end if;

  if exists (
    select 1
      from public.bank_reconciliation_matches as match_record
      left join public.bank_reconciliation_match_reversals as reversal
        on reversal.business_id = match_record.business_id and reversal.match_id = match_record.id
     where match_record.business_id = new.business_id
       and match_record.financial_outflow_id = new.outflow_id
       and reversal.id is null
  ) then
    raise exception using errcode = '23514', message = 'Unmatch the bank movement before voiding this financial outflow.';
  end if;

  return new;
end;
$function$;

revoke all on function private.guard_financial_outflow_not_reconciled_before_void() from public, anon, authenticated;
create trigger financial_outflow_void_requires_bank_unmatch
  before insert on public.financial_outflow_voids
  for each row execute function private.guard_financial_outflow_not_reconciled_before_void();

create function public.record_bank_movement(
  p_business_id uuid,
  p_bank_account_id uuid,
  p_transaction_date date,
  p_direction public.bank_movement_direction,
  p_description text,
  p_counterparty_name text,
  p_amount_cents bigint,
  p_notes text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Bank movement access denied.';
  end if;
  if p_request_id is null
     or p_bank_account_id is null
     or p_transaction_date is null
     or p_transaction_date > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
     or p_direction is null
     or p_description is null or char_length(btrim(p_description)) not between 1 and 200
     or (p_counterparty_name is not null and char_length(btrim(p_counterparty_name)) > 160)
     or p_amount_cents is null or p_amount_cents <= 0
     or (p_notes is not null and char_length(btrim(p_notes)) > 2000) then
    raise exception using errcode = '22023', message = 'Bank movement details are invalid.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_bank_movement',
    'business_id', p_business_id,
    'bank_account_id', p_bank_account_id,
    'transaction_date', p_transaction_date,
    'direction', p_direction,
    'description', btrim(p_description),
    'counterparty_name', nullif(btrim(p_counterparty_name), ''),
    'amount_cents', p_amount_cents,
    'notes', nullif(btrim(p_notes), '')
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select movement.id, movement.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.bank_transactions as movement
   where movement.business_id = p_business_id and movement.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different bank movement details.';
    end if;
    return v_id;
  end if;

  perform 1
    from public.bank_accounts as account
   where account.business_id = p_business_id and account.id = p_bank_account_id and account.is_active
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The active bank account does not exist in this business.';
  end if;

  insert into public.bank_transactions (
    business_id, bank_account_id, transaction_date, description, counterparty_name,
    amount_cents, source, notes, request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_bank_account_id, p_transaction_date, btrim(p_description),
    nullif(btrim(p_counterparty_name), ''),
    case p_direction when 'credit'::public.bank_movement_direction then p_amount_cents else -p_amount_cents end,
    'manual'::public.bank_transaction_source, nullif(btrim(p_notes), ''), p_request_id,
    v_fingerprint, (select auth.uid())
  ) returning id into v_id;

  return v_id;
end;
$function$;

create function public.match_bank_transaction(
  p_business_id uuid,
  p_bank_transaction_id uuid,
  p_order_payment_id uuid,
  p_financial_outflow_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_bank_amount bigint;
  v_source_amount bigint;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Bank reconciliation access denied.';
  end if;
  if p_request_id is null or p_bank_transaction_id is null
     or ((p_order_payment_id is null) = (p_financial_outflow_id is null)) then
    raise exception using errcode = '22023', message = 'Select one bank transaction and exactly one financial record to reconcile.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'match_bank_transaction',
    'business_id', p_business_id,
    'bank_transaction_id', p_bank_transaction_id,
    'order_payment_id', p_order_payment_id,
    'financial_outflow_id', p_financial_outflow_id
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select match_record.id, match_record.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.bank_reconciliation_matches as match_record
   where match_record.business_id = p_business_id and match_record.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different bank reconciliation details.';
    end if;
    return v_id;
  end if;

  select movement.amount_cents into v_bank_amount
    from public.bank_transactions as movement
   where movement.business_id = p_business_id and movement.id = p_bank_transaction_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The bank transaction does not exist in this business.';
  end if;

  if exists (
    select 1
      from public.bank_reconciliation_matches as match_record
      left join public.bank_reconciliation_match_reversals as reversal
        on reversal.business_id = match_record.business_id and reversal.match_id = match_record.id
     where match_record.business_id = p_business_id
       and match_record.bank_transaction_id = p_bank_transaction_id
       and reversal.id is null
  ) then
    raise exception using errcode = '23505', message = 'This bank transaction is already reconciled.';
  end if;
  if exists (
    select 1
      from public.bank_transaction_duplicates as duplicate_record
      left join public.bank_transaction_duplicate_clears as clear_record
        on clear_record.business_id = duplicate_record.business_id and clear_record.duplicate_id = duplicate_record.id
     where duplicate_record.business_id = p_business_id
       and duplicate_record.duplicate_transaction_id = p_bank_transaction_id
       and clear_record.id is null
  ) then
    raise exception using errcode = '23514', message = 'A duplicate bank transaction cannot be reconciled.';
  end if;

  if p_order_payment_id is not null then
    select payment.amount_cents into v_source_amount
      from public.order_payments as payment
     where payment.business_id = p_business_id and payment.id = p_order_payment_id
     for update;
    if not found then
      raise exception using errcode = '23503', message = 'The receipt does not exist in this business.';
    end if;
    if v_bank_amount <> v_source_amount then
      raise exception using errcode = '22023', message = 'The bank credit and recorded receipt must have the same amount.';
    end if;
    if exists (
      select 1
        from public.bank_reconciliation_matches as match_record
        left join public.bank_reconciliation_match_reversals as reversal
          on reversal.business_id = match_record.business_id and reversal.match_id = match_record.id
       where match_record.business_id = p_business_id
         and match_record.order_payment_id = p_order_payment_id
         and reversal.id is null
    ) then
      raise exception using errcode = '23505', message = 'This receipt is already reconciled to another bank movement.';
    end if;
  else
    select outflow.amount_cents into v_source_amount
      from public.financial_outflows as outflow
     where outflow.business_id = p_business_id and outflow.id = p_financial_outflow_id
     for update;
    if not found then
      raise exception using errcode = '23503', message = 'The paid outflow does not exist in this business.';
    end if;
    if v_bank_amount <> -v_source_amount then
      raise exception using errcode = '22023', message = 'The bank debit and recorded paid outflow must have the same amount.';
    end if;
    if exists (
      select 1 from public.financial_outflow_voids as void_event
       where void_event.business_id = p_business_id and void_event.outflow_id = p_financial_outflow_id
    ) then
      raise exception using errcode = '23514', message = 'A voided paid outflow cannot be reconciled.';
    end if;
    if exists (
      select 1
        from public.bank_reconciliation_matches as match_record
        left join public.bank_reconciliation_match_reversals as reversal
          on reversal.business_id = match_record.business_id and reversal.match_id = match_record.id
       where match_record.business_id = p_business_id
         and match_record.financial_outflow_id = p_financial_outflow_id
         and reversal.id is null
    ) then
      raise exception using errcode = '23505', message = 'This paid outflow is already reconciled to another bank movement.';
    end if;
  end if;

  insert into public.bank_reconciliation_matches (
    business_id, bank_transaction_id, order_payment_id, financial_outflow_id,
    request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_bank_transaction_id, p_order_payment_id, p_financial_outflow_id,
    p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_id;

  return v_id;
end;
$function$;

create function public.unmatch_bank_transaction(
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

create function public.mark_bank_transaction_duplicate(
  p_business_id uuid,
  p_duplicate_transaction_id uuid,
  p_original_transaction_id uuid,
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
  v_existing_fingerprint text;
  v_fingerprint text;
  v_duplicate_account_id uuid;
  v_duplicate_date date;
  v_duplicate_amount bigint;
  v_original_account_id uuid;
  v_original_date date;
  v_original_amount bigint;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Bank duplicate correction access denied.';
  end if;
  if p_duplicate_transaction_id is null or p_original_transaction_id is null
     or p_duplicate_transaction_id = p_original_transaction_id or p_request_id is null
     or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Select two different movements and provide a duplicate reason.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'mark_bank_transaction_duplicate',
    'business_id', p_business_id,
    'duplicate_transaction_id', p_duplicate_transaction_id,
    'original_transaction_id', p_original_transaction_id,
    'reason', btrim(p_reason)
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select duplicate_record.id, duplicate_record.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.bank_transaction_duplicates as duplicate_record
   where duplicate_record.business_id = p_business_id and duplicate_record.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different duplicate details.';
    end if;
    return v_id;
  end if;

  perform 1
    from public.bank_transactions as movement
   where movement.business_id = p_business_id
     and movement.id in (p_duplicate_transaction_id, p_original_transaction_id)
   order by movement.id
   for update;

  select movement.bank_account_id, movement.transaction_date, movement.amount_cents
    into v_duplicate_account_id, v_duplicate_date, v_duplicate_amount
    from public.bank_transactions as movement
   where movement.business_id = p_business_id and movement.id = p_duplicate_transaction_id;
  if not found then
    raise exception using errcode = '23503', message = 'The duplicate movement does not exist in this business.';
  end if;
  select movement.bank_account_id, movement.transaction_date, movement.amount_cents
    into v_original_account_id, v_original_date, v_original_amount
    from public.bank_transactions as movement
   where movement.business_id = p_business_id and movement.id = p_original_transaction_id;
  if not found then
    raise exception using errcode = '23503', message = 'The original movement does not exist in this business.';
  end if;
  if v_duplicate_account_id <> v_original_account_id
     or v_duplicate_date <> v_original_date
     or v_duplicate_amount <> v_original_amount then
    raise exception using errcode = '22023', message = 'A duplicate must have the same account, date, and signed amount as its original movement.';
  end if;
  if exists (
    select 1
      from public.bank_reconciliation_matches as match_record
      left join public.bank_reconciliation_match_reversals as reversal
        on reversal.business_id = match_record.business_id and reversal.match_id = match_record.id
     where match_record.business_id = p_business_id
       and match_record.bank_transaction_id = p_duplicate_transaction_id
       and reversal.id is null
  ) then
    raise exception using errcode = '23514', message = 'Unmatch this movement before marking it as a duplicate.';
  end if;
  if exists (
    select 1
      from public.bank_transaction_duplicates as duplicate_record
      left join public.bank_transaction_duplicate_clears as clear_record
        on clear_record.business_id = duplicate_record.business_id and clear_record.duplicate_id = duplicate_record.id
     where duplicate_record.business_id = p_business_id
       and duplicate_record.duplicate_transaction_id = p_duplicate_transaction_id
       and clear_record.id is null
  ) then
    raise exception using errcode = '23505', message = 'This movement is already marked as a duplicate.';
  end if;
  if exists (
    select 1
      from public.bank_transaction_duplicates as duplicate_record
      left join public.bank_transaction_duplicate_clears as clear_record
        on clear_record.business_id = duplicate_record.business_id and clear_record.duplicate_id = duplicate_record.id
     where duplicate_record.business_id = p_business_id
       and duplicate_record.duplicate_transaction_id = p_original_transaction_id
       and clear_record.id is null
  ) then
    raise exception using errcode = '23514', message = 'The original movement cannot itself be marked as a duplicate.';
  end if;
  if exists (
    select 1
      from public.bank_transaction_duplicates as duplicate_record
      left join public.bank_transaction_duplicate_clears as clear_record
        on clear_record.business_id = duplicate_record.business_id and clear_record.duplicate_id = duplicate_record.id
     where duplicate_record.business_id = p_business_id
       and duplicate_record.original_transaction_id = p_duplicate_transaction_id
       and clear_record.id is null
  ) then
    raise exception using errcode = '23514', message = 'A movement that is the original for an active duplicate cannot itself be reclassified.';
  end if;

  insert into public.bank_transaction_duplicates (
    business_id, duplicate_transaction_id, original_transaction_id, reason,
    request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_duplicate_transaction_id, p_original_transaction_id, btrim(p_reason),
    p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_id;

  return v_id;
end;
$function$;

create function public.clear_bank_transaction_duplicate(
  p_business_id uuid,
  p_duplicate_id uuid,
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
  v_existing_fingerprint text;
  v_fingerprint text;
  v_duplicate_transaction_id uuid;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Bank duplicate correction access denied.';
  end if;
  if p_duplicate_id is null or p_request_id is null
     or p_reason is null or char_length(btrim(p_reason)) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'A duplicate correction reason is required.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'clear_bank_transaction_duplicate',
    'business_id', p_business_id,
    'duplicate_id', p_duplicate_id,
    'reason', btrim(p_reason)
  )::text);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select clear_record.id, clear_record.request_fingerprint
    into v_id, v_existing_fingerprint
    from public.bank_transaction_duplicate_clears as clear_record
   where clear_record.business_id = p_business_id and clear_record.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different duplicate correction details.';
    end if;
    return v_id;
  end if;

  select duplicate_record.duplicate_transaction_id into v_duplicate_transaction_id
    from public.bank_transaction_duplicates as duplicate_record
   where duplicate_record.business_id = p_business_id and duplicate_record.id = p_duplicate_id
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The duplicate record does not exist in this business.';
  end if;
  if exists (
    select 1 from public.bank_transaction_duplicate_clears as clear_record
     where clear_record.business_id = p_business_id and clear_record.duplicate_id = p_duplicate_id
  ) then
    raise exception using errcode = '23514', message = 'This duplicate classification was already cleared.';
  end if;
  perform 1 from public.bank_transactions as movement
   where movement.business_id = p_business_id and movement.id = v_duplicate_transaction_id
   for update;

  insert into public.bank_transaction_duplicate_clears (
    business_id, duplicate_id, reason, request_id, request_fingerprint, created_by
  ) values (
    p_business_id, p_duplicate_id, btrim(p_reason), p_request_id, v_fingerprint, (select auth.uid())
  ) returning id into v_id;

  return v_id;
end;
$function$;

-- A duplicate classification is reversible, but the reason and original decision remain in history.
revoke all on function public.record_bank_movement(
  uuid, uuid, date, public.bank_movement_direction, text, text, bigint, text, uuid
) from public, anon, authenticated;
revoke all on function public.match_bank_transaction(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.unmatch_bank_transaction(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.mark_bank_transaction_duplicate(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.clear_bank_transaction_duplicate(uuid, uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.record_bank_movement(
  uuid, uuid, date, public.bank_movement_direction, text, text, bigint, text, uuid
) to authenticated;
grant execute on function public.match_bank_transaction(uuid, uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.unmatch_bank_transaction(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.mark_bank_transaction_duplicate(uuid, uuid, uuid, text, uuid) to authenticated;
grant execute on function public.clear_bank_transaction_duplicate(uuid, uuid, text, uuid) to authenticated;
