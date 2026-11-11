begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

create function pg_temp.uid(text) returns uuid language sql immutable as $$ select md5($1)::uuid $$;
create function pg_temp.make_order(text, numeric, boolean) returns uuid language sql as $$
  select public.create_order(
    pg_temp.uid('workflow-business'),
    pg_temp.uid('workflow-customer'),
    '', 0, 0, '',
    jsonb_build_array(jsonb_build_object(
      'product_id', pg_temp.uid('workflow-product'),
      'quantity', $2
    )),
    jsonb_build_array(jsonb_build_object(
      'amount_cents', (1000::numeric * $2)::bigint,
      'due_on', current_date,
      'payment_method', 'PIX'
    )),
    $3,
    pg_temp.uid($1)
  )
$$;
create function pg_temp.record_receipt(text, uuid, bigint) returns uuid language sql as $$
  select public.record_order_payment(
    pg_temp.uid('workflow-business'), $2, $3, null, 'PIX', 'Fixture receipt',
    (select jsonb_build_array(jsonb_build_object(
      'installment_id', installment.id,
      'amount_cents', $3
    ))
       from public.order_installments as installment
      where installment.business_id = pg_temp.uid('workflow-business')
        and installment.order_id = $2
      order by installment.installment_number
      limit 1),
    pg_temp.uid($1)
  )
$$;

insert into auth.users (id) values
  (pg_temp.uid('workflow-owner')),
  (pg_temp.uid('workflow-outsider')),
  (pg_temp.uid('workflow-staff'));
insert into public.businesses (id, name, created_by) values
  (pg_temp.uid('workflow-business'), 'Order workflow test', pg_temp.uid('workflow-owner')),
  (pg_temp.uid('workflow-other-business'), 'Other workflow test', pg_temp.uid('workflow-outsider'));
insert into public.business_memberships (business_id, user_id, role)
values (pg_temp.uid('workflow-business'), pg_temp.uid('workflow-staff'), 'staff');
insert into public.customers (id, business_id, name, created_by)
values (
  pg_temp.uid('workflow-customer'), pg_temp.uid('workflow-business'),
  'Synthetic customer', pg_temp.uid('workflow-owner')
);
select set_config('request.jwt.claim.sub', pg_temp.uid('workflow-owner')::text, true);
insert into public.products (
  id, business_id, name, inventory_unit, sale_price_cents, cost_cents, created_by, is_active
) values (
  pg_temp.uid('workflow-product'), pg_temp.uid('workflow-business'),
  'Synthetic tracked product', 'un', 1000, 400, pg_temp.uid('workflow-owner'), false
);

create temp table workflow_results (name text primary key, id uuid);
grant all on workflow_results to authenticated;
set local role authenticated;

select has_function('public', 'create_order', array[
  'uuid', 'uuid', 'text', 'bigint', 'bigint', 'text', 'jsonb', 'jsonb', 'boolean', 'uuid'
], 'Current create_order accepts explicit delivery mode and installments');
select ok(not has_function_privilege(
  'anon', 'public.create_order(uuid,uuid,text,bigint,bigint,text,jsonb,jsonb,boolean,uuid)', 'EXECUTE'
), 'Anonymous users cannot create orders');

insert into workflow_results values (
  'opening', public.configure_product_inventory(
    pg_temp.uid('workflow-business'), pg_temp.uid('workflow-product'),
    'un', 5, null, pg_temp.uid('workflow-opening')
  )
);
select is(public.configure_product_inventory(
  pg_temp.uid('workflow-business'), pg_temp.uid('workflow-product'),
  'un', 5, null, pg_temp.uid('workflow-opening')
), (select id from workflow_results where name = 'opening'),
  'Opening count retry returns its original inventory movement');
select is((
  select quantity_on_hand from public.inventory_balances
   where business_id = pg_temp.uid('workflow-business')
     and product_id = pg_temp.uid('workflow-product')
), 5::numeric, 'Opening count establishes the expected stock balance');
update public.products set is_active = true
 where business_id = pg_temp.uid('workflow-business')
   and id = pg_temp.uid('workflow-product');

