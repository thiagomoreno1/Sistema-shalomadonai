create or replace function private.enforce_product_stock_and_combo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Keep authorization failures distinct from catalog validation failures.
  -- Triggers run before RLS checks, so unauthorized attempts must be rejected
  -- here before inspecting the submitted product state.
  if (select auth.uid()) is null
     or not (select private.is_business_owner(new.business_id)) then
    raise exception using errcode = '42501', message = 'Product access denied.';
  end if;

  if tg_op = 'INSERT' then
    if new.is_combo then
      raise exception using errcode = '22023', message = 'New combo products are no longer supported.';
    end if;
  elsif new.is_combo and not old.is_combo then
    raise exception using errcode = '22023', message = 'New combo products are no longer supported.';
  end if;
  if new.is_active and not new.is_combo and not new.inventory_tracked then
    raise exception using errcode = '22023', message = 'Set the stock unit and opening count before activating this product.';
  end if;
  return new;
end;
$function$;

revoke all on function private.enforce_product_stock_and_combo() from public, anon, authenticated;
