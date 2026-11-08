-- 0012: what a call established survives a failed send, errands carry what they wait for,
-- memories go with the data, and a call needs its consent and a pinned caller setup.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- 0028 test mode (owner's decision, 7 Nov 2026) comments out production call guards; see
-- supabase/restore_call_checks.sql. pg_temp.test_mode() reads whether that is live, so each
-- assertion below that depends on it switches back by itself when the guards are restored.
create function pg_temp.test_mode() returns boolean language sql as $$
  select coalesce((select prosrc like '%is_tester := true%' from pg_proc where proname = 'check_dial_base'), false)
$$;

create function pg_temp.at(hhmm text, d text default '2026-10-23') returns timestamptz
language sql as $$ select (d || ' ' || hhmm || ':00+05:30')::timestamptz $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into businesses (id, place_id, phone_e164, name, city, source, opening_hours) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places', null);
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());
insert into credit_ledger (delta_rs, reason) values (1000, 'test');
select set_limit('active_agent_version', '"7"', 'test');
insert into gate_passes (agent_version, suite, passed, instructions_sha256) values ('7', 'test', true, 'pin');
select set_limit('agent_instructions_sha256', '"pin"', 'test');
update gate_passes set outputs_seen = (select array_agg(name) from caller_contract);

create temp table t (name text primary key, id uuid);
create function pg_temp.id(n text) returns uuid language sql as $$ select id from t where name = n $$;

-- A request in calling_1 with a call open.
create function pg_temp.calling(n text, u uuid default 'a0000000-0000-0000-0000-000000000001') returns void
language plpgsql as $$
declare
  rid uuid;
  cid uuid := gen_random_uuid();
begin
  rid := (start_request(u, 'booking', pg_temp.at('11:00')) ->> 'request_id')::uuid;
  update requests set state = 'calling_1', business_id = 'b0000000-0000-0000-0000-000000000001' where id = rid;
  insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  values (cid, rid, u, 'b0000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000001', 'first', '7', 'completed', pg_temp.at('11:05'));
  insert into t values (n, rid), (n || '_call', cid);
end $$;

-- settle_and_report ----------------------------------------------------------------

select pg_temp.calling('r1');
select is((settle_and_report(pg_temp.id('r1_call'), 'done', '[]',
  '{"time": null, "date": "2026-11-08", "captured": "November 8", "approved": "2026-11-08T20:00:00+05:30", "verified": false, "problems": ["date only"]}',
  false, '{"event": "call_result", "happened": {"status": "booked"}}',
  p_now => pg_temp.at('11:10')) ->> 'state'), 'done', 'the result settles');
select is((select count(*)::int from deliveries where call_id = pg_temp.id('r1_call') and status = 'pending'), 1,
          'what the user is owed is stored with the settlement');
select is((select message from deliveries where call_id = pg_temp.id('r1_call')), null,
          'as facts: a model writes the message after');
select results_eq(
  $$select time, booked_on, captured_time from bookings where request_id = pg_temp.id('r1')$$,
  $$values (null::timestamptz, '2026-11-08'::date, 'November 8'::text)$$,
  'a date stays a date: no time, and the captured value is kept');

select is((settle_and_report(pg_temp.id('r1_call'), 'done', p_facts =>
  '{"event": "again"}', p_now => pg_temp.at('11:11')) ->> 'ok'),
  'false', 'a redelivered result settles nothing');
select is((select count(*)::int from deliveries where call_id = pg_temp.id('r1_call')), 1, 'and queues nothing');

-- Options: the prompt waits for the message, so what's approved is what was read.
select pg_temp.calling('r3', 'a0000000-0000-0000-0000-000000000002');
select settle_and_report(pg_temp.id('r3_call'), 'options',
  '[{"label": "8:30 pm", "value": {}}]', p_facts => '{"event": "call_result"}', p_now => pg_temp.at('11:13'));
