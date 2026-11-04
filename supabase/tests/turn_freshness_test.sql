begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into users(id,wa_id) values ('a3000000-0000-0000-0000-000000000001','919300000001');
select ingest_inbound('a3000000-0000-0000-0000-000000000001','freshness.first','{"text":{"body":"two people"}}',now());
create temp table turn_claims(name text,value jsonb);
insert into turn_claims values('first',claim_turn('a3000000-0000-0000-0000-000000000001','freshness.first'));
select lives_ok(format('select assert_turn(%L,%L)','a3000000-0000-0000-0000-000000000001',
 (select value->>'token' from turn_claims where name='first')),'current input authorizes the turn');
select ingest_inbound('a3000000-0000-0000-0000-000000000001','freshness.correction','{"text":{"body":"actually four people"}}',now());
select throws_ok(format('select assert_turn(%L,%L)','a3000000-0000-0000-0000-000000000001',
 (select value->>'token' from turn_claims where name='first')),'55000','turn superseded','new input invalidates a live lease');
select set_config('request.headers',jsonb_build_object('x-desk-turn',(select value->>'token' from turn_claims where name='first'))::text,true);
select throws_ok($$insert into user_memories(user_id,kind,scope,text,source) values
 ('a3000000-0000-0000-0000-000000000001','preference','all','stale preference','said')$$,
 '55000','turn superseded','stale memory writes are refused by the database');
select throws_ok($$select owe_message('a3000000-0000-0000-0000-000000000001',null,'stale-freshness','{"kind":"text","body":"For two?"}')$$,
 '55000','turn superseded','stale output cannot enter the retry queue');
select set_config('request.headers','{}',true);
select abandon_turn('a3000000-0000-0000-0000-000000000001',(select (value->>'token')::uuid from turn_claims where name='first'));
insert into turn_claims values('next',claim_turn('a3000000-0000-0000-0000-000000000001','freshness.correction'));
select is((select value->>'status' from turn_claims where name='next'),'claimed','newest input can immediately claim the released turn');
select is((select jsonb_array_length(value->'batch') from turn_claims where name='next'),2,'successor sees both original request and correction');
select complete_turn('a3000000-0000-0000-0000-000000000001',(select (value->>'token')::uuid from turn_claims where name='next'));
select is((select count(*)::int from messages where user_id='a3000000-0000-0000-0000-000000000001' and handled_at is null),0,'successor completes the combined input');
select * from finish();
rollback;
