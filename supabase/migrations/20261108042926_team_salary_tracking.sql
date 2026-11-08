-- Generalize the delivery roster into a team directory while preserving the
-- existing delivery-worker IDs used by orders and the delivery portal.
alter table public.delivery_workers
  add column member_type text not null default 'delivery_driver'
    check (member_type in ('delivery_driver', 'employee')),
  add column monthly_salary_cents bigint
    check (monthly_salary_cents is null or monthly_salary_cents > 0),
  add column salary_due_day smallint
    check (salary_due_day is null or salary_due_day between 1 and 31),
  add column salary_started_on date,
  add constraint delivery_workers_salary_schedule_check check (
    (monthly_salary_cents is null and salary_due_day is null and salary_started_on is null)
    or (monthly_salary_cents is not null and salary_due_day is not null and salary_started_on is not null)
  ),
  add constraint delivery_workers_employee_no_portal_check check (
    member_type = 'delivery_driver' or user_id is null
  );

create index delivery_workers_team_idx
  on public.delivery_workers (business_id, member_type, is_active, name);

grant insert (member_type, monthly_salary_cents, salary_due_day)
  on public.delivery_workers to authenticated;
grant update (monthly_salary_cents, salary_due_day)
  on public.delivery_workers to authenticated;

create table public.team_salary_schedules (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_worker_id uuid not null,
  monthly_salary_cents bigint not null check (monthly_salary_cents > 0),
  salary_due_day smallint not null check (salary_due_day between 1 and 31),
  effective_on date not null,
  effective_until date,
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, delivery_worker_id, effective_on),
  foreign key (business_id, delivery_worker_id)
    references public.delivery_workers (business_id, id) on delete restrict,
  check (effective_until is null or effective_until >= effective_on)
);

create index team_salary_schedules_history_idx
  on public.team_salary_schedules (business_id, delivery_worker_id, effective_on desc);

alter table public.team_salary_schedules enable row level security;
revoke all on table public.team_salary_schedules from public, anon, authenticated;
create policy team_salary_schedules_select_for_owners on public.team_salary_schedules
  for select to authenticated using ((select private.is_business_owner(business_id)));

create function private.sync_team_salary_schedules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_current_month_end date := (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date;
  v_next_month_start date := (date_trunc('month', v_today) + interval '1 month')::date;
  v_effective_on date;
  v_salary_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.monthly_salary_cents is not null and new.salary_due_day is not null and new.is_active then
      new.salary_started_on := v_today;
      insert into public.team_salary_schedules (
        business_id, delivery_worker_id, monthly_salary_cents, salary_due_day, effective_on, created_by
      ) values (
        new.business_id, new.id, new.monthly_salary_cents, new.salary_due_day,
        new.salary_started_on, coalesce((select auth.uid()), new.created_by)
      );
    end if;
    return new;
  end if;

  v_salary_changed := old.monthly_salary_cents is distinct from new.monthly_salary_cents
    or old.salary_due_day is distinct from new.salary_due_day;

  if v_salary_changed then
    if old.monthly_salary_cents is not null then
      update public.team_salary_schedules
         set effective_until = v_current_month_end
       where business_id = old.business_id
         and delivery_worker_id = old.id
         and effective_until is null
         and effective_on <= v_current_month_end;
    end if;

    if new.monthly_salary_cents is not null and new.salary_due_day is not null and new.is_active then
      v_effective_on := case
        when old.monthly_salary_cents is null then v_today
        else v_next_month_start
      end;
      insert into public.team_salary_schedules (
        business_id, delivery_worker_id, monthly_salary_cents, salary_due_day, effective_on, created_by
      ) values (
        new.business_id, new.id, new.monthly_salary_cents, new.salary_due_day,
        v_effective_on, coalesce((select auth.uid()), new.created_by)
      ) on conflict (business_id, delivery_worker_id, effective_on) do update
        set monthly_salary_cents = excluded.monthly_salary_cents,
            salary_due_day = excluded.salary_due_day,
            effective_until = null;
      new.salary_started_on := v_effective_on;
    else
      delete from public.team_salary_schedules
       where business_id = old.business_id
         and delivery_worker_id = old.id
         and effective_on > v_current_month_end
         and effective_until is null;
      new.salary_started_on := null;
    end if;
  elsif old.is_active and not new.is_active then
    delete from public.team_salary_schedules
     where business_id = old.business_id
       and delivery_worker_id = old.id
       and effective_on > v_current_month_end
       and effective_until is null;
    update public.team_salary_schedules
       set effective_until = v_current_month_end
     where business_id = old.business_id
       and delivery_worker_id = old.id
       and effective_on <= v_current_month_end
       and effective_until is null;
  elsif not old.is_active and new.is_active
        and new.monthly_salary_cents is not null and new.salary_due_day is not null then
    insert into public.team_salary_schedules (
      business_id, delivery_worker_id, monthly_salary_cents, salary_due_day, effective_on, created_by
    ) values (
      new.business_id, new.id, new.monthly_salary_cents, new.salary_due_day,
      v_next_month_start, coalesce((select auth.uid()), new.created_by)
    ) on conflict (business_id, delivery_worker_id, effective_on) do update
      set monthly_salary_cents = excluded.monthly_salary_cents,
          salary_due_day = excluded.salary_due_day,
          effective_until = null;
    new.salary_started_on := v_next_month_start;
  end if;
  return new;
end;
$function$;

revoke all on function private.sync_team_salary_schedules() from public, anon, authenticated;
create trigger delivery_workers_sync_salary_schedules
  before insert or update of monthly_salary_cents, salary_due_day, salary_started_on, is_active
  on public.delivery_workers
  for each row execute function private.sync_team_salary_schedules();

create table public.team_salary_payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  delivery_worker_id uuid not null,
  period_start date not null check (period_start = date_trunc('month', period_start)::date),
  due_on date not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  outflow_id uuid not null,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, delivery_worker_id, period_start),
  unique (business_id, outflow_id),
  unique (business_id, request_id),
  foreign key (business_id, delivery_worker_id)
    references public.delivery_workers (business_id, id) on delete restrict,
  foreign key (business_id, outflow_id)
    references public.financial_outflows (business_id, id) on delete restrict
);

