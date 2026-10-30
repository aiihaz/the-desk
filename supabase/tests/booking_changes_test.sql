-- 0011: advance holds and payments, cancelling and rescheduling Desk bookings.
-- Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, d text default '2026-10-23') returns timestamptz
language sql as $$ select (d || ' ' || hhmm || ':00+05:30')::timestamptz $$;
create temp table t (name text primary key, id uuid);
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from t where name = p_name $$;
create function pg_temp.reason(res jsonb) returns text
language sql as $$ select coalesce(res ->> 'reason', 'ok') $$;

-- A request for Paragon in p_state, with a call of p_kind on caller number 1.
create function pg_temp.calling(p_user uuid, p_task text, p_state text, p_kind text, p_now timestamptz) returns uuid
language plpgsql as $$
declare
  rid uuid;
  cid uuid;
begin
  rid := (start_request(p_user, p_task, p_now) ->> 'request_id')::uuid;
  update requests set state = p_state, business_id = 'b0000000-0000-0000-0000-000000000001',
                      caller_number_id = 'c0000000-0000-0000-0000-000000000001'
   where id = rid;
  insert into calls (request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  values (rid, p_user, 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
          p_kind, '7', 'completed', p_now)
  returning id into cid;
  return cid;
end $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now()),
  ('c0000000-0000-0000-0000-000000000002', '+918000000002', 'sarvam', now());
select set_limit('active_agent_version', '"7"', 'test');
insert into gate_passes (agent_version, suite, passed) values ('7', 'test', true);
insert into credit_ledger (delta_rs, reason) values (1000, 'test');

-- Hold -------------------------------------------------------------------------------
insert into t values ('c_hold', pg_temp.calling('a0000000-0000-0000-0000-000000000001', 'booking', 'calling_1', 'first', pg_temp.at('18:00')));
insert into t values ('r_hold', (select request_id from calls where id = pg_temp.id('c_hold')));
select is(settle_call(pg_temp.id('c_hold'), 'held', '[]',
                      '{"time": "2026-10-23T20:15:00+05:30", "amount_rs": 500, "upi_id": "paragon@okhdfc",
                        "payee_name": "Paragon", "deadline": "2026-10-23T19:30:00+05:30"}',
                      false, pg_temp.at('18:01')) ->> 'state', 'awaiting_payment', 'a hold waits for the payment');
select is((select status || ' ' || deposit_amount::int || ' ' || upi_id || ' ' || payee_name from bookings
            where request_id = pg_temp.id('r_hold')),
          'held_pending_deposit 500 paragon@okhdfc Paragon', 'held with the payment details');
insert into t values ('bk_hold', (select id from bookings where request_id = pg_temp.id('r_hold')));

-- Payment ------------------------------------------------------------------------------
select is(pg_temp.reason(check_dial(pg_temp.id('r_hold'), 'payment_confirm', null, false, pg_temp.at('18:30'))),
          'no_consent', 'no confirm call without a screenshot that passed');
select is(record_payment(pg_temp.id('r_hold'), false, '{"amount_rs": 50, "utr": "111", "problems": ["amount"]}',
                         pg_temp.at('18:40')) ->> 'consent_id', null, 'a failed check is stored, with no approval');
select is((select state from requests where id = pg_temp.id('r_hold')), 'awaiting_payment', 'and nothing moves');
select is(record_payment(pg_temp.id('r_hold'), true, '{"amount_rs": 500, "utr": "432112344321", "payee": "paragon@okhdfc"}',
                         pg_temp.at('18:42')) ->> 'ok', 'true', 'a passing screenshot is recorded');
select is((select state from requests where id = pg_temp.id('r_hold')), 'verifying', 'the confirm call is next');
select is(pg_temp.reason(check_dial(pg_temp.id('r_hold'), 'payment_confirm', null, false, pg_temp.at('18:43'))),
          'ok', 'and allowed');
select is((check_dial(pg_temp.id('r_hold'), 'payment_confirm', null, false, pg_temp.at('18:43')) ->> 'caller_number_id')::uuid,
          'c0000000-0000-0000-0000-000000000001'::uuid, 'from the number that made the hold');

