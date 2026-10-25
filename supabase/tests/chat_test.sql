-- Chat state machine (E4 design 2.5 lifecycle, 2.8 approvals bound to what was shown).
-- Clock: Friday 2026-10-23 in IST. Paragon is open 11:00 to 01:00 every day.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, day text default '2026-10-23') returns timestamptz
language sql as $$ select (day || ' ' || hhmm || ':00+05:30')::timestamptz $$;

create function pg_temp.reason(res jsonb) returns text
language sql as $$ select coalesce(res ->> 'reason', 'ok') $$;

create function pg_temp.state(p_id uuid) returns text
language sql as $$ select state from requests where id = p_id $$;

create function pg_temp.ver(p_id uuid) returns int
language sql as $$ select version from requests where id = p_id $$;

-- A booking request for 4, 7:30-9 pm tonight at Paragon, in awaiting_yes with its read-back open.
create function pg_temp.ready(p_user uuid, p_prompt uuid, p_now timestamptz) returns uuid
language plpgsql as $$
declare
  rid uuid;
begin
  rid := (start_request(p_user, 'booking', p_now) ->> 'request_id')::uuid;
  perform update_slots(rid, '{"party_size": 4, "customer_name": "Ihaz",
                               "window_start": "2026-10-23T19:30:00+05:30",
                               "window_end": "2026-10-23T21:00:00+05:30"}', p_now);
  perform set_request_business(rid, 'b0000000-0000-0000-0000-000000000001', p_now);
  perform advance_request(rid, 'confirming', p_now);
  perform open_prompt(p_prompt, rid, 'ask', '{}', 'yes', 'read-back', '{}', p_now);
  return rid;
end $$;

-- Call 1 happened and returned one option; the option list is open. The option id
-- is the prompt id with a d prefix (prompt e...0102 → option d...0102).
create function pg_temp.after_call_1(p_request uuid, p_prompt uuid, p_now timestamptz) returns void
language plpgsql as $$
declare
  oid uuid := ('d' || substr(p_prompt::text, 2))::uuid;
begin
  insert into calls (request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  select id, user_id, business_id, 'c0000000-0000-0000-0000-000000000001', 'first', 'v1', 'completed', p_now
    from requests where id = p_request;
  update requests set state = 'options_ready' where id = p_request;
  perform bump_request(p_request, 'options_changed', p_now);
  insert into options (id, request_id, label, value, created_at) values
    (oid, p_request, '9:30 pm', '{"time": "2026-10-23T21:30:00+05:30", "party_size": 4}', p_now);
  perform open_prompt(p_prompt, p_request, 'options', array[oid], 'yes', 'option list', '{}', p_now);
end $$;

-- Fixture
insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002'),
  ('a0000000-0000-0000-0000-000000000003', '919800000003', 'Ravi', '+919800000003');
insert into businesses (id, place_id, phone_e164, name, city, source, opening_hours)
select 'b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places',
       jsonb_build_object('periods', jsonb_agg(jsonb_build_object(
         'open',  jsonb_build_object('day', d, 'hour', 11, 'minute', 0),
         'close', jsonb_build_object('day', (d + 1) % 7, 'hour', 1, 'minute', 0))))
  from generate_series(0, 6) d;
insert into businesses (id, phone_e164, name, source) values
  ('b0000000-0000-0000-0000-000000000002', '+914952700002', 'Zudio', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', '2026-10-01');
insert into credit_ledger (delta_rs, reason) values (500, 'top-up');
insert into gate_passes (agent_version, suite, passed) values ('v1', 'sarvam-tests', true);
select set_limit('active_agent_version', '"v1"', 'test');

create temp table t (name text primary key, id uuid);
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from t where name = p_name $$;

-- Happy path: slots → read-back → YES → call 1 allowed -----------------------
insert into t values ('r1', pg_temp.ready('a0000000-0000-0000-0000-000000000001',
                                          'e0000000-0000-0000-0000-000000000001', pg_temp.at('18:00')));
select is(pg_temp.state(pg_temp.id('r1')), 'awaiting_yes', 'opening the read-back moves to awaiting_yes');
select is(pg_temp.reason(check_dial(pg_temp.id('r1'), 'first', null, false, pg_temp.at('19:00'))),
          'no_consent', 'a read-back alone allows no call');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000001', null, 'cancel', 'wamid.1', pg_temp.at('18:01'))),
          'wrong_word', 'CANCEL does not answer a YES prompt');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000001', null, 'yes', 'wamid.1', pg_temp.at('18:01'))),
          'ok', 'YES on the open read-back is stored');
