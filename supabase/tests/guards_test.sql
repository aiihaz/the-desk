-- Guards: check_dial() and reserve_call() (eng plan 5.1, test plan "Guards").
-- Clock: Friday 2026-10-23 in IST. Paragon is open 11:00 to 01:00 every day.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, day text default '2026-10-23') returns timestamptz
language sql as $$ select (day || ' ' || hhmm || ':00+05:30')::timestamptz $$;

create function pg_temp.reason(res jsonb) returns text
language sql as $$ select coalesce(res ->> 'reason', 'ok') $$;

create function pg_temp.new_request(p_user uuid, p_business uuid, p_consent boolean default true)
returns uuid language plpgsql as $$
declare
  rid uuid;
  f   jsonb := '{"party_size": 4, "window_start": "2026-10-23T19:30:00+05:30",
                 "window_end": "2026-10-23T21:00:00+05:30"}';
begin
  -- One active request per user (0004): earlier fixtures step aside. check_dial()
  -- doesn't read the state, so they stay usable.
  update requests set state = 'done' where user_id = p_user and state = 'awaiting_yes';
  insert into requests (user_id, task, state, fields, business_id)
  values (p_user, 'booking', 'awaiting_yes', f, p_business) returning id into rid;
  if p_consent then
    insert into consents (request_id, kind, text_shown, fields_hash)
    values (rid, 'ask', 'read-back', fields_hash(f));
  end if;
  return rid;
end $$;

create function pg_temp.new_option(p_request uuid, p_created timestamptz, p_consent boolean default true)
returns uuid language plpgsql as $$
declare
  oid uuid;
begin
  insert into options (request_id, label, value, created_at)
  values (p_request, '9:30 pm', '{"time": "2026-10-23T21:30:00+05:30", "party_size": 4}', p_created)
  returning id into oid;
  if p_consent then
    insert into consents (request_id, kind, option_id, text_shown, fields_hash)
    values (p_request, 'book', oid, 'Reply 1 to book 9:30 pm', 'n/a');
  end if;
  return oid;
end $$;

-- Fixture
insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz',  '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha',  '+919800000002');

insert into businesses (id, place_id, phone_e164, name, city, source, opening_hours)
select 'b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places',
       jsonb_build_object('periods', jsonb_agg(jsonb_build_object(
         'open',  jsonb_build_object('day', d, 'hour', 11, 'minute', 0),
         'close', jsonb_build_object('day', (d + 1) % 7, 'hour', 1, 'minute', 0))))
  from generate_series(0, 6) d;
insert into businesses (id, place_id, phone_e164, name, source) values
  ('b0000000-0000-0000-0000-000000000002', 'places/nohours', '+914952700002', 'No Hours Cafe', 'places'),
  ('b0000000-0000-0000-0000-000000000003', null,             '+919800000099', 'Friend playing a shop', 'user');
insert into test_numbers (phone_e164, name) values ('+919800000099', 'Friend');

insert into caller_numbers (id, e164, provider, a2p_declared_at, created_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', '2026-10-01', '2026-10-01'),
  ('c0000000-0000-0000-0000-000000000002', '+918000000002', 'sarvam', null,         '2026-10-02');

insert into credit_ledger (delta_rs, reason) values (500, 'top-up');
insert into gate_passes (agent_version, suite, passed) values ('v1', 'sarvam-tests', true);
select set_limit('active_agent_version', '"v1"', 'test');

-- Happy path ---------------------------------------------------------------
create temp table t (name text primary key, id uuid);
insert into t values ('r1', pg_temp.new_request('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'));

select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'ok', 'consented request to an open business passes');
select is(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00')) ->> 'caller_number_id',
          'c0000000-0000-0000-0000-000000000001', 'an undeclared number is never chosen for a real business');
select is(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00')) -> 'flags',
          '[]'::jsonb, 'no flags when hours are known');

-- Consent ------------------------------------------------------------------
insert into t values ('r_nocons', pg_temp.new_request('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', false));
select is(pg_temp.reason(check_dial((select id from t where name = 'r_nocons'), 'first', null, false, pg_temp.at('19:00'))),
          'no_consent', 'no consent #1 → availability call refused');

insert into t values ('r_edit', pg_temp.new_request('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'));
update requests set fields = fields || '{"party_size": 6}' where id = (select id from t where name = 'r_edit');
select is(pg_temp.reason(check_dial((select id from t where name = 'r_edit'), 'first', null, false, pg_temp.at('19:00'))),
          'fields_changed', 'fields changed after YES → refused');

insert into t values ('o_nocons', pg_temp.new_option((select id from t where name = 'r1'), pg_temp.at('18:50'), false));
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_nocons'), false, pg_temp.at('19:00'))),
          'no_consent', 'no consent #2 → booking call refused');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'booking', null, false, pg_temp.at('19:00'))),
          'no_option', 'booking call without an option refused');

