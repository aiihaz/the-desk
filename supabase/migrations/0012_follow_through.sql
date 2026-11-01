-- 0012_follow_through.sql: the Desk finishes what it took on. Errands record what they
-- are waiting for and can carry a reminder. What a call established is stored with the
-- settlement and sent through a tracked delivery, so a failed send is retried instead of
-- lost. The user's facts and preferences are kept, visibly (user_memories). A booking
-- keeps what the caller captured beside what the user approved. A call needs its consent
-- as proof and a pinned, tested caller setup. Jev gets a pinned model.

-- Schema --------------------------------------------------------------------------

alter table requests
  -- What this errand is waiting for, in plain words, and when to bring it up again.
  add column waiting_for          text,
  add column remind_at            timestamptz,
  -- The request version the last automatic nudge went out for: once per plan.
  add column nudged_version       int,
  -- The user was told this errand expired.
  add column notified_at          timestamptz,
  -- "Cancel" while the call was live: the call can't be stopped, so it ends the errand
  -- when the result comes (settle_and_report).
  add column cancel_requested_at  timestamptz;

alter table bookings
  -- The call gave a date and no time. Never a fabricated midnight: time stays null.
  add column booked_on         date,
  -- What the caller reported, as it came, and what the user approved.
  add column captured_time     text,
  add column approved_time     text,
  -- {from, to, why}: the stored date was corrected from the captured one.
  add column time_correction   jsonb;

-- The consent that allowed this call: no proof, no call (check_dial, reserve_call).
alter table calls add column consent_id uuid references consents on delete set null;

-- The caller instructions a version's test suite passed on.
alter table gate_passes add column instructions_sha256 text;

-- What the Desk keeps about a user: said ("remember I'm vegetarian") or learned from a
-- correction and told to them. Text for Luna to fill details with, which the plan then
-- shows back. Never a permission: nothing in the approval or dial path reads this table.
create table user_memories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users on delete cascade,
  kind          text not null check (kind in ('fact', 'preference')),
  -- all | booking | question | place:<name>
  scope         text not null default 'all',
  text          text not null check (char_length(text) between 1 and 200),
  source        text not null check (source in ('said', 'learned')),
  -- learned: the user's own words it came from.
  evidence      text,
  created_at    timestamptz not null default now(),
  forgotten_at  timestamptz
);
create unique index user_memories_live_idx on user_memories (user_id, lower(text)) where forgotten_at is null;
alter table user_memories enable row level security;

-- One row per message the Desk owes a user outside a turn: call reports, reminders,
-- nudges, notices. Written in the same transaction as what it reports.
create table deliveries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users on delete cascade,
  request_id       uuid references requests on delete set null,
  call_id          uuid references calls on delete set null,
  -- An options message: its message id goes on the prompt once sent.
  prompt_id        uuid references consent_prompts on delete set null,
  -- report parts: call:<id>:<part>. A redelivered result can't queue a part twice.
  dedupe_key       text not null unique,
  -- report: what the user is owed whatever else happens, even after STOP.
  kind             text not null check (kind in ('report', 'reminder', 'nudge', 'notice')),
  seq              int not null default 0,
  message          jsonb not null,
  status           text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'dropped')),
  attempts         int not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  wa_message_id    text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index deliveries_due_idx on deliveries (next_attempt_at) where status = 'pending';
alter table deliveries enable row level security;

-- When each scheduled job last finished, so health can tell a job that never runs.
create table job_runs (
  name        text primary key,
  last_ok_at  timestamptz not null,
  detail      jsonb not null default '{}'
);
alter table job_runs enable row level security;

insert into limits (key, value, value_type, nullable, description) values
  ('nudge_after_minutes',       '180',  'int',  false, 'a plan or option list unanswered this long gets one reminder'),
  ('payment_reminder_minutes',  '30',   'int',  false, 'reminder this long before a held booking''s payment deadline'),
  ('delivery_max_attempts',     '6',    'int',  false, 'tries for one owed message before it is failed and alerted'),
  ('max_memories_per_user',     '30',   'int',  false, 'facts and preferences kept per user'),
  ('follow_up_template',        'null', 'text', true,  'approved WhatsApp template with one body parameter, for messages outside the 24-hour window'),
  ('agent_instructions_sha256', 'null', 'text', true,  'sha256 of the caller instructions in use (agent/instructions.md); a call needs a passed gate on this hash');