select is((select state from requests where id = pg_temp.id('r3')), 'options_ready', 'no prompt until it is written');
select is((select count(*)::int from consent_prompts where request_id = pg_temp.id('r3')), 0, 'none at all');

-- Cancelled during the call, nothing booked: the errand ends.
select pg_temp.calling('r4');
select is((request_cancel_after_call(pg_temp.id('r4')) ->> 'ok'), 'true', 'cancel can be asked during a call');
select settle_and_report(pg_temp.id('r4_call'), 'back', p_facts => '{"event": "call_result"}',
  p_end => true, p_now => pg_temp.at('11:14'));
select results_eq($$select state, end_reason from requests where id = pg_temp.id('r4')$$,
                  $$values ('cancelled'::text, 'user'::text)$$, 'and ends the errand with the result');
select is((request_cancel_after_call(pg_temp.id('r4')) ->> 'reason'), 'not_calling', 'not when no call is running');

-- An answered question cancelled during its call: settled, then closed as the cancel.
select pg_temp.calling('r7');
select settle_and_report(pg_temp.id('r7_call'), 'done', p_facts => '{"event": "call_result"}',
  p_end => true, p_now => pg_temp.at('11:14'));
select results_eq($$select state, end_reason from requests where id = pg_temp.id('r7')$$,
                  $$values ('cancelled'::text, 'user'::text)$$, 'an answered question closes as cancelled');
select is((select count(*)::int from deliveries where call_id = pg_temp.id('r7_call')), 1, 'and its answer is still owed');

-- A waiting errand becomes current, and is said only if it did.
select pg_temp.calling('r5');
insert into t values ('q1', (queue_request('a0000000-0000-0000-0000-000000000001', 'question', pg_temp.at('11:15')) ->> 'request_id')::uuid);
select settle_and_report(pg_temp.id('r5_call'), 'done', p_facts => '{"event": "call_result"}',
  p_next => jsonb_build_object('request_id', pg_temp.id('q1'), 'facts', '{"task": "question"}'::jsonb),
  p_now => pg_temp.at('11:16'));
select is((select state from requests where id = pg_temp.id('q1')), 'collecting', 'the errand behind it becomes current');
select is((select facts -> 'next_errand' ->> 'task' from deliveries where call_id = pg_temp.id('r5_call')), 'question',
          'and the same message says so');

-- Writing ---------------------------------------------------------------------------

update deliveries set status = 'sent' where call_id not in (pg_temp.id('r5_call'), pg_temp.id('r3_call'));
select is(jsonb_array_length(take_deliveries(pg_temp.at('11:20'))), 0, 'nothing unwritten can be sent');
create temp table taken as select jsonb_array_elements(take_unwritten(pg_temp.at('11:20'))) as d;
select is((select count(*)::int from taken), 2, 'what is owed comes out to be written');
select is(jsonb_array_length(take_unwritten(pg_temp.at('11:20'))), 0, 'a write being done is leased');

-- A write that fails stays owed, backs off, tells the review surface once, and never fails.
select delivery_unwritten((select id from deliveries where call_id = pg_temp.id('r5_call')), 'model down', pg_temp.at('11:20'));
select is((select status from deliveries where call_id = pg_temp.id('r5_call')), 'pending', 'a failed write stays owed');
select is(jsonb_array_length(take_unwritten(pg_temp.at('11:20'))), 0, 'and backs off');
update deliveries set write_attempts = 4 where call_id = pg_temp.id('r5_call');
select delivery_unwritten((select id from deliveries where call_id = pg_temp.id('r5_call')), 'model down', pg_temp.at('11:21'));
update deliveries set write_attempts = 5 where call_id = pg_temp.id('r5_call');
select delivery_unwritten((select id from deliveries where call_id = pg_temp.id('r5_call')), 'model down', pg_temp.at('11:22'));
select is((select count(*)::int from alerts where kind = 'report_unwritten'), 1, 'the review surface hears once');
select is((select message from deliveries where call_id = pg_temp.id('r5_call')), null, 'and nothing stands in for it');

