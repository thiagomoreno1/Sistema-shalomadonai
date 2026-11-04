begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

create function pg_temp.uid(text) returns uuid language sql immutable as $$ select md5($1)::uuid $$;
create function pg_temp.items(text, text[]) returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('kind', $1, 'id', pg_temp.uid(x))) from unnest($2) x
$$;
create function pg_temp.match_group(text, text, text[], text) returns uuid language sql as $$
  select public.match_bank_transaction_group(pg_temp.uid('business'), pg_temp.uid($1), pg_temp.items($2, $3), pg_temp.uid($4))
$$;

insert into auth.users (id) values (pg_temp.uid('owner')), (pg_temp.uid('stranger')), (pg_temp.uid('staff'));
insert into public.businesses (id, name, created_by) values
  (pg_temp.uid('business'), 'Grouping test', pg_temp.uid('owner')),
  (pg_temp.uid('foreign-business'), 'Foreign test', pg_temp.uid('stranger'));
insert into public.business_memberships (business_id,user_id,role)
values (pg_temp.uid('business'),pg_temp.uid('staff'),'staff');
insert into public.customers (id,business_id,name,created_by)
values (pg_temp.uid('customer'),pg_temp.uid('business'),'Test',pg_temp.uid('owner'));
insert into public.orders (id,business_id,customer_id,customer_name_snapshot,subtotal_cents,total_cents,request_id,request_fingerprint,created_by)
values (pg_temp.uid('order'),pg_temp.uid('business'),pg_temp.uid('customer'),'Test',10000,10000,gen_random_uuid(),md5('order'),pg_temp.uid('owner'));
insert into public.order_payments (id,business_id,order_id,amount_cents,request_id,request_fingerprint,created_by)
select pg_temp.uid(name),pg_temp.uid('business'),pg_temp.uid('order'),amount,gen_random_uuid(),md5(name),pg_temp.uid('owner')
from (values ('r1',100::bigint),('r2',200),('r3',300),('r4',100),('r5',200),('legacy',300)) x(name,amount);
insert into public.financial_outflows (id,business_id,outflow_type,description,amount_cents,paid_on,request_id,request_fingerprint,created_by)
select pg_temp.uid(name),pg_temp.uid('business'),'operating_expense',name,amount,current_date,gen_random_uuid(),md5(name),pg_temp.uid('owner')
from (values ('o1',100::bigint),('o2',200),('void',300)) x(name,amount);
insert into public.financial_outflow_voids (business_id,outflow_id,reason,request_id,request_fingerprint,created_by)
values (pg_temp.uid('business'),pg_temp.uid('void'),'Fixture',gen_random_uuid(),md5('void'),pg_temp.uid('owner'));
insert into public.bank_accounts (id,business_id,institution_name,account_label,created_by)
values (pg_temp.uid('account'),pg_temp.uid('business'),'Test','Test',pg_temp.uid('owner'));
insert into public.bank_transactions (id,business_id,bank_account_id,transaction_date,description,amount_cents,source,request_id,request_fingerprint,created_by)
select pg_temp.uid(name),pg_temp.uid('business'),pg_temp.uid('account'),current_date,name,amount,'manual',gen_random_uuid(),md5(name),pg_temp.uid('owner')
from (values ('credit',300::bigint),('debit',-300),('other-credit',300),('wrong-total',301),('legacy-bank',300),('duplicate',300)) x(name,amount);

create temp table results (name text primary key, id uuid);
grant all on results to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.uid('owner')::text,true);

