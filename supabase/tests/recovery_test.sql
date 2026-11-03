begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into users(id,wa_id,name) values
 ('a1000000-0000-0000-0000-000000000001','919100000001','Review'),
 ('a1000000-0000-0000-0000-000000000002','919100000002','Other');
create function pg_temp.uid() returns uuid language sql as $$select 'a1000000-0000-0000-0000-000000000001'::uuid$$;
create function pg_temp.at(n int) returns timestamptz language sql as $$select '2026-11-03 12:00Z'::timestamptz+make_interval(secs=>n)$$;
create temp table saved(name text primary key,value jsonb);

select ok(ingest_inbound(pg_temp.uid(),'recovery.m1','{"from":"919100000001","text":{"body":"yes"}}',pg_temp.at(0)), 'first inbound is inserted');
select is(ingest_inbound(pg_temp.uid(),'recovery.m1','{}',pg_temp.at(0)),false,'message ID dedupes writes');
insert into saved values('claim',claim_turn(pg_temp.uid(),'recovery.m1',90,pg_temp.at(0)));
select is((select value->>'status' from saved where name='claim'),'claimed','turn claimed');
select is((select handled_at from messages where wa_message_id='recovery.m1'),null,'claim is not completion');
select is(claim_turn(pg_temp.uid(),'recovery.m1',90,pg_temp.at(20))->>'status','busy','live turn excludes another worker');
insert into saved values('successor',claim_turn(pg_temp.uid(),'recovery.m1',90,pg_temp.at(91)));
select is((select value->>'status' from saved where name='successor'),'claimed','expired work can be reclaimed');
select throws_ok(format('select complete_turn(%L,%L,%L)',pg_temp.uid(),(select value->>'token' from saved where name='claim'),pg_temp.at(92)), '55000','turn lease lost','stale worker cannot complete successor work');
select complete_turn(pg_temp.uid(),(select (value->>'token')::uuid from saved where name='successor'),pg_temp.at(92));
select ok((select handled_at is not null from messages where wa_message_id='recovery.m1'),'completion marks handled');
select is(claim_turn(pg_temp.uid(),'recovery.m1',90,pg_temp.at(100))->>'status','handled','completed work is not repeated');

-- Database writes carry the same generation fence, including memory deletion.
select ingest_inbound(pg_temp.uid(),'recovery.fence','{"text":{"body":"remember this"}}',now());
insert into saved values('fence',claim_turn(pg_temp.uid(),'recovery.fence'));
select set_config('request.headers',jsonb_build_object('x-desk-turn',(select value->>'token' from saved where name='fence'))::text,true);
select lives_ok(format('insert into user_memories(id,user_id,kind,scope,text,source) values(%L,%L,%L,%L,%L,%L)',
 'f2000000-0000-0000-0000-000000000001',pg_temp.uid(),'fact','all','fence test','said'),'live generation may write memory');
select abandon_turn(pg_temp.uid(),(select (value->>'token')::uuid from saved where name='fence'));
select throws_ok('delete from user_memories where id=''f2000000-0000-0000-0000-000000000001''','55000','turn lease lost','stale generation cannot delete memory');
select throws_ok(format('select owe_message(%L,null,%L,%L)',pg_temp.uid(),'stale-reply','{"kind":"text","body":"stale"}'),'55000','turn lease lost','stale worker cannot enqueue a reply for later delivery');
select set_config('request.headers','{}',true);
delete from user_memories where id='f2000000-0000-0000-0000-000000000001';

-- Consent is refused under the same lock used by ingestion when the inbox advanced.
insert into saved values('request',start_request(pg_temp.uid(),'question',pg_temp.at(0)));
update requests set state='confirming' where id=(select (value->>'request_id')::uuid from saved where name='request');
select open_prompt('e1000000-0000-0000-0000-000000000001',(select (value->>'request_id')::uuid from saved where name='request'),'ask','{}','yes','Call?','{}',pg_temp.at(0));
select ingest_inbound(pg_temp.uid(),'recovery.yes','{"text":{"body":"yes"}}',pg_temp.at(1));
insert into saved select 'watermark',to_jsonb(seq) from messages where wa_message_id='recovery.yes';
select ingest_inbound(pg_temp.uid(),'recovery.wait','{"text":{"body":"wait"}}',pg_temp.at(2));
select is(record_consent('e1000000-0000-0000-0000-000000000001',null,'yes','recovery.yes',pg_temp.at(3),
 jsonb_build_object('input_seq',(select value from saved where name='watermark')))->>'reason','new_inbound','new correction atomically blocks consent');
