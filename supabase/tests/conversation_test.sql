-- 0007: errands that wait instead of replacing, consents with their basis, and a finished
-- call settling its request (settle_call). Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-10-23 ' || hhmm || ':00+05:30')::timestamptz $$;

create function pg_temp.reason(res jsonb) returns text
language sql as $$ select coalesce(res ->> 'reason', 'ok') $$;

create function pg_temp.state(p_id uuid) returns text
language sql as $$ select state from requests where id = p_id $$;

-- A question for Paragon with its plan open as prompt p_prompt.
create function pg_temp.ready(p_user uuid, p_prompt uuid, p_now timestamptz) returns uuid
language plpgsql as $$
declare
  rid uuid;
begin
  rid := (start_request(p_user, 'question', p_now) ->> 'request_id')::uuid;
  perform update_slots(rid, '{"questions": ["Do you dry clean blazers?"]}', p_now);
  perform set_request_business(rid, 'b0000000-0000-0000-0000-000000000001', p_now);
  perform advance_request(rid, 'confirming', p_now);
  perform open_prompt(p_prompt, rid, 'ask', '{}', 'yes', 'plan', '{}', p_now);
  return rid;
end $$;

-- A call row for a request in calling_1, as reserve_call would leave it.
create function pg_temp.call(p_request uuid, p_kind text, p_now timestamptz) returns uuid
language sql as $$
  insert into calls (request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  select r.id, r.user_id, r.business_id, 'c0000000-0000-0000-0000-000000000001', p_kind, 'v1', 'in_progress', p_now
    from requests r where r.id = p_request
  returning id
$$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002'),
  ('a0000000-0000-0000-0000-000000000003', '919800000003', 'Ravi', '+919800000003');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());

create temp table t (name text primary key, id uuid);
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from t where name = p_name $$;

-- Errands wait instead of replacing -------------------------------------------
insert into t values ('laundry', pg_temp.ready('a0000000-0000-0000-0000-000000000001',
                                               'e0000000-0000-0000-0000-000000000001', pg_temp.at('18:00')));
insert into t values ('dental', (queue_request('a0000000-0000-0000-0000-000000000001', 'booking', pg_temp.at('18:01')) ->> 'request_id')::uuid);
select is(pg_temp.state(pg_temp.id('dental')), 'queued', 'a second errand waits behind the first');
select is(pg_temp.state(pg_temp.id('laundry')), 'awaiting_yes', 'the first errand and its plan are untouched');
select is((select closed_at from consent_prompts where id = 'e0000000-0000-0000-0000-000000000001'), null,
          'its plan is still open');
select is(pg_temp.reason(update_slots(pg_temp.id('dental'), '{"service": "dental checkup"}', pg_temp.at('18:02'))),
          'ok', 'the waiting errand collects details');

-- The queue has a limit.
select set_limit('max_queued_requests', '1', 'test');
select is(pg_temp.reason(queue_request('a0000000-0000-0000-0000-000000000001', 'question', pg_temp.at('18:03'))),
          'queue_full', 'past max_queued_requests, a further errand is refused');
select set_limit('max_queued_requests', '3', 'test');

-- Replacing the current errand doesn't drop the one waiting.
insert into t values ('laundry2', (start_request('a0000000-0000-0000-0000-000000000001', 'question', pg_temp.at('18:04')) ->> 'request_id')::uuid);
select is(pg_temp.state(pg_temp.id('laundry')), 'cancelled', 'replace ends the current errand');
select is(pg_temp.state(pg_temp.id('dental')), 'queued', 'the waiting errand is kept');

-- With nothing current, a queued errand starts at once.
select is(queue_request('a0000000-0000-0000-0000-000000000002', 'question', pg_temp.at('18:05')) ->> 'state',
          'collecting', 'with nothing current, the errand starts now');

-- Consents carry their basis --------------------------------------------------
insert into t values ('q1', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                          'e0000000-0000-0000-0000-000000000003', pg_temp.at('18:10')));
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000003', null, 'yes', 'wamid.3',
                                        pg_temp.at('18:11'), '{"evidence": "haan kar do"}')),
          'ok', 'a consent is stored with what it was read from');