select is(pg_temp.state(pg_temp.id('r1')), 'calling_1', 'consent #1 moves to calling_1');
select is(pg_temp.reason(check_dial(pg_temp.id('r1'), 'first', null, false, pg_temp.at('19:00'))),
          'ok', 'consent #1 on the current version allows call 1');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000001', null, 'yes', 'wamid.2', pg_temp.at('18:02'))),
          'prompt_closed', 'a second tap on the same read-back is refused');
select is((select count(*)::int from consents where request_id = pg_temp.id('r1')), 1, 'only one consent stored');

-- In flight: no edit, no cancel, a new request is queued ----------------------
select is(pg_temp.reason(update_slots(pg_temp.id('r1'), '{"party_size": 5}', pg_temp.at('18:03'))),
          'in_flight', 'slots cannot change during a call');
select is(pg_temp.reason(cancel_request(pg_temp.id('r1'), pg_temp.at('18:03'))),
          'in_flight', 'a request cannot be cancelled during a call');
insert into t values ('q1', (start_request('a0000000-0000-0000-0000-000000000001', 'question', pg_temp.at('18:04')) ->> 'request_id')::uuid);
select is(pg_temp.state(pg_temp.id('q1')), 'queued', 'a new request during a call is queued');
select is(pg_temp.state(pg_temp.id('r1')), 'calling_1', 'the call in flight is untouched');
select is(pg_temp.reason(update_slots(pg_temp.id('q1'), '{"question": "Size 32 in black jeans?"}', pg_temp.at('18:05'))),
          'ok', 'a queued request can collect slots');
select is(pg_temp.reason(open_prompt('e0000000-0000-0000-0000-000000000009', pg_temp.id('q1'), 'ask', '{}', 'yes', 'rb', '{}', pg_temp.at('18:05'))),
          'wrong_state', 'a queued request gets no read-back');
select is(activate_queued('a0000000-0000-0000-0000-000000000001', pg_temp.at('18:06')) -> 'request_id',
          'null'::jsonb, 'nothing activates while a call is in flight');

-- After the report the queued request becomes active with a new version.
update requests set state = 'done', end_reason = 'done' where id = pg_temp.id('r1');
select is((activate_queued('a0000000-0000-0000-0000-000000000001', pg_temp.at('18:20')) ->> 'request_id')::uuid,
          pg_temp.id('q1'), 'after the report the queued request activates');
select is(pg_temp.state(pg_temp.id('q1')), 'collecting', 'an activated request starts collecting again');
select cmp_ok(pg_temp.ver(pg_temp.id('q1')), '>', 2, 'activation bumps the version');
select cancel_request(pg_temp.id('q1'), pg_temp.at('18:21'));

-- Replace before consent and after call 1 -----------------------------------
insert into t values ('r2', pg_temp.ready('a0000000-0000-0000-0000-000000000002',
                                          'e0000000-0000-0000-0000-000000000002', pg_temp.at('18:00')));
select is(start_request('a0000000-0000-0000-0000-000000000002', 'booking', pg_temp.at('18:01')) ->> 'replaced_request_id',
          pg_temp.id('r2')::text, 'a new request replaces one awaiting YES');
select is((select state || '/' || end_reason from requests where id = pg_temp.id('r2')), 'cancelled/replaced',
          'the replaced request ends with reason replaced');
select is((select close_reason from consent_prompts where id = 'e0000000-0000-0000-0000-000000000002'), 'replaced',
          'its read-back is closed');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000002', null, 'yes', 'wamid.3', pg_temp.at('18:02'))),
          'prompt_closed', 'YES on a replaced request''s read-back is refused');