create index team_salary_payments_period_idx
  on public.team_salary_payments (business_id, period_start desc, delivery_worker_id);

alter table public.team_salary_payments enable row level security;
revoke all on table public.team_salary_payments from public, anon, authenticated;

create policy team_salary_payments_select_for_owners on public.team_salary_payments
  for select to authenticated using ((select private.is_business_owner(business_id)));

create function private.require_active_delivery_driver()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.delivery_worker_id is not null and not exists (
    select 1 from public.delivery_workers as worker
     where worker.business_id = new.business_id
       and worker.id = new.delivery_worker_id
       and worker.is_active
       and worker.member_type = 'delivery_driver'
  ) then
    raise exception using errcode = '23503', message = 'Choose an active delivery driver in this business.';
  end if;
  return new;
end;
$function$;

revoke all on function private.require_active_delivery_driver() from public, anon, authenticated;

create trigger deliveries_require_active_driver
  before insert or update of delivery_worker_id on public.deliveries
  for each row execute function private.require_active_delivery_driver();

create function public.get_team_salary_status(p_business_id uuid, p_today date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with settings as (
    select least(p_today, (pg_catalog.now() at time zone 'America/Sao_Paulo')::date) as as_of_on
  ), salary_periods as (
    select worker.business_id,
           worker.id as worker_id,
           worker.name,
           worker.member_type,
           schedule.salary_due_day,
           schedule.monthly_salary_cents,
           schedule.effective_on,
           schedule.effective_until,
           settings.as_of_on,
           date_trunc('month', period.period_at)::date as period_start
      from public.team_salary_schedules as schedule
      join public.delivery_workers as worker
        on worker.business_id = schedule.business_id
       and worker.id = schedule.delivery_worker_id
      cross join settings
      cross join lateral pg_catalog.generate_series(
        date_trunc('month', schedule.effective_on)::timestamp,
        date_trunc('month', least(settings.as_of_on, coalesce(schedule.effective_until, settings.as_of_on)))::timestamp,
        interval '1 month'
      ) as period(period_at)
     where schedule.business_id = p_business_id
       and schedule.effective_on <= settings.as_of_on
  ), expected_payments as (
    select salary_periods.*,
           period_start + (
             least(
               salary_due_day,
               extract(day from (period_start + interval '1 month' - interval '1 day'))::integer
             ) - 1
           ) as due_on
      from salary_periods
     where period_start + (
       least(
         salary_due_day,
         extract(day from (period_start + interval '1 month' - interval '1 day'))::integer
       ) - 1
     ) >= effective_on
       and (effective_until is null or period_start + (
         least(
           salary_due_day,
           extract(day from (period_start + interval '1 month' - interval '1 day'))::integer
         ) - 1
       ) <= effective_until)
  ), statuses as (
    select expected.*,
           coalesce(payment.amount_cents, expected.monthly_salary_cents) as amount_cents,
           payment.paid_on,
           payment.outflow_id,
           (payment.id is not null and void_event.id is null) as is_paid
      from expected_payments as expected
      left join public.team_salary_payments as payment
        on payment.business_id = expected.business_id
       and payment.delivery_worker_id = expected.worker_id
       and payment.period_start = expected.period_start
      left join public.financial_outflow_voids as void_event
        on void_event.business_id = payment.business_id
       and void_event.outflow_id = payment.outflow_id
  )
  select case
    when (select auth.uid()) is null
      or p_business_id is null
      or p_today is null
      or not (select private.is_business_owner(p_business_id))
    then null
    else pg_catalog.jsonb_build_object(
      'as_of_on', (select as_of_on from settings),
      'overdue_count', (select count(*) from statuses where not is_paid and due_on < (select as_of_on from settings)),
      'overdue_amount_cents', coalesce((select sum(amount_cents) from statuses where not is_paid and due_on < (select as_of_on from settings)), 0)::text,
      'due_today_count', (select count(*) from statuses where not is_paid and due_on = (select as_of_on from settings)),
      'due_today_amount_cents', coalesce((select sum(amount_cents) from statuses where not is_paid and due_on = (select as_of_on from settings)), 0)::text,
      'items', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'worker_id', item.worker_id,
          'name', item.name,
          'member_type', item.member_type,
          'period_start', item.period_start,
          'due_on', item.due_on,
          'amount_cents', item.amount_cents::text,
          'paid_on', case when item.is_paid then item.paid_on else null end,
          'outflow_id', case when item.is_paid then item.outflow_id else null end
        ) order by item.is_paid, item.due_on, item.name, item.worker_id)
        from (
          select * from statuses
           where (not is_paid and (due_on <= (select as_of_on from settings) or period_start = date_trunc('month', (select as_of_on from settings))::date))
              or (period_start = date_trunc('month', (select as_of_on from settings))::date and is_paid)
           order by is_paid, due_on, name, worker_id
           limit 100
        ) as item
      ), '[]'::jsonb)
    )
  end