select is((select count(*)::int from consents where request_id=(select (value->>'request_id')::uuid from saved where name='request')),0,'refused approval leaves no consent');

-- Send ownership and closed-window resumption.
insert into deliveries(id,user_id,dedupe_key,kind,message,next_attempt_at) values
 ('d1000000-0000-0000-0000-000000000001',pg_temp.uid(),'recovery:delivery','report','{"kind":"text","body":"Update"}',pg_temp.at(0));
insert into saved values('delivery',take_deliveries(pg_temp.at(0),1));
select is(jsonb_array_length(take_deliveries(pg_temp.at(0),1)),0,'a live send lease excludes other claims');
select throws_ok(format('select delivery_sent(%L,%L,%L,%L)','d1000000-0000-0000-0000-000000000001','out',pg_temp.at(1),gen_random_uuid()),'P0001','delivery lease lost','wrong send owner cannot acknowledge');
update messages set at=now()-interval '25 hours' where user_id=pg_temp.uid() and direction='in';
select defer_delivery('d1000000-0000-0000-0000-000000000001',(select (value->0->>'claim_token')::uuid from saved where name='delivery'));
select is((select next_attempt_at::text from deliveries where dedupe_key='recovery:delivery'),'infinity','closed window waits for inbound');
select is((select status from deliveries where dedupe_key='recovery:delivery'),'pending','expired window is not a permanent failure');
select ingest_inbound(pg_temp.uid(),'recovery.reopen','{"text":{"body":"hello"}}',now());
select ok((select next_attempt_at<='infinity'::timestamptz and isfinite(next_attempt_at) from deliveries where dedupe_key='recovery:delivery'),'new inbound wakes deferred updates');

-- Explicit, evidence-backed preferences; replacing one cannot create contradictions.
select ingest_inbound(pg_temp.uid(),'memory.one','{"text":{"body":"remember I prefer 8pm"}}',now());
insert into saved values('memory',remember_fact(pg_temp.uid(),'preference','booking','prefers 8pm','said','memory.one'));
select ingest_inbound(pg_temp.uid(),'memory.two','{"text":{"body":"actually I always prefer 9pm"}}',now());
select throws_ok(format('select remember_fact(%L,%L,%L,%L,%L,%L,%L)',pg_temp.uid(),'preference','booking','prefers 9pm','learned','memory.two','invented words'),'P0001','memory evidence must quote the user message','fabricated memory evidence is rejected');
select remember_fact(pg_temp.uid(),'preference','booking','prefers 9pm','learned','memory.two','always prefer 9pm',
 (select 'm-' || left(value->>'id',8) from saved where name='memory'));
select is((select count(*)::int from user_memories where user_id=pg_temp.uid()),1,'correction replaces the previous preference');
select is((select text from user_memories where user_id=pg_temp.uid()),'prefers 9pm','only the corrected preference remains');
select is(jsonb_array_length(recall_errands('a1000000-0000-0000-0000-000000000002','')),0,'recall is scoped to the requesting user');

select is(set_follow_up((select (value->>'request_id')::uuid from saved where name='request'),'waiting',now()+interval '25 hours')->>'reason',
 'outside_service_window','database refuses reminders beyond the current service window');

-- One reminder for the whole user's window, never an empty keep-alive after work ends.
update requests set state='collecting',paused_at=null where user_id=pg_temp.uid();
update messages set at=pg_temp.at(-24*3600+60) where user_id=pg_temp.uid() and direction='in';
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at(0))) x where x->>'reason'='window'),1,'unfinished work produces a near-expiry update');
insert into saved select 'window',x from jsonb_array_elements(due_follow_ups(pg_temp.at(0))) x where x->>'reason'='window';
select queue_follow_up((select (value->>'request_id')::uuid from saved where name='window'),'window',
 (select (value->>'stamp')::bigint from saved where name='window'),'{}',pg_temp.at(0));
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at(0))) x where x->>'reason'='window'),0,'no repeated window nudge');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at(61))) x where x->>'reason'='window'),0,'no update once the window expired');

