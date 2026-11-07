-- 0027: check results are recorded without conversation text; a checker's own words are kept
-- only while switched on, never for someone awaiting erasure, gone at once on a deletion
-- request, and expired; a malformed event is counted, not lost silently.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into users (id, wa_id, phone_e164) values
  ('c0000000-0000-0000-0000-000000000001', '919800000101', '+919800000101'),
  ('c0000000-0000-0000-0000-000000000002', '919800000102', '+919800000102');
insert into messages (user_id, wa_message_id, direction, body, at) values
  ('c0000000-0000-0000-0000-000000000001', 'w1', 'in', '{"text": "book it"}', now());

-- Off by default: the event is kept, the words are not, and the event says so.
select is(
  (record_checks('c0000000-0000-0000-0000-000000000001',
    '[{"check":"plan_check","outcome":"reject","category":"fidelity","reason":"unfaithful","attempt":1,
       "detail":["drops the time they gave"]},
      {"check":"luna_turn","outcome":"pass","reason":"first_try"}]', 'd6abcf8', 'w1') ->> 'recorded')::int,
  2, 'both events recorded');
select is((select detail from check_events where check_name = 'plan_check'), 'off', 'words not kept while off');
select is((select count(*)::int from check_details), 0, 'no detail rows while off');
select is((select code_version from check_events where check_name = 'luna_turn'), 'd6abcf8', 'code version kept');
select isnt((select message_id from check_events where check_name = 'luna_turn'), null, 'linked to the answered message');

-- Switched on for one user: their words are kept, capped; another user's are not.
insert into user_limits (user_id, key, value, updated_by) values
  ('c0000000-0000-0000-0000-000000000001', 'check_details_until', to_jsonb((now() + interval '1 hour')::text), 'test');
select record_checks('c0000000-0000-0000-0000-000000000001',
  '[{"check":"report_check","outcome":"reject","category":"fidelity","reason":"unfaithful","detail":["a","b","c","d","e","f","g","h","i","j","k","l"]}]',
  'd6abcf8');
select is((select cardinality(detail) from check_details d join check_events e on e.id = d.event_id
  where e.check_name = 'report_check'), 10, 'detail capped at 10 items');
select is((select detail from check_events where check_name = 'report_check'), 'kept', 'event says the words are kept');
select record_checks('c0000000-0000-0000-0000-000000000002',
  '[{"check":"approval","outcome":"reject","category":"consent","reason":"decision_no","detail":["asked a question"]}]',
  'd6abcf8');
select is((select count(*)::int from check_details where user_id = 'c0000000-0000-0000-0000-000000000002'), 0,
  'not kept for a user it is not switched on for');

-- A lapsed or malformed switch is off.
update user_limits set value = to_jsonb((now() - interval '1 minute')::text)
  where user_id = 'c0000000-0000-0000-0000-000000000001' and key = 'check_details_until';
select is(check_details_on('c0000000-0000-0000-0000-000000000001', now()), false, 'lapsed switch is off');
update user_limits set value = '"soon"'
  where user_id = 'c0000000-0000-0000-0000-000000000001' and key = 'check_details_until';
select is(check_details_on('c0000000-0000-0000-0000-000000000001', now()), false, 'malformed switch is off');

-- Text can't ride in on a reason, and a bad event is counted rather than costing the batch.
select is(
  (record_checks('c0000000-0000-0000-0000-000000000002',
    '[{"check":"reply_code","outcome":"reject","category":"format","reason":"They said Indiranagar"},
      {"check":"reply_code","outcome":"reject","category":"format","reason":"link"}]', 'd6abcf8') ->> 'dropped')::int,
  1, 'an event with text in its reason is rejected');
select is((select reason from check_events where check_name = 'diag_dropped'
  and user_id = 'c0000000-0000-0000-0000-000000000002'), 'rejected:1', 'the loss is recorded as a count');
select is((select count(*)::int from check_events where reason = 'link'), 1, 'the good event still lands');
select is((select code_version from check_events where user_id = 'c0000000-0000-0000-0000-000000000002'
  order by id limit 1), 'd6abcf8', 'version kept');
select record_checks('c0000000-0000-0000-0000-000000000002', '[{"check":"luna_turn","outcome":"pass"}]', 'Not A Version!');
select is((select code_version from check_events order by id desc limit 1), 'unknown', 'a bad version reads unknown');

-- A deletion request: their words go at once, counts stay until erasure, and no new words are kept.
update user_limits set value = to_jsonb((now() + interval '1 hour')::text)
  where user_id = 'c0000000-0000-0000-0000-000000000001' and key = 'check_details_until';
select request_data_deletion('c0000000-0000-0000-0000-000000000001');
select is((select count(*)::int from check_details where user_id = 'c0000000-0000-0000-0000-000000000001'), 0,
  'words deleted on the request');
select cmp_ok((select count(*)::int from check_events where user_id = 'c0000000-0000-0000-0000-000000000001'), '>', 0,
  'counts wait for erasure');
select record_checks('c0000000-0000-0000-0000-000000000001',
  '[{"check":"plan_check","outcome":"reject","category":"fidelity","reason":"unfaithful","detail":["x"]}]', 'd6abcf8');
select is((select detail from check_events where user_id = 'c0000000-0000-0000-0000-000000000001' order by id desc limit 1),
  'awaiting_erasure', 'awaiting erasure: words not collected, and the event says why');
select is((select count(*)::int from check_details where user_id = 'c0000000-0000-0000-0000-000000000001'), 0,
  'still no words');

-- Erasure deletes the user row; every event goes with it.
delete from users where id = 'c0000000-0000-0000-0000-000000000001';
select is((select count(*)::int from check_events where user_id = 'c0000000-0000-0000-0000-000000000001'), 0,
  'events cascade with the user');
select is((record_checks('c0000000-0000-0000-0000-000000000001', '[{"check":"luna_turn","outcome":"pass"}]', 'x')
  ->> 'recorded')::int, 0, 'nothing recorded for an erased user');

-- Expiry: words after the short window, events after their own.
insert into user_limits (user_id, key, value, updated_by) values
  ('c0000000-0000-0000-0000-000000000002', 'check_details_until', to_jsonb((now() + interval '1 hour')::text), 'test');
select record_checks('c0000000-0000-0000-0000-000000000002',
  '[{"check":"grounding","outcome":"reject","category":"fidelity","reason":"plan:intent_unclear","detail":["which day?"]}]',
  'd6abcf8', null, now() - interval '73 hours');
select is(purge_check_details(now()), 1, 'words older than 72 hours purged');
select purge_old_data(now() + interval '91 days');
select is((select count(*)::int from check_events), 0, 'events older than 90 days purged');

-- Not readable through the API roles.
select is(has_table_privilege('anon', 'check_events', 'select'), false, 'anon cannot read events');
select is(has_table_privilege('authenticated', 'check_details', 'select'), false, 'authenticated cannot read details');
select is(has_function_privilege('anon', 'record_checks(uuid,jsonb,text,text,timestamptz)', 'execute'), false,
  'anon cannot write');

select * from finish();
rollback;