select delivery_written((select id from deliveries where call_id = pg_temp.id('r5_call')),
                        '{"kind": "text", "body": "Done."}', pg_temp.at('11:23'));
select is((select status from deliveries where call_id = pg_temp.id('r5_call')), 'pending', 'written, then sent');
select is(((take_deliveries(pg_temp.at('11:23')) -> 0 -> 'message') ->> 'body'), 'Done.', 'a written message goes out');
select is(jsonb_array_length(take_deliveries(pg_temp.at('11:23'))), 0, 'a taken message is leased');
select is(delivery_failed((select id from deliveries where call_id = pg_temp.id('r5_call')),
                          'whatsapp down', false, pg_temp.at('11:23')), 'pending', 'a failed send stays owed');
select is(jsonb_array_length(take_deliveries(pg_temp.at('11:23'))), 0, 'it backs off');
select is(jsonb_array_length(take_deliveries(pg_temp.at('11:40'))), 1, 'then it is tried again');
select is(delivery_failed((select id from deliveries where call_id = pg_temp.id('r5_call')),
                          'outside window', true, pg_temp.at('11:41')), 'failed', 'a message that can''t go is failed');
select is((select count(*)::int from alerts where kind = 'delivery_failed'), 1, 'and raised, not lost');

-- The options message opens its prompt with exactly the text the user reads.
select delivery_written((select id from deliveries where call_id = pg_temp.id('r3_call')),
                        '{"kind": "text", "body": "They offered: 1. 8:30 pm"}', pg_temp.at('11:42'));
select is((select state from requests where id = pg_temp.id('r3')), 'awaiting_pick', 'the prompt opens when it is written');
select is((select text_shown from consent_prompts where request_id = pg_temp.id('r3')), 'They offered: 1. 8:30 pm',
          'with the words the user gets');
select delivery_sent((select id from deliveries where call_id = pg_temp.id('r3_call')), 'wamid.opts', pg_temp.at('11:43'));
select is((select wa_message_id from consent_prompts where request_id = pg_temp.id('r3')), 'wamid.opts',
          'and learns which message showed it');

-- The errand moved on while the report waited: the message still goes, with no prompt.
select pg_temp.calling('r8', 'a0000000-0000-0000-0000-000000000002');
select settle_and_report(pg_temp.id('r8_call'), 'options', '[{"label": "9 pm", "value": {}}]',
  p_facts => '{"event": "call_result"}', p_now => pg_temp.at('11:50'));
select cancel_request(pg_temp.id('r8'), pg_temp.at('11:51'));
select delivery_written((select id from deliveries where call_id = pg_temp.id('r8_call')),
                        '{"kind": "text", "body": "They offered 9 pm"}', pg_temp.at('11:52'));
select is((select message ->> 'body' from deliveries where call_id = pg_temp.id('r8_call')), 'They offered 9 pm',
          'what happened is still told');
select is((select count(*)::int from consent_prompts where request_id = pg_temp.id('r8') and closed_at is null), 0,
          'but no prompt opens on an errand that ended');

-- Something owed outside a call result is owed once.
select owe_facts('a0000000-0000-0000-0000-000000000001', null, 'payment:wamid.1', 'notice', '{"event": "payment_check"}', pg_temp.at('11:53'));
select owe_facts('a0000000-0000-0000-0000-000000000001', null, 'payment:wamid.1', 'notice', '{"event": "payment_check"}', pg_temp.at('11:54'));
select is((select count(*)::int from deliveries where dedupe_key = 'tell:payment:wamid.1'), 1, 'owed once');

-- Follow-ups -------------------------------------------------------------------------

select is((set_follow_up(pg_temp.id('q1'), 'Asha to confirm', pg_temp.at('18:00'), pg_temp.at('12:00')) ->> 'ok'), 'true',
          'an errand records what it waits for');
