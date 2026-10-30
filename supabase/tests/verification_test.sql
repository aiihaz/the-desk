-- 0008: a booking is stored as booked only when verified (eng plan 3.5); otherwise
-- probably_booked with an alert for review. Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-10-23 ' || hhmm || ':00+05:30')::timestamptz $$;

-- A booking request for Paragon in calling_1, and its call.
create function pg_temp.calling(p_user uuid, p_now timestamptz) returns uuid
language plpgsql as $$
declare
  rid uuid;
  cid uuid;
begin
  rid := (start_request(p_user, 'booking', p_now) ->> 'request_id')::uuid;
  update requests set state = 'calling_1', business_id = 'b0000000-0000-0000-0000-000000000001' where id = rid;
  insert into calls (request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  values (rid, p_user, 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
          'first', 'v1', 'in_progress', p_now)
  returning id into cid;
  return cid;
end $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002'),
  ('a0000000-0000-0000-0000-000000000003', '919800000003', 'Ravi', '+919800000003');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());

create temp table t (name text primary key, id uuid);
insert into t values ('ok',      pg_temp.calling('a0000000-0000-0000-0000-000000000001', pg_temp.at('18:00')));
insert into t values ('unsure',  pg_temp.calling('a0000000-0000-0000-0000-000000000002', pg_temp.at('18:00')));
insert into t values ('legacy',  pg_temp.calling('a0000000-0000-0000-0000-000000000003', pg_temp.at('18:00')));

-- Verified ---------------------------------------------------------------------
select is(settle_call((select id from t where name = 'ok'), 'done', '[]',
                      '{"time": "2026-10-23T20:00:00+05:30", "reference": "T12", "verified": true, "problems": []}',
                      false, pg_temp.at('18:05')) ->> 'state', 'done', 'a verified booking ends the errand');
select is((select status from bookings where call_id = (select id from t where name = 'ok')), 'booked',
          'verified → booked');
select is((select verified from calls where id = (select id from t where name = 'ok')), true,
          'the call is marked verified');
select is((select count(*)::int from alerts where call_id = (select id from t where name = 'ok')), 0,
          'and nothing is flagged');

-- Not verified -----------------------------------------------------------------
select settle_call((select id from t where name = 'unsure'), 'done', '[]',
                   '{"time": "2026-10-23T20:00:00+05:30", "verified": false, "problems": ["transcript: unclear"]}',
                   false, pg_temp.at('18:06'));
select is((select status from bookings where call_id = (select id from t where name = 'unsure')), 'probably_booked',
          'not verified → probably booked');
select is((select verified from calls where id = (select id from t where name = 'unsure')), false,
          'the call is marked unverified');
select is((select kind || ' ' || (detail -> 'problems' ->> 0) from alerts
            where call_id = (select id from t where name = 'unsure')),
          'booking_unverified transcript: unclear', 'flagged for review with the problems');
select is((select count(*)::int from alerts where resolved_at is null), 1, 'one open alert');

-- A booking with no verification at all is never booked ------------------------
select settle_call((select id from t where name = 'legacy'), 'done', '[]',
                   '{"time": "2026-10-23T20:00:00+05:30"}', false, pg_temp.at('18:07'));
select is((select status from bookings where call_id = (select id from t where name = 'legacy')), 'probably_booked',
          'no verified flag → probably booked');

select * from finish();
rollback;