select is((select basis ->> 'evidence' from consents where request_id = pg_temp.id('q1')), 'haan kar do',
          'the approving words are kept with the consent');
select is(pg_temp.state(pg_temp.id('q1')), 'calling_1', 'and the request moves to calling');
-- The old five-argument form still works (no basis).
insert into t values ('q2', pg_temp.ready('a0000000-0000-0000-0000-000000000002',
                                          'e0000000-0000-0000-0000-000000000004', pg_temp.at('18:12')));
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000004', null, 'yes', 'wamid.4', pg_temp.at('18:13'))),
          'ok', 'a consent without a basis is still accepted');

-- A finished call settles its request -----------------------------------------
-- No answer: back to the user, the approval spent.
insert into t values ('c1', pg_temp.call(pg_temp.id('q1'), 'question', pg_temp.at('18:12')));
select is(settle_call(pg_temp.id('c1'), 'back', p_now => pg_temp.at('18:14')) ->> 'state', 'confirming',
          'no usable result: the errand goes back to the user');
select is((select count(*)::int from consents where request_id = pg_temp.id('q1') and voided_at is null), 0,
          'the approval is spent: calling again needs a new one');
select is((select void_reason from consents where request_id = pg_temp.id('q1')), 'call_ended',
          'voided because the call ended');
select is(pg_temp.reason(settle_call(pg_temp.id('c1'), 'done', p_now => pg_temp.at('18:15'))), 'not_calling',
          'a redelivered result changes nothing');
select is(pg_temp.state(pg_temp.id('q1')), 'confirming', 'still back with the user');

-- Done, with what they said was booked.
update requests set state = 'calling_1' where id = pg_temp.id('q2');
insert into t values ('c2', pg_temp.call(pg_temp.id('q2'), 'first', pg_temp.at('18:16')));
select is(settle_call(pg_temp.id('c2'), 'done', '[]', '{"time": "2026-10-23T20:00:00+05:30", "reference": "T12"}',
                      false, pg_temp.at('18:17')) ->> 'state', 'done', 'a booking they confirmed ends the errand');
select is((select status || ' ' || reference from bookings where request_id = pg_temp.id('q2')), 'probably_booked T12',
          'stored as probably booked until verification (eng plan 3.5)');

-- Options: they become the request's options, after call 1.
insert into t values ('b1', (start_request('a0000000-0000-0000-0000-000000000003', 'booking', pg_temp.at('18:20')) ->> 'request_id')::uuid);
update requests set state = 'calling_1', business_id = 'b0000000-0000-0000-0000-000000000001' where id = pg_temp.id('b1');
insert into t values ('c3', pg_temp.call(pg_temp.id('b1'), 'first', pg_temp.at('18:21')));
select is(jsonb_array_length(settle_call(pg_temp.id('c3'), 'options',
                                         '[{"label": "8:30 pm", "value": {"time": "2026-10-23T20:30:00+05:30"}},
                                           {"label": "9:15 pm", "value": {}, "advance_required": true}]',
                                         p_now => pg_temp.at('18:22')) -> 'option_ids'), 2,
          'other times offered become options');
select is(pg_temp.state(pg_temp.id('b1')), 'options_ready', 'and the errand waits for a pick');
select is((select count(*)::int from options where request_id = pg_temp.id('b1') and voided_at is null and advance_required), 1,
          'an option that needs an advance is marked');
select throws_ok($$select settle_call(pg_temp.id('c3'), 'options', '[]')$$, '22023', null,
                 'an options result needs options');

-- An opt-out is recorded even when the request has moved on.
select settle_call(pg_temp.id('c1'), 'back', p_opt_out => true, p_now => pg_temp.at('18:30'));
select is((select source from opt_outs where phone_e164 = '+914952700001'), 'call',
          'the business asked not to be called: recorded for every caller number');

select * from finish();
rollback;
