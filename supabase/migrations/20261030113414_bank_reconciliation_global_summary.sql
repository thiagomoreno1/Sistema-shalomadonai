-- Return one atomic, RLS-filtered snapshot for all bank movements in a business.
create function public.bank_reconciliation_global_summary(p_business_id uuid)
returns table (
  status text,
  movement_count text,
  gross_cents text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with authorized_business as materialized (
    select p_business_id as business_id
     where (select auth.uid()) is not null
       and (select private.is_business_owner(p_business_id))
  ),
  status_rows(status) as (
    values ('reconciled'::text), ('pending'::text), ('duplicate'::text)
  ),
  movement_status as (
    select movement.id,
           movement.amount_cents,
           case
             when exists (
               select 1
                 from public.bank_transaction_duplicates as duplicate_record
                 left join public.bank_transaction_duplicate_clears as clear_record
                   on clear_record.business_id = duplicate_record.business_id
                  and clear_record.duplicate_id = duplicate_record.id
                where duplicate_record.business_id = movement.business_id
                  and duplicate_record.duplicate_transaction_id = movement.id
                  and clear_record.id is null
             ) then 'duplicate'::text
             when exists (
               select 1
                 from public.bank_reconciliation_matches as match_record
                 left join public.bank_reconciliation_match_reversals as reversal
                   on reversal.business_id = match_record.business_id
                  and reversal.match_id = match_record.id
                where match_record.business_id = movement.business_id
                  and match_record.bank_transaction_id = movement.id
                  and reversal.id is null
             ) then 'reconciled'::text
             else 'pending'::text
           end as status
      from authorized_business as authorized
      join public.bank_transactions as movement
        on movement.business_id = authorized.business_id
  )
  select status_row.status,
         count(movement.id)::text as movement_count,
         coalesce(sum(abs(movement.amount_cents::numeric)), 0)::text as gross_cents
    from authorized_business as authorized
    cross join status_rows as status_row
    left join movement_status as movement
      on movement.status = status_row.status
   group by status_row.status
   order by case status_row.status
     when 'reconciled' then 1
     when 'pending' then 2
     else 3
   end;
$function$;

revoke all on function public.bank_reconciliation_global_summary(uuid)
  from public, anon, authenticated;
grant execute on function public.bank_reconciliation_global_summary(uuid)
  to authenticated;
