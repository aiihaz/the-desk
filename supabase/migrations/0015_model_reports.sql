-- 0015_model_reports.sql: code settles what happened; the model writes what the user hears.
-- What the Desk owes a user is stored as facts, in the same transaction as what they report,
-- and written into a message afterwards (chat/tell.ts). A write that fails stays owed: there
-- is no code-written stand-in, so during an outage the update waits, an alert goes to the
-- review surface, and the message says it's late when it finally goes.

-- Schema --------------------------------------------------------------------------

alter table deliveries
  alter column message drop not null,
  -- What to tell the user: chat/tell.ts Facts. Pending with no message: still to be written.
  add column facts           jsonb,
  -- An options message: its consent prompt opens with the text the user actually gets.
  -- {"id", "option_ids"}
  add column prompt          jsonb,
  add column write_attempts  int not null default 0,
  add column written_at      timestamptz,
  add constraint deliveries_has_content check (message is not null or facts is not null);
create index deliveries_unwritten_idx on deliveries (next_attempt_at)
  where status = 'pending' and message is null;

insert into limits (key, value, value_type, nullable, description) values
  ('report_model',             'null',   'text', true,  'model that writes and checks messages to the user; null = luna_model'),
  ('report_reasoning_effort',  '"low"',  'text', false, 'reasoning effort for writing and checking a message'),
  ('report_alert_attempts',    '4',      'int',  false, 'failed writes of one message before the review surface is told'),
  ('report_late_minutes',      '10',     'int',  false, 'a message written this long after its facts says that it is late'),
  ('l3_promise_threshold_pct', '60',     'int',  false, 'Jev score above which a reply counts as promising a reminder');

-- Writing -------------------------------------------------------------------------

-- The next messages to write, oldest first, each leased so a second run doesn't take it.
create function take_unwritten(
  p_now      timestamptz default now(),
  p_limit    int default 20,
  p_call_id  uuid default null
) returns jsonb
language plpgsql as $$
declare
  res jsonb;
begin
  update deliveries d set status = 'dropped'
    from users u
   where u.id = d.user_id and d.status = 'pending' and d.message is null and d.kind <> 'report'
     and u.stopped_at is not null;

  with due as (
    select id from deliveries
     where status = 'pending' and message is null and next_attempt_at <= p_now
       and (p_call_id is null or call_id = p_call_id)
     order by next_attempt_at limit p_limit for update skip locked
  ), taken as (
    update deliveries d
       set write_attempts = write_attempts + 1, next_attempt_at = p_now + interval '2 minutes'
      from due where d.id = due.id
    returning d.id, d.user_id, d.request_id, d.facts, d.write_attempts, d.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'request_id', t.request_id, 'facts', t.facts,
           'write_attempts', t.write_attempts, 'created_at', t.created_at)), '[]')
    into res
    from taken t;
  return res;
end $$;

-- The message is written. An options message opens its prompt with exactly this text, so
-- what the user approves is what they read. If the errand moved on meanwhile the prompt
-- can't open, and the message still goes: it's what happened.
create function delivery_written(p_id uuid, p_message jsonb, p_now timestamptz default now())
returns void
language plpgsql as $$
declare
  d       deliveries;
  opened  jsonb;
  ids     uuid[];
  pid     uuid;
begin
  select * into d from deliveries where id = p_id;
  if not found or d.message is not null then
    return;
  end if;
  if d.prompt is not null then
    select array_agg(x::uuid) into ids from jsonb_array_elements_text(d.prompt -> 'option_ids') x;
    opened := open_prompt((d.prompt ->> 'id')::uuid, d.request_id, 'options', ids, 'yes',
                          p_message ->> 'body', p_message, p_now);
    if (opened ->> 'ok')::boolean then
      pid := (d.prompt ->> 'id')::uuid;
    end if;
  end if;
  update deliveries
     set message = p_message, prompt_id = pid, written_at = p_now, next_attempt_at = p_now, last_error = null
   where id = p_id;
end $$;

-- A write failed. It stays owed and is tried again, less and less often; the review surface
-- hears once. Nothing else is sent in its place.
create function delivery_unwritten(p_id uuid, p_error text, p_now timestamptz default now())
returns void
language plpgsql as $$
declare
  d deliveries;
begin
  select * into d from deliveries where id = p_id;
  update deliveries
     set last_error = p_error,
         next_attempt_at = p_now + make_interval(mins => least(power(2, d.write_attempts)::int, 30))
   where id = p_id;
  if d.write_attempts = limit_int('report_alert_attempts', d.user_id) then
    perform raise_alert('report_unwritten', d.request_id, d.call_id,
                        jsonb_build_object('delivery', d.id, 'error', p_error), p_now);
  end if;