select is((select count(*)::int from requests where user_id = 'a0000000-0000-0000-0000-000000000002'
             and request_group(state) not in ('ended', 'queued')), 1, 'one active request per user');
select throws_ok($$insert into requests (user_id, task) values ('a0000000-0000-0000-0000-000000000002', 'booking')$$,
                 '23505', null, 'a second active request cannot be inserted');

-- Edits void approvals ------------------------------------------------------
insert into t values ('r3', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                          'e0000000-0000-0000-0000-000000000003', pg_temp.at('18:00')));
select is(update_slots(pg_temp.id('r3'), '{"party_size": 4}', pg_temp.at('18:01')) -> 'changed',
          'false'::jsonb, 'proposing the same value changes nothing');
select is((select closed_at from consent_prompts where id = 'e0000000-0000-0000-0000-000000000003'), null,
          'and leaves the read-back open');
select is(update_slots(pg_temp.id('r3'), '{"party_size": 5}', pg_temp.at('18:02')) ->> 'state',
          'confirming', '"yes but make it 5" is an edit: back to confirming');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000003', null, 'yes', 'wamid.4', pg_temp.at('18:03'))),
          'prompt_closed', 'YES on the read-back from before the edit is refused');
select is(update_slots(pg_temp.id('r3'), '{"service": null}', pg_temp.at('18:03')) -> 'changed',
          'false'::jsonb, 'removing an absent key changes nothing');
select is(pg_temp.reason(set_request_business(pg_temp.id('r3'), 'b0000000-0000-0000-0000-000000000002', pg_temp.at('18:04'))),
          'ok', 'the business can change before consent');
select is(pg_temp.reason(advance_request(pg_temp.id('r3'), 'confirming', pg_temp.at('18:04'))), 'ok', 'advance to confirming');
select is(pg_temp.reason(advance_request(pg_temp.id('r3'), 'collecting', pg_temp.at('18:04'))), 'ok', 'and back to collecting');
select throws_ok($$select advance_request(pg_temp.id('r3'), 'awaiting_yes')$$, '22023', null,
                 'advance_request cannot reach awaiting_yes');
select cancel_request(pg_temp.id('r3'), pg_temp.at('18:05'));

-- Every void reason makes check_dial() refuse -------------------------------
-- edited: a YES, then a direct field change with the version bumped.
insert into t values ('v_edit', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                              'e0000000-0000-0000-0000-000000000010', pg_temp.at('18:10')));
select record_consent('e0000000-0000-0000-0000-000000000010', null, 'yes', 'wamid.10', pg_temp.at('18:10'));
select is(pg_temp.reason(check_dial(pg_temp.id('v_edit'), 'first', null, false, pg_temp.at('19:00'))), 'ok', 'consented');
update requests set state = 'awaiting_yes' where id = pg_temp.id('v_edit');
select update_slots(pg_temp.id('v_edit'), '{"party_size": 6}', pg_temp.at('18:11'));
select is(pg_temp.reason(check_dial(pg_temp.id('v_edit'), 'first', null, false, pg_temp.at('19:00'))),
          'consent_voided', 'edited → call 1 refused');
select is((select void_reason from consents where request_id = pg_temp.id('v_edit')), 'edited', 'void reason edited');

-- replaced
update requests set state = 'awaiting_yes', fields = fields || '{"party_size": 4}' where id = pg_temp.id('v_edit');
select cancel_request(pg_temp.id('v_edit'), pg_temp.at('18:12'));
insert into t values ('v_repl', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                              'e0000000-0000-0000-0000-000000000011', pg_temp.at('18:12')));
select record_consent('e0000000-0000-0000-0000-000000000011', null, 'yes', 'wamid.11', pg_temp.at('18:12'));
update requests set state = 'awaiting_yes' where id = pg_temp.id('v_repl');
select start_request('a0000000-0000-0000-0000-000000000003', 'booking', pg_temp.at('18:13'));
select is(pg_temp.reason(check_dial(pg_temp.id('v_repl'), 'first', null, false, pg_temp.at('19:00'))),
          'consent_voided', 'replaced → call 1 refused');