insert into workflow_results values ('pickup_order', pg_temp.make_order('workflow-pickup-order', 2, false));
select is((select total_cents from public.orders where id = (select id from workflow_results where name = 'pickup_order')),
  2000::bigint, 'Order total uses whole-cent unit pricing');
select is((select count(*) from public.order_lines where order_id = (select id from workflow_results where name = 'pickup_order')),
  1::bigint, 'Order persists its line snapshot');
select is((select unit_price_snapshot_cents from public.order_lines where order_id = (select id from workflow_results where name = 'pickup_order')),
  1000::bigint, 'Order freezes the product sale price at creation');
select is((select count(*) from public.order_installments where order_id = (select id from workflow_results where name = 'pickup_order')),
  1::bigint, 'Order persists its payment installment');
select is((select sum(amount_cents) from public.order_installments where order_id = (select id from workflow_results where name = 'pickup_order')),
  2000::numeric, 'Installment schedule equals the order total');
select is(pg_temp.make_order('workflow-pickup-order', 2, false),
  (select id from workflow_results where name = 'pickup_order'), 'Identical order retry is idempotent');
select throws_ok($$select pg_temp.make_order('workflow-pickup-order', 3, false)$$,
  '22023', null, 'Reusing an order request id with changed details is rejected');

insert into workflow_results values (
  'partial_payment', pg_temp.record_receipt('workflow-partial-payment',
    (select id from workflow_results where name = 'pickup_order'), 500)
);
select is(pg_temp.record_receipt('workflow-partial-payment',
  (select id from workflow_results where name = 'pickup_order'), 500),
  (select id from workflow_results where name = 'partial_payment'),
  'Identical partial receipt retry returns its original payment');
select is((select count(*) from public.order_payments where order_id = (select id from workflow_results where name = 'pickup_order')),
  1::bigint, 'Receipt retry does not duplicate payment records');
select is((
  select installment.amount_cents::numeric - coalesce(sum(allocation.amount_cents::numeric), 0)
    from public.order_installments as installment
    left join public.order_payment_allocations as allocation
      on allocation.business_id = installment.business_id
     and allocation.order_id = installment.order_id
     and allocation.installment_id = installment.id
   where installment.order_id = (select id from workflow_results where name = 'pickup_order')
   group by installment.amount_cents
), 1500::numeric, 'Partial receipt leaves the correct installment balance');
select throws_ok($$select pg_temp.record_receipt('workflow-partial-payment',
  (select id from workflow_results where name = 'pickup_order'), 501)$$,
  '22023', null, 'A receipt request id cannot be reused with a changed amount');
select throws_ok($$select pg_temp.record_receipt('workflow-overpayment',
  (select id from workflow_results where name = 'pickup_order'), 1501)$$,
  '22023', null, 'Receipt allocation cannot exceed the remaining installment balance');
select is((select count(*) from public.order_payments where business_id = pg_temp.uid('workflow-business')),
  1::bigint, 'Rejected receipt requests leave no payment rows');

select set_config('request.jwt.claim.sub', pg_temp.uid('workflow-staff')::text, true);
select is((select count(*) from public.orders where business_id = pg_temp.uid('workflow-business')),
  0::bigint, 'Staff cannot read owner-only orders');
select is((select count(*) from public.order_payments where business_id = pg_temp.uid('workflow-business')),
  0::bigint, 'Staff cannot read owner-only receipts');
select is((select count(*) from public.inventory_balances where business_id = pg_temp.uid('workflow-business')),
  0::bigint, 'Staff cannot read owner-only stock balances');
select throws_ok($$select pg_temp.make_order('workflow-staff-order', 1, false)$$,
  '42501', null, 'Staff cannot create an order');
select throws_ok($$select public.record_order_pickup(
  pg_temp.uid('workflow-business'), (select id from workflow_results where name = 'pickup_order'),
  pg_temp.uid('workflow-staff-pickup'))$$,
  '42501', null, 'Staff cannot register customer pickup');
