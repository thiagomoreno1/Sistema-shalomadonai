-- Keep interaction retries safe after a client loses the response to a commit.
-- The private ledger stores only a request fingerprint and the original IDs.
create table private.customer_interaction_requests (
  business_id uuid not null references public.businesses (id) on delete restrict,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  interaction_id uuid not null,
  follow_up_task_id uuid,
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (business_id, request_id),
  unique (business_id, interaction_id),
  foreign key (business_id, interaction_id)
    references public.customer_interactions (business_id, id)
    on delete restrict
);

revoke all on table private.customer_interaction_requests from public, anon, authenticated;

-- Use a new RPC name so PostgREST callers can roll forward without changing
-- the signature or behavior of the existing interaction RPCs.
create function public.record_customer_interaction_with_order_idempotent(
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
  p_follow_up_priority public.follow_up_priority,
  p_related_order_id uuid,
  p_request_id uuid
)
returns table (interaction_id uuid, follow_up_task_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_fingerprint text;
  v_interaction_id uuid;
  v_follow_up_task_id uuid;
  v_existing_fingerprint text;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Interaction access denied.';
  end if;

  if p_request_id is null then
    raise exception using errcode = '22023', message = 'An interaction request id is required.';
  end if;

  if p_customer_id is not null and not exists (
    select 1
      from public.customers as customer
     where customer.business_id = p_business_id
       and customer.id = p_customer_id
  ) then
    raise exception using errcode = '23503', message = 'The customer must belong to the selected business.';
  end if;

  if p_related_order_id is not null and (
    p_customer_id is null
    or not exists (
      select 1
        from public.orders as order_record
       where order_record.business_id = p_business_id
         and order_record.customer_id = p_customer_id
         and order_record.id = p_related_order_id
    )
  ) then
    raise exception using
      errcode = '23503',
      message = 'The related order must belong to the selected customer and business.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_business_id::text), pg_catalog.hashtext(p_request_id::text)
  );

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_object(
    'operation', 'record_customer_interaction_with_order',
    'business_id', p_business_id,
    'customer_id', p_customer_id,
    'interaction_type', p_interaction_type,
    'direction', p_direction,
    'call_outcome', p_call_outcome,
    'outcome', p_outcome,
    'notes', p_notes,
    'occurred_at', p_occurred_at,
    'follow_up_title', p_follow_up_title,
    'follow_up_due_on', p_follow_up_due_on,
    'follow_up_priority', p_follow_up_priority,
    'related_order_id', p_related_order_id
  )::text);

  select request.interaction_id, request.follow_up_task_id, request.request_fingerprint
    into v_interaction_id, v_follow_up_task_id, v_existing_fingerprint
    from private.customer_interaction_requests as request
   where request.business_id = p_business_id
     and request.request_id = p_request_id;
  if found then
    if v_existing_fingerprint is distinct from v_fingerprint then
      raise exception using errcode = '22023', message = 'This request id was already used for different interaction details.';
    end if;
    return query select v_interaction_id, v_follow_up_task_id;
    return;
  end if;

  select recorded.interaction_id, recorded.follow_up_task_id
    into v_interaction_id, v_follow_up_task_id
    from public.record_customer_interaction_with_order(
      p_business_id,
      p_customer_id,
      p_interaction_type,
      p_direction,
      p_call_outcome,
      p_outcome,
      p_notes,
      p_occurred_at,
      p_follow_up_title,
      p_follow_up_due_on,
      p_follow_up_priority,
      p_related_order_id
    ) as recorded;

  insert into private.customer_interaction_requests (
    business_id, request_id, request_fingerprint,
    interaction_id, follow_up_task_id, created_by
  ) values (
    p_business_id, p_request_id, v_fingerprint,
    v_interaction_id, v_follow_up_task_id, (select auth.uid())
  );

  return query select v_interaction_id, v_follow_up_task_id;
end;
$function$;

revoke all on function public.record_customer_interaction_with_order_idempotent(
  uuid, uuid, public.customer_interaction_type, public.interaction_direction,
  public.call_outcome, text, text, timestamptz, text, date,
  public.follow_up_priority, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.record_customer_interaction_with_order_idempotent(
  uuid, uuid, public.customer_interaction_type, public.interaction_direction,
  public.call_outcome, text, text, timestamptz, text, date,
  public.follow_up_priority, uuid, uuid
) to authenticated;
