-- Requesters may read only their own pending access request so the app can
-- distinguish a submitted request from an account that has not asked yet.
create policy business_access_requests_select_own_request
  on public.business_access_requests
  for select
  to authenticated
  using (user_id = (select auth.uid()));