select has_table('public','bank_reconciliation_match_groups','Group audit table exists');
select has_table('public','bank_reconciliation_match_group_reversals','Group reversal audit table exists');
select has_column('public','bank_reconciliation_matches','match_group_id','Legacy links have nullable group');
select throws_ok($$select pg_temp.match_group('wrong-total','receipt',array['r1','r2'],'bad-total')$$,'22023',null,'Mismatched total rejected');
select throws_ok($$select pg_temp.match_group('credit','outflow',array['o1','o2'],'bad-direction')$$,'22023',null,'Wrong direction rejected');
select throws_ok($$select pg_temp.match_group('credit','receipt',array['r1','r1'],'repeated')$$,'22023',null,'Repeated IDs rejected');
select throws_ok($$select pg_temp.match_group('credit','receipt',array['missing'],'missing')$$,'23503',null,'Unknown source rejected');
select throws_ok($$select pg_temp.match_group('debit','outflow',array['void'],'voided')$$,'23514',null,'Voided outflow rejected');
select throws_ok($$select public.match_bank_transaction_group(pg_temp.uid('business'),pg_temp.uid('credit'),'[]',gen_random_uuid())$$,'22023',null,'Empty selection rejected');
select throws_ok($$select public.match_bank_transaction_group(pg_temp.uid('business'),pg_temp.uid('credit'),'{}',gen_random_uuid())$$,'22023',null,'Non-array rejected');
select throws_ok($$select public.match_bank_transaction_group(pg_temp.uid('business'),pg_temp.uid('credit'),jsonb_build_array(jsonb_build_object('kind','receipt','id','bad')),gen_random_uuid())$$,'22023',null,'Malformed UUID rejected');
select throws_ok($$select public.match_bank_transaction_group(pg_temp.uid('business'),pg_temp.uid('credit'),(select jsonb_agg(jsonb_build_object('kind','receipt','id',gen_random_uuid())) from generate_series(1,51)),gen_random_uuid())$$,'22023',null,'More than 50 items rejected');
select is((select count(*) from public.bank_reconciliation_match_groups),0::bigint,'Rejected groups leave no audit rows');
insert into results values ('credit',pg_temp.match_group('credit','receipt',array['r1','r2'],'credit-request'));
select is(pg_temp.match_group('credit','receipt',array['r2','r1'],'credit-request'),(select id from results where name='credit'),'Reordered retry is idempotent');
select throws_ok($$select pg_temp.match_group('credit','receipt',array['r3'],'credit-request')$$,'22023',null,'Request reuse with different items rejected');
select is((select count(*) from public.bank_reconciliation_matches where match_group_id=(select id from results where name='credit')),2::bigint,'One child per full receipt');
select is((select movement_count from public.bank_reconciliation_global_summary(pg_temp.uid('business')) where status='reconciled'),'1','Summary counts movement once');
select throws_ok($$select pg_temp.match_group('credit','receipt',array['r3'],'active-bank')$$,'23505',null,'Active movement cannot be matched again');
select throws_ok($$select pg_temp.match_group('other-credit','receipt',array['r1','r2'],'active-source')$$,'23505',null,'Active receipts cannot be reused');
insert into results values ('debit',pg_temp.match_group('debit','outflow',array['o2','o1'],'debit-request'));
select is((select count(*) from public.bank_reconciliation_matches where match_group_id=(select id from results where name='debit')),2::bigint,'Exact outflow group writes both children');
select throws_ok($$select public.void_financial_outflow(pg_temp.uid('business'),pg_temp.uid('o1'),'Blocked',gen_random_uuid())$$,'23514',null,'Active group prevents outflow void');
select throws_ok($$select public.mark_bank_transaction_duplicate(pg_temp.uid('business'),pg_temp.uid('credit'),pg_temp.uid('duplicate'),'Blocked',gen_random_uuid())$$,'23514',null,'Active group prevents duplicate classification');

