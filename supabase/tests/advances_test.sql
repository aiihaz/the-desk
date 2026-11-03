-- 0014: an advance is never agreed on a call and stays open until the user closes it,
-- conditions go to the user, and what isn't known is recorded as not known.
-- Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, d text default '2026-10-23') returns timestamptz
language sql as $$ select (d || ' ' || hhmm || ':00+05:30')::timestamptz $$;
create temp table t (name text primary key, id uuid);
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from t where name = p_name $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());

-- A request of p_task in p_state with a finished call of p_kind. Named n, with n_call.
create function pg_temp.calling(n text, p_task text, p_state text, p_kind text, p_user uuid default 'a0000000-0000-0000-0000-000000000001') returns void
language plpgsql as $$
declare
  rid uuid;
  cid uuid := gen_random_uuid();
begin
  insert into requests (user_id, task, state, business_id, caller_number_id, created_at, updated_at)
  values (p_user, p_task, 'queued', 'b0000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000001', pg_temp.at('10:00'), pg_temp.at('10:00'))
  returning id into rid;
  update requests set state = p_state where id = rid;
  insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  values (cid, rid, p_user, 'b0000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000001', p_kind, '7', 'completed', pg_temp.at('10:01'));
  insert into t values (n, rid), (n || '_call', cid);
end $$;

-- The terms come back, and nothing is agreed -----------------------------------------
select pg_temp.calling('a', 'booking', 'calling_1', 'first');
select is(settle_call(pg_temp.id('a_call'), 'advance', '[]',
  '{"amount_rs": 500, "upi_id": "paragon@okhdfc", "payee_name": "Paragon",
    "terms": {"amount_rs": 500, "redeemable": "adjusted in the bill", "refund": "not refundable", "holding": "yes", "mode": "upi"}}',
  false, pg_temp.at('10:02')) ->> 'state', 'awaiting_payment', 'the errand waits for the user');
select results_eq(
  $$select status, advance_terms ->> 'redeemable', advance_terms ->> 'refund' from bookings where request_id = pg_temp.id('a')$$,
  $$values ('advance_due'::text, 'adjusted in the bill'::text, 'not refundable'::text)$$,
  'every term is kept');
select is((select count(*)::int from bookings where status = 'booked'), 0, 'and nothing is booked');

-- It never expires: only the user closes it.
select expire_requests(pg_temp.at('12:00', '2026-11-30'));
select is((select state from requests where id = pg_temp.id('a')), 'awaiting_payment', 'no deadline: it stays open');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('12:00', '2026-11-30'))) x
            where (x ->> 'request_id')::uuid = pg_temp.id('a')), 0, 'and nothing prods them');

-- An advance doesn't take up the user's one active errand, so two can be open at once.
select pg_temp.calling('b', 'booking', 'calling_1', 'first');
select settle_call(pg_temp.id('b_call'), 'advance', '[]', '{"amount_rs": 300, "deadline": "2026-10-23T18:00:00+05:30"}', false, pg_temp.at('10:03'));
select is((select count(*)::int from requests where state = 'awaiting_payment'), 2, 'two can be open at once');

-- A deadline passing is told once, and ends nothing --------------------------------------
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('17:45'))) x where x ->> 'reason' = 'payment'), 1,
          'a reminder before the deadline');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('17:00'))) x where x ->> 'reason' = 'deadline'), 0,
          'not before it passes');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('18:01'))) x where x ->> 'reason' = 'deadline'), 1,
          'told when it passes');
select ok(queue_follow_up(pg_temp.id('b'), 'deadline', 1, '{"event": "follow_up"}', pg_temp.at('18:01')), 'queued');
select is((select count(*)::int from jsonb_array_elements(due_follow_ups(pg_temp.at('19:00'))) x where x ->> 'reason' = 'deadline'), 0,
          'once');
select is((select state from requests where id = pg_temp.id('b')), 'awaiting_payment', 'and the errand is still theirs to close');