select set_config('request.jwt.claim.sub', pg_temp.uid('workflow-outsider')::text, true);
select is((select count(*) from public.orders where business_id = pg_temp.uid('workflow-business')),
  0::bigint, 'Owner of another business cannot read these orders');
select throws_ok($$select pg_temp.make_order('workflow-cross-business-order', 1, false)$$,
  '42501', null, 'Owner cannot create an order in another business');
select set_config('request.jwt.claim.sub', pg_temp.uid('workflow-owner')::text, true);

insert into workflow_results values (
  'pickup_event', public.record_order_pickup(
    pg_temp.uid('workflow-business'), (select id from workflow_results where name = 'pickup_order'),
    pg_temp.uid('workflow-pickup-event')
  )
);
select is(public.record_order_pickup(
  pg_temp.uid('workflow-business'), (select id from workflow_results where name = 'pickup_order'),
  pg_temp.uid('workflow-pickup-event')
), (select id from workflow_results where name = 'pickup_event'),
  'Customer pickup retry returns its original event');
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), 3::numeric,
  'Customer pickup deducts stock once');
select is((select count(*) from public.inventory_movements
  where order_id = (select id from workflow_results where name = 'pickup_order')
    and movement_type = 'dispatch'::public.inventory_movement_type), 1::bigint,
  'Customer pickup creates one dispatch movement');
select throws_ok($$select public.record_inventory_movement(
  pg_temp.uid('workflow-business'), pg_temp.uid('workflow-product'),
  'return'::public.inventory_movement_type, 3, null, 'Oversized synthetic return',
  (select id from workflow_results where name = 'pickup_order'), null, pg_temp.uid('workflow-too-large-return'))$$,
  '22023', null, 'Return cannot exceed the quantity still out for a picked-up order');
insert into workflow_results values (
  'pickup_return', public.record_inventory_movement(
    pg_temp.uid('workflow-business'), pg_temp.uid('workflow-product'),
    'return'::public.inventory_movement_type, 1, null, 'Synthetic inspected return',
    (select id from workflow_results where name = 'pickup_order'), null, pg_temp.uid('workflow-pickup-return')
  )
);
select is(public.record_inventory_movement(
  pg_temp.uid('workflow-business'), pg_temp.uid('workflow-product'),
  'return'::public.inventory_movement_type, 1, null, 'Synthetic inspected return',
  (select id from workflow_results where name = 'pickup_order'), null, pg_temp.uid('workflow-pickup-return')
), (select id from workflow_results where name = 'pickup_return'),
  'Inspected return retry is idempotent');
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), 4::numeric,
  'Inspected pickup return restores stock once');

insert into workflow_results values ('delivery_order', pg_temp.make_order('workflow-delivery-order', 2, true));
select is((select status::text from public.deliveries
  where order_id = (select id from workflow_results where name = 'delivery_order')),
  'awaiting_separation'::text, 'Delivery order creates its initial delivery record');
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), 4::numeric,
  'Creating a delivery order does not deduct stock before dispatch');

insert into workflow_results values ('oversell_order', pg_temp.make_order('workflow-oversell-order', 3, true));
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), 4::numeric,
  'Stock remains unchanged until the oversell is dispatched');

insert into workflow_results values ('delivery_ready', public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'delivery_order')),
  'ready'::public.delivery_status, null, null, pg_temp.uid('workflow-delivery-ready')
));
insert into workflow_results values ('delivery_dispatched', public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'delivery_order')),
  'dispatched'::public.delivery_status, null, null, pg_temp.uid('workflow-delivery-dispatched')
));
select is(public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'delivery_order')),
  'dispatched'::public.delivery_status, null, null, pg_temp.uid('workflow-delivery-dispatched')
), (select id from workflow_results where name = 'delivery_dispatched'),
  'Dispatch retry returns its original delivery event');
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), 2::numeric,
  'Dispatch deducts stock exactly once');
