-- Allow the owner to remove an order that has not produced financial,
-- inventory, fulfillment, or customer-service side effects.
create function private.order_can_be_purged(
  p_business_id uuid,
  p_order_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_business_id is not null
     and p_order_id is not null
     and (select auth.uid()) is not null
     and (select private.is_business_owner(p_business_id))
     and exists (
       select 1
         from public.orders as order_row
        where order_row.business_id = p_business_id
          and order_row.id = p_order_id
     )
     and not exists (
       select 1 from public.order_payments as payment
        where payment.business_id = p_business_id and payment.order_id = p_order_id
     )
     and not exists (
       select 1 from public.inventory_movements as movement
        where movement.business_id = p_business_id and movement.order_id = p_order_id
     )
     and not exists (
       select 1 from public.financial_outflows as outflow
        where outflow.business_id = p_business_id and outflow.order_id = p_order_id
     )
     and not exists (
       select 1 from public.order_events as event
        where event.business_id = p_business_id
          and event.order_id = p_order_id
          and event.event_type = 'picked_up'::public.order_event_type
     )
     and not exists (
       select 1 from public.deliveries as delivery
        where delivery.business_id = p_business_id
          and delivery.order_id = p_order_id
          and delivery.status not in (
            'awaiting_separation'::public.delivery_status,
            'ready'::public.delivery_status
          )
     )
     and not exists (
       select 1 from public.customer_interactions as interaction
        where interaction.business_id = p_business_id
          and interaction.related_order_id = p_order_id
     )
     and not exists (
       select 1 from public.whatsapp_conversation_links as link
        where link.business_id = p_business_id and link.order_id = p_order_id
     )
     and not exists (
       select 1 from public.whatsapp_conversation_contexts as context
        where context.business_id = p_business_id and context.order_id = p_order_id
     );
$function$;

revoke all on function private.order_can_be_purged(uuid, uuid) from public, anon, authenticated;

-- Keep append-only snapshots immutable except when the owner-only purge RPC
-- removes a safe, unfulfilled order in the same transaction.
create or replace function private.reject_immutable_record_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_business_id uuid;
  v_order_id uuid;
begin
  if tg_op = 'DELETE'
     and current_setting('shalom.order_purge', true) = 'on'
     and tg_table_name in ('order_line_components', 'delivery_events') then
    if tg_table_name = 'order_line_components' then
      v_business_id := old.business_id;
      v_order_id := old.order_id;
    else
      select delivery.business_id, delivery.order_id
        into v_business_id, v_order_id
        from public.deliveries as delivery
       where delivery.business_id = old.business_id
         and delivery.id = old.delivery_id;
    end if;

    if v_business_id is not null
       and v_order_id is not null
       and private.order_can_be_purged(v_business_id, v_order_id) then
      return old;
    end if;
  end if;

  raise exception using errcode = '55000', message = 'This record is append-only.';
end;
$function$;

revoke all on function private.reject_immutable_record_change() from public, anon, authenticated;

create function public.delete_unfulfilled_order(
  p_business_id uuid,
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Order deletion access denied.';
  end if;
  if p_business_id is null or p_order_id is null then
    raise exception using errcode = '22023', message = 'Order deletion details are invalid.';
  end if;

  -- Lock in the same order used by payment and delivery transitions so their
  -- side effects cannot race the eligibility check.
  perform 1
    from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.id = p_order_id
   for update;
  if not found then
    -- Make retries safe when a request succeeded but its response was lost.
    return p_order_id;
  end if;

  perform 1
    from public.deliveries as delivery
   where delivery.business_id = p_business_id and delivery.order_id = p_order_id
   for update;

  if not private.order_can_be_purged(p_business_id, p_order_id) then
    raise exception using errcode = '22023', message = 'order_delete_has_side_effects';
  end if;

  perform pg_catalog.set_config('shalom.order_purge', 'on', true);

  delete from public.delivery_events as event
   using public.deliveries as delivery
   where delivery.business_id = p_business_id
     and delivery.order_id = p_order_id
     and event.business_id = delivery.business_id
     and event.delivery_id = delivery.id;

  delete from public.deliveries as delivery
   where delivery.business_id = p_business_id and delivery.order_id = p_order_id;

  delete from public.order_line_components as component
   where component.business_id = p_business_id and component.order_id = p_order_id;

  delete from public.order_events as event
   where event.business_id = p_business_id and event.order_id = p_order_id;

  delete from public.order_installments as installment
   where installment.business_id = p_business_id and installment.order_id = p_order_id;

  delete from public.order_lines as line
   where line.business_id = p_business_id and line.order_id = p_order_id;

  delete from public.orders as order_row
   where order_row.business_id = p_business_id and order_row.id = p_order_id;

  return p_order_id;
end;
$function$;

revoke all on function public.delete_unfulfilled_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_unfulfilled_order(uuid, uuid) to authenticated;