-- Dropping it -----------------------------------------------------------------------------
select is(cancel_request(pg_temp.id('b'), pg_temp.at('19:01')) ->> 'ok', 'true', 'an unpaid advance can be dropped');
select results_eq(
  $$select r.state, b.status from requests r join bookings b on b.request_id = r.id where r.id = pg_temp.id('b')$$,
  $$values ('cancelled'::text, 'dropped'::text)$$, 'the work stops, and that says nothing about the business');

select record_payment(pg_temp.id('a'), true, '{"amount_rs": 500, "utr": "1", "weak_payee_match": true}', pg_temp.at('12:00'));
select is((select count(*)::int from alerts where kind = 'payment_payee_weak'), 1, 'a weak payee match is flagged');
update requests set state = 'awaiting_payment' where id = pg_temp.id('a');
select is(cancel_request(pg_temp.id('a'), pg_temp.at('12:01')) ->> 'reason', 'paid', 'a paid one is a cancellation');

-- Cancelling it on a call ends the errand waiting on it.
select pg_temp.calling('c', 'cancel', 'calling_1', 'cancel');
update requests set booking_id = (select id from bookings where request_id = pg_temp.id('a')) where id = pg_temp.id('c');
select settle_call(pg_temp.id('c_call'), 'cancelled', p_now => pg_temp.at('12:10'));
select is((select status from bookings where request_id = pg_temp.id('a')), 'cancelled', 'the business cancelled it');
select is((select state from requests where id = pg_temp.id('a')), 'cancelled', 'and nothing waits for a payment on it');

-- Unknown stays unknown --------------------------------------------------------------------
create function pg_temp.booked(n text, p_user uuid default 'a0000000-0000-0000-0000-000000000002') returns void
language plpgsql as $$
begin
  perform pg_temp.calling(n, 'booking', 'calling_1', 'first', p_user);
  perform settle_call(pg_temp.id(n || '_call'), 'done', '[]',
                      '{"time": "2026-10-24T20:00:00+05:30", "verified": true}', false, pg_temp.at('10:04'));
  insert into t values (n || '_bk', (select id from bookings where request_id = pg_temp.id(n)));
end $$;

-- A move the business didn't clearly confirm: the original stands, with the move beside it.
select pg_temp.booked('m');
select pg_temp.calling('mv', 'reschedule', 'calling_1', 'reschedule', 'a0000000-0000-0000-0000-000000000002');
update requests set booking_id = pg_temp.id('m_bk') where id = pg_temp.id('mv');
select settle_call(pg_temp.id('mv_call'), 'done', '[]',
                   '{"time": "2026-10-24T21:00:00+05:30", "verified": false, "problems": ["unclear"]}', false, pg_temp.at('10:05'));
select results_eq($$select status, pending_change ->> 'kind' from bookings where id = pg_temp.id('m_bk')$$,
                  $$values ('booked'::text, 'move'::text)$$, 'the original stands, the move pending');
select is((select replaces_booking_id from bookings where request_id = pg_temp.id('mv')), pg_temp.id('m_bk'),
          'and the new row says what it would replace');
select is((select status from bookings where request_id = pg_temp.id('mv')), 'probably_booked', 'which is not known either');

-- A cancel that didn't clearly go through leaves it standing, with the cancel pending.
select pg_temp.booked('k');
select pg_temp.calling('kc', 'cancel', 'calling_1', 'cancel', 'a0000000-0000-0000-0000-000000000002');
update requests set booking_id = pg_temp.id('k_bk') where id = pg_temp.id('kc');
select settle_call(pg_temp.id('kc_call'), 'unconfirmed', '[]', '{"said": "ok ok"}', false, pg_temp.at('10:06'));
select results_eq($$select status, pending_change ->> 'kind' from bookings where id = pg_temp.id('k_bk')$$,
                  $$values ('booked'::text, 'cancel'::text)$$, 'a pending cancel doesn''t change what is known');

