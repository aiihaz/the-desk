begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into users(id,wa_id,phone_e164,channel) values
 ('a2000000-0000-0000-0000-000000000001','linq:919200000001','+919200000001','linq'),
 ('a2000000-0000-0000-0000-000000000002','919200000002','+919200000002','whatsapp');
insert into requests(id,user_id,task,state) values
 ('b2000000-0000-0000-0000-000000000001','a2000000-0000-0000-0000-000000000001','question','collecting'),
 ('b2000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000002','question','collecting');
select ingest_inbound('a2000000-0000-0000-0000-000000000001','linq-recover-old','{"text":{"body":"hello"}}',now()-interval '25 hours');
select ingest_inbound('a2000000-0000-0000-0000-000000000002','wa-recover-old','{"text":{"body":"hello"}}',now()-interval '25 hours');

select is((select count(*)::int from jsonb_array_elements(pending_inbound()) x
 where x->>'user_id'='a2000000-0000-0000-0000-000000000001' and x->>'channel'='linq'),1,
 'old Linq inbox work remains recoverable with its channel');
select is((select count(*)::int from jsonb_array_elements(pending_inbound()) x
 where x->>'user_id'='a2000000-0000-0000-0000-000000000002'),0,
 'old WhatsApp inbox work waits for a new service window');
select is(set_follow_up('b2000000-0000-0000-0000-000000000001','your decision',now()+interval '2 days')->>'ok','true',
 'Linq accepts a later conversational follow-up');
select is(set_follow_up('b2000000-0000-0000-0000-000000000002','your decision',now()+interval '2 days')->>'reason','outside_service_window',
 'WhatsApp keeps its service-window guard');

update messages set at=now()-interval '23 hours 59 minutes' where wa_message_id in ('linq-recover-old','wa-recover-old');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups()) x
 where x->>'user_id'='a2000000-0000-0000-0000-000000000001' and x->>'reason'='window'),0,
 'Linq never receives a WhatsApp expiry nudge');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups()) x
 where x->>'user_id'='a2000000-0000-0000-0000-000000000002' and x->>'reason'='window'),1,
 'WhatsApp still receives its useful near-expiry update');

update requests set state='confirming',last_user_msg_at=now()-interval '5 hours'
 where id='b2000000-0000-0000-0000-000000000001';
select open_prompt('c2000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001',
 'ask','{}','yes','Call?','{}',now()-interval '4 hours');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups()) x
 where x->>'user_id'='a2000000-0000-0000-0000-000000000001' and x->>'reason'='nudge'),1,
 'Linq retains the ordinary unanswered-plan follow-up');
select is(queue_follow_up('b2000000-0000-0000-0000-000000000001','window',
 (select seq from messages where wa_message_id='linq-recover-old'),'{}'),false,
 'the database refuses a synthetic WhatsApp-window update for Linq');

insert into webhook_events(source,external_id,payload) values
 ('linq','linq-recover-event','{"data":{"sender_handle":{"handle":"+919200000001"}}}'),
 ('linq','linq-other-event','{"data":{"sender_handle":{"handle":"+919200000099"}}}');
insert into linq_contact_shares(chat_id,user_id,claim_token,next_attempt_at)
 values('linq-recover-chat','a2000000-0000-0000-0000-000000000001',gen_random_uuid(),now());
update messages set at=now()-interval '2 days' where wa_message_id='linq-recover-old';
select request_data_deletion('a2000000-0000-0000-0000-000000000001',now()-interval '2 minutes');
create temp table erased as select erase_requested_users() as notices;
select is((select count(*)::int from users where id='a2000000-0000-0000-0000-000000000001'),0,
 'Linq erasure completes');
select is((select count(*)::int from webhook_events where external_id='linq-recover-event'),0,
 'Linq erasure deletes raw phone-addressed envelopes');
select is((select count(*)::int from webhook_events where external_id='linq-other-event'),1,
 'another Linq conversation remains intact');
select is((select count(*)::int from linq_contact_shares where chat_id='linq-recover-chat'),0,
 'Linq erasure removes contact-card state');
select is((select notices->0->>'channel' from erased),'linq','erasure confirmation retains the delivery channel');
select is((select notices->0->>'wa_id' from erased),'919200000001',
 'erasure confirmation uses the normalized phone even outside a WhatsApp window');

select * from finish();
rollback;