insert into t values ('o_fresh', pg_temp.new_option((select id from t where name = 'r1'), pg_temp.at('18:50')));
select is(check_dial((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('19:00')),
          jsonb_build_object('ok', true, 'caller_number_id', 'c0000000-0000-0000-0000-000000000001',
                             'agent_version', 'v1', 'must_reask', false, 'flags', '[]'::jsonb),
          'picked option with consent #2 → booking call allowed, no re-ask');

insert into t values ('o_stale', pg_temp.new_option((select id from t where name = 'r1'), pg_temp.at('17:30')));
select is((check_dial((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_stale'), false, pg_temp.at('19:00')) ->> 'must_reask')::boolean,
          true, 'stale option → booking call must re-ask');

insert into t values ('r_other', pg_temp.new_request('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001'));
select is(pg_temp.reason(check_dial((select id from t where name = 'r_other'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('19:00'))),
          'no_option', 'an option from another request cannot be booked');

-- Opt-outs and blocks ------------------------------------------------------
insert into opt_outs (phone_e164, source) values ('+914952700001', 'call');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'opted_out', 'opted-out business refused');
-- The opt-out was heard on number 1; a request pinned to a different declared number is refused too.
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000003', '+918000000003', 'sarvam', '2026-10-01');
insert into t values ('r_pinned', pg_temp.new_request('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001'));
update requests set caller_number_id = 'c0000000-0000-0000-0000-000000000003' where id = (select id from t where name = 'r_pinned');
select is(pg_temp.reason(check_dial((select id from t where name = 'r_pinned'), 'first', null, false, pg_temp.at('19:00'))),
          'opted_out', 'an opt-out applies on every caller number');
delete from opt_outs;
update caller_numbers set active = false where id = 'c0000000-0000-0000-0000-000000000003';

insert into user_blocks values ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'user_block', 'a place the user blocked is refused');
select is(pg_temp.reason(check_dial((select id from t where name = 'r_other'), 'first', null, false, pg_temp.at('19:00'))),
          'ok', 'one user''s block does not affect another user');
delete from user_blocks;

update users set blocked = true where id = 'a0000000-0000-0000-0000-000000000001';
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'user_blocked', 'a blocked user cannot dial');
update users set blocked = false;

-- Timing -------------------------------------------------------------------
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('09:00'))),
          'business_closed', 'business closed → refused');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'question', null, false, pg_temp.at('23:30'))),
          'ok', '23:30 call with no calling_window and the business open → allowed');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'question', null, false, pg_temp.at('00:30', '2026-10-25'))),
          'ok', 'Saturday-night hours that run into Sunday count as open');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('21:15'))),
          'too_late', 'availability call after the request window has passed → refused');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('21:40'))),
          'too_late', 'booking call after the picked time has passed → refused');

select set_limit('respect_opening_hours', 'false', 'test');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('09:00'))),
          'ok', 'respect_opening_hours off → closed business allowed');
select set_limit('respect_opening_hours', 'true', 'test');

select set_limit('calling_window', '{"from": "09:00", "to": "21:00"}', 'test');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'question', null, false, pg_temp.at('23:30'))),
          'outside_calling_window', 'calling_window set → enforced');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'question', null, false, pg_temp.at('20:59'))),
          'ok', 'inside calling_window → allowed');
select set_limit('calling_window', 'null', 'test');

select set_limit('provider_blocked_hours', '[{"from": "21:00", "to": "09:00"}]', 'test');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'question', null, false, pg_temp.at('23:30'))),
          'provider_blocked_hours', 'provider blocked hours → refused');
select set_limit('provider_blocked_hours', 'null', 'test');

insert into t values ('r_nohours', pg_temp.new_request('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'));
select is(check_dial((select id from t where name = 'r_nohours'), 'first', null, false, pg_temp.at('19:00')) -> 'flags',
          '["hours_unknown"]'::jsonb, 'unknown hours → allowed and flagged');

-- Caller numbers -----------------------------------------------------------
update caller_numbers set active = false where id = 'c0000000-0000-0000-0000-000000000001';
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'no_caller_number', 'only an undeclared number left → refused for a real business');
insert into t values ('r_tester', pg_temp.new_request('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003'));
select is(check_dial((select id from t where name = 'r_tester'), 'question', null, false, pg_temp.at('19:00')) ->> 'caller_number_id',
          'c0000000-0000-0000-0000-000000000002', 'an undeclared number may call a consenting tester');
update caller_numbers set active = true where id = 'c0000000-0000-0000-0000-000000000001';

-- Kill switch, credit, agent gate -------------------------------------------
select set_limit('kill_switch', 'true', 'test');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'kill_switch', 'stop all → every call refused');
select set_limit('kill_switch', 'false', 'test');

insert into credit_ledger (delta_rs, reason) values (-350, 'calls');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'low_credit', 'credit below min_credit_rs → refused');
insert into credit_ledger (delta_rs, reason) values (350, 'top-up');

select set_limit('active_agent_version', '"v2"', 'test');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'agent_not_gated', 'agent version without a passed test suite → refused');
insert into gate_passes (agent_version, suite, passed) values ('v2', 'sarvam-tests', false);
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'agent_not_gated', 'a failed suite run does not gate the version');
select set_limit('active_agent_version', '"v1"', 'test');