-- The same UTR for another booking is a reused screenshot.
insert into t values ('c_hold2', pg_temp.calling('a0000000-0000-0000-0000-000000000002', 'booking', 'calling_1', 'first', pg_temp.at('18:00')));
select settle_call(pg_temp.id('c_hold2'), 'held', '[]', '{"amount_rs": 500, "upi_id": "x@ok"}', false, pg_temp.at('18:01'));
select is(pg_temp.reason(record_payment((select request_id from calls where id = pg_temp.id('c_hold2')), true,
                                        '{"amount_rs": 500, "utr": "432112344321"}', pg_temp.at('18:50'))),
          'utr_used', 'a UTR that passed for another booking is refused');

-- Confirm call: not seen → retry → due.
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
values ('d0000000-0000-0000-0000-000000000001', pg_temp.id('r_hold'), 'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'payment_confirm', '7',
        'completed', pg_temp.at('18:44'));
select is(settle_call('d0000000-0000-0000-0000-000000000001', 'retry', p_now => pg_temp.at('18:46')) ->> 'state',
          'awaiting_payment', 'not seen yet: back to waiting');
select is((select next_call_at from requests where id = pg_temp.id('r_hold')), pg_temp.at('19:16'),
          'with the redial due after payment_confirm_retry_minutes');
select is(pg_temp.reason(check_dial(pg_temp.id('r_hold'), 'payment_confirm', null, true, pg_temp.at('19:16'))),
          'ok', 'the screenshot still allows the one redial');
select is((select count(*)::int from take_due_calls(pg_temp.at('19:00'))), 0, 'not due before its time');
select is((select count(*)::int from take_due_calls(pg_temp.at('19:16'))), 1, 'due at its time');
select is((select count(*)::int from take_due_calls(pg_temp.at('19:17'))), 0, 'and taken once');

-- Received: the held booking becomes booked.
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
values ('d0000000-0000-0000-0000-000000000002', pg_temp.id('r_hold'), 'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'payment_confirm', '7',
        'completed', pg_temp.at('19:16'));
select settle_call('d0000000-0000-0000-0000-000000000002', 'done', '[]',
                   '{"time": "2026-10-23T20:15:00+05:30", "reference": "T12", "verified": true}', false, pg_temp.at('19:18'));
select is((select status || ' ' || reference from bookings where id = pg_temp.id('bk_hold')), 'booked T12',
          'the held booking is now booked, not a second row');
select is((select count(*)::int from bookings where request_id = pg_temp.id('r_hold')), 1, 'one booking row');

-- Cancel --------------------------------------------------------------------------------
insert into t values ('r_cancel', (start_request('a0000000-0000-0000-0000-000000000001', 'cancel', pg_temp.at('19:20')) ->> 'request_id')::uuid);
select is(pg_temp.reason(set_request_booking(pg_temp.id('r_cancel'), pg_temp.id('bk_hold'), pg_temp.at('19:21'))), 'ok',
          'the user''s own upcoming booking can be cancelled');
select is((select caller_number_id from requests where id = pg_temp.id('r_cancel')),
          'c0000000-0000-0000-0000-000000000001'::uuid, 'calling from the number that made it');
select is(pg_temp.reason(set_request_booking(pg_temp.id('r_cancel'), pg_temp.id('bk_hold'), pg_temp.at('21:00'))),
          'booking_past', 'a booking in the past can''t');
insert into t values ('r_other', (start_request('a0000000-0000-0000-0000-000000000002', 'cancel', pg_temp.at('19:20')) ->> 'request_id')::uuid);
select is(pg_temp.reason(set_request_booking(pg_temp.id('r_other'), pg_temp.id('bk_hold'), pg_temp.at('19:21'))),
          'no_booking', 'nor someone else''s');
insert into t values ('r_q', (start_request('a0000000-0000-0000-0000-000000000002', 'question', pg_temp.at('19:22')) ->> 'request_id')::uuid);
select is(pg_temp.reason(set_request_booking(pg_temp.id('r_q'), pg_temp.id('bk_hold'), pg_temp.at('19:22'))),
          'wrong_task', 'and only for a reschedule or cancel');

update requests set state = 'calling_1' where id = pg_temp.id('r_cancel');
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
values ('d0000000-0000-0000-0000-000000000003', pg_temp.id('r_cancel'), 'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'cancel', '7',
        'completed', pg_temp.at('19:25'));
