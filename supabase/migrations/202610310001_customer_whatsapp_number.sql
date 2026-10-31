-- Store a customer's WhatsApp contact separately from their general phone.
-- Existing customer RLS remains the tenant boundary for this optional field.

alter table public.customers
  add column whatsapp_phone text
  check (whatsapp_phone is null or char_length(btrim(whatsapp_phone)) between 1 and 64);

grant insert (whatsapp_phone) on table public.customers to authenticated;
grant update (whatsapp_phone) on table public.customers to authenticated;