select is((select waiting_for from requests where id = pg_temp.id('q1')), 'Asha to confirm', 'stored, so a restart keeps it');
select is(jsonb_array_length(due_follow_ups(pg_temp.at('17:00'))), 0, 'not due yet');
create temp table due as select jsonb_array_elements(due_follow_ups(pg_temp.at('18:01'))) as d;
select is((select count(*)::int from due where d ->> 'reason' = 'reminder'), 1, 'due at its time');
select ok(queue_follow_up(pg_temp.id('q1'), 'reminder', 1, '{"event": "follow_up"}', pg_temp.at('18:01')), 'queued');
select ok(not queue_follow_up(pg_temp.id('q1'), 'reminder', 1, '{"event": "follow_up"}', pg_temp.at('18:02')),
          'a job that runs twice can''t queue it twice');
select is((select remind_at from requests where id = pg_temp.id('q1')), null, 'a reminder fires once');
select is((set_follow_up(pg_temp.id('r1'), 'x', null) ->> 'reason'), 'not_active', 'an ended errand waits for nothing');

-- "Hold on, remind me at 6" pauses the errand, and the reminder still fires.
insert into t values ('p1', (start_request('a0000000-0000-0000-0000-000000000001', 'booking', pg_temp.at('12:00')) ->> 'request_id')::uuid);
select pause_request(pg_temp.id('p1'), pg_temp.at('12:01'));
select set_follow_up(pg_temp.id('p1'), 'checking with Asha', pg_temp.at('18:00'), pg_temp.at('12:01'));
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('18:01'))) x
            where (x ->> 'request_id')::uuid = pg_temp.id('p1') and x ->> 'reason' = 'reminder'), 1,
          'a paused errand''s reminder still fires');

-- A plan nobody answered gets one nudge per version.
update requests set state = 'cancelled' where user_id = 'a0000000-0000-0000-0000-000000000001' and state not in ('done');
insert into t values ('n1', (start_request('a0000000-0000-0000-0000-000000000001', 'booking', pg_temp.at('12:00')) ->> 'request_id')::uuid);
update requests set state = 'confirming', business_id = 'b0000000-0000-0000-0000-000000000001' where id = pg_temp.id('n1');
select open_prompt('e0000000-0000-0000-0000-000000000002', pg_temp.id('n1'), 'ask', '{}', 'yes', 'Plan', '{"kind": "text", "body": "Plan"}', pg_temp.at('12:05'));
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('14:00'))) x where x ->> 'reason' = 'nudge'), 0, 'not before nudge_after_minutes');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('15:10'))) x where x ->> 'reason' = 'nudge'), 0, 'no extra mid-window keep-alive');
select queue_follow_up(pg_temp.id('n1'), 'nudge', 1, '{"event": "follow_up"}', pg_temp.at('15:10'));
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('20:00'))) x where x ->> 'reason' = 'nudge'), 0, 'only once');

-- An expired errand is told, once.
select expire_requests(pg_temp.at('12:00', '2026-10-25'));
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('12:01', '2026-10-25'))) x
            where x ->> 'reason' = 'expired' and (x ->> 'request_id')::uuid = pg_temp.id('n1')), 1, 'an expired errand is told');

-- A stopped user gets no nudges, but still hears how a call went.
select pg_temp.calling('r6');
select settle_and_report(pg_temp.id('r6_call'), 'back', p_facts => '{"event": "call_result"}',
  p_now => pg_temp.at('12:10', '2026-10-25'));
update deliveries set status = 'pending', next_attempt_at = pg_temp.at('11:00')
 where dedupe_key like 'nudge:%';
select stop_user('a0000000-0000-0000-0000-000000000001', pg_temp.at('12:11', '2026-10-25'));
select take_unwritten(pg_temp.at('12:12', '2026-10-25'));
select is((select status from deliveries where dedupe_key like 'nudge:%'), 'dropped', 'a stopped user gets no nudge');
select is((select write_attempts from deliveries where call_id = pg_temp.id('r6_call')), 1, 'but a call report still goes');
select resume_user('a0000000-0000-0000-0000-000000000001');

