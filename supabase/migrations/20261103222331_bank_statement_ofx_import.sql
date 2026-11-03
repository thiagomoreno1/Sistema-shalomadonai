-- Store aggregate import outcomes only; raw statement data stays in the browser.
create table public.bank_statement_import_batches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete restrict,
  bank_account_id uuid not null,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  transaction_count integer not null check (transaction_count between 1 and 1000),
  imported_count integer not null check (imported_count >= 0),
  duplicate_count integer not null check (duplicate_count >= 0),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, request_id),
  foreign key (business_id, bank_account_id)
    references public.bank_accounts (business_id, id) on delete restrict,
  check (imported_count + duplicate_count = transaction_count)
);

create index bank_statement_import_batches_account_created_idx
  on public.bank_statement_import_batches (business_id, bank_account_id, created_at desc, id desc);

alter table public.bank_statement_import_batches enable row level security;
revoke all on table public.bank_statement_import_batches from public, anon, authenticated;
grant select on table public.bank_statement_import_batches to authenticated;

create policy bank_statement_import_batches_select_for_owners
  on public.bank_statement_import_batches
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create trigger bank_statement_import_batches_append_only
  before update or delete on public.bank_statement_import_batches
  for each row execute function private.reject_immutable_record_change();
create trigger bank_statement_import_batches_reject_truncate
  before truncate on public.bank_statement_import_batches
  for each statement execute function private.reject_immutable_record_change();