-- cancelled (after call 1, with a pick consent)
select cancel_request(id, pg_temp.at('18:14')) from requests
 where user_id = 'a0000000-0000-0000-0000-000000000003' and request_group(state) = 'before_consent';
insert into t values ('v_canc', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                              'e0000000-0000-0000-0000-000000000012', pg_temp.at('18:14')));
select record_consent('e0000000-0000-0000-0000-000000000012', null, 'yes', 'wamid.12', pg_temp.at('18:14'));
select pg_temp.after_call_1(pg_temp.id('v_canc'), 'e0000000-0000-0000-0000-000000000102', pg_temp.at('18:20'));
select is(pg_temp.state(pg_temp.id('v_canc')), 'awaiting_pick', 'sending the option list moves to awaiting_pick');
select is(pg_temp.reason(check_dial(pg_temp.id('v_canc'), 'first', null, false, pg_temp.at('19:00'))),
          'consent_voided', 'options_changed → another call 1 needs a new YES');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000102', 'd0000000-0000-0000-0000-000000000009', 'yes', 'wamid.13', pg_temp.at('18:21'))),
          'bad_option', 'a pick of an option not on the list is refused');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000102', null, 'yes', 'wamid.13', pg_temp.at('18:21'))),
          'bad_option', 'a pick without an option is refused');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000102', 'd0000000-0000-0000-0000-000000000102', 'yes', 'wamid.13', pg_temp.at('18:21'))),
          'ok', 'a pick from the open list is consent #2');
select is(pg_temp.state(pg_temp.id('v_canc')), 'calling_2', 'consent #2 moves to calling_2');
select is(pg_temp.reason(check_dial(pg_temp.id('v_canc'), 'booking', 'd0000000-0000-0000-0000-000000000102', false, pg_temp.at('19:00'))),
          'ok', 'consent #2 allows call 2 for that option');
update requests set state = 'awaiting_pick' where id = pg_temp.id('v_canc');
select is(pg_temp.reason(cancel_request(pg_temp.id('v_canc'), pg_temp.at('18:22'))), 'ok', '"neither, forget it" cancels after call 1');
select is(pg_temp.reason(check_dial(pg_temp.id('v_canc'), 'booking', 'd0000000-0000-0000-0000-000000000102', false, pg_temp.at('19:00'))),
          'option_voided', 'cancelled → call 2 refused');

-- options edited after call 1 ("the second one, but at 9 instead")
insert into t values ('v_opt', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                             'e0000000-0000-0000-0000-000000000013', pg_temp.at('18:30')));
select record_consent('e0000000-0000-0000-0000-000000000013', null, 'yes', 'wamid.14', pg_temp.at('18:30'));
select pg_temp.after_call_1(pg_temp.id('v_opt'), 'e0000000-0000-0000-0000-000000000103', pg_temp.at('18:35'));
select is(update_slots(pg_temp.id('v_opt'), '{"window_start": "2026-10-23T21:00:00+05:30"}', pg_temp.at('18:36')) ->> 'state',
          'confirming', 'an edit after call 1 goes back to a new read-back');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000103', 'd0000000-0000-0000-0000-000000000103', 'yes', 'wamid.15', pg_temp.at('18:37'))),
          'prompt_closed', 'a pick from the list before the edit is refused');
select is((select voided_at is not null from options where id = 'd0000000-0000-0000-0000-000000000103'), true,
          'the edit voids the options');
-- Second availability call used up: a further edit after call 1 is refused.
select open_prompt('e0000000-0000-0000-0000-000000000014', pg_temp.id('v_opt'), 'ask', '{}', 'yes', 'rb', '{}', pg_temp.at('18:37'));
select record_consent('e0000000-0000-0000-0000-000000000014', null, 'yes', 'wamid.16', pg_temp.at('18:37'));
select pg_temp.after_call_1(pg_temp.id('v_opt'), 'e0000000-0000-0000-0000-000000000104', pg_temp.at('18:45'));
select is(pg_temp.reason(update_slots(pg_temp.id('v_opt'), '{"party_size": 5}', pg_temp.at('18:46'))),
          'limit_availability_calls', 'over max_availability_calls_per_request the edit is refused');
