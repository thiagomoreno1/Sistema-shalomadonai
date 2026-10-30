-- Keep customer/order links tenant-safe and ensure the order belongs to
-- the same customer as the interaction.
alter table public.orders
  add constraint orders_business_customer_id_key unique (business_id, customer_id, id);

alter table public.customer_interactions
  add column related_order_id uuid,
  add constraint customer_interactions_related_order_requires_customer
    check (related_order_id is null or customer_id is not null),
  add constraint customer_interactions_related_order_fkey
    foreign key (business_id, customer_id, related_order_id)
    references public.orders (business_id, customer_id, id)
    on delete restrict;

create index customer_interactions_order_history_idx
  on public.customer_interactions (business_id, related_order_id, occurred_at desc)
  where related_order_id is not null;

-- This RPC retains the original interaction and follow-up behavior while
-- atomically attaching an optional order. A distinct name avoids unsupported
-- PostgREST function overloading and leaves existing callers unchanged.
create function public.record_customer_interaction_with_order(
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
  p_related_order_id uuid
)
returns table (interaction_id uuid, follow_up_task_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_interaction_id uuid;
  v_follow_up_task_id uuid;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Interaction access denied.';
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

  select recorded.interaction_id, recorded.follow_up_task_id
    into v_interaction_id, v_follow_up_task_id
    from public.record_customer_interaction(
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
      p_follow_up_priority
    ) as recorded;

  if p_related_order_id is not null then
    update public.customer_interactions
       set related_order_id = p_related_order_id
     where business_id = p_business_id
       and id = v_interaction_id;
  end if;

  return query select v_interaction_id, v_follow_up_task_id;
end;
$function$;

revoke all on function public.record_customer_interaction_with_order(
  uuid, uuid, public.customer_interaction_type, public.interaction_direction,
  public.call_outcome, text, text, timestamptz, text, date,
  public.follow_up_priority, uuid
) from public, anon, authenticated;
grant execute on function public.record_customer_interaction_with_order(
  uuid, uuid, public.customer_interaction_type, public.interaction_direction,
  public.call_outcome, text, text, timestamptz, text, date,
  public.follow_up_priority, uuid
) to authenticated;
