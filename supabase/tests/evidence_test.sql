-- 0006: STOP, pause, turns, no default advance, a call that can't start (evidence review P1-P16).
-- Clock: Friday 2026-10-23 in IST. Paragon is open all day.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-10-23 ' || hhmm || ':00+05:30')::timestamptz $$;

create function pg_temp.reason(res jsonb) returns text
language sql as $$ select coalesce(res ->> 'reason', 'ok') $$;

create function pg_temp.state(p_id uuid) returns text
language sql as $$ select state from requests where id = p_id $$;

-- A question for Paragon in awaiting_yes, its read-back open as prompt p_prompt.
create function pg_temp.ready(p_user uuid, p_prompt uuid, p_now timestamptz) returns uuid
language plpgsql as $$
declare
  rid uuid;
begin
  rid := (start_request(p_user, 'question', p_now) ->> 'request_id')::uuid;
  perform update_slots(rid, '{"question": "Do you dry clean blazers?"}', p_now);
  perform set_request_business(rid, 'b0000000-0000-0000-0000-000000000001', p_now);
  perform advance_request(rid, 'confirming', p_now);
  perform open_prompt(p_prompt, rid, 'ask', '{}', 'yes', 'read-back', '{}', p_now);
  return rid;
end $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');

create temp table t (name text primary key, id uuid);
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from t where name = p_name $$;

-- P5: no advance by default ---------------------------------------------------
select is(limit_int('max_advance_rs', 'a0000000-0000-0000-0000-000000000001'), 0,
          'no advance allowance unless set for the user');

-- P1: STOP --------------------------------------------------------------------
insert into t values ('r1', pg_temp.ready('a0000000-0000-0000-0000-000000000001',
                                          'e0000000-0000-0000-0000-000000000001', pg_temp.at('18:00')));
select is(stop_user('a0000000-0000-0000-0000-000000000001', pg_temp.at('18:01')),
          '{"ok": true, "cancelled": 1, "in_flight": false}'::jsonb, 'STOP ends the request waiting for YES');
select is(pg_temp.state(pg_temp.id('r1')), 'cancelled', 'the request is cancelled');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000001', null, 'yes', 'wamid.1', pg_temp.at('18:02'))),
          'stopped', 'a YES after STOP stores no consent');
select is((select count(*)::int from consents where request_id = pg_temp.id('r1')), 0, 'no consent row');

-- Stopped: a new request gets no read-back and no call can be reserved.
insert into t values ('r2', (start_request('a0000000-0000-0000-0000-000000000001', 'question', pg_temp.at('18:03')) ->> 'request_id')::uuid);
select is(pg_temp.reason(open_prompt('e0000000-0000-0000-0000-000000000002', pg_temp.id('r2'), 'ask', '{}', 'yes', 'rb', '{}', pg_temp.at('18:03'))),
          'stopped', 'no read-back opens while stopped');
update requests set state = 'calling_1', business_id = 'b0000000-0000-0000-0000-000000000001' where id = pg_temp.id('r2');
select is(pg_temp.reason(reserve_call(pg_temp.id('r2'), 'question', null, false, pg_temp.at('18:04'))),
          'user_stopped', 'no call is reserved while stopped');
select is(stop_user('a0000000-0000-0000-0000-000000000001', pg_temp.at('18:05')) -> 'in_flight', 'true'::jsonb,
          'STOP with a call under way says so');
select is(pg_temp.state(pg_temp.id('r2')), 'calling_1', 'a call in flight is not touched');

select is(resume_user('a0000000-0000-0000-0000-000000000001'), '{"ok": true, "was_stopped": true}'::jsonb, 'START');
select is(user_stopped('a0000000-0000-0000-0000-000000000001'), false, 'not stopped after START');
select is(pg_temp.state(pg_temp.id('r1')), 'cancelled', 'START brings nothing back');

-- Delete my data: stops and records.
select is(request_data_deletion('a0000000-0000-0000-0000-000000000002', pg_temp.at('18:06')) ->> 'ok', 'true', 'delete my data');
select ok((select stopped_at is not null and delete_requested_at is not null from users
            where id = 'a0000000-0000-0000-0000-000000000002'), 'stopped and recorded');
select resume_user('a0000000-0000-0000-0000-000000000002');

-- A call that can't start ends the request --------------------------------------
select is(pg_temp.reason(call_not_started(pg_temp.id('r2'), pg_temp.at('18:07'))), 'ok', 'call_not_started');
select is((select state || '/' || end_reason from requests where id = pg_temp.id('r2')), 'cancelled/limit',
          'the request ends instead of waiting in calling_1');
