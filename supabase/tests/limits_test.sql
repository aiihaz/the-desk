-- Limits (eng plan 5.2, test plan "Limits").
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into users (id, wa_id, name) values
  ('a0000000-0000-0000-0000-000000000001', '919800000001', 'Ihaz');

-- Seed
select is((select count(*)::int from limits), 43, 'all limit keys are seeded');
select is(limit_int('max_calls_per_request'), 4, 'placeholder default is readable');
select is(limit_int('max_calls_per_business_per_day'), null, 'business limit is off by default');
select is(limit_bool('book_on_first_call'), true, 'book_on_first_call defaults to true');

-- set limit changes behaviour without a deploy
select set_limit('max_calls_per_request', '6', 'wa:919800000001');
select is(limit_int('max_calls_per_request'), 6, 'set_limit changes the global value');
select is((select updated_by from limits where key = 'max_calls_per_request'), 'wa:919800000001',
          'limits row records who changed it');

-- bad values are rejected
select throws_ok($$select set_limit('max_calls_per_request', '-1', 'test')$$, '22023', null, 'negative int rejected');
select throws_ok($$select set_limit('max_calls_per_request', '1.5', 'test')$$, '22023', null, 'fractional int rejected');
select throws_ok($$select set_limit('max_calls_per_request', '"4"', 'test')$$, '22023', null, 'string for int rejected');
select throws_ok($$select set_limit('max_calls_per_request', 'null', 'test')$$, '22023', null, 'null for a non-nullable limit rejected');
select throws_ok($$select set_limit('book_on_first_call', '1', 'test')$$, '22023', null, 'number for bool rejected');
select throws_ok($$select set_limit('calling_window', '{"from":"25:00","to":"23:00"}', 'test')$$, '22023', null, 'bad hour rejected');
select throws_ok($$select set_limit('calling_window', '{"from":"07:00"}', 'test')$$, '22023', null, 'window without "to" rejected');
select throws_ok($$select set_limit('provider_blocked_hours', '[]', 'test')$$, '22023', null, 'empty window list rejected');
select throws_ok($$select set_limit('no_such_limit', '1', 'test')$$, '22023', null, 'unknown key rejected');
select is(limit_int('max_calls_per_request'), 6, 'a rejected change leaves the value as it was');

select lives_ok($$select set_limit('calling_window', '{"from":"21:00","to":"09:00"}', 'test')$$, 'window across midnight accepted');
select lives_ok($$select set_limit('max_calls_per_business_per_day', '3', 'test')$$, 'nullable limit set to a number');
select lives_ok($$select set_limit('max_calls_per_business_per_day', 'null', 'test')$$, 'nullable limit set back to off');

-- every change is logged
select is((select count(*)::int from limit_changes where key = 'max_calls_per_request'), 1,
          'one log row per accepted change, none for rejected ones');
select is((select old_value from limit_changes where key = 'max_calls_per_request'), '4'::jsonb,
          'log keeps the old value');
select is((select changed_by from limit_changes where key = 'max_calls_per_request'), 'wa:919800000001',
          'log keeps who changed it');

-- per-user override wins
select set_limit('max_calls_per_user_per_day', '2', 'test', 'a0000000-0000-0000-0000-000000000001');
select is(limit_int('max_calls_per_user_per_day', 'a0000000-0000-0000-0000-000000000001'), 2, 'override wins for that user');
select is(limit_int('max_calls_per_user_per_day'), 10, 'global value unchanged');
select is((select count(*)::int from limit_changes
            where key = 'max_calls_per_user_per_day' and user_id = 'a0000000-0000-0000-0000-000000000001'), 1,
          'override change is logged with the user');

select set_limit('max_calls_per_business_per_day', '5', 'test');
select set_limit('max_calls_per_business_per_day', 'null', 'test', 'a0000000-0000-0000-0000-000000000001');
select is(limit_int('max_calls_per_business_per_day', 'a0000000-0000-0000-0000-000000000001'), null,
          'a null override turns a limit off for that user');

select clear_user_limit('max_calls_per_user_per_day', 'a0000000-0000-0000-0000-000000000001', 'test');
select is(limit_int('max_calls_per_user_per_day', 'a0000000-0000-0000-0000-000000000001'), 10,
          'clearing the override restores the global value');

-- only the service role may change limits
select ok(not has_function_privilege('anon', 'set_limit(text, jsonb, text, uuid)', 'execute'),
          'anon cannot run set_limit');
select ok(not has_function_privilege('authenticated', 'reserve_call(uuid, text, uuid, boolean, timestamptz)', 'execute'),
          'authenticated cannot run reserve_call');
select ok(has_function_privilege('service_role', 'reserve_call(uuid, text, uuid, boolean, timestamptz)', 'execute'),
          'service role can run reserve_call');

select * from finish();
rollback;