create function public.import_bank_statement(
  p_business_id uuid,
  p_bank_account_id uuid,
  p_rows jsonb,
  p_duplicate_rows_in_file integer,
  p_request_id uuid
)
returns table (batch_id uuid, imported_count integer, duplicate_count integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_fingerprint text;
  v_existing_fingerprint text;
  v_batch_id uuid;
  v_stored_imported_count integer;
  v_stored_duplicate_count integer;
  v_row_count integer;
  v_total_count integer;
  v_imported_count integer := 0;
  v_duplicate_count integer;
  v_rows_affected integer;
  v_item jsonb;
  v_transaction_date date;
  v_description text;
  v_counterparty_name text;
  v_amount_text text;
  v_amount_cents bigint;
  v_external_transaction_id text;
  v_row_fingerprint text;
  v_row_request_hash text;
  v_row_request_id uuid;
begin
  if (select auth.uid()) is null
     or p_business_id is null
     or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Bank statement import access denied.';
  end if;

  if p_bank_account_id is null
     or p_request_id is null
     or p_rows is null
     or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array'
     or p_duplicate_rows_in_file is null
     or p_duplicate_rows_in_file < 0
     or p_duplicate_rows_in_file > 1000 then
    raise exception using errcode = '22023', message = 'Bank statement import details are invalid.';
  end if;

  v_row_count := pg_catalog.jsonb_array_length(p_rows);
  v_total_count := v_row_count + p_duplicate_rows_in_file;
  if v_total_count not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'A statement must contain between 1 and 1,000 transactions.';
  end if;

  -- Require a compact, exact row shape. The RPC never stores arbitrary provider or file fields.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_rows) as entry(value)
     where case
       when pg_catalog.jsonb_typeof(entry.value) = 'object' then
         (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(entry.value)) <> 5
         or not (entry.value ?& array[
           'transaction_date', 'description', 'counterparty_name', 'amount_cents', 'external_transaction_id'
         ])
       else true
     end
  ) then
    raise exception using errcode = '22023', message = 'Bank statement rows have an invalid shape.';
  end if;

  -- The database constraint on bank_transactions caps external IDs at 200 characters.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_rows) as entry(value)
     where pg_catalog.jsonb_typeof(entry.value -> 'transaction_date') is distinct from 'string'
        or pg_catalog.jsonb_typeof(entry.value -> 'description') is distinct from 'string'
        or pg_catalog.jsonb_typeof(entry.value -> 'amount_cents') is distinct from 'string'
        or pg_catalog.jsonb_typeof(entry.value -> 'external_transaction_id') is distinct from 'string'
        or (entry.value -> 'counterparty_name' <> 'null'::jsonb
            and pg_catalog.jsonb_typeof(entry.value -> 'counterparty_name') is distinct from 'string')
        or (entry.value ->> 'transaction_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or pg_catalog.char_length(pg_catalog.btrim(entry.value ->> 'description')) not between 1 and 200
        or (entry.value -> 'counterparty_name' <> 'null'::jsonb
            and pg_catalog.char_length(pg_catalog.btrim(entry.value ->> 'counterparty_name')) > 160)
        or (entry.value ->> 'amount_cents') !~ '^-?(0|[1-9][0-9]*)$'
        or pg_catalog.char_length(entry.value ->> 'amount_cents') not between 1 and 20
        or pg_catalog.char_length(pg_catalog.btrim(entry.value ->> 'external_transaction_id')) not between 1 and 200
  ) then
    raise exception using errcode = '22023', message = 'A bank statement row contains invalid values.';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_rows) as entry(value)
     where (entry.value ->> 'amount_cents')::numeric = 0
        or (entry.value ->> 'amount_cents')::numeric < '-9223372036854775808'::numeric
        or (entry.value ->> 'amount_cents')::numeric > '9223372036854775807'::numeric
  ) then
    raise exception using errcode = '22023', message = 'A bank statement row contains an unsafe amount.';
  end if;

  -- Cast every date before recording anything so invalid calendar dates fail the whole batch.
  begin
    if exists (
      select 1
        from pg_catalog.jsonb_array_elements(p_rows) as entry(value)
       where pg_catalog.to_char((entry.value ->> 'transaction_date')::date, 'YYYY-MM-DD')
             is distinct from (entry.value ->> 'transaction_date')
          or (entry.value ->> 'transaction_date')::date
             > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
    ) then
      raise exception using errcode = '22023', message = 'A bank statement row has an invalid or future date.';
    end if;
  exception
    when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'A bank statement row has an invalid or future date.';
  end;

  if exists (
    select pg_catalog.btrim(entry.value ->> 'external_transaction_id')
      from pg_catalog.jsonb_array_elements(p_rows) as entry(value)
     group by pg_catalog.btrim(entry.value ->> 'external_transaction_id')
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Bank statement rows must have unique FITID values.';
  end if;

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'import_bank_statement',
    'business_id', p_business_id,
    'bank_account_id', p_bank_account_id,
    'rows', p_rows,
    'duplicate_rows_in_file', p_duplicate_rows_in_file
  )::text);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select batch.id, batch.request_fingerprint, batch.imported_count, batch.duplicate_count
    into v_batch_id, v_existing_fingerprint, v_stored_imported_count, v_stored_duplicate_count
    from public.bank_statement_import_batches as batch
   where batch.business_id = p_business_id and batch.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different statement rows.';
    end if;
    return query select v_batch_id, v_stored_imported_count, v_stored_duplicate_count;
    return;
  end if;

  perform 1
    from public.bank_accounts as account
   where account.business_id = p_business_id
     and account.id = p_bank_account_id
     and account.is_active
   for update;
  if not found then
    raise exception using errcode = '23503', message = 'The active bank account does not exist in this business.';
  end if;

  v_duplicate_count := p_duplicate_rows_in_file;
  for v_item in
    select entry.value
      from pg_catalog.jsonb_array_elements(p_rows) as entry(value)
     order by entry.value ->> 'external_transaction_id'
  loop
    v_transaction_date := (v_item ->> 'transaction_date')::date;
    v_description := pg_catalog.btrim(v_item ->> 'description');
    v_counterparty_name := nullif(pg_catalog.btrim(v_item ->> 'counterparty_name'), '');
    v_amount_text := v_item ->> 'amount_cents';
    v_amount_cents := v_amount_text::bigint;
    v_external_transaction_id := pg_catalog.btrim(v_item ->> 'external_transaction_id');

    v_row_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
      'operation', 'imported_bank_transaction',
      'business_id', p_business_id,
      'bank_account_id', p_bank_account_id,
      'transaction_date', v_transaction_date,
      'description', v_description,
      'counterparty_name', v_counterparty_name,
      'amount_cents', v_amount_cents,
      'external_transaction_id', v_external_transaction_id
    )::text);

    -- Derive a stable, per-account request ID from FITID so row writes cannot duplicate on retry.
    v_row_request_hash := pg_catalog.md5(
      p_business_id::text || ':' || p_bank_account_id::text || ':' || v_external_transaction_id
    );
    v_row_request_id := (
      pg_catalog.substr(v_row_request_hash, 1, 8) || '-' ||
      pg_catalog.substr(v_row_request_hash, 9, 4) || '-' ||
      pg_catalog.substr(v_row_request_hash, 13, 4) || '-' ||
      pg_catalog.substr(v_row_request_hash, 17, 4) || '-' ||
      pg_catalog.substr(v_row_request_hash, 21, 12)
    )::uuid;

    insert into public.bank_transactions (
      business_id, bank_account_id, transaction_date, description, counterparty_name,
      amount_cents, source, external_transaction_id, request_id, request_fingerprint, created_by
    ) values (
      p_business_id, p_bank_account_id, v_transaction_date, v_description, v_counterparty_name,
      v_amount_cents, 'statement_file'::public.bank_transaction_source,
      v_external_transaction_id, v_row_request_id, v_row_fingerprint, (select auth.uid())
    )
    on conflict (business_id, bank_account_id, source, external_transaction_id)
      where external_transaction_id is not null
      do nothing;

    get diagnostics v_rows_affected = row_count;
    if v_rows_affected = 1 then
      v_imported_count := v_imported_count + 1;
    else
      v_duplicate_count := v_duplicate_count + 1;
    end if;
  end loop;

  insert into public.bank_statement_import_batches (
    business_id, bank_account_id, request_id, request_fingerprint, transaction_count,
    imported_count, duplicate_count, created_by
  ) values (
    p_business_id, p_bank_account_id, p_request_id, v_fingerprint, v_total_count,
    v_imported_count, v_duplicate_count, (select auth.uid())
  ) returning id into v_batch_id;

  return query select v_batch_id, v_imported_count, v_duplicate_count;
end;
$function$;

-- This public RPC is an intentional authenticated endpoint; the owner check above is mandatory.
revoke all on function public.import_bank_statement(uuid, uuid, jsonb, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.import_bank_statement(uuid, uuid, jsonb, integer, uuid)
  to authenticated;