select settle_call('d0000000-0000-0000-0000-000000000003', 'back', '[]', '{"fee_rs": 200}', false, pg_temp.at('19:26'));
select is((select known_fee_rs::int from bookings where id = pg_temp.id('bk_hold')), 200,
          'a stated charge is kept for the next plan');
select is((select status from bookings where id = pg_temp.id('bk_hold')), 'booked', 'and the booking still stands');
update requests set state = 'calling_1' where id = pg_temp.id('r_cancel');
select settle_call('d0000000-0000-0000-0000-000000000003', 'cancelled', p_now => pg_temp.at('19:40'));
select is((select status from bookings where id = pg_temp.id('bk_hold')), 'cancelled', 'cancelled');

-- Reschedule ---------------------------------------------------------------------------
insert into t values ('c_b2', pg_temp.calling('a0000000-0000-0000-0000-000000000002', 'booking', 'calling_1', 'first', pg_temp.at('17:00')));
select settle_call(pg_temp.id('c_b2'), 'done', '[]', '{"time": "2026-10-24T20:00:00+05:30", "verified": true}',
                   false, pg_temp.at('17:01'));
insert into t values ('bk_b2', (select id from bookings where call_id = pg_temp.id('c_b2')));
insert into t values ('r_move', (start_request('a0000000-0000-0000-0000-000000000002', 'reschedule', pg_temp.at('19:00')) ->> 'request_id')::uuid);
select set_request_booking(pg_temp.id('r_move'), pg_temp.id('bk_b2'), pg_temp.at('19:01'));
update requests set state = 'calling_1' where id = pg_temp.id('r_move');
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
values ('d0000000-0000-0000-0000-000000000004', pg_temp.id('r_move'), 'a0000000-0000-0000-0000-000000000002',
        'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'reschedule', '7',
        'completed', pg_temp.at('19:05'));
select settle_call('d0000000-0000-0000-0000-000000000004', 'done', '[]',
                   '{"time": "2026-10-24T21:00:00+05:30", "verified": true}', false, pg_temp.at('19:06'));
select is((select status from bookings where id = pg_temp.id('bk_b2')), 'moved', 'the original is marked moved');
select is((select status || ' ' || to_char(time at time zone 'Asia/Kolkata', 'HH24:MI') from bookings
            where request_id = pg_temp.id('r_move')), 'booked 21:00', 'and the new time is a booking');

-- Unconfirmed ----------------------------------------------------------------------------
insert into t values ('c_un', pg_temp.calling('a0000000-0000-0000-0000-000000000001', 'booking', 'calling_1', 'first', pg_temp.at('19:50')));
select settle_call(pg_temp.id('c_un'), 'held', '[]', '{"amount_rs": 300, "upi_id": "y@ok"}', false, pg_temp.at('19:51'));
update requests set state = 'verifying' where id = (select request_id from calls where id = pg_temp.id('c_un'));
update calls set kind = 'payment_confirm' where id = pg_temp.id('c_un');
select settle_call(pg_temp.id('c_un'), 'unconfirmed', '[]', '{"said": "we got Rs 30"}', false, pg_temp.at('20:00'));
select is((select status from bookings where call_id = pg_temp.id('c_un')), 'unconfirmed', 'not confirmed → unconfirmed');
select is((select kind || ' ' || (detail ->> 'said') from alerts where call_id = pg_temp.id('c_un')),
          'booking_unconfirmed we got Rs 30', 'flagged with what they said');

-- A confirm call that couldn't start goes back to waiting; the hold stands.
insert into t values ('c_ns', pg_temp.calling('a0000000-0000-0000-0000-000000000002', 'booking', 'calling_1', 'first', pg_temp.at('20:00')));
select settle_call(pg_temp.id('c_ns'), 'held', '[]', '{"amount_rs": 300, "upi_id": "z@ok"}', false, pg_temp.at('20:01'));
update requests set state = 'verifying' where id = (select request_id from calls where id = pg_temp.id('c_ns'));
select call_not_started((select request_id from calls where id = pg_temp.id('c_ns')), pg_temp.at('20:05'));
select is((select state from requests where id = (select request_id from calls where id = pg_temp.id('c_ns'))),
          'awaiting_payment', 'a confirm call that didn''t start leaves the hold waiting');

select * from finish();
rollback;
