-- Order detail joins line snapshots to the combo-component snapshots by product.
-- The existing owner-only RLS policy remains the row-level authorization gate.
grant select (product_id) on table public.order_lines to authenticated;