select is((select count(*) from public.inventory_movements
  where order_id = (select id from workflow_results where name = 'delivery_order')
    and movement_type = 'dispatch'::public.inventory_movement_type), 1::bigint,
  'Dispatch creates one stock movement for the order');

insert into workflow_results values ('oversell_ready', public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'oversell_order')),
  'ready'::public.delivery_status, null, null, pg_temp.uid('workflow-oversell-ready')
));
insert into workflow_results values ('oversell_dispatched', public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'oversell_order')),
  'dispatched'::public.delivery_status, null, null, pg_temp.uid('workflow-oversell-dispatched')
));
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), -1::numeric,
  'Confirmed stock shortage is allowed to become negative at dispatch');
select is((select jsonb_array_length(stock_warnings) from public.delivery_events
  where id = (select id from workflow_results where name = 'oversell_dispatched')),
  1, 'Dispatch records a stock warning for the negative balance');

select throws_ok($$select public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'delivery_order')),
  'attempted'::public.delivery_status, null, 'Confirmar nova tentativa', pg_temp.uid('workflow-delivery-attempt-invalid'))$$,
  '22023', null, 'A failed delivery attempt requires a note and next step');
insert into workflow_results values ('delivery_attempted', public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'delivery_order')),
  'attempted'::public.delivery_status, 'Cliente ausente', 'Confirmar nova tentativa', pg_temp.uid('workflow-delivery-attempted')
));
insert into workflow_results values ('delivery_returned', public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'delivery_order')),
  'returned'::public.delivery_status, null, null, pg_temp.uid('workflow-delivery-returned')
));
select is((select status::text from public.deliveries
  where order_id = (select id from workflow_results where name = 'delivery_order')),
  'returned'::text, 'Failed delivery can be recorded as returned after an attempt');
select lives_ok($$select public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'oversell_order')),
  'delivered'::public.delivery_status, null, null, pg_temp.uid('workflow-oversell-delivered'))$$,
  'Dispatched delivery can be marked delivered');
insert into workflow_results values ('delivery_return', public.record_inventory_movement(
  pg_temp.uid('workflow-business'), pg_temp.uid('workflow-product'),
  'return'::public.inventory_movement_type, 1, null, 'Synthetic inspected failed-delivery return',
  (select id from workflow_results where name = 'delivery_order'), null, pg_temp.uid('workflow-delivery-return')
));
select is((select quantity_on_hand from public.inventory_balances
  where product_id = pg_temp.uid('workflow-product')), 0::numeric,
  'Inspected failed-delivery return restores stock');

insert into workflow_results values ('cancel_order', pg_temp.make_order('workflow-cancel-order', 1, true));
select is(public.cancel_order(
  pg_temp.uid('workflow-business'), (select id from workflow_results where name = 'cancel_order'), 'Synthetic cancellation'
), (select id from workflow_results where name = 'cancel_order'), 'Undispatched order can be cancelled');
select is((select status::text from public.orders where id = (select id from workflow_results where name = 'cancel_order')),
  'cancelled'::text, 'Cancellation persists on the order');
select is((select canceled_at is not null from public.deliveries
  where order_id = (select id from workflow_results where name = 'cancel_order')),
  true, 'Cancellation marks the linked delivery as canceled');
select is((select count(*) from public.inventory_movements
  where order_id = (select id from workflow_results where name = 'cancel_order')),
  0::bigint, 'Cancelling before dispatch creates no stock movement');
select throws_ok($$select public.transition_delivery(
  pg_temp.uid('workflow-business'),
  (select id from public.deliveries where order_id = (select id from workflow_results where name = 'cancel_order')),
  'ready'::public.delivery_status, null, null, pg_temp.uid('workflow-canceled-delivery'))$$,
  '22023', null, 'Canceled order cannot resume its delivery workflow');

select throws_ok($$select public.cancel_order(
  pg_temp.uid('workflow-business'), (select id from workflow_results where name = 'pickup_order'), 'Receipt exists'
)$$, '22023', null, 'Order with a receipt cannot be cancelled');

reset role;
select * from finish();
rollback;
