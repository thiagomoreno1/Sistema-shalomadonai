-- ProductsPage includes is_active in direct product inserts.
-- Keep the added privilege column-scoped; the existing owner RLS policy still applies.
grant insert (is_active) on table public.products to authenticated;
