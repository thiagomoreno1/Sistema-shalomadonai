-- Public signup is for access requests only. Business creation is managed by
-- trusted project administration so new accounts cannot create their own tenant.
drop policy if exists businesses_insert_for_authenticated_creator on public.businesses;
revoke insert (name, timezone, currency) on table public.businesses from public, anon, authenticated;