select is(pg_temp.reason(call_not_started(pg_temp.id('r2'), pg_temp.at('18:08'))), 'wrong_state', 'only from calling');

-- P3: pause -------------------------------------------------------------------
insert into t values ('r3', pg_temp.ready('a0000000-0000-0000-0000-000000000002',
                                          'e0000000-0000-0000-0000-000000000003', pg_temp.at('18:10')));
select is(pause_request(pg_temp.id('r3'), pg_temp.at('18:11')), '{"ok": true, "state": "confirming"}'::jsonb,
          'pause closes the read-back');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000003', null, 'yes', 'wamid.3', pg_temp.at('18:12'))),
          'paused', 'a stray YES while paused is refused');
select is(pg_temp.reason(open_prompt('e0000000-0000-0000-0000-000000000004', pg_temp.id('r3'), 'ask', '{}', 'yes', 'rb', '{}', pg_temp.at('18:12'))),
          'paused', 'no new read-back while paused');
select is(pg_temp.reason(update_slots(pg_temp.id('r3'), '{"question": "Do you dry clean blazers by Friday?"}', pg_temp.at('18:13'))),
          'ok', 'edits still apply while paused');
select ok((select paused_at is not null from requests where id = pg_temp.id('r3')), 'still paused after an edit');
select is(resume_request(pg_temp.id('r3'), pg_temp.at('18:20')) ->> 'changed', 'true', 'resume');
select is(pg_temp.reason(open_prompt('e0000000-0000-0000-0000-000000000005', pg_temp.id('r3'), 'ask', '{}', 'yes', 'rb', '{}', pg_temp.at('18:20'))),
          'ok', 'after resume a fresh read-back opens');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000005', null, 'yes', 'wamid.5', pg_temp.at('18:21'))),
          'ok', 'and its YES counts');

-- P6: turns -------------------------------------------------------------------
insert into messages (user_id, wa_message_id, direction, body, at) values
  ('a0000000-0000-0000-0000-000000000001', 'm1', 'in', '{"text": "ask Test Laundry"}', pg_temp.at('19:00')),
  ('a0000000-0000-0000-0000-000000000001', 'm2', 'in', '{"text": "if they can dry clean"}', pg_temp.at('19:00')),
  ('a0000000-0000-0000-0000-000000000001', 'm3', 'in', '{"text": "by Friday"}', pg_temp.at('19:00'));
select is(claim_turn('a0000000-0000-0000-0000-000000000001', 'm1', 90, pg_temp.at('19:01')) ->> 'status', 'newer',
          'an earlier message of a burst leaves it to the newest');
select is(claim_turn('a0000000-0000-0000-0000-000000000001', 'm3', 90, pg_temp.at('19:01')),
          '{"status": "claimed", "batch": [{"text": "ask Test Laundry"}, {"text": "if they can dry clean"}, {"text": "by Friday"}]}'::jsonb,
          'the newest takes the whole burst, oldest first');
select is(claim_turn('a0000000-0000-0000-0000-000000000001', 'm2', 90, pg_temp.at('19:01')) ->> 'status', 'handled',
          'a message already taken is not answered again');
insert into messages (user_id, wa_message_id, direction, body, at) values
  ('a0000000-0000-0000-0000-000000000001', 'm4', 'in', '{"text": "also pickup?"}', pg_temp.at('19:02'));
select is(claim_turn('a0000000-0000-0000-0000-000000000001', 'm4', 90, pg_temp.at('19:02')) ->> 'status', 'busy',
          'one turn per user at a time');
select release_turn('a0000000-0000-0000-0000-000000000001', 'm3');
select is(claim_turn('a0000000-0000-0000-0000-000000000001', 'm4', 90, pg_temp.at('19:03')) ->> 'status', 'claimed',
          'after release the next turn runs');
select is(claim_turn('a0000000-0000-0000-0000-000000000002', 'm4', 90, pg_temp.at('19:03')) ->> 'status', 'handled',
          'another user cannot claim this user''s message');
-- A crashed turn frees the user when its lease runs out.
insert into messages (user_id, wa_message_id, direction, body, at) values
  ('a0000000-0000-0000-0000-000000000001', 'm5', 'in', '{"text": "hello?"}', pg_temp.at('19:04'));
select is(claim_turn('a0000000-0000-0000-0000-000000000001', 'm5', 90, pg_temp.at('19:05')) ->> 'status', 'claimed',
          'an expired lease does not block');

-- P16 ---------------------------------------------------------------------------
select has_column('router_log', 'luna_reasoning_effort', 'router_log records Luna''s reasoning effort');

select * from finish();
rollback;
