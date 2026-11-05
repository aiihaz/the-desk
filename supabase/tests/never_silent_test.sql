-- 0024 (0017 on main): a call report that can't be written yet is told as late, once, on its own; and a
-- number recorded as wrong can be looked up before a plan is made for it.
-- Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-10-23 ' || hhmm || ':00+05:30')::timestamptz $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places'),
  ('b0000000-0000-0000-0000-000000000002', 'places/rahmath', '+914952700003', 'Rahmath', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());
insert into requests (id, user_id, task, state, business_id, caller_number_id, created_at, updated_at)
values ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'booking', 'queued',
        'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
        pg_temp.at('10:00'), pg_temp.at('10:00'));
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
values ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000001', 'first', '7', 'completed', pg_temp.at('10:01'));
insert into deliveries (id, user_id, request_id, call_id, dedupe_key, kind, facts, created_at, next_attempt_at)
values ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
        'd0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
        'call:e0000000-0000-0000-0000-000000000001:report', 'report',
        '{"event": "call_result", "place": "Paragon", "happened": {"status": "options_offered"}, "values": {}}',
        pg_temp.at('10:02'), pg_temp.at('10:02'));

create function pg_temp.fail_once(hhmm text) returns void
language sql as $$
  select take_unwritten(pg_temp.at(hhmm), 20, 'e0000000-0000-0000-0000-000000000001');
  select delivery_unwritten('f0000000-0000-0000-0000-000000000001', 'draft refused', pg_temp.at(hhmm));
$$;

-- A stalled report ------------------------------------------------------------------
select pg_temp.fail_once('10:02');
select is((select count(*)::int from deliveries where kind = 'notice'), 0, 'one failed write: nothing yet');

select pg_temp.fail_once('10:05');
select results_eq(
  $$select facts ->> 'event', facts ->> 'place', call_id is null, message is null
      from deliveries where kind = 'notice'$$,
  $$values ('call_report_delayed', 'Paragon', true, true)$$,
  'a second failed write owes them a notice, to be written, outside the call''s sequence');
select is((select status from deliveries where id = 'f0000000-0000-0000-0000-000000000001'), 'pending',
          'the report itself is still owed');

select pg_temp.fail_once('10:12');
select pg_temp.fail_once('10:30');
select is((select count(*)::int from deliveries where kind = 'notice'), 1, 'told once, however many fail');

select is(jsonb_array_length(take_unwritten(pg_temp.at('10:31'))), 1,
          'the notice is written like any other message');

-- A wrong number --------------------------------------------------------------------
insert into wrong_numbers (user_id, business_id, phone_e164)
values ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', '+914952700001');
select is(wrong_number_for('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
          true, 'the number that reached someone else is known as wrong');
select is(wrong_number_for('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002'),
          false, 'another place is not');
update businesses set phone_e164 = '+914952700002' where id = 'b0000000-0000-0000-0000-000000000001';
select is(wrong_number_for('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
          false, 'a new number for the business clears it');

select * from finish();
rollback;
