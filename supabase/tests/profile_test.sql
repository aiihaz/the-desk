-- 0026: their own name lands on the profile only in words they wrote, and addresses are
-- kept under their labels, replaced by label, capped, and erased with their data.
-- Clock: Friday 2026-11-06 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-11-06 ' || hhmm || ':00+05:30')::timestamptz $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', null, '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into messages (user_id, wa_message_id, direction, body, at) values
  ('a0000000-0000-0000-0000-000000000001', 'm1', 'in', '{"text": "i need a plumber"}', pg_temp.at('14:30')),
  ('a0000000-0000-0000-0000-000000000001', 'o1', 'out', '{"text": "What name should I give them?"}', pg_temp.at('14:31')),
  ('a0000000-0000-0000-0000-000000000001', 'm2', 'in', '{"text": "book under my name ihaz"}', pg_temp.at('14:32')),
  ('a0000000-0000-0000-0000-000000000001', 'm0', 'in', '{"text": "I go by Zain"}', pg_temp.at('09:00') - interval '2 days'),
  ('a0000000-0000-0000-0000-000000000002', 'n1', 'in', '{"text": "I am Ihaz"}', pg_temp.at('14:30'));

-- Their name ------------------------------------------------------------------------
select is(set_profile_name('a0000000-0000-0000-0000-000000000001', 'Ihaz', 'book under my name ihaz',
  pg_temp.at('14:33')) ->> 'name', 'Ihaz', 'their own name, in their words, goes on the profile');
select is((select name from users where id = 'a0000000-0000-0000-0000-000000000001'), 'Ihaz',
  'and is there for the next errand');
select is(set_profile_name('a0000000-0000-0000-0000-000000000001', 'Zain', 'book under my name ihaz',
  pg_temp.at('14:33')) ->> 'reason', 'name_not_in_evidence', 'a name their words do not hold is refused');
select is(set_profile_name('a0000000-0000-0000-0000-000000000001', 'Zain', 'my name is Zain',
  pg_temp.at('14:33')) ->> 'reason', 'evidence_not_said', 'words they never wrote are refused');
select is(set_profile_name('a0000000-0000-0000-0000-000000000001', 'Zain', 'I go by Zain',
  pg_temp.at('14:33')) ->> 'reason', 'evidence_not_said', 'a message older than a day is not evidence');
select is(set_profile_name('a0000000-0000-0000-0000-000000000001', 'Ihaz', 'What name should I give them',
  pg_temp.at('14:33')) ->> 'reason', 'evidence_not_said', 'the Desk''s own words are not evidence');
select is(set_profile_name('a0000000-0000-0000-0000-000000000002', 'Ihaz', 'book under my name ihaz',
  pg_temp.at('14:33')) ->> 'reason', 'evidence_not_said', 'another user''s message is not evidence');
select is((select name from users where id = 'a0000000-0000-0000-0000-000000000002'), 'Asha',
  'and their name is untouched');

-- Addresses -------------------------------------------------------------------------
select is(save_address('a0000000-0000-0000-0000-000000000001', 'home', 'Flat 302, Prestige Lakeside, HSR Layout',
  'm2', pg_temp.at('14:34')) ->> 'label', 'home', 'an address is kept under their label');
select is(save_address('a0000000-0000-0000-0000-000000000001', 'Work', 'WeWork, Koramangala', 'm2',
  pg_temp.at('14:34')) ->> 'label', 'Work', 'a second place is a second label');
select is(save_address('a0000000-0000-0000-0000-000000000001', 'HOME', 'Villa 9, Whitefield', 'm2',
  pg_temp.at('14:35')) ->> 'address', 'Villa 9, Whitefield', 'the same label, in any case, is replaced');
select is((select count(*)::int from user_addresses where user_id = 'a0000000-0000-0000-0000-000000000001'), 2,
  'replacing a label adds no row');
select is(save_address('a0000000-0000-0000-0000-000000000001', 'gym', 'Cult, HSR', 'o1',
  pg_temp.at('14:35')) ->> 'reason', 'needs_user_message', 'only against one of their own messages');
select is(save_address('a0000000-0000-0000-0000-000000000001', 'work', null, 'm2',
  pg_temp.at('14:36')) ->> 'removed', 'Work', 'a null address removes that label');
select is(save_address('a0000000-0000-0000-0000-000000000001', 'work', null, 'm2',
  pg_temp.at('14:36')) ->> 'reason', 'no_such_label', 'removing a label they do not have says so');

update limits set value = '1' where key = 'max_addresses_per_user';
select is(save_address('a0000000-0000-0000-0000-000000000001', 'mum', 'Indiranagar', 'm2',
  pg_temp.at('14:37')) ->> 'reason', 'addresses_full', 'past the cap a new label is refused');
select is(save_address('a0000000-0000-0000-0000-000000000001', 'home', 'Villa 10, Whitefield', 'm2',
  pg_temp.at('14:37')) ->> 'ok', 'true', 'at the cap an existing label can still change');

-- Erasure ---------------------------------------------------------------------------
select request_data_deletion('a0000000-0000-0000-0000-000000000001', pg_temp.at('14:40'));
select is((select count(*)::int from user_addresses where user_id = 'a0000000-0000-0000-0000-000000000001'), 0,
  'deleting their data takes the addresses at once');

select * from finish();
rollback;
