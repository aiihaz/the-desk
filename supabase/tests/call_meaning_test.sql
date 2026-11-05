-- 0019: the confirm call's redial is at the time the message names, and a number that
-- reached someone else isn't dialled again for that user.
-- Clock: Friday 2026-10-23 in IST.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text, d text default '2026-10-23') returns timestamptz
language sql as $$ select (d || ' ' || hhmm || ':00+05:30')::timestamptz $$;
create temp table t (name text primary key, id uuid);
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from t where name = p_name $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001'),
  ('a0000000-0000-0000-0000-000000000002', '919800000002', 'Asha', '+919800000002');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/paragon', '+914952700001', 'Paragon', 'Kozhikode', 'places');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());

create function pg_temp.calling(n text, p_task text, p_state text, p_kind text, p_user uuid default 'a0000000-0000-0000-0000-000000000001') returns void
language plpgsql as $$
declare
  rid uuid;
  cid uuid := gen_random_uuid();
begin
  insert into requests (user_id, task, state, business_id, caller_number_id, created_at, updated_at)
  values (p_user, p_task, 'queued', 'b0000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000001', pg_temp.at('10:00'), pg_temp.at('10:00'))
  returning id into rid;
  update requests set state = p_state where id = rid;
  insert into calls (id, request_id, user_id, business_id, caller_number_id, kind, agent_version, status, created_at)
  values (cid, rid, p_user, 'b0000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000001', p_kind, '7', 'completed', pg_temp.at('10:01'));
  insert into t values (n, rid), (n || '_call', cid);
end $$;

-- The redial ------------------------------------------------------------------------
select pg_temp.calling('p', 'booking', 'verifying', 'payment_confirm');
select is(settle_call(pg_temp.id('p_call'), 'retry', '[]', '{"retry_at": "2026-10-23T10:42:00+05:30"}',
                      false, pg_temp.at('10:02')) ->> 'state', 'awaiting_payment', 'not seen: the errand waits');
select is((select next_call_at from requests where id = pg_temp.id('p')), pg_temp.at('10:42'),
          'the redial is at the time the business asked for, not the default');

select pg_temp.calling('q', 'booking', 'verifying', 'payment_confirm');
select settle_call(pg_temp.id('q_call'), 'retry', p_now => pg_temp.at('10:02'));
select is((select next_call_at from requests where id = pg_temp.id('q')), pg_temp.at('10:32'),
          'with no time given, after payment_confirm_retry_minutes');

select pg_temp.calling('s', 'booking', 'verifying', 'payment_confirm');
select settle_call(pg_temp.id('s_call'), 'retry', '[]', '{"retry_at": "2026-10-23T09:00:00+05:30"}',
                   false, pg_temp.at('10:02'));
select is((select next_call_at from requests where id = pg_temp.id('s')), pg_temp.at('10:02'),
          'never in the past');

-- A wrong number --------------------------------------------------------------------
select pg_temp.calling('w', 'booking', 'calling_1', 'first');
select is(settle_call(pg_temp.id('w_call'), 'back', '[]', '{"wrong_number": true}', false, pg_temp.at('10:03')) ->> 'ok',
          'true', 'a wrong number settles as nothing done');
select results_eq(
  $$select user_id, phone_e164::text from wrong_numbers$$,
  $$values ('a0000000-0000-0000-0000-000000000001'::uuid, '+914952700001'::text)$$,
  'the number is recorded for this user');
select is(check_dial(pg_temp.id('w'), 'first', null, false, pg_temp.at('10:05')) ->> 'reason', 'wrong_number',
          'and is not dialled again for them');

select pg_temp.calling('x', 'booking', 'confirming', 'first', 'a0000000-0000-0000-0000-000000000002');
select isnt(check_dial(pg_temp.id('x'), 'first', null, false, pg_temp.at('10:05')) ->> 'reason', 'wrong_number',
            'another user is not held by it');

update businesses set phone_e164 = '+914952700002' where id = 'b0000000-0000-0000-0000-000000000001';
select isnt(check_dial(pg_temp.id('w'), 'first', null, false, pg_temp.at('10:05')) ->> 'reason', 'wrong_number',
            'a new number for the business is dialled again');

select * from finish();
rollback;
