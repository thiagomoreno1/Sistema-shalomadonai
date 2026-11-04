begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

create function pg_temp.uid(text) returns uuid language sql immutable as $$ select md5($1)::uuid $$;

insert into auth.users (id) values
  (pg_temp.uid('catalog-owner')),
  (pg_temp.uid('catalog-outsider')),
  (pg_temp.uid('catalog-staff'));
insert into public.businesses (id, name, created_by) values
  (pg_temp.uid('catalog-business'), 'Catalog access test', pg_temp.uid('catalog-owner')),
  (pg_temp.uid('catalog-other-business'), 'Other catalog test', pg_temp.uid('catalog-outsider'));
insert into public.business_memberships (business_id, user_id, role)
values (pg_temp.uid('catalog-business'), pg_temp.uid('catalog-staff'), 'staff');

create temp table catalog_records (name text primary key, id uuid);
grant all on catalog_records to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.uid('catalog-owner')::text, true);

select ok(
  not has_table_privilege('anon', 'public.customers', 'SELECT')
  and not has_table_privilege('anon', 'public.customers', 'INSERT')
  and not has_table_privilege('anon', 'public.customers', 'UPDATE')
  and not has_table_privilege('anon', 'public.customers', 'DELETE'),
  'Anonymous users have no customer table access'
);
select ok(
  not has_table_privilege('anon', 'public.products', 'SELECT')
  and not has_table_privilege('anon', 'public.products', 'INSERT')
  and not has_table_privilege('anon', 'public.products', 'UPDATE')
  and not has_table_privilege('anon', 'public.products', 'DELETE'),
  'Anonymous users have no product table access'
);
select ok(
  not has_table_privilege('anon', 'public.product_categories', 'SELECT')
  and not has_table_privilege('anon', 'public.product_categories', 'INSERT')
  and not has_table_privilege('anon', 'public.product_categories', 'UPDATE')
  and not has_table_privilege('anon', 'public.product_categories', 'DELETE'),
  'Anonymous users have no product category table access'
);
select ok(
  not has_table_privilege('anon', 'public.customer_addresses', 'SELECT')
  and not has_table_privilege('anon', 'public.customer_addresses', 'INSERT')
  and not has_table_privilege('anon', 'public.customer_addresses', 'UPDATE')
  and not has_table_privilege('anon', 'public.customer_addresses', 'DELETE'),
  'Anonymous users have no customer address table access'
);
select ok(not has_table_privilege('authenticated', 'public.customers', 'DELETE'), 'Customer records use archive instead of direct deletion');
select ok(not has_table_privilege('authenticated', 'public.products', 'DELETE'), 'Products use archive instead of direct deletion');

with created as (
  insert into public.customers (business_id, name, phone, whatsapp_phone, delivery_address, notes)
  values (
    pg_temp.uid('catalog-business'), 'Synthetic customer', '+5521999990000', '+5521988880000',
    'Rua de teste, 10', 'Initial test note'
  )
  returning id
)
insert into catalog_records values ('customer', (select id from created));

with created as (
  insert into public.product_categories (business_id, name)
  values (pg_temp.uid('catalog-business'), 'Synthetic category')
  returning id
)
insert into catalog_records values ('category', (select id from created));

with created as (
  insert into public.products (
    business_id, category_id, name, description, inventory_unit, sale_price_cents, cost_cents
  )
  values (
    pg_temp.uid('catalog-business'),
    (select id from catalog_records where name = 'category'),
    'Synthetic product', 'Local RLS fixture', 'un', 1000, 400
  )
  returning id
)
insert into catalog_records values ('product', (select id from created));

select is((select count(*) from public.customers where id = (select id from catalog_records where name = 'customer')),
  1::bigint, 'Owner can read the customer created in their business');
select is((select count(*) from public.product_categories where id = (select id from catalog_records where name = 'category')),
  1::bigint, 'Owner can read a product category in their business');
select is((select count(*) from public.products where id = (select id from catalog_records where name = 'product')),
  1::bigint, 'Owner can read a product in their business');
select is((select created_by from public.customers where id = (select id from catalog_records where name = 'customer')),
  pg_temp.uid('catalog-owner'), 'Customer insert records the authenticated owner');
select is((select whatsapp_phone from public.customers where id = (select id from catalog_records where name = 'customer')),
  '+5521988880000', 'Owner can save a separate WhatsApp contact number');
select is((select count(*) from public.customer_addresses
  where customer_id = (select id from catalog_records where name = 'customer')),
  1::bigint, 'Legacy address input creates one saved principal address');

with created as (
  insert into public.customer_addresses (business_id, customer_id, label, address)
  values (
    pg_temp.uid('catalog-business'),
    (select id from catalog_records where name = 'customer'),
    'Trabalho', 'Avenida de teste, 20'
  )
  returning id
)
insert into catalog_records values ('secondary_address', (select id from created));

