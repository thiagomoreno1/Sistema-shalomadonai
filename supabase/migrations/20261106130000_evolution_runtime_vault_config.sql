-- Keep Evolution credentials encrypted in Vault and readable only by server-side Edge Functions.
create or replace function public.get_evolution_runtime_config()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  secrets jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
    into secrets
    from vault.decrypted_secrets
   where name in (
     'evolution_api_url',
     'evolution_api_key',
     'evolution_instance_name',
     'evolution_business_id',
     'evolution_webhook_url',
     'evolution_webhook_secret'
   );

  return secrets;
end;
$$;

revoke all on function public.get_evolution_runtime_config() from public, anon, authenticated;
grant execute on function public.get_evolution_runtime_config() to service_role;
