-- Product price and cost changes are captured atomically with product writes.
-- Baseline rows only record values present when this migration runs; they do
-- not claim to represent earlier price or cost changes.

create table public.product_price_history (
  id uuid primary key default gen_random_uuid(),
  event_sequence bigint generated always as identity unique,
  business_id uuid not null,
  product_id uuid not null,
  event_kind text not null check (event_kind in ('baseline', 'created', 'updated')),
  old_sale_price_cents bigint check (old_sale_price_cents is null or old_sale_price_cents >= 0),
  new_sale_price_cents bigint check (new_sale_price_cents is null or new_sale_price_cents >= 0),
  old_cost_cents bigint check (old_cost_cents is null or old_cost_cents >= 0),
  new_cost_cents bigint check (new_cost_cents is null or new_cost_cents >= 0),
  changed_by uuid references auth.users (id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  unique (business_id, id),
  foreign key (business_id, product_id)
    references public.products (business_id, id) on delete restrict,
  check (
    (event_kind = 'baseline'
      and old_sale_price_cents is null
      and old_cost_cents is null
      and (new_sale_price_cents is not null or new_cost_cents is not null))
    or (event_kind = 'created'
      and old_sale_price_cents is null
      and old_cost_cents is null
      and (new_sale_price_cents is not null or new_cost_cents is not null))
    or (event_kind = 'updated'
      and (old_sale_price_cents is distinct from new_sale_price_cents
        or old_cost_cents is distinct from new_cost_cents))
  )
);

comment on table public.product_price_history is
  'Append-only product price and cost snapshots. Baseline rows record only values present when history capture was introduced.';

create index product_price_history_product_idx
  on public.product_price_history (business_id, product_id, event_sequence desc);

-- Preserve a clearly identified starting snapshot for products that already
-- have a recorded price or cost. Earlier edits are not available to infer.
insert into public.product_price_history (
  business_id,
  product_id,
  event_kind,
  new_sale_price_cents,
  new_cost_cents
)
select
  product.business_id,
  product.id,
  'baseline',
  product.sale_price_cents,
  product.cost_cents
from public.products as product
where product.sale_price_cents is not null
   or product.cost_cents is not null;

create function private.capture_product_price_cost_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_user_id uuid := (select auth.uid());
begin
  if authenticated_user_id is null
    or not (select private.is_business_owner(new.business_id)) then
    raise exception using errcode = '42501', message = 'Product price history access denied.';
  end if;

  if tg_op = 'INSERT' then
    if new.sale_price_cents is null and new.cost_cents is null then
      return new;
    end if;

    insert into public.product_price_history (
      business_id,
      product_id,
      event_kind,
      new_sale_price_cents,
      new_cost_cents,
      changed_by
    ) values (
      new.business_id,
      new.id,
      'created',
      new.sale_price_cents,
      new.cost_cents,
      authenticated_user_id
    );

    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.business_id is distinct from old.business_id then
      raise exception using errcode = '42501', message = 'A product cannot change businesses.';
    end if;

    if new.sale_price_cents is not distinct from old.sale_price_cents
      and new.cost_cents is not distinct from old.cost_cents then
      return new;
    end if;

    insert into public.product_price_history (
      business_id,
      product_id,
      event_kind,
      old_sale_price_cents,
      new_sale_price_cents,
      old_cost_cents,
      new_cost_cents,
      changed_by
    ) values (
      new.business_id,
      new.id,
      'updated',
      old.sale_price_cents,
      new.sale_price_cents,
      old.cost_cents,
      new.cost_cents,
      authenticated_user_id
    );

    return new;
  end if;

  raise exception using errcode = '22023', message = 'Unsupported product price history event.';
end;
$function$;

revoke all on function private.capture_product_price_cost_history() from public, anon, authenticated;

create trigger products_record_price_cost_history_after_insert
  after insert on public.products
  for each row execute function private.capture_product_price_cost_history();

create trigger products_record_price_cost_history_after_update
  after update of sale_price_cents, cost_cents on public.products
  for each row execute function private.capture_product_price_cost_history();

alter table public.product_price_history enable row level security;

revoke all on table public.product_price_history from public, anon, authenticated;
grant select on table public.product_price_history to authenticated;

create policy product_price_history_select_for_owners
  on public.product_price_history
  for select to authenticated
  using ((select private.is_business_owner(business_id)));

create trigger product_price_history_append_only
  before update or delete on public.product_price_history
  for each row execute function private.reject_immutable_record_change();

create trigger product_price_history_reject_truncate
  before truncate on public.product_price_history
  for each statement execute function private.reject_immutable_record_change();