-- A terminal provider result is durable and retryable until settlement commits.
insert into businesses(id,name,phone_e164,source) values('b1000000-0000-0000-0000-000000000001','Test place','+919100000003','user');
insert into caller_numbers(id,e164,provider) values('c1000000-0000-0000-0000-000000000001','+919100000004','sarvam');
update requests set state='calling_1',business_id='b1000000-0000-0000-0000-000000000001' where user_id=pg_temp.uid();
insert into calls(id,user_id,request_id,business_id,caller_number_id,kind,agent_version,status)
 select 'f1000000-0000-0000-0000-000000000001',pg_temp.uid(),id,business_id,'c1000000-0000-0000-0000-000000000001','question','test','dialing'
 from requests where user_id=pg_temp.uid();
insert into saved values('provider','{"attemptId":"review-attempt","callId":"f1000000-0000-0000-0000-000000000001","status":"completed","outputs":{"outcome":"question_answered","answer":"Open at ten"},"transcript":null,"durationS":30}');
select is(finish_provider_call((select value from saved where name='provider')),'f1000000-0000-0000-0000-000000000001'::uuid,'provider result stored');
select ok((select provider_result is not null and settled_at is null from calls where id='f1000000-0000-0000-0000-000000000001'),'terminal result remains owed');
select is(finish_provider_call((select value from saved where name='provider')),'f1000000-0000-0000-0000-000000000001'::uuid,'redelivery retries an unsettled report');
insert into saved values('settlement',to_jsonb(claim_settlement('f1000000-0000-0000-0000-000000000001')));
select is(claim_settlement('f1000000-0000-0000-0000-000000000001'),null,'only one worker owns settlement');
select is(settle_and_report('f1000000-0000-0000-0000-000000000001','done',p_claim_token=>gen_random_uuid())->>'reason','settlement_lease_lost','stale settlement cannot commit');
select settle_and_report('f1000000-0000-0000-0000-000000000001','done',
 p_facts=>' {"event":"call_result","happened":{"possible_unintended_commitment":"Reserved a table without approval"}}',
 p_claim_token=>(select trim(both '"' from value::text)::uuid from saved where name='settlement'));
select ok((select settled_at is not null from calls where id='f1000000-0000-0000-0000-000000000001'),'settlement and report mark completion atomically');
select is((select count(*)::int from alerts where call_id='f1000000-0000-0000-0000-000000000001' and kind='unintended_commitment'),1,'unintended commitment raises an incident in the same transaction');
select is(finish_provider_call((select value from saved where name='provider')),null,'completed settlement is not repeated');
select is(recall_errands(pg_temp.uid(),'')->0->'last_report'->'facts'->'happened'->>'possible_unintended_commitment',
 'Reserved a table without approval','past errand recall uses the recorded result facts');
select record_call_cost('f1000000-0000-0000-0000-000000000001',20);
select record_call_cost('f1000000-0000-0000-0000-000000000001',20);
select is((select count(*)::int from credit_ledger where call_id='f1000000-0000-0000-0000-000000000001'),1,'reported spend is idempotent');
select record_call_cost('f1000000-0000-0000-0000-000000000001',25);
select is((select sum(delta_rs) from credit_ledger where call_id='f1000000-0000-0000-0000-000000000001'),-25::numeric,'cost correction debits only the difference');

-- Local deletion completes and does not leave a hidden memory behind.
select request_data_deletion(pg_temp.uid(),now()-interval '2 minutes');
select erase_requested_users(now());
select is((select count(*)::int from users where id=pg_temp.uid()),0,'requested profile is erased');
select is((select count(*)::int from messages where user_id=pg_temp.uid()),0,'messages are erased');
select is((select count(*)::int from user_memories where user_id=pg_temp.uid()),0,'memories are erased');
select is((select count(*)::int from erasure_audit),1,'anonymous deletion completion is recorded');
select * from finish();
rollback;