end $$;

-- Something the user is owed that isn't a call result (a payment check, a call that couldn't
-- start). p_key: what it answers, so doing that twice can't owe it twice.
create function owe_facts(
  p_user_id     uuid,
  p_request_id  uuid,
  p_key         text,
  p_kind        text,
  p_facts       jsonb,
  p_now         timestamptz default now()
) returns void
language sql as $$
  insert into deliveries (user_id, request_id, dedupe_key, kind, facts, created_at, next_attempt_at)
  values (p_user_id, p_request_id, 'tell:' || p_key, p_kind, p_facts, p_now, p_now)
  on conflict (dedupe_key) do nothing;
$$;

-- As in 0012, only messages already written go out.
create or replace function take_deliveries(
  p_now      timestamptz default now(),
  p_limit    int default 50,
  p_call_id  uuid default null
) returns jsonb
language plpgsql as $$
declare
  res jsonb;
begin
  update deliveries d set status = 'dropped'
    from users u
   where u.id = d.user_id and d.status = 'pending' and d.kind <> 'report' and u.stopped_at is not null;

  with firsts as (
    select distinct on (coalesce(call_id::text, id::text)) id, next_attempt_at, message
      from deliveries
     where status = 'pending' and (p_call_id is null or call_id = p_call_id)
     order by coalesce(call_id::text, id::text), seq, created_at
  ), due as (
    select id from firsts
     where next_attempt_at <= p_now and message is not null
     order by next_attempt_at limit p_limit
  ), taken as (
    update deliveries d
       set attempts = attempts + 1, next_attempt_at = p_now + interval '2 minutes'
      from due where d.id = due.id
    returning d.id, d.user_id, d.message, d.attempts, d.kind, d.prompt_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'user_id', t.user_id, 'wa_id', u.wa_id, 'message', t.message,
           'attempts', t.attempts, 'kind', t.kind)), '[]')
    into res
    from taken t join users u on u.id = t.user_id;
  return res;
end $$;

-- Settling ------------------------------------------------------------------------

