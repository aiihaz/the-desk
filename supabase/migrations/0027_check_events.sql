-- Diagnostics for the Desk's checks, in two tiers (checks.ts). Recording only: no check,
-- prompt or fallback reads these tables.
--
-- check_events: which check ran, what it decided, on which attempt, whether the writer's words
-- or a fallback went out, and the deployed code version. No conversation text: reasons are
-- short codes (the constraint holds them to that). Kept check_events_retention_days, and
-- erased with the user (the erasure job's user delete cascades).
--
-- check_details: a checker's own words, which can quote the user. Written only while an
-- investigation switches them on (check_details_until, for everyone or one user), never for
-- someone awaiting erasure, deleted at once when they ask for their data to be deleted, and
-- expired after check_details_retention_hours by an hourly job.
--
-- Completeness: every Luna turn, plan sent and report written records an event of its own,
-- so one without is a known gap (a lost write), not a silent undercount. check_events_since
-- says when recording began, so earlier work isn't counted as missing.

create table check_events (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  user_id       uuid not null references users on delete cascade,
  request_id    uuid references requests on delete set null,
  message_id    uuid references messages on delete set null,
  delivery_id   uuid references deliveries on delete set null,
  prompt_id     uuid references consent_prompts on delete set null,
  run_id        uuid,
  check_name    text not null check (check_name in ('plan_check', 'plan_source', 'report_check',
                  'report_source', 'reply_code', 'reply_jev', 'reply_promise', 'luna_turn', 'redirect',
                  'grounding', 'approval', 'diag_dropped')),
  outcome       text not null check (outcome in ('pass', 'reject', 'unusable', 'error', 'writer',
                  'readback', 'plain', 'fallback', 'template')),
  category      text check (category in ('fidelity', 'format', 'safety', 'obligation', 'consent',
                  'availability')),
  reason        text check (reason ~ '^[a-z0-9_:-]{1,60}$'),
  attempt       smallint check (attempt between 1 and 20),
  model         text check (length(model) <= 60),
  latency_ms    int check (latency_ms >= 0),
  code_version  text not null check (code_version ~ '^[a-z0-9_:-]{1,40}$'),
  -- What happened to the checker's own words: none given, kept (tier two), or not kept and why.
  detail        text not null default 'none' check (detail in ('none', 'kept', 'off', 'awaiting_erasure'))
);
create index check_events_at_idx on check_events (at);
create index check_events_user_idx on check_events (user_id);
create index check_events_check_idx on check_events (check_name, at);
alter table check_events enable row level security;

create table check_details (
  event_id  bigint primary key references check_events on delete cascade,
  user_id   uuid not null references users on delete cascade,
  at        timestamptz not null default now(),
  detail    text[] not null check (cardinality(detail) between 1 and 10)
);
create index check_details_at_idx on check_details (at);
create index check_details_user_idx on check_details (user_id);
alter table check_details enable row level security;

-- Service role only: no policies, and no table rights for the API's other roles.
revoke all on check_events, check_details from anon, authenticated;

insert into limits (key, value, value_type, nullable, description) values
  ('check_events_retention_days', '90', 'int', false,
   'check_events (no conversation text) are deleted after this many days'),
  ('check_details_retention_hours', '72', 'int', false,
   'check_details (checker words that can quote the user) are deleted after this many hours'),
  ('check_details_until', 'null', 'text', true,
   'checker words are kept while now is before this ISO time; null is off. Set per user to investigate one person'),
  ('check_events_since', to_jsonb(to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'text', false,
   'when check_events began: work before this has no events, which is not a gap. Not a setting');

-- Whether checker words are being kept for this user now. A malformed time is off.
create function check_details_on(p_user_id uuid, p_now timestamptz) returns boolean
language plpgsql stable as $$
declare until text := limit_text('check_details_until', p_user_id);
begin
  if until is null then return false; end if;
  return until::timestamptz > p_now;
exception when others then
  return false;
end $$;

-- One turn's or report's events. Each event is inserted on its own, so a malformed one is
-- counted (diag_dropped) instead of costing the rest. Nothing is kept for a user already
-- erased. p_wa_message_id: the message the turn answered, linked by its stored row.
create function record_checks(p_user_id uuid, p_events jsonb, p_version text,
  p_wa_message_id text default null, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare
  u users;
  msg uuid;
  keep boolean;
  e jsonb;
  ev bigint;
  words text[];
  version text := coalesce(nullif(p_version, ''), 'unknown');
  kept int := 0;
  bad int := 0;
begin
  select * into u from users where id = p_user_id;
  if not found then return jsonb_build_object('ok', true, 'recorded', 0); end if;
  if version !~ '^[a-z0-9_:-]{1,40}$' then version := 'unknown'; end if;
  if p_wa_message_id is not null then
    select id into msg from messages where user_id = p_user_id and wa_message_id = p_wa_message_id limit 1;
  end if;
  keep := u.delete_requested_at is null and check_details_on(p_user_id, p_now);
  for e in select x from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) x limit 60 loop
    begin
      words := case when jsonb_typeof(e -> 'detail') = 'array' then
        array(select left(d, 300) from jsonb_array_elements_text(e -> 'detail') d where length(trim(d)) > 0 limit 10)
        else '{}' end;
      insert into check_events (at, user_id, request_id, message_id, delivery_id, prompt_id, run_id,
        check_name, outcome, category, reason, attempt, model, latency_ms, code_version, detail)
      values (p_now, p_user_id, (e ->> 'request_id')::uuid, msg, (e ->> 'delivery_id')::uuid,
        (e ->> 'prompt_id')::uuid, (e ->> 'run_id')::uuid, e ->> 'check', e ->> 'outcome',
        e ->> 'category', e ->> 'reason', (e ->> 'attempt')::smallint, e ->> 'model',
        (e ->> 'latency_ms')::int, version,
        case when cardinality(words) = 0 then 'none'
             when u.delete_requested_at is not null then 'awaiting_erasure'
             when keep then 'kept' else 'off' end)
      returning id into ev;
      if keep and cardinality(words) > 0 then
        insert into check_details (event_id, user_id, at, detail) values (ev, p_user_id, p_now, words);
      end if;
      kept := kept + 1;
    exception when others then
      bad := bad + 1;
    end;
  end loop;
  if bad > 0 or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 60 then
    insert into check_events (at, user_id, message_id, check_name, outcome, reason, code_version)
    values (p_now, p_user_id, msg, 'diag_dropped', 'error',
      'rejected:' || (bad + greatest(jsonb_array_length(coalesce(p_events, '[]'::jsonb)) - 60, 0)), version);
  end if;
  return jsonb_build_object('ok', true, 'recorded', kept, 'dropped', bad);
end $$;

create function purge_check_details(p_now timestamptz default now()) returns int
language plpgsql as $$
declare n int;
begin
  delete from check_details
    where at < p_now - make_interval(hours => limit_int('check_details_retention_hours'));
  get diagnostics n = row_count;
  return n;
end $$;

-- As in 0022, plus both diagnostic tiers.
create or replace function purge_old_data(p_now timestamptz default now()) returns jsonb language plpgsql as $$
declare res jsonb;
begin
  res := desk_private.purge_old_data(p_now);
  delete from model_usage where at < p_now - make_interval(days => limit_int('transcript_retention_days'));
  delete from check_events where at < p_now - make_interval(days => limit_int('check_events_retention_days'));
  perform purge_check_details(p_now);
  return res;
end $$;

-- As in 0026, plus the checker words about them, which are conversation text: gone at once.
-- Their check_events (no text) go with the user row when erasure completes.
create or replace function request_data_deletion(p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  res jsonb;
begin
  res := stop_user(p_user_id, p_now);
  update users set delete_requested_at = coalesce(delete_requested_at, p_now) where id = p_user_id;
  delete from user_memories where user_id = p_user_id;
  delete from user_addresses where user_id = p_user_id;
  delete from check_details where user_id = p_user_id;
  return res;
end $$;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not available: check_details purge not scheduled';
    return;
  end if;
  perform cron.schedule('desk-check-details', '17 * * * *', 'select purge_check_details()');
exception when others then
  raise notice 'check_details purge not scheduled: %', sqlerrm;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