-- The version jev-latest resolved to on 1 Nov 2026 (E4 design 3: never jev-latest).
update limits set value = '"jev-1.14.0"' where key = 'jev_model' and value = 'null';
-- From live scores (dev/jev_eval.ts): fine replies reached 0.46 ("You're welcome!"),
-- off-task help started at 0.88. The placeholder 30 would have refused small talk.
update limits set value = '70' where key = 'l3_offtask_threshold_pct';

-- Follow-through ------------------------------------------------------------------

-- What an errand is waiting for. p_remind_at null: no reminder. Doesn't touch the plan.
-- → {"ok": true} | {"ok": false, "reason"}
create function set_follow_up(
  p_request_id   uuid,
  p_waiting_for  text,
  p_remind_at    timestamptz,
  p_now          timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  r requests;
begin
  select * into r from requests where id = p_request_id;
  if not found then
    return chat_refused('no_request');
  end if;
  perform lock_user(r.user_id);
  select * into r from requests where id = p_request_id;
  if request_group(r.state) = 'ended' then
    return chat_refused('not_active');
  end if;
  update requests set waiting_for = p_waiting_for, remind_at = p_remind_at, updated_at = p_now
   where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- The errands the Desk owes the user a word about. One row per reason:
--   reminder:  a reminder fell due, paused or not: "hold on, remind me at 6" is both;
--   nudge:     a plan or option list has waited nudge_after_minutes, once per version;
--   payment:   a held booking's deadline is near, once per version;
--   expired:   an errand ended without an answer, in the last day, not yet told.
create function due_follow_ups(p_now timestamptz default now()) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x), '[]') from (
    select r.id as request_id, r.user_id, 'reminder' as reason, r.task, r.state, r.fields,
           r.waiting_for, r.end_reason, b.name as place, null::numeric as amount_rs, null::timestamptz as deadline,
           extract(epoch from r.remind_at)::bigint as stamp
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
     where r.remind_at <= p_now and u.stopped_at is null
       and request_group(r.state) in ('before_consent', 'after_call_1', 'queued', 'awaiting_payment')
    union all
    select r.id, r.user_id, 'nudge', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           null, null, r.version
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
      join consent_prompts p on p.request_id = r.id and p.closed_at is null
     where r.state in ('awaiting_yes', 'awaiting_pick', 'stale_options')
       and r.paused_at is null and u.stopped_at is null
       and r.nudged_version is distinct from r.version
       and p.sent_at + make_interval(mins => limit_int('nudge_after_minutes', r.user_id)) <= p_now
       and coalesce(r.last_user_msg_at, p.sent_at) <= p.sent_at
    union all
    select r.id, r.user_id, 'payment', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           k.deposit_amount, k.payment_deadline, r.version
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
      join bookings k on k.request_id = r.id and k.status = 'held_pending_deposit'
     where r.state = 'awaiting_payment' and u.stopped_at is null
       and r.nudged_version is distinct from r.version
       and k.payment_deadline > p_now
       and k.payment_deadline - make_interval(mins => limit_int('payment_reminder_minutes', r.user_id)) <= p_now
    union all
    select r.id, r.user_id, 'expired', r.task, r.state, r.fields, r.waiting_for, r.end_reason, b.name,
           null, null, r.version
      from requests r join users u on u.id = r.user_id left join businesses b on b.id = r.business_id
     where r.state = 'expired' and r.notified_at is null and u.stopped_at is null
       and r.updated_at >= p_now - interval '1 day'
  ) x;
$$;

-- Queues the message for one due_follow_ups() row and marks it told, in one transaction.
-- p_stamp is the row's own: a job that ran twice can't queue the same follow-up twice.
create function queue_follow_up(
  p_request_id  uuid,
  p_reason      text,
  p_stamp       bigint,
  p_message     jsonb,
  p_now         timestamptz default now()
) returns boolean
language plpgsql as $$
declare
  r  requests;
  n  int;
