-- Arariboia-specific customer credit settings are no longer part of the product.
-- Generic installment schedules and customer receivables remain unchanged.

do $migration$
begin
  if (
    select count(*) = 2
      from pg_catalog.pg_attribute
     where attrelid = 'public.customers'::regclass
       and attname in ('is_arariboia', 'arariboia_limit_cents')
       and not attisdropped
  ) then
    revoke insert (is_arariboia, arariboia_limit_cents)
      on table public.customers from authenticated;
    revoke update (is_arariboia, arariboia_limit_cents)
      on table public.customers from authenticated;
  end if;
end
$migration$;

alter table public.customers
  drop constraint if exists customers_arariboia_limit_nonnegative,
  drop column if exists is_arariboia,
  drop column if exists arariboia_limit_cents;
