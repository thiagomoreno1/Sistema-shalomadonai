-- Record a paid stock receipt as a purchase outflow in the same transaction.
-- Purchases affect cash reporting; product cost is still recognized in profit
-- when the purchased stock is sold through the order snapshots.
create function public.record_inventory_receipt_with_payment(
  p_business_id uuid,
  p_supplier_name text,
  p_purchase_reference text,
  p_received_on date,
  p_notes text,
  p_items jsonb,
  p_record_as_paid boolean,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receipt_id uuid;
  v_total_cents numeric;
  v_request_hash text;
  v_outflow_request_id uuid;
  v_paid_on date;
begin
  if (select auth.uid()) is null or not (select private.is_business_owner(p_business_id)) then
    raise exception using errcode = '42501', message = 'Inventory receipt access denied.';
  end if;
  if p_record_as_paid is null then
    raise exception using errcode = '22023', message = 'Purchase payment status is required.';
  end if;

  v_receipt_id := public.record_inventory_receipt(
    p_business_id,
    p_supplier_name,
    p_purchase_reference,
    p_received_on,
    p_notes,
    p_items,
    p_request_id
  );

  if not p_record_as_paid then
    return v_receipt_id;
  end if;

  -- The cash movement date is when this owner records the purchase as paid,
  -- which can differ from the day the goods physically arrived.
  v_paid_on := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;

  select coalesce(sum(pg_catalog.round(line.quantity * line.unit_cost_cents)), 0)
    into v_total_cents
    from public.inventory_receipt_lines as line
   where line.business_id = p_business_id
     and line.receipt_id = v_receipt_id;

  if v_total_cents <= 0 then
    return v_receipt_id;
  end if;
  if v_total_cents > 9007199254740991 then
    raise exception using errcode = '22003', message = 'The paid purchase amount is too large to record safely.';
  end if;

  v_request_hash := pg_catalog.md5('inventory-receipt-paid:' || v_receipt_id::text);
  v_outflow_request_id := (
    pg_catalog.substr(v_request_hash, 1, 8) || '-' ||
    pg_catalog.substr(v_request_hash, 9, 4) || '-' ||
    pg_catalog.substr(v_request_hash, 13, 4) || '-' ||
    pg_catalog.substr(v_request_hash, 17, 4) || '-' ||
    pg_catalog.substr(v_request_hash, 21, 12)
  )::uuid;

  perform public.record_financial_outflow(
    p_business_id,
    'purchase'::public.financial_outflow_type,
    'Compra para estoque',
    'Compra de estoque',
    p_supplier_name,
    v_total_cents::bigint,
    v_paid_on,
    null,
    null,
    array[v_receipt_id],
    v_outflow_request_id
  );

  return v_receipt_id;
end;
$function$;

revoke all on function public.record_inventory_receipt_with_payment(uuid, text, text, date, text, jsonb, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.record_inventory_receipt_with_payment(uuid, text, text, date, text, jsonb, boolean, uuid)
  to authenticated;

-- Keep a received stock purchase from being recorded as paid twice, including
-- when two separate manual outflow requests race to link the same receipt.
create function private.prevent_duplicate_active_inventory_receipt_outflow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(new.business_id::text),
    pg_catalog.hashtext('inventory-receipt-paid:' || new.inventory_receipt_id::text)
  );

  if exists (
    select 1
      from public.financial_outflow_inventory_receipts as existing_link
      join public.financial_outflows as existing_outflow
        on existing_outflow.business_id = existing_link.business_id
       and existing_outflow.id = existing_link.outflow_id
     where existing_link.business_id = new.business_id
       and existing_link.inventory_receipt_id = new.inventory_receipt_id
       and not exists (
         select 1 from public.financial_outflow_voids as void_event
          where void_event.business_id = existing_outflow.business_id
            and void_event.outflow_id = existing_outflow.id
       )
  ) then
    raise exception using errcode = '23505', message = 'This inventory receipt is already linked to an active paid purchase.';
  end if;

  return new;
end;
$function$;

revoke all on function private.prevent_duplicate_active_inventory_receipt_outflow() from public, anon, authenticated;

create trigger financial_outflow_inventory_receipts_prevent_duplicate_active_receipt
  before insert on public.financial_outflow_inventory_receipts
  for each row execute function private.prevent_duplicate_active_inventory_receipt_outflow();