-- settle_call() and the facts the user is owed for it, in one transaction, so a crash or a
-- failed write can't lose the result. Replaces the 0012 version, whose caller wrote the
-- message first. p_facts: what to tell them. p_next: {"request_id", "facts"}, the waiting
-- errand, told only if it's the one that became current. p_end: the user asked to cancel
-- during the call and nothing was booked, so the errand ends here.
-- → settle_call()'s result; a redelivered call result finds nothing to settle.
drop function settle_and_report(uuid, text, jsonb, jsonb, boolean, jsonb, jsonb, jsonb, boolean, timestamptz);
create function settle_and_report(
  p_call_id  uuid,
  p_result   text,
  p_options  jsonb default '[]',
  p_booking  jsonb default null,
  p_opt_out  boolean default false,
  p_facts    jsonb default '{}',
  p_next     jsonb default null,
  p_end      boolean default false,
  p_now      timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  c      calls;
  res    jsonb;
  rid    uuid;
  st     text;
  bid    uuid;
  act    jsonb;
  facts  jsonb := p_facts;
begin
  res := settle_call(p_call_id, p_result, p_options, p_booking, p_opt_out, p_now);
  if not (res ->> 'ok')::boolean then
    return res;
  end if;
  select * into c from calls where id = p_call_id;
  rid := (res ->> 'request_id')::uuid;

  if p_booking is not null and p_result in ('done', 'advance') then
    select id into bid from bookings where request_id = rid order by created_at desc limit 1;
    update bookings
       set booked_on     = coalesce((p_booking ->> 'date')::date, booked_on),
           captured_time = coalesce(p_booking ->> 'captured', captured_time),
           approved_time = coalesce(p_booking ->> 'approved', approved_time)
     where id = bid;
  end if;

  if p_end then
    perform end_request(rid, 'cancelled', 'user', p_now);
  end if;
  select state into st from requests where id = rid;
  if request_group(st) = 'ended' then
    act := activate_queued(c.user_id, p_now);
  end if;
  if p_next is not null and act ->> 'request_id' = p_next ->> 'request_id' then
    facts := facts || jsonb_build_object('next_errand', p_next -> 'facts');
  end if;

  insert into deliveries (user_id, request_id, call_id, dedupe_key, kind, facts, prompt,
                          created_at, next_attempt_at)
  values (c.user_id, rid, c.id, 'call:' || c.id || ':report', 'report', facts,
          case when p_result = 'options' and not p_end
               then jsonb_build_object('id', gen_random_uuid(), 'option_ids', res -> 'option_ids') end,
          p_now, p_now);

  return res || jsonb_build_object('state', st);
end $$;

-- Follow-through ------------------------------------------------------------------

-- As in 0012, plus deadline: a payment deadline passed with nothing paid, told once. The
-- errand doesn't end: only the user closes it, and nothing says the business dropped it.
-- A payment reminder goes only while nothing has been paid. Each row carries the terms.
create or replace function due_follow_ups(p_now timestamptz default now()) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x), '[]') from (
    select r.id as request_id, r.user_id, 'reminder' as reason, r.task, r.state, r.fields,
           r.waiting_for, r.end_reason, b.name as place, null::numeric as amount_rs,
           null::timestamptz as deadline, null::jsonb as terms,
           extract(epoch from r.remind_at)::bigint as stamp
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
     where r.remind_at <= p_now and u.stopped_at is null
       and request_group(r.state) in ('before_consent', 'after_call_1', 'queued', 'awaiting_payment')
    union all
    select r.id, r.user_id, 'nudge', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           null, null, null, r.version
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
      join consent_prompts p on p.request_id = r.id and p.closed_at is null
     where r.state in ('awaiting_yes', 'awaiting_pick', 'stale_options')
       and r.paused_at is null and u.stopped_at is null
       and r.nudged_version is distinct from r.version
       and p.sent_at + make_interval(mins => limit_int('nudge_after_minutes', r.user_id)) <= p_now
       and coalesce(r.last_user_msg_at, p.sent_at) <= p.sent_at
    union all
    select r.id, r.user_id, 'payment', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           k.deposit_amount, k.payment_deadline, k.advance_terms, r.version
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
      join bookings k on k.request_id = r.id and k.status = 'advance_due'
     where r.state = 'awaiting_payment' and u.stopped_at is null
       and k.paid_reported_at is null
       and r.nudged_version is distinct from r.version
       and k.payment_deadline > p_now
       and k.payment_deadline - make_interval(mins => limit_int('payment_reminder_minutes', r.user_id)) <= p_now
    union all
    select r.id, r.user_id, 'deadline', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           k.deposit_amount, k.payment_deadline, k.advance_terms,
           extract(epoch from k.payment_deadline)::bigint
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
      join bookings k on k.request_id = r.id and k.status = 'advance_due'
     where r.state = 'awaiting_payment' and u.stopped_at is null
       and k.paid_reported_at is null and r.deadline_told_at is null
       and k.payment_deadline <= p_now
    union all
    select r.id, r.user_id, 'expired', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           null, null, null, r.version
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
     where r.state = 'expired' and r.notified_at is null and u.stopped_at is null
       and r.updated_at >= p_now - interval '1 day'
  ) x;
$$;

-- Stores the facts for one due_follow_ups() row and marks it told, in one transaction.
-- p_stamp is the row's own: a job that ran twice can't queue the same follow-up twice.
drop function queue_follow_up(uuid, text, bigint, jsonb, timestamptz);
create function queue_follow_up(
  p_request_id  uuid,
  p_reason      text,
  p_stamp       bigint,
  p_facts       jsonb,
  p_now         timestamptz default now()
) returns boolean
language plpgsql as $$
declare
  r  requests;
  n  int;
begin
  if p_reason not in ('reminder', 'nudge', 'payment', 'deadline', 'expired') then
    raise exception 'unknown follow-up: %', p_reason using errcode = '22023';
  end if;
  select * into r from requests where id = p_request_id;
  if not found then
    return false;
  end if;
  perform lock_user(r.user_id);
  insert into deliveries (user_id, request_id, dedupe_key, kind, facts, created_at, next_attempt_at)
  values (r.user_id, r.id, p_reason || ':' || r.id || ':' || p_stamp,
          case p_reason when 'reminder' then 'reminder'
                        when 'expired' then 'notice'
                        when 'deadline' then 'notice'
                        else 'nudge' end,
          p_facts, p_now, p_now)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;

  if p_reason = 'reminder' then
    update requests set remind_at = null, updated_at = p_now where id = r.id;
  elsif p_reason = 'expired' then
    update requests set notified_at = p_now where id = r.id;
  elsif p_reason = 'deadline' then
    update requests set deadline_told_at = p_now where id = r.id;
  else
    update requests set nudged_version = version where id = r.id;
  end if;
  return n > 0;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