-- Memory ----------------------------------------------------------------------------

insert into user_memories (user_id, kind, text, source) values
  ('a0000000-0000-0000-0000-000000000001', 'fact', 'vegetarian', 'said');
select throws_ok($$insert into user_memories (user_id, kind, text, source) values
  ('a0000000-0000-0000-0000-000000000001', 'fact', 'Vegetarian', 'said')$$, '23505', null, 'a memory is kept once');
select request_data_deletion('a0000000-0000-0000-0000-000000000001', pg_temp.at('12:20', '2026-10-25'));
select is((select count(*)::int from user_memories where user_id = 'a0000000-0000-0000-0000-000000000001'), 0, 'delete my data takes the memories');
-- Reset this fixture before independent caller-pinning checks. START itself cannot cancel erasure.
update users set delete_requested_at=null where id='a0000000-0000-0000-0000-000000000001';
select resume_user('a0000000-0000-0000-0000-000000000001');

-- Dialling --------------------------------------------------------------------------

insert into t values ('d1', (start_request('a0000000-0000-0000-0000-000000000001', 'booking', pg_temp.at('12:00', '2026-10-26')) ->> 'request_id')::uuid);
update requests set state = 'confirming', business_id = 'b0000000-0000-0000-0000-000000000001' where id = pg_temp.id('d1');
select open_prompt('e0000000-0000-0000-0000-000000000003', pg_temp.id('d1'), 'ask', '{}', 'yes', 'Plan', '{"kind": "text", "body": "Plan"}', pg_temp.at('12:01', '2026-10-26'));
select is((check_dial(pg_temp.id('d1'), 'first', p_now => pg_temp.at('12:02', '2026-10-26')) ->> 'reason'), 'no_consent', 'no consent, no call');
insert into t values ('k1', (record_consent('e0000000-0000-0000-0000-000000000003', null, 'yes', 'wamid.x', pg_temp.at('12:02', '2026-10-26')) ->> 'consent_id')::uuid);

select is((check_dial(pg_temp.id('d1'), 'first', p_now => pg_temp.at('12:03', '2026-10-26')) ->> 'consent_id')::uuid, pg_temp.id('k1'),
          'the dial check names the consent it rests on');
select set_limit('agent_instructions_sha256', '"changed"', 'test');
select case when pg_temp.test_mode() then skip('0028 test mode: the instructions pin is off until the production guards are restored') else is((check_dial(pg_temp.id('d1'), 'first', p_now => pg_temp.at('12:03', '2026-10-26')) ->> 'reason'), 'agent_instructions_mismatch',
          'instructions that drifted from the tested ones can''t dial') end;
select set_limit('agent_instructions_sha256', 'null', 'test');
select case when pg_temp.test_mode() then skip('0028 test mode: the instructions pin is off until the production guards are restored') else is((check_dial(pg_temp.id('d1'), 'first', p_now => pg_temp.at('12:03', '2026-10-26')) ->> 'reason'), 'no_instructions_pin',
          'nor can an unpinned setup') end;
select set_limit('agent_instructions_sha256', '"pin"', 'test');
insert into t values ('c1', (reserve_call(pg_temp.id('d1'), 'first', p_now => pg_temp.at('12:04', '2026-10-26')) ->> 'call_id')::uuid);
select is((select consent_id from calls where id = pg_temp.id('c1')), pg_temp.id('k1'), 'the call keeps its consent');

-- Health and Jev.
select job_ran('reconcile', '{"sent": 1}', pg_temp.at('12:30'));
select job_ran('reconcile', '{"sent": 2}', pg_temp.at('12:35'));
select is((select detail ->> 'sent' from job_runs where name = 'reconcile'), '2', 'a job records its last run');
select is(limit_text('jev_model'), 'jev-1.14.0', 'Jev has a pinned model');
select is(limit_text('jev_mode'), 'shadow', 'and stays in shadow until its evals pass');

select * from finish();
rollback;