select is((select count(*) from public.customer_addresses
  where customer_id = (select id from catalog_records where name = 'customer')),
  2::bigint, 'Owner can add a second customer address');
update public.customer_addresses set is_default = true
 where id = (select id from catalog_records where name = 'secondary_address');
select is((select count(*) from public.customer_addresses
  where customer_id = (select id from catalog_records where name = 'customer') and is_default),
  1::bigint, 'Changing the principal keeps exactly one default address');
select is((select delivery_address from public.customers where id = (select id from catalog_records where name = 'customer')),
  'Avenida de teste, 20', 'Changing the principal synchronizes the legacy order address');

update public.customers set notes = 'Updated test note'
 where id = (select id from catalog_records where name = 'customer');
update public.product_categories set name = 'Updated category'
 where id = (select id from catalog_records where name = 'category');
update public.products set sale_price_cents = 1200, cost_cents = 450
 where id = (select id from catalog_records where name = 'product');

select is((select notes from public.customers where id = (select id from catalog_records where name = 'customer')),
  'Updated test note', 'Owner can update customer details');
select is((select name from public.product_categories where id = (select id from catalog_records where name = 'category')),
  'Updated category', 'Owner can update a product category');
select is((select sale_price_cents from public.products where id = (select id from catalog_records where name = 'product')),
  1200::bigint, 'Owner can update product pricing');
select is((select count(*) from public.product_price_history
  where product_id = (select id from catalog_records where name = 'product')),
  2::bigint, 'Product creation and price change create history records');
select is((select old_sale_price_cents from public.product_price_history
  where product_id = (select id from catalog_records where name = 'product') and event_kind = 'updated'),
  1000::bigint, 'Product history retains the old price');
select is((select new_sale_price_cents from public.product_price_history
  where product_id = (select id from catalog_records where name = 'product') and event_kind = 'updated'),
  1200::bigint, 'Product history records the new price');
select is((select changed_by from public.product_price_history
  where product_id = (select id from catalog_records where name = 'product') and event_kind = 'updated'),
  pg_temp.uid('catalog-owner'), 'Product history identifies the authenticated owner');

select set_config('request.jwt.claim.sub', pg_temp.uid('catalog-staff')::text, true);
select is((select count(*) from public.customers where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Staff cannot read owner-only customers');
select is((select count(*) from public.product_categories where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Staff cannot read owner-only product categories');
select is((select count(*) from public.products where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Staff cannot read owner-only products');
select is((select count(*) from public.customer_addresses where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Staff cannot read owner-only customer addresses');
select throws_ok($$insert into public.customers (business_id, name)
  values (pg_temp.uid('catalog-business'), 'Unauthorized staff customer')$$,
  '42501', null, 'Staff cannot create a customer');
select throws_ok($$insert into public.products (business_id, name, sale_price_cents)
  values (pg_temp.uid('catalog-business'), 'Unauthorized staff product', 1000)$$,
  '42501', null, 'Staff cannot create a product');
select throws_ok($$insert into public.customer_addresses (business_id, customer_id, label, address)
  values (pg_temp.uid('catalog-business'), (select id from catalog_records where name = 'customer'), 'Staff', 'Blocked')$$,
  '42501', null, 'Staff cannot add a customer address');
select is((with changed as (
  update public.customers set name = 'Unauthorized staff update'
   where id = (select id from catalog_records where name = 'customer') returning 1
) select count(*) from changed), 0::bigint, 'Staff cannot update an owner customer');
select is((with changed as (
  update public.products set sale_price_cents = 1
   where id = (select id from catalog_records where name = 'product') returning 1
) select count(*) from changed), 0::bigint, 'Staff cannot update an owner product');

select set_config('request.jwt.claim.sub', pg_temp.uid('catalog-outsider')::text, true);
select is((select count(*) from public.customers where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Owner of another business cannot read these customers');
select is((select count(*) from public.products where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Owner of another business cannot read these products');
select is((select count(*) from public.customer_addresses where business_id = pg_temp.uid('catalog-business')),
  0::bigint, 'Owner of another business cannot read these addresses');
select throws_ok($$insert into public.customers (business_id, name)
  values (pg_temp.uid('catalog-business'), 'Unauthorized cross-business customer')$$,
  '42501', null, 'Owner cannot create a customer in another business');
select throws_ok($$insert into public.products (business_id, name, sale_price_cents)
  values (pg_temp.uid('catalog-business'), 'Unauthorized cross-business product', 1000)$$,
  '42501', null, 'Owner cannot create a product in another business');

select set_config('request.jwt.claim.sub', pg_temp.uid('catalog-owner')::text, true);
select is((select notes from public.customers where id = (select id from catalog_records where name = 'customer')),
  'Updated test note', 'Rejected writes leave the owner customer unchanged');
select is((select sale_price_cents from public.products where id = (select id from catalog_records where name = 'product')),
  1200::bigint, 'Rejected writes leave the owner product unchanged');

reset role;
select * from finish();
rollback;
