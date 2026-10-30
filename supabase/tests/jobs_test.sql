-- 0009 jobs and 0010 admin functions. Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, d text default '2026-10-23') returns timestamptz
language sql as $$ select (d || ' ' || hhmm || ':00+05:30')::timestamptz $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now()),
  ('c1000000-0000-0000-0000-000000000002', '+918000000002', 'sarvam', null);

create temp table t (name text primary key, id uuid);

-- A request after call 1 with two options offered at 18:00.
insert into t values ('r1', (start_request('a0000000-0000-0000-0000-000000000001', 'booking', pg_temp.at('17:50')) ->> 'request_id')::uuid);
update requests set state = 'calling_1', business_id = 'b0000000-0000-0000-0000-000000000001' where id = (select id from t where name = 'r1');
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at, transcript)
select 'd0000000-0000-0000-0000-000000000001', id, 'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-000000000001', 'first', 'v1', 'completed', pg_temp.at('17:58'), '[{"role": "user", "en_text": "hi"}]'
  from t where name = 'r1';
select settle_call('d0000000-0000-0000-0000-000000000001', 'options',
                   '[{"label": "8:30 pm", "value": {}}, {"label": "9:15 pm", "value": {}}]', p_now => pg_temp.at('18:00'));
update options set created_at = pg_temp.at('18:00') where request_id = (select id from t where name = 'r1');

-- Stale options -------------------------------------------------------------------
select is(mark_stale_options(pg_temp.at('18:59')), 0, 'within option_hold_minutes: nothing goes stale');
select is(mark_stale_options(pg_temp.at('19:00')), 1, 'at the hold time the request goes stale');
select is((select state from requests where id = (select id from t where name = 'r1')), 'stale_options',
          'shown as stale_options');
select is((select count(*)::int from options where request_id = (select id from t where name = 'r1') and stale_at is not null), 2,
          'both options are stale, so call 2 must re-ask');
select is(mark_stale_options(pg_temp.at('19:30')), 0, 'and nothing is marked twice');

-- Timeout -------------------------------------------------------------------------
insert into t values ('r2', (start_request('a0000000-0000-0000-0000-000000000002', 'booking', pg_temp.at('17:00')) ->> 'request_id')::uuid);
insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, provider_call_id, created_at)
select 'd0000000-0000-0000-0000-000000000002', id, 'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-000000000001', 'first', 'v1', 'dialing', 'att-2', pg_temp.at('17:05')
  from t where name = 'r2';
select is(timeout_call('d0000000-0000-0000-0000-000000000002', pg_temp.at('19:10')), true, 'an open call times out');
select is((select status || ' ' || outcome from calls where id = 'd0000000-0000-0000-0000-000000000002'), 'timeout no_result',
          'stored as timeout, no result');
select is((select kind || ' ' || (detail ->> 'attempt_id') from alerts where call_id = 'd0000000-0000-0000-0000-000000000002'),
          'call_lost att-2', 'and flagged with the attempt id');
select is(timeout_call('d0000000-0000-0000-0000-000000000002', pg_temp.at('19:20')), false, 'a closed call is left alone');
select is(timeout_call('d0000000-0000-0000-0000-000000000001', pg_temp.at('19:20')), false, 'so is one with a result');

-- Retention -----------------------------------------------------------------------
insert into webhook_events (source, external_id, payload, received_at) values
  ('sarvam', 'old', '{}', pg_temp.at('10:00', '2026-07-01')),
  ('sarvam', 'new', '{}', pg_temp.at('10:00'));
update calls set created_at = pg_temp.at('17:58', '2026-07-01') where id = 'd0000000-0000-0000-0000-000000000001';
select is(purge_old_data(pg_temp.at('12:00')), '{"transcripts": 1, "webhook_events": 1}'::jsonb,
          'transcripts and raw payloads older than 90 days go');
select is((select status || ' ' || (transcript is null) from calls where id = 'd0000000-0000-0000-0000-000000000001'),
          'completed true', 'the call row stays, without its transcript');
select is((select count(*)::int from webhook_events where external_id = 'new'), 1, 'recent payloads stay');

-- Admin ---------------------------------------------------------------------------
select is((admin_status(pg_temp.at('19:30')) ->> 'open_alerts')::int, 1, 'status counts the open alert');
select is((admin_status(pg_temp.at('19:30')) -> 'calls_today' ->> 'timeout')::int, 1, 'and today''s calls by status');
select is(resolve_alert('zz', 'test') ->> 'reason', 'not_found', 'too short a prefix matches nothing');
select is(resolve_alert(left((select id::text from alerts limit 1), 6), '919800000001', pg_temp.at('19:31')) ->> 'ok', 'true',
          'resolve by id prefix');
select is((select resolved_by from alerts limit 1), '919800000001', 'and who resolved it is kept');
select is(set_caller_number_active('c', false) ->> 'reason', 'not_found', 'a 1-character ref matches nothing');
select is(set_caller_number_active('c', false) ->> 'ok', 'false', 'so nothing changes');
select is(set_caller_number_active('+918000000001', false) ->> 'active', 'false', 'number off by E.164');
select is(set_caller_number_active('c100', true) ->> 'e164', '+918000000002', 'number on by id prefix');
select is(jsonb_array_length(caller_numbers_today(pg_temp.at('19:30'))), 2, 'numbers lists every caller number');
select is(add_credit(500, '919800000001'), 500::numeric, 'credit adds a top-up and returns the balance');
select throws_ok($$select add_credit(-5, 'x')$$, '22023', null, 'a negative top-up is refused');
select is(admin_opt_out('+914952700009'), true, 'optout records the number');
select is(admin_opt_out('+914952700009'), false, 'twice is a no-op');
select is((select source from opt_outs where phone_e164 = '+914952700009'), 'admin', 'with the admin as source');
select is(mark_alerts_notified(array(select id from alerts)), 1, 'alerts are marked notified once');
select is(mark_alerts_notified(array(select id from alerts)), 0, 'and not again');

select * from finish();
rollback;