select set_config('request.jwt.claim.sub',pg_temp.uid('stranger')::text,true);
select is((select count(*) from public.bank_reconciliation_match_groups),0::bigint,'Other owner cannot read groups');
select throws_ok($$select pg_temp.match_group('other-credit','receipt',array['r3'],'stranger')$$,'42501',null,'Other owner cannot match');
select throws_ok($$select public.unmatch_bank_transaction_group(pg_temp.uid('business'),(select id from results where name='credit'),'Denied',gen_random_uuid())$$,'42501',null,'Other owner cannot reverse');
select set_config('request.jwt.claim.sub',pg_temp.uid('staff')::text,true);
select is((select count(*) from public.bank_reconciliation_match_groups),0::bigint,'Staff cannot read groups');
select throws_ok($$select pg_temp.match_group('other-credit','receipt',array['r3'],'staff')$$,'42501',null,'Staff cannot match');
select set_config('request.jwt.claim.sub',pg_temp.uid('owner')::text,true);
select throws_ok($$select public.match_bank_transaction_group(pg_temp.uid('foreign-business'),pg_temp.uid('credit'),pg_temp.items('receipt',array['r1','r2']),gen_random_uuid())$$,'42501',null,'Cross-business owner boundary enforced');
select throws_ok($$select public.unmatch_bank_transaction_group(pg_temp.uid('business'),(select id from results where name='credit'),' ',gen_random_uuid())$$,'22023',null,'Reversal requires reason');
insert into results values ('reversal',public.unmatch_bank_transaction_group(pg_temp.uid('business'),(select id from results where name='credit'),' Correction ',pg_temp.uid('reverse-request')));
select is(public.unmatch_bank_transaction_group(pg_temp.uid('business'),(select id from results where name='credit'),'Correction',pg_temp.uid('reverse-request')),(select id from results where name='reversal'),'Reversal retry trims reason and is idempotent');
select throws_ok($$select public.unmatch_bank_transaction_group(pg_temp.uid('business'),(select id from results where name='credit'),'Other',pg_temp.uid('reverse-request'))$$,'22023',null,'Reversal request mismatch rejected');
select throws_ok($$select public.unmatch_bank_transaction_group(pg_temp.uid('business'),(select id from results where name='credit'),'Again',gen_random_uuid())$$,'23514',null,'Group cannot reverse twice');
select is((select count(*) from public.bank_reconciliation_match_reversals r join public.bank_reconciliation_matches m on m.id=r.match_id where m.match_group_id=(select id from results where name='credit')),2::bigint,'Group reversal appends every compatible child reversal');
select lives_ok($$select pg_temp.match_group('other-credit','receipt',array['r2','r1'],'released-receipts')$$,'Released receipts can be reconciled again');
insert into results values ('child-reversal',public.unmatch_bank_transaction(pg_temp.uid('business'),(select id from public.bank_reconciliation_matches where match_group_id=(select id from results where name='debit') order by id limit 1),'Legacy client',pg_temp.uid('child-reverse')));
select is(public.unmatch_bank_transaction(pg_temp.uid('business'),(select id from public.bank_reconciliation_matches where match_group_id=(select id from results where name='debit') order by id limit 1),'Legacy client',pg_temp.uid('child-reverse')),(select id from results where name='child-reversal'),'Legacy child reversal retry returns child reversal ID');
select is((select count(*) from public.bank_reconciliation_match_reversals r join public.bank_reconciliation_matches m on m.id=r.match_id where m.match_group_id=(select id from results where name='debit')),2::bigint,'Legacy child reversal reverses entire group');
select lives_ok($$select public.void_financial_outflow(pg_temp.uid('business'),pg_temp.uid('o1'),'Released',gen_random_uuid())$$,'Group reversal releases outflow void guard');
select lives_ok($$select public.mark_bank_transaction_duplicate(pg_temp.uid('business'),pg_temp.uid('credit'),pg_temp.uid('duplicate'),'Released',gen_random_uuid())$$,'Group reversal releases duplicate guard');
select throws_ok($$select pg_temp.match_group('credit','receipt',array['r3'],'duplicate-match')$$,'23514',null,'Duplicate movement cannot be grouped');
insert into results values ('legacy',public.match_bank_transaction(pg_temp.uid('business'),pg_temp.uid('legacy-bank'),pg_temp.uid('legacy'),null,pg_temp.uid('legacy-request')));
select ok((select match_group_id is null from public.bank_reconciliation_matches where id=(select id from results where name='legacy')),'Legacy RPC preserves one-to-one null group');
select lives_ok($$select public.unmatch_bank_transaction(pg_temp.uid('business'),(select id from results where name='legacy'),'Legacy',gen_random_uuid())$$,'Legacy single reversal still works');
select throws_ok($$delete from public.bank_reconciliation_match_groups$$,'42501',null,'Authenticated clients cannot directly delete history');
reset role;
select throws_ok($$update public.bank_reconciliation_match_groups set created_at=now()$$,'55000',null,'Privileged group update blocked');
select throws_ok($$delete from public.bank_reconciliation_match_group_reversals$$,'55000',null,'Privileged reversal deletion blocked');
select throws_ok($$truncate public.bank_reconciliation_match_group_reversals$$,'55000',null,'Reversal truncate blocked');
select ok(not has_function_privilege('anon','public.match_bank_transaction_group(uuid,uuid,jsonb,uuid)','EXECUTE'),'Anonymous match execute revoked');
select ok(not has_function_privilege('anon','public.unmatch_bank_transaction_group(uuid,uuid,text,uuid)','EXECUTE'),'Anonymous reversal execute revoked');
select * from finish();
rollback;