-- reserve_call, sticky numbers, per-request limits ---------------------------
select is(pg_temp.reason(reserve_call((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:00'))),
          'ok', 'reserve_call passes the checks');
select is((select count(*)::int from calls where request_id = (select id from t where name = 'r1')), 1,
          'reserve_call writes the call row');
select is((select caller_number_id from requests where id = (select id from t where name = 'r1')),
          'c0000000-0000-0000-0000-000000000001'::uuid, 'the request is pinned to the first caller number');

-- A fresh declared number with no calls today would win a new choice; call 2 must still use number 1.
update caller_numbers set active = true where id = 'c0000000-0000-0000-0000-000000000003';
select is(reserve_call((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('19:20')) ->> 'caller_number_id',
          'c0000000-0000-0000-0000-000000000001', 'call 2 uses call 1''s number');
select is(check_dial((select id from t where name = 'r_other'), 'first', null, false, pg_temp.at('19:20')) ->> 'caller_number_id',
          'c0000000-0000-0000-0000-000000000003', 'a new request prefers the number with fewest calls to this business');

select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, true, pg_temp.at('19:10'))),
          'retry_too_soon', 'redial before retry_delay_minutes → refused');
select is(pg_temp.reason(reserve_call((select id from t where name = 'r1'), 'first', null, true, pg_temp.at('19:35'))),
          'ok', 'redial after the delay → allowed');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, true, pg_temp.at('20:10'))),
          'limit_retries', 'max_retries_no_answer enforced');
select is(pg_temp.reason(check_dial((select id from t where name = 'r_other'), 'first', null, true, pg_temp.at('19:40'))),
          'nothing_to_retry', 'a retry needs an earlier call');

select is(pg_temp.reason(reserve_call((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:40'))),
          'ok', 'second availability call (re-ask) allowed');
-- r1 now has 4 calls: first, booking, first (retry), first.
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('19:45'))),
          'limit_request', 'max_calls_per_request enforced');
select set_limit('max_calls_per_request', '10', 'test');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'first', null, false, pg_temp.at('19:45'))),
          'limit_availability_calls', 'max_availability_calls_per_request enforced (retries not counted)');
select is(pg_temp.reason(reserve_call((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('19:45'))),
          'ok', 'second booking call (after an alternative) allowed');
select is(pg_temp.reason(check_dial((select id from t where name = 'r1'), 'booking', (select id from t where name = 'o_fresh'), false, pg_temp.at('19:50'))),
          'limit_booking_calls', 'max_booking_calls_per_request enforced');
select set_limit('max_calls_per_request', '4', 'test');

-- Per-user daily limit and overrides (user 1 has 5 calls today) -------------
select set_limit('max_calls_per_user_per_day', '5', 'test');
insert into t values ('r2', pg_temp.new_request('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'));
select is(pg_temp.reason(check_dial((select id from t where name = 'r2'), 'first', null, false, pg_temp.at('19:50'))),
          'limit_user_day', 'max_calls_per_user_per_day enforced');
select is(pg_temp.reason(check_dial((select id from t where name = 'r2'), 'question', null, false, pg_temp.at('00:10', '2026-10-24'))),
          'ok', 'the daily count resets at midnight IST');
select set_limit('max_calls_per_user_per_day', '20', 'test', 'a0000000-0000-0000-0000-000000000001');
select is(pg_temp.reason(check_dial((select id from t where name = 'r2'), 'first', null, false, pg_temp.at('19:50'))),
          'ok', 'per-user override wins over the global limit');
select set_limit('max_calls_per_user_per_day', '10', 'test');

-- Per-business limits (Paragon has 5 calls today, all from number 1) --------
select is(pg_temp.reason(check_dial((select id from t where name = 'r_other'), 'first', null, false, pg_temp.at('19:50'))),
          'ok', 'null business limit → no limit');
select set_limit('max_calls_per_business_per_number_per_day', '5', 'test');
select is(check_dial((select id from t where name = 'r_other'), 'first', null, false, pg_temp.at('19:50')) ->> 'caller_number_id',
          'c0000000-0000-0000-0000-000000000003', 'per-number business limit: another number can still call');
update caller_numbers set active = false where id = 'c0000000-0000-0000-0000-000000000003';
select is(pg_temp.reason(check_dial((select id from t where name = 'r_other'), 'first', null, false, pg_temp.at('19:50'))),
          'limit_business_number_day', 'max_calls_per_business_per_number_per_day enforced');
select set_limit('max_calls_per_business_per_number_per_day', 'null', 'test');

-- Two requests racing one business: the limit lets only one through.
select set_limit('max_calls_per_business_per_day', '6', 'test');
insert into t values ('r_race', pg_temp.new_request('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001'));
select is(pg_temp.reason(reserve_call((select id from t where name = 'r_other'), 'first', null, false, pg_temp.at('19:55'))),
          'ok', 'first of two racing requests gets the last slot');
select is(pg_temp.reason(reserve_call((select id from t where name = 'r_race'), 'first', null, false, pg_temp.at('19:55'))),
          'limit_business_day', 'second racing request is refused');

select * from finish();
rollback;
