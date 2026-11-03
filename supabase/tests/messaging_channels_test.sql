-- Existing WhatsApp identities and a Linq conversation for the same phone coexist.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into users (id, wa_id, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', '+919800000001');
insert into users (id, wa_id, phone_e164, channel) values
  ('a0000000-0000-0000-0000-000000000002', 'linq:919800000001', '+919800000001', 'linq');

select is((select channel from users where wa_id = '919800000001'), 'whatsapp',
  'existing insert shape still creates a WhatsApp user');
select is((select count(*)::int from users where phone_e164 = '+919800000001'), 2,
  'the same phone has separate WhatsApp and Linq user rows');
select lives_ok($$insert into users (wa_id, phone_e164) values ('919800000001', '+919800000001')
  on conflict (wa_id) do nothing$$, 'deployed WhatsApp upsert retains its unique conflict target');
select throws_ok($$insert into users (wa_id, phone_e164, channel)
  values ('919800000002', '+919800000002', 'linq')$$, '23514', null,
  'Linq users must use a namespaced identity');

select start_request('a0000000-0000-0000-0000-000000000001', 'question');
select start_request('a0000000-0000-0000-0000-000000000002', 'question');
select stop_user('a0000000-0000-0000-0000-000000000002');
select is(user_stopped('a0000000-0000-0000-0000-000000000002'), true, 'STOP stops the Linq identity');
select is(user_stopped('a0000000-0000-0000-0000-000000000001'), false, 'the WhatsApp identity stays active');
select is((select state from requests where user_id = 'a0000000-0000-0000-0000-000000000001'),
  'collecting', 'WhatsApp errand is not cancelled by Linq STOP');
select is((select state from requests where user_id = 'a0000000-0000-0000-0000-000000000002'),
  'cancelled', 'Linq errand is cancelled by its own STOP');

select * from finish();
rollback;
