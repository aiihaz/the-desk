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

-- A turn lost between the YES and Sarvam started no call (dialForTurn): its request is read
-- against the plan again, not left in calling_1. One with a call still open is left alone.
insert into businesses(id,name,phone_e164,source) values('b3000000-0000-0000-0000-000000000001','Fresh place','+919300000003','user');
insert into caller_numbers(id,e164,provider) values('c3000000-0000-0000-0000-000000000001','+919300000004','sarvam');
insert into turn_claims values('request',start_request('a3000000-0000-0000-0000-000000000001','question',now()));
update requests set state='calling_1',business_id='b3000000-0000-0000-0000-000000000001'
 where id=(select (value->>'request_id')::uuid from turn_claims where name='request');
insert into turn_claims select 'version',to_jsonb(version) from requests where id=(select (value->>'request_id')::uuid from turn_claims where name='request');
insert into calls(id,user_id,request_id,business_id,caller_number_id,kind,agent_version,status)
 select 'f3000000-0000-0000-0000-000000000001',user_id,id,business_id,'c3000000-0000-0000-0000-000000000001','question','test','queued'
 from requests where id=(select (value->>'request_id')::uuid from turn_claims where name='request');
select defer_changed_consent((select (value->>'request_id')::uuid from turn_claims where name='request'));
select is((select state from requests where id=(select (value->>'request_id')::uuid from turn_claims where name='request')),'calling_1',
 'a call still open keeps the request calling');
update calls set status='failed',submission_state='rejected' where id='f3000000-0000-0000-0000-000000000001';
select defer_changed_consent((select (value->>'request_id')::uuid from turn_claims where name='request'));
select is((select state from requests where id=(select (value->>'request_id')::uuid from turn_claims where name='request')),'confirming',
 'a lost turn''s request goes back to its plan');
select ok((select version > (select value::int from turn_claims where name='version') from requests
 where id=(select (value->>'request_id')::uuid from turn_claims where name='request')),'and the plan shown before no longer stands');
select * from finish();
rollback;