begin
  if p_reason not in ('reminder', 'nudge', 'payment', 'expired') then
    raise exception 'unknown follow-up: %', p_reason using errcode = '22023';
  end if;
  select * into r from requests where id = p_request_id;
  if not found then
    return false;
  end if;
  perform lock_user(r.user_id);
  insert into deliveries (user_id, request_id, dedupe_key, kind, message, created_at, next_attempt_at)
  values (r.user_id, r.id, p_reason || ':' || r.id || ':' || p_stamp,
          case p_reason when 'reminder' then 'reminder' when 'expired' then 'notice' else 'nudge' end,
          p_message, p_now, p_now)
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;

  if p_reason = 'reminder' then
    update requests set remind_at = null, updated_at = p_now where id = r.id;
  elsif p_reason = 'expired' then
    update requests set notified_at = p_now where id = r.id;
  else
    update requests set nudged_version = version where id = r.id;
  end if;
  return n > 0;
end $$;

-- The next messages due, oldest first: the first unsent part of each call, so a report's
-- parts arrive in order and a failed part holds back the ones after it. Each one taken
-- is leased, so a second run doesn't take it too. Nudges and reminders to a stopped user
-- are dropped; a report isn't, because it says what happened to a call they asked for.
create function take_deliveries(
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
    select distinct on (coalesce(call_id::text, id::text)) id, next_attempt_at
      from deliveries
     where status = 'pending' and (p_call_id is null or call_id = p_call_id)
     order by coalesce(call_id::text, id::text), seq, created_at
  ), due as (
    select id from firsts where next_attempt_at <= p_now order by next_attempt_at limit p_limit
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

create function delivery_sent(p_id uuid, p_wa_message_id text, p_now timestamptz default now())
returns void
language plpgsql as $$
declare
  d deliveries;
begin
  update deliveries set status = 'sent', sent_at = p_now, wa_message_id = p_wa_message_id,
                        last_error = null
   where id = p_id returning * into d;
  if d.prompt_id is not null then
    perform prompt_sent(d.prompt_id, p_wa_message_id);
  end if;
end $$;

-- A reply whose send failed during a turn: owed, like any other message. p_key is the
-- inbound message it answers, so a retried turn can't owe it twice.
create function owe_message(
  p_user_id     uuid,
  p_request_id  uuid,
  p_key         text,
  p_message     jsonb,
  p_now         timestamptz default now()
) returns void
language sql as $$
  insert into deliveries (user_id, request_id, dedupe_key, kind, message, created_at, next_attempt_at)
  values (p_user_id, p_request_id, 'reply:' || p_key, 'report', p_message, p_now,
          p_now + interval '1 minute')
  on conflict (dedupe_key) do nothing;
$$;

-- Backs off and tries again, up to delivery_max_attempts. p_final: another try can't
-- help (outside the 24-hour window with no template). A message that can't arrive
-- becomes an alert: the user is owed something and nobody else knows.
create function delivery_failed(
  p_id     uuid,
  p_error  text,
  p_final  boolean default false,
  p_now    timestamptz default now()
) returns text
language plpgsql as $$
declare
  d deliveries;
begin
  select * into d from deliveries where id = p_id;
  if p_final or d.attempts >= limit_int('delivery_max_attempts', d.user_id) then
    update deliveries set status = 'failed', last_error = p_error where id = p_id;
    perform raise_alert('delivery_failed', d.request_id, d.call_id,
                        jsonb_build_object('delivery', d.id, 'kind', d.kind, 'error', p_error), p_now);
    return 'failed';
  end if;
  update deliveries
     set last_error = p_error,
         next_attempt_at = p_now + make_interval(mins => least(power(2, d.attempts)::int, 60))
   where id = p_id;
  return 'pending';
end $$;

-- Asked to cancel while the call runs: it ends with the result, and the user is told how.
create function request_cancel_after_call(p_request_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  r requests;
begin
  select * into r from requests where id = p_request_id;
  if not found then
    return chat_refused('no_request');
  end if;
  perform lock_user(r.user_id);
  select * into r from requests where id = p_request_id;
  if request_group(r.state) <> 'in_flight' then
    return chat_refused('not_calling');
  end if;
  update requests set cancel_requested_at = p_now, updated_at = p_now where id = r.id;
  return jsonb_build_object('ok', true);
end $$;

-- settle_call() and everything the user is owed for it, in one transaction, so a crash
-- or a failed send can't lose the result. p_parts: [{"key", "message"}], in order.
-- p_prompt: {"id", "text", "message"}, the options message. p_next: {"request_id",
-- "message"}, said only if that errand is the one that became current. p_end: the user
-- asked to cancel during the call and nothing was booked, so the errand ends here.
-- → settle_call()'s result; a redelivered call result finds nothing to settle.
create function settle_and_report(
  p_call_id  uuid,
  p_result   text,
  p_options  jsonb default '[]',
  p_booking  jsonb default null,
  p_opt_out  boolean default false,
  p_parts    jsonb default '[]',
  p_prompt   jsonb default null,
  p_next     jsonb default null,
  p_end      boolean default false,
  p_now      timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  c     calls;
  res   jsonb;
  rid   uuid;
  ids   uuid[];
  st    text;
  bid   uuid;
  part  jsonb;
  i     int := 0;
  act   jsonb;
begin
  res := settle_call(p_call_id, p_result, p_options, p_booking, p_opt_out, p_now);
  if not (res ->> 'ok')::boolean then
    return res;
  end if;
  select * into c from calls where id = p_call_id;
  rid := (res ->> 'request_id')::uuid;

  if p_booking is not null and p_result in ('done', 'held') then
    select id into bid from bookings where request_id = rid order by created_at desc limit 1;
    update bookings
       set booked_on       = coalesce((p_booking ->> 'date')::date, booked_on),
           captured_time   = coalesce(p_booking ->> 'captured', captured_time),
           approved_time   = coalesce(p_booking ->> 'approved', approved_time),
           time_correction = coalesce(p_booking -> 'correction', time_correction)
     where id = bid;
    if p_booking -> 'correction' is not null and jsonb_typeof(p_booking -> 'correction') = 'object' then
      perform raise_alert('booking_date_corrected', rid, c.id, p_booking -> 'correction', p_now);
    end if;
  end if;

  if p_prompt is not null then
    select array_agg(x::uuid) into ids from jsonb_array_elements_text(res -> 'option_ids') x;
    perform open_prompt((p_prompt ->> 'id')::uuid, rid, 'options', ids, 'yes',
                        p_prompt ->> 'text', p_prompt -> 'message', p_now);
    insert into deliveries (user_id, request_id, call_id, prompt_id, dedupe_key, kind, seq, message,
                            created_at, next_attempt_at)
    values (c.user_id, rid, c.id, (p_prompt ->> 'id')::uuid, 'call:' || c.id || ':options', 'report', i,
            p_prompt -> 'message', p_now, p_now);
    i := i + 1;
  end if;

  if p_end then
    perform end_request(rid, 'cancelled', 'user', p_now);
  end if;

  select state into st from requests where id = rid;
  if request_group(st) = 'ended' then
    act := activate_queued(c.user_id, p_now);
  end if;
  for part in select * from jsonb_array_elements(p_parts) loop
    insert into deliveries (user_id, request_id, call_id, dedupe_key, kind, seq, message,
                            created_at, next_attempt_at)
    values (c.user_id, rid, c.id, 'call:' || c.id || ':' || (part ->> 'key'), 'report', i,
            part -> 'message', p_now, p_now);
    i := i + 1;
  end loop;
  if p_next is not null and act ->> 'request_id' = p_next ->> 'request_id' then
    insert into deliveries (user_id, request_id, call_id, dedupe_key, kind, seq, message,
                            created_at, next_attempt_at)
    values (c.user_id, (p_next ->> 'request_id')::uuid, c.id, 'call:' || c.id || ':next', 'report', i,
            p_next -> 'message', p_now, p_now);
  end if;

  return res || jsonb_build_object('state', st);
end $$;

-- Deleting data takes the memories with it at once.
create or replace function request_data_deletion(p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  res jsonb;
begin
  res := stop_user(p_user_id, p_now);
  update users set delete_requested_at = coalesce(delete_requested_at, p_now) where id = p_user_id;
  delete from user_memories where user_id = p_user_id;
  return res;
end $$;

-- A scheduled job finished.
create function job_ran(p_name text, p_detail jsonb default '{}', p_now timestamptz default now())
returns void
language sql as $$
  insert into job_runs (name, last_ok_at, detail) values (p_name, p_now, p_detail)
  on conflict (name) do update set last_ok_at = excluded.last_ok_at, detail = excluded.detail;
$$;

-- The newest migration applied here, so health can say which schema is running.
create function schema_version() returns text
language plpgsql stable security definer as $$
declare
  v text;
begin
  execute 'select max(version) from supabase_migrations.schema_migrations' into v;
  return v;
exception when others then
  return null;
end $$;

-- Dialling ------------------------------------------------------------------------
-- check_dial() as in 0011, then two more refusals, and its result names the consent:
--   the caller setup: the active version must have a passed gate on the pinned hash of
--   the instructions, so a version that drifted, or was never tested, can't dial;
--   the proof: the exact consent this call rests on. reserve_call keeps it on the call.
alter function check_dial(uuid, text, uuid, boolean, timestamptz) rename to check_dial_base;

create function check_dial(
  p_request_id  uuid,
  p_kind        text,
  p_option_id   uuid default null,
  p_is_retry    boolean default false,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql stable as $$
declare
  res     jsonb;
  r       requests;
  pin     text;
  gated   text;
  cid     uuid;
begin
  res := check_dial_base(p_request_id, p_kind, p_option_id, p_is_retry, p_now);
  if not (res ->> 'ok')::boolean then
    return res;
  end if;

  pin := limit_text('agent_instructions_sha256');
  if pin is null then
    return dial_refused('no_instructions_pin');
  end if;
  select g.instructions_sha256 into gated from gate_passes g
   where g.agent_version = res ->> 'agent_version' and g.passed;
  if gated is distinct from pin then
    return dial_refused('agent_instructions_mismatch');
  end if;

  select * into r from requests where id = p_request_id;
  select k.id into cid from consents k
   where k.request_id = r.id and k.voided_at is null and k.request_version = r.version
     and k.kind = case when p_kind = 'payment_confirm' then 'pay'
                       when p_option_id is not null then 'book'
                       else 'ask' end
     and (p_option_id is null or k.option_id = p_option_id)
   order by k.at desc limit 1;
  if cid is null then
    return dial_refused('no_consent');
  end if;
  return res || jsonb_build_object('consent_id', cid);
end $$;

create or replace function reserve_call(
  p_request_id  uuid,
  p_kind        text,
  p_option_id   uuid default null,
  p_is_retry    boolean default false,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  r    requests;
  ph   text;
  res  jsonb;
  cid  uuid;
begin
  select * into r from requests where id = p_request_id;
  if not found then
    return dial_refused('no_request');
  end if;
  select phone_e164 into ph from businesses where id = r.business_id;

  perform pg_advisory_xact_lock(hashtextextended('desk:user:' || r.user_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('desk:request:' || r.id, 0));
  if ph is not null then
    perform pg_advisory_xact_lock(hashtextextended('desk:phone:' || ph, 0));
  end if;

  if user_stopped(r.user_id) then
    return dial_refused('user_stopped');
  end if;

  res := check_dial(p_request_id, p_kind, p_option_id, p_is_retry, p_now);
  if not (res ->> 'ok')::boolean then
    return res;
  end if;

  insert into calls (request_id, user_id, business_id, caller_number_id, kind,
                     option_id, is_retry, agent_version, consent_id, created_at)
  values (r.id, r.user_id, r.business_id, (res ->> 'caller_number_id')::uuid, p_kind,
          p_option_id, p_is_retry, res ->> 'agent_version', (res ->> 'consent_id')::uuid, p_now)
  returning id into cid;

  update requests
     set caller_number_id = coalesce(caller_number_id, (res ->> 'caller_number_id')::uuid),
         updated_at = p_now
   where id = r.id;

  return res || jsonb_build_object('call_id', cid);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;

-- Schedule ------------------------------------------------------------------------
-- Reminders and owed messages go out from reconcile, so it runs every 5 minutes now.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('desk-reconcile', '*/5 * * * *', 'select call_edge_function(''reconcile'')');
  end if;
exception when others then
  raise notice 'reconcile not rescheduled: %', sqlerrm;
end $$;