$function$;

revoke all on function public.get_team_salary_status(uuid, date) from public, anon, authenticated;
grant execute on function public.get_team_salary_status(uuid, date) to authenticated;

create function public.record_team_salary_payment(
  p_business_id uuid,
  p_worker_id uuid,
  p_period_start date,
  p_paid_on date,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_worker record;
  v_schedule record;
  v_due_on date;
  v_amount_cents bigint;
  v_existing_payment record;
  v_outflow_id uuid;
  v_existing_fingerprint text;
  v_fingerprint text;
  v_business_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Team salary access denied.';
  end if;
  if p_worker_id is null
     or p_period_start is null
     or p_period_start <> date_trunc('month', p_period_start)::date
     or p_period_start > date_trunc('month', v_business_today)::date
     or p_paid_on is null
     or p_paid_on > v_business_today
     or p_request_id is null then
    raise exception using errcode = '22023', message = 'Team salary payment details are invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  select worker.id, worker.name
    into v_worker
    from public.delivery_workers as worker
   where worker.business_id = p_business_id and worker.id = p_worker_id
   for update;
  if not found then
    raise exception using errcode = '22023', message = 'This team member has no salary due for the selected month.';
  end if;

  select schedule.monthly_salary_cents, schedule.salary_due_day,
         schedule.effective_on, schedule.effective_until,
         p_period_start + (
           least(
             schedule.salary_due_day,
             extract(day from (p_period_start + interval '1 month' - interval '1 day'))::integer
           ) - 1
         ) as due_on
    into v_schedule
    from public.team_salary_schedules as schedule
   where schedule.business_id = p_business_id
     and schedule.delivery_worker_id = p_worker_id
     and p_period_start + (
       least(
         schedule.salary_due_day,
         extract(day from (p_period_start + interval '1 month' - interval '1 day'))::integer
       ) - 1
     ) >= schedule.effective_on
     and (schedule.effective_until is null or p_period_start + (
       least(
         schedule.salary_due_day,
         extract(day from (p_period_start + interval '1 month' - interval '1 day'))::integer
       ) - 1
     ) <= schedule.effective_until)
   order by schedule.effective_on desc
   limit 1
   for share of schedule;
  if not found then
    raise exception using errcode = '22023', message = 'This team member has no salary due for the selected month.';
  end if;

  v_due_on := v_schedule.due_on;
  if v_due_on < v_schedule.effective_on
     or (v_schedule.effective_until is not null and v_due_on > v_schedule.effective_until) then
    raise exception using errcode = '22023', message = 'This salary period is outside the active salary schedule.';
  end if;
  v_amount_cents := v_schedule.monthly_salary_cents;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_team_salary_payment',
    'business_id', p_business_id,
    'worker_id', p_worker_id,
    'period_start', p_period_start,
    'due_on', v_due_on,
    'amount_cents', v_amount_cents,
    'paid_on', p_paid_on
  )::text);

  select payment.id, payment.outflow_id, payment.request_id, payment.request_fingerprint,
         void_event.id as void_id
    into v_existing_payment
    from public.team_salary_payments as payment
    left join public.financial_outflow_voids as void_event
      on void_event.business_id = payment.business_id and void_event.outflow_id = payment.outflow_id
   where payment.business_id = p_business_id
     and payment.delivery_worker_id = p_worker_id
     and payment.period_start = p_period_start
   for update of payment;

  if found and v_existing_payment.void_id is null then
    return v_existing_payment.outflow_id;
  end if;

  select outflow.id, outflow.request_fingerprint
    into v_outflow_id, v_existing_fingerprint
    from public.financial_outflows as outflow
   where outflow.business_id = p_business_id and outflow.request_id = p_request_id;
  if found then
    if exists (
      select 1 from public.financial_outflow_voids as void_event
       where void_event.business_id = p_business_id
         and void_event.outflow_id = v_outflow_id
    ) then
      raise exception using errcode = '22023', message = 'This request id belongs to a voided salary payment. Retry with a new request id.';
    end if;
    if v_existing_fingerprint is distinct from pg_catalog.md5(pg_catalog.jsonb_build_object(
      'operation', 'record_financial_outflow',
      'business_id', p_business_id,
      'outflow_type', 'operating_expense'::public.financial_outflow_type,
      'description', pg_catalog.left('Salário · ' || v_worker.name || ' · ' || pg_catalog.to_char(p_period_start, 'MM/YYYY'), 200),
      'category', 'Salários da equipe',
      'counterparty_name', v_worker.name,
      'amount_cents', v_amount_cents,
      'paid_on', p_paid_on,
      'order_id', null,
      'notes', 'Pagamento de salário referente a ' || pg_catalog.to_char(p_period_start, 'MM/YYYY'),
      'inventory_receipt_ids', '{}'::uuid[]
    )::text) then
      raise exception using errcode = '22023', message = 'This request id was already used for different team salary details.';
    end if;
  else
    v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
      'operation', 'record_financial_outflow',
      'business_id', p_business_id,
      'outflow_type', 'operating_expense'::public.financial_outflow_type,
      'description', pg_catalog.left('Salário · ' || v_worker.name || ' · ' || pg_catalog.to_char(p_period_start, 'MM/YYYY'), 200),
      'category', 'Salários da equipe',
      'counterparty_name', v_worker.name,
      'amount_cents', v_amount_cents,
      'paid_on', p_paid_on,
      'order_id', null,
      'notes', 'Pagamento de salário referente a ' || pg_catalog.to_char(p_period_start, 'MM/YYYY'),
      'inventory_receipt_ids', '{}'::uuid[]
    )::text);
    insert into public.financial_outflows (
      business_id, outflow_type, description, category, counterparty_name,
      amount_cents, paid_on, order_id, notes, request_id, request_fingerprint, created_by
    ) values (
      p_business_id,
      'operating_expense'::public.financial_outflow_type,
      pg_catalog.left('Salário · ' || v_worker.name || ' · ' || pg_catalog.to_char(p_period_start, 'MM/YYYY'), 200),
      'Salários da equipe', v_worker.name, v_amount_cents, p_paid_on, null,
      'Pagamento de salário referente a ' || pg_catalog.to_char(p_period_start, 'MM/YYYY'),
      p_request_id, v_fingerprint, (select auth.uid())
    ) returning id into v_outflow_id;
  end if;

  if v_existing_payment.id is null then
    insert into public.team_salary_payments (
      business_id, delivery_worker_id, period_start, due_on, amount_cents,
      paid_on, outflow_id, request_id, request_fingerprint, created_by
    ) values (
      p_business_id, p_worker_id, p_period_start, v_due_on, v_amount_cents,
      p_paid_on, v_outflow_id, p_request_id, v_fingerprint, (select auth.uid())
    );
  else
    update public.team_salary_payments
       set due_on = v_due_on,
           amount_cents = v_amount_cents,
           paid_on = p_paid_on,
           outflow_id = v_outflow_id,
           request_id = p_request_id,
           request_fingerprint = v_fingerprint,
           created_by = (select auth.uid())
     where business_id = p_business_id and id = v_existing_payment.id;
  end if;
  return v_outflow_id;
end;
$function$;

revoke all on function public.record_team_salary_payment(uuid, uuid, date, date, uuid) from public, anon, authenticated;
grant execute on function public.record_team_salary_payment(uuid, uuid, date, date, uuid) to authenticated;