select is(pg_temp.state(pg_temp.id('v_opt')), 'awaiting_pick', 'and the existing options stay open');
select cancel_request(pg_temp.id('v_opt'), pg_temp.at('18:47'));

-- expired, then reopened
insert into t values ('v_exp', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                             'e0000000-0000-0000-0000-000000000015', pg_temp.at('06:00')));
update requests set fields = fields || '{"window_start": "2026-10-24T19:30:00+05:30", "window_end": "2026-10-24T21:00:00+05:30"}'
 where id = pg_temp.id('v_exp');
select is(expire_requests(pg_temp.at('17:00')), 0, 'idle under 12 hours: not expired');
select is(expire_requests(pg_temp.at('18:01')), 1, 'idle 12 hours before consent: expired');
select is((select state || '/' || end_reason from requests where id = pg_temp.id('v_exp')), 'expired/expired',
          'end reason expired');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000015', null, 'yes', 'wamid.17', pg_temp.at('18:02'))),
          'prompt_closed', 'YES on an expired request''s read-back is refused');
select is(pg_temp.reason(reopen_request(pg_temp.id('v_exp'), pg_temp.at('18:05'))), 'ok', '"still want Paragon?" reopens it');
select is(pg_temp.state(pg_temp.id('v_exp')), 'collecting', 'a reopened request needs a fresh read-back');
select is((select void_reason from consents where request_id = pg_temp.id('v_exp')), null, 'no consent existed to void');
-- reopened: a consent from before the expiry never carries over.
update requests set state = 'confirming' where id = pg_temp.id('v_exp');
select open_prompt('e0000000-0000-0000-0000-000000000016', pg_temp.id('v_exp'), 'ask', '{}', 'yes', 'rb', '{}', pg_temp.at('18:06'));
select record_consent('e0000000-0000-0000-0000-000000000016', null, 'yes', 'wamid.18', pg_temp.at('18:06'));
update requests set state = 'awaiting_yes' where id = pg_temp.id('v_exp');
select expire_requests(pg_temp.at('23:59', '2026-10-24'));
select is(pg_temp.reason(reopen_request(pg_temp.id('v_exp'), pg_temp.at('23:59', '2026-10-24'))),
          'window_passed', 'a request whose window passed cannot be reopened');
update requests set state = 'expired', end_reason = 'expired',
                    fields = fields || '{"window_start": "2026-10-25T19:30:00+05:30", "window_end": "2026-10-25T21:00:00+05:30"}'
 where id = pg_temp.id('v_exp');
select reopen_request(pg_temp.id('v_exp'), pg_temp.at('10:00', '2026-10-25'));
select is(pg_temp.reason(check_dial(pg_temp.id('v_exp'), 'first', null, false, pg_temp.at('19:00', '2026-10-25'))),
          'consent_voided', 'reopened → the old YES does not allow a call');
select cancel_request(pg_temp.id('v_exp'), pg_temp.at('10:01', '2026-10-25'));

-- window passed
insert into t values ('v_win', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                             'e0000000-0000-0000-0000-000000000017', pg_temp.at('18:00')));
select is(expire_requests(pg_temp.at('21:00')), 1, '"table tonight" expires once the window has passed');
select is((select end_reason from requests where id = pg_temp.id('v_win')), 'window_passed', 'end reason window_passed');

-- reactivated: a queued request whose window passed while it waited expires instead.
insert into t values ('v_busy', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                              'e0000000-0000-0000-0000-000000000018', pg_temp.at('20:00', '2026-10-22')));
update requests set fields = fields || '{"window_start": "2026-10-24T19:30:00+05:30", "window_end": "2026-10-24T21:00:00+05:30"}'
 where id = pg_temp.id('v_busy');
select record_consent('e0000000-0000-0000-0000-000000000018', null, 'yes', 'wamid.19', pg_temp.at('20:00', '2026-10-22'));
insert into t values ('v_q', (start_request('a0000000-0000-0000-0000-000000000003', 'booking', pg_temp.at('20:01', '2026-10-22')) ->> 'request_id')::uuid);
update requests set fields = '{"window_end": "2026-10-22T20:30:00+05:30"}' where id = pg_temp.id('v_q');
update requests set state = 'done' where id = pg_temp.id('v_busy');
select is(activate_queued('a0000000-0000-0000-0000-000000000003', pg_temp.at('21:00', '2026-10-22')) -> 'expired',
          jsonb_build_array(pg_temp.id('v_q')), 'a queued request past its window expires on activation');