-- A charge stated with no amount is still a charge.
select pg_temp.booked('f');
select pg_temp.calling('fc', 'cancel', 'calling_1', 'cancel', 'a0000000-0000-0000-0000-000000000002');
update requests set booking_id = pg_temp.id('f_bk') where id = pg_temp.id('fc');
select settle_call(pg_temp.id('fc_call'), 'back', '[]', '{"fee_rs": null, "charge_stated": true}', false, pg_temp.at('10:07'));
select results_eq($$select charge_stated, known_fee_rs from bookings where id = pg_temp.id('f_bk')$$,
                  $$values (true, null::numeric)$$, 'stated, and no amount known');
select cancel_request(pg_temp.id('fc'), pg_temp.at('10:07'));

-- Conditions -------------------------------------------------------------------------------
select pg_temp.calling('d', 'booking', 'calling_1', 'first', 'a0000000-0000-0000-0000-000000000002');
select settle_call(pg_temp.id('d_call'), 'done', '[]',
  '{"time": "2026-10-24T20:00:00+05:30", "verified": false, "problems": ["condition: cover charge"], "decision_open": true,
    "conditions": [{"words": "Rs 500 cover per head", "what": "cover charge", "required": true, "covered": false},
                   {"words": "valet is Rs 100 if you want it", "what": "valet", "required": false, "covered": false}]}',
  false, pg_temp.at('10:08'));
insert into t values ('d_bk', (select id from bookings where request_id = pg_temp.id('d')));
select results_eq($$select status, decision_open, jsonb_array_length(conditions) from bookings where id = pg_temp.id('d_bk')$$,
                  $$values ('probably_booked'::text, true, 2)$$, 'a required condition waits on the user, with all of them kept');
select is(accept_condition(pg_temp.id('d_bk'), 'a0000000-0000-0000-0000-000000000001', '{"evidence": "fine"}', pg_temp.at('10:09')) ->> 'reason',
          'no_booking', 'only their own');
select is(accept_condition(pg_temp.id('d_bk'), 'a0000000-0000-0000-0000-000000000002', '{"evidence": "fine"}', pg_temp.at('10:10')) ->> 'ok',
          'true', 'they accept it');
select results_eq($$select status, decision_open, decision_basis ->> 'evidence' from bookings where id = pg_temp.id('d_bk')$$,
                  $$values ('booked'::text, false, 'fine'::text)$$, 'and it is booked, with what they said');
select is(accept_condition(pg_temp.id('d_bk'), 'a0000000-0000-0000-0000-000000000002', '{}', pg_temp.at('10:11')) ->> 'reason',
          'no_decision', 'once');

-- A booking the Desk couldn't confirm can be cancelled, not moved.
select pg_temp.calling('u', 'booking', 'calling_1', 'first', 'a0000000-0000-0000-0000-000000000002');
select settle_call(pg_temp.id('u_call'), 'done', '[]', '{"time": "2026-10-24T20:00:00+05:30", "verified": false}', false, pg_temp.at('10:12'));
insert into t values ('u_bk', (select id from bookings where request_id = pg_temp.id('u')));
insert into t values ('rc', (queue_request('a0000000-0000-0000-0000-000000000002', 'cancel', pg_temp.at('10:13')) ->> 'request_id')::uuid);
select is(set_request_booking(pg_temp.id('rc'), pg_temp.id('u_bk'), pg_temp.at('10:14')) ->> 'ok', 'true', 'it can be cancelled');
insert into t values ('rr', (queue_request('a0000000-0000-0000-0000-000000000002', 'reschedule', pg_temp.at('10:15')) ->> 'request_id')::uuid);
select is(set_request_booking(pg_temp.id('rr'), pg_temp.id('u_bk'), pg_temp.at('10:16')) ->> 'reason', 'booking_not_active', 'not moved');

select * from finish();
rollback;
