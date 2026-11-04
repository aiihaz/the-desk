-- 0023: the landing page's invite list.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$ select ('2026-11-04 ' || hhmm || ':00+05:30')::timestamptz $$;

-- A new number joins; the same number again changes nothing.
select is(join_waitlist('+919800000001', '@ihaz', 'ip-a', pg_temp.at('10:00')),
          '{"ok": true, "new": true}'::jsonb, 'a new number joins the list');
select is(join_waitlist('+919800000001', '@someone_else', 'ip-b', pg_temp.at('10:05')),
          '{"ok": true, "new": false}'::jsonb, 'the same number again is not a new signup');
select is((select count(*)::int from waitlist), 1, 'one row per number');
select is((select handle from waitlist), '@ihaz', 'a repeat can''t change the handle');
select is((select created_at from waitlist), pg_temp.at('10:00'), 'the first signup time is kept');
select is((select ip_hash from waitlist), 'ip-a', 'the first IP hash is kept');

-- Five new numbers an hour from one IP; a number already listed is never refused.
select join_waitlist('+91980000000' || i, '@x' || i, 'ip-a', pg_temp.at('10:10')) from generate_series(2, 5) i;
select is(join_waitlist('+919800000006', '@six', 'ip-a', pg_temp.at('10:20')),
          '{"ok": false, "reason": "rate_limited"}'::jsonb, 'the sixth new number in an hour is refused');
select is((select count(*)::int from waitlist where phone_e164 = '+919800000006'), 0, 'and is not stored');
select is(join_waitlist('+919800000002', '@two', 'ip-a', pg_temp.at('10:20')),
          '{"ok": true, "new": false}'::jsonb, 'a listed number from the same IP is still thanked');
select is(join_waitlist('+919800000006', '@six', 'ip-c', pg_temp.at('10:20')),
          '{"ok": true, "new": true}'::jsonb, 'another IP is not affected');
select is(join_waitlist('+919800000007', '@seven', 'ip-a', pg_temp.at('11:01')),
          '{"ok": true, "new": true}'::jsonb, 'an hour later the IP may add again');
select is(join_waitlist('+919800000008', '@eight', null, pg_temp.at('11:02')),
          '{"ok": true, "new": true}'::jsonb, 'no IP hash, no count');

select set_limit('max_waitlist_signups_per_ip_per_hour', 'null', 'test');
select join_waitlist('+91980000010' || i, '@y' || i, 'ip-d', pg_temp.at('12:00')) from generate_series(0, 9) i;
select is((select count(*)::int from waitlist where ip_hash = 'ip-d'), 10, 'a null limit turns the count off');

-- The hourly total holds whatever IP each request claims.
select set_limit('max_waitlist_signups_per_hour', '12', 'test');
select join_waitlist('+91980000020' || i, '@z' || i, 'ip-fake-' || i, pg_temp.at('12:30')) from generate_series(0, 1) i;
select is(join_waitlist('+919800000202', '@z2', 'ip-fake-2', pg_temp.at('12:30')),
          '{"ok": false, "reason": "rate_limited"}'::jsonb, 'the 13th new number in an hour is refused, new IP or not');
select is(join_waitlist('+919800000001', '@ihaz', 'ip-fake-3', pg_temp.at('12:30')),
          '{"ok": true, "new": false}'::jsonb, 'a listed number is still thanked when the list is full');
select is(join_waitlist('+919800000202', '@z2', 'ip-fake-2', pg_temp.at('13:31')),
          '{"ok": true, "new": true}'::jsonb, 'an hour later the list takes new numbers again');
select set_limit('max_waitlist_signups_per_hour', 'null', 'test');

-- The table guards its own values.
select throws_ok($$select join_waitlist('9800000001', '@a', null)$$, '23514', null, 'a number not in E.164 is refused');
select throws_ok($$select join_waitlist('+919800000099', '', null)$$, '23514', null, 'an empty handle is refused');

-- Only the service role reaches it.
select ok(not has_function_privilege('anon', 'join_waitlist(text, text, text, timestamptz)', 'execute'),
          'anon cannot call join_waitlist');
select ok((select relrowsecurity from pg_class where oid = 'waitlist'::regclass),
          'row level security with no policies: anon cannot read the list');
select is((select count(*)::int from pg_policies where tablename = 'waitlist'), 0, 'no policies on waitlist');

select * from finish();
rollback;