-- Prompt binding -------------------------------------------------------------
insert into t values ('p1', pg_temp.ready('a0000000-0000-0000-0000-000000000003',
                                          'e0000000-0000-0000-0000-000000000020', pg_temp.at('18:00')));
select open_prompt('e0000000-0000-0000-0000-000000000021', pg_temp.id('p1'), 'ask', '{}', 'yes', 'rb again', '{}', pg_temp.at('18:01'));
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000020', null, 'yes', 'wamid.20', pg_temp.at('18:02'))),
          'prompt_closed', 'an older read-back is closed by the newer one');
update consent_prompts set request_version = request_version - 1 where id = 'e0000000-0000-0000-0000-000000000021';
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000021', null, 'yes', 'wamid.21', pg_temp.at('18:02'))),
          'stale_version', 'a prompt for an older version is refused even if open');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-0000000000ff', null, 'yes', 'wamid.22', pg_temp.at('18:02'))),
          'no_prompt', 'an unknown prompt id is refused');
select is(pg_temp.reason(open_prompt('e0000000-0000-0000-0000-000000000022', pg_temp.id('p1'), 'options',
                                     array['d0000000-0000-0000-0000-000000000001']::uuid[], 'yes', 'x', '{}', pg_temp.at('18:03'))),
          'wrong_state', 'no option list before call 1');
select is(pg_temp.reason(open_prompt('e0000000-0000-0000-0000-000000000023', pg_temp.id('p1'), 'ask', '{}', 'cancel',
                                     'CANCEL read-back', '{}', pg_temp.at('18:04'))),
          'ok', 'a read-back can ask for CANCEL');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000023', null, 'yes', 'wamid.23', pg_temp.at('18:05'))),
          'wrong_word', 'a reflexive YES cannot approve a possible loss');
select is(pg_temp.reason(record_consent('e0000000-0000-0000-0000-000000000023', null, 'cancel', 'wamid.23', pg_temp.at('18:05'))),
          'ok', 'CANCEL approves it');

-- Exact times (Ihaz, 25 Oct) ---------------------------------------------------
select is(limit_int('match_tolerance_minutes'), 0, 'an exact time means that time: no tolerance');
insert into t values ('x1', pg_temp.ready('a0000000-0000-0000-0000-000000000002',
                                          'e0000000-0000-0000-0000-000000000030', pg_temp.at('18:00')));
update requests set fields = '{"party_size": 4, "customer_name": "Asha", "exact_time": "2026-10-23T20:00:00+05:30"}',
                    state = 'awaiting_yes'
 where id = pg_temp.id('x1');
insert into consents (request_id, kind, text_shown, fields_hash, request_version)
select id, 'ask', 'rb', fields_hash(fields), version from requests where id = pg_temp.id('x1');
select is(pg_temp.reason(check_dial(pg_temp.id('x1'), 'first', null, false, pg_temp.at('19:30'))),
          'ok', 'before the exact time, call 1 is allowed');
select is(pg_temp.reason(check_dial(pg_temp.id('x1'), 'first', null, false, pg_temp.at('20:05'))),
          'too_late', 'after an exact time with no window, call 1 is refused as too late');

-- Quote-replies: every send of a prompt is recorded --------------------------
select prompt_sent('e0000000-0000-0000-0000-000000000023', 'wamid.first');
select prompt_sent('e0000000-0000-0000-0000-000000000023', 'wamid.resend');
select is((select sent_ids from consent_prompts where id = 'e0000000-0000-0000-0000-000000000023'),
          array['wamid.first', 'wamid.resend'], 'each send of a prompt is kept, so a quote of any of them binds');
select is((select wa_message_id from consent_prompts where id = 'e0000000-0000-0000-0000-000000000023'),
          'wamid.resend', 'the latest send is what a bare YES binds to');

select * from finish();
rollback;
