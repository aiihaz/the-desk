-- 0013: a version that hasn't shown the output contract can't reach a real business.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-10-26 ' || hhmm || ':00+05:30')::timestamptz $$;

insert into users (id, wa_id, name, phone_e164) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz', '+919800000001');
insert into businesses (id, place_id, phone_e164, name, city, source) values
  ('b0000000-0000-0000-0000-000000000001', 'places/real', '+914952700001', 'Paragon', 'Kozhikode', 'places'),
  ('b0000000-0000-0000-0000-000000000002', 'places/test', '+914952700002', 'Test line', 'Kozhikode', 'places');
insert into test_numbers (phone_e164, name) values ('+914952700002', 'Test line');
insert into caller_numbers (id, e164, provider, a2p_declared_at) values
  ('c0000000-0000-0000-0000-000000000001', '+918000000001', 'sarvam', now());
insert into credit_ledger (delta_rs, reason) values (1000, 'test');
select set_limit('active_agent_version', '"7"', 'test');
insert into gate_passes (agent_version, suite, passed, instructions_sha256) values ('7', 'test', true, 'pin');
select set_limit('agent_instructions_sha256', '"pin"', 'test');

create temp table t (name text primary key, id uuid);
create function pg_temp.id(n text) returns uuid language sql as $$ select id from t where name = n $$;

-- A request with an approved plan, ready to dial, at the given business.
create function pg_temp.approved(n text, biz uuid) returns void language plpgsql as $$
declare
  rid uuid;
  pid uuid := gen_random_uuid();
begin
  update requests set state = 'cancelled' where user_id = 'a0000000-0000-0000-0000-000000000001'
    and state not in ('cancelled', 'done');
  rid := (start_request('a0000000-0000-0000-0000-000000000001', 'booking', pg_temp.at('12:00')) ->> 'request_id')::uuid;
  update requests set state = 'confirming', business_id = biz where id = rid;
  perform open_prompt(pid, rid, 'ask', '{}', 'yes', 'Plan', '{"kind": "text", "body": "Plan"}', pg_temp.at('12:01'));
  perform record_consent(pid, null, 'yes', n, pg_temp.at('12:02'));
  insert into t values (n, rid);
end $$;

select is((select count(*)::int from caller_contract), 22, 'the contract is seeded');

select pg_temp.approved('real', 'b0000000-0000-0000-0000-000000000001');
select is((check_dial(pg_temp.id('real'), 'first', p_now => pg_temp.at('12:03')) ->> 'reason'), 'caller_contract_mismatch',
          'a version that has shown nothing can''t reach a real business');

select pg_temp.approved('test', 'b0000000-0000-0000-0000-000000000002');
select is((check_dial(pg_temp.id('test'), 'first', p_now => pg_temp.at('12:03')) ->> 'ok'), 'true',
          'a test number can, so a version can earn it');
insert into t values ('c1', (reserve_call(pg_temp.id('test'), 'first', p_now => pg_temp.at('12:04')) ->> 'call_id')::uuid);

-- A summary-only caller, like Desk Caller v2-3.
select record_caller_outputs(pg_temp.id('c1'), array['call_summary']);
select is((select outputs_seen from gate_passes where agent_version = '7'), '{}'::text[], 'names outside the contract don''t count');

select record_caller_outputs(pg_temp.id('c1'), (select array_agg(name) from caller_contract where name <> 'summary'));
select pg_temp.approved('real2', 'b0000000-0000-0000-0000-000000000001');
select is((check_dial(pg_temp.id('real2'), 'first', p_now => pg_temp.at('12:05')) ->> 'reason'), 'caller_contract_mismatch',
          'one output short is still refused');

select record_caller_outputs(pg_temp.id('c1'), array['summary']);
select is((check_dial(pg_temp.id('real2'), 'first', p_now => pg_temp.at('12:05')) ->> 'ok'), 'true',
          'every output shown: a real business can be dialled');
select is((check_dial(pg_temp.id('real2'), 'first', p_now => pg_temp.at('12:05')) ->> 'consent_id') is not null, true,
          'and the result still names its consent');

select caller_contract_broken(pg_temp.id('c1'), pg_temp.at('12:06'));
select is((check_dial(pg_temp.id('real2'), 'first', p_now => pg_temp.at('12:07')) ->> 'reason'), 'caller_contract_broken',
          'a call with no readable result blocks the version');
select is((reserve_call(pg_temp.id('real2'), 'first', p_now => pg_temp.at('12:07')) ->> 'reason'), 'caller_contract_broken',
          'reserve_call refuses it too');
select pg_temp.approved('test2', 'b0000000-0000-0000-0000-000000000002');
select is((check_dial(pg_temp.id('test2'), 'first', p_now => pg_temp.at('12:08')) ->> 'ok'), 'true', 'test numbers stay open');

select * from finish();
rollback;
