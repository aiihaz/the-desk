-- 0023: how long a call transcript is kept, and that every copy goes. Clock: IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, d text default '2026-11-04') returns timestamptz
language sql as $$ select (d || ' ' || hhmm || ':00+05:30')::timestamptz $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001');
insert into businesses (id, place_id, phone_e164, name, city, state, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'Kerala', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());

-- r1 question, no booking. r2 booking for 5 Nov 20:00. r3 reschedules r2's booking to
-- 7 Nov 19:00. r4 booking that was cancelled. r5 a call still in progress.
insert into requests (id, user_id, task, state) values
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'question', 'done'),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'booking', 'done'),
  ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'reschedule', 'done'),
  ('e0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'booking', 'done'),
  ('e0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'booking', 'done');

insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status,
                   provider_call_id, created_at, transcript)
select ('d0000000-0000-0000-0000-00000000000' || n)::uuid, ('e0000000-0000-0000-0000-00000000000' || n)::uuid,
       'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-000000000001', case when n = 3 then 'reschedule' else 'first' end, '3',
       case when n = 5 then 'in_progress' else 'completed' end, 'att-' || n, pg_temp.at('10:00'),
       '[{"role": "agent", "en_text": "Hello"}, {"role": "user", "en_text": "Yes, 8 is fine"}]'
  from generate_series(1, 5) n;

insert into bookings (id, request_id, call_id, status, time) values
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   'moved', pg_temp.at('20:00', '2026-11-05')),
  ('f0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004',
   'cancelled', pg_temp.at('20:00', '2026-11-05'));
update bookings set created_at = pg_temp.at('10:01');
update requests set booking_id = 'f0000000-0000-0000-0000-000000000002' where id = 'e0000000-0000-0000-0000-000000000003';
insert into bookings (request_id, call_id, status, time, created_at) values
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'booked',
   pg_temp.at('19:00', '2026-11-07'), pg_temp.at('11:00'));

select is(transcript_until('d0000000-0000-0000-0000-000000000001'), pg_temp.at('10:00', '2026-11-06'),
          'no event: 48 hours after the call');
select is(transcript_until('d0000000-0000-0000-0000-000000000002'), pg_temp.at('07:00', '2026-11-08'),
          'a moved booking: 12 hours after the new time, for the original call too');
select is(transcript_until('d0000000-0000-0000-0000-000000000003'), pg_temp.at('07:00', '2026-11-08'),
          'and for the reschedule call');
select is(transcript_until('d0000000-0000-0000-0000-000000000004'), pg_temp.at('10:00', '2026-11-06'),
          'a cancelled booking is no event: 48 hours after the call');

update bookings set time = null, booked_on = '2026-11-09' where request_id = 'e0000000-0000-0000-0000-000000000003';
select is(transcript_until('d0000000-0000-0000-0000-000000000003'), pg_temp.at('12:00', '2026-11-10'),
          'a date with no time: 12 hours after that day ends');
update bookings set time = pg_temp.at('19:00', '2026-11-07'), booked_on = null
 where request_id = 'e0000000-0000-0000-0000-000000000003';

select is(jsonb_array_length(user_transcripts('a0000000-0000-0000-0000-000000000001', pg_temp.at('12:00'))), 5,
          'every call with a transcript is listed while kept');
select is(user_transcripts('a0000000-0000-0000-0000-000000000001', pg_temp.at('12:00')) -> 0 ->> 'place', 'Paragon',
          'with its place');

-- Copies of call 1's transcript: raw payload, provider result, report facts, a message.
insert into webhook_events (source, external_id, payload) values
  ('sarvam', 'att-1', '{"interaction_transcript": [{"role": "user", "en_text": "Yes"}], "status": "completed"}');
update calls set provider_result = '{"status": "completed", "transcript": [{"role": "user", "en_text": "Yes"}]}',
                 settled_at = pg_temp.at('10:05')
 where id = 'd0000000-0000-0000-0000-000000000001';
insert into deliveries (user_id, call_id, dedupe_key, kind, facts) values
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'call:1:report', 'report',
   '{"event": "call_result", "call": {"transcript": ["business: Yes"], "caller_noted": {"x": "y"}}}');
insert into messages (user_id, wa_message_id, direction, body, transcript_call_id) values
  ('a0000000-0000-0000-0000-000000000001', 'wamid.t1', 'out', '{"kind": "text", "body": "business: Yes"}',
   'd0000000-0000-0000-0000-000000000001');

select is(purge_transcripts(pg_temp.at('09:59', '2026-11-06')), '{"calls": 0, "messages": 0}'::jsonb,
          'nothing goes before its time');
select is(purge_transcripts(pg_temp.at('10:00', '2026-11-06')), '{"calls": 2, "messages": 1}'::jsonb,
          'at 48 hours, the question call and the cancelled booking''s call go');
select is((select transcript from calls where id = 'd0000000-0000-0000-0000-000000000001'), null, 'the transcript is gone');
select is((select provider_result -> 'transcript' from calls where id = 'd0000000-0000-0000-0000-000000000001'),
          'null'::jsonb, 'and from the provider result');
select is((select payload from webhook_events where external_id = 'att-1'), '{"status": "completed"}'::jsonb,
          'and from the raw payload, which stays for redelivery checks');
select is((select facts -> 'call' from deliveries where dedupe_key = 'call:1:report'), '{"caller_noted": {"x": "y"}}'::jsonb,
          'and from the report facts; what the caller noted stays');
select is((select body ->> 'body' from messages where wa_message_id = 'wamid.t1'), '(Call transcript deleted.)',
          'and from the message that showed it');
select is((select transcript is not null from calls where id = 'd0000000-0000-0000-0000-000000000002'), true,
          'the moved booking''s call is kept');
select is(jsonb_array_length(user_transcripts('a0000000-0000-0000-0000-000000000001', pg_temp.at('10:00', '2026-11-06'))), 2,
          'deleted ones, and one past its time but not yet purged, are no longer listed');

select is(purge_transcripts(pg_temp.at('07:00', '2026-11-08')) ->> 'calls', '2', 'after the new time plus 12 hours, both go');
select is((select count(*)::int from calls where transcript is not null), 1, 'a call still in progress is left alone');
select is(purge_transcripts(pg_temp.at('07:00', '2026-11-09')) ->> 'calls', '0', 'and each call is purged once');

select * from finish();
rollback;
