-- 0004_chat.sql: the chat agent's state machine (E4 design, sections 2.5 and 2.8).
-- Code owns the request state. Every change goes through a function here, so a
-- version bump always closes the open prompts and voids the open approvals in the
-- same transaction. No model ever calls these; the chat-agent code does.

-- Schema --------------------------------------------------------------------

alter table users add column city text;
alter table businesses add column address text;
alter table user_places add column aliases text[] not null default '{}';

alter table requests drop constraint requests_state_check;
alter table requests add constraint requests_state_check check (state in (
  'collecting', 'choosing_place', 'confirming', 'awaiting_yes',
  'calling_1', 'options_ready', 'awaiting_pick', 'calling_2',
  'verifying', 'done', 'awaiting_payment', 'stale_options', 'cancelled',
  'queued', 'expired'));
alter table requests drop constraint requests_task_check;
alter table requests add constraint requests_task_check
  check (task in ('booking', 'question', 'reschedule', 'cancel'));
alter table requests
  add column version          int not null default 1,
  add column end_reason       text check (end_reason in (
                                'done', 'user', 'replaced', 'expired', 'window_passed', 'limit')),
  add column booking_id       uuid references bookings on delete set null,
  add column last_user_msg_at timestamptz;

-- One active request per user. Queued, ended and awaiting_payment requests don't count.
create unique index requests_one_active on requests (user_id) where state in (
  'collecting', 'choosing_place', 'confirming', 'awaiting_yes',
  'calling_1', 'options_ready', 'awaiting_pick', 'calling_2', 'verifying', 'stale_options');

alter table options
  add column voided_at   timestamptz,
  add column void_reason text;

alter table bookings drop constraint bookings_status_check;
alter table bookings add constraint bookings_status_check check (status in (
  'booked', 'held_pending_deposit', 'probably_booked', 'cancelled', 'unconfirmed'));

-- Each read-back, option list and Book-it confirmation is a prompt. A consent
-- counts only against an open prompt for the request's current version.
create table consent_prompts (
  id               uuid primary key,
  request_id       uuid not null references requests on delete cascade,
  request_version  int not null,
  -- ask = read-back (consent #1); options = the option list; book = one option's Book-it button.
  kind             text not null check (kind in ('ask', 'options', 'book')),
  option_ids       uuid[] not null default '{}',
  -- The word that approves it. 'cancel' when the read-back states a possible loss (2.9).
  confirm_word     text not null default 'yes' check (confirm_word in ('yes', 'cancel')),
  text_shown       text not null,
  -- The exact WhatsApp message, so a re-send is identical.
  message          jsonb not null,
  wa_message_id    text,
  -- Every WhatsApp message that showed this prompt (first send and re-sends),
  -- so a quote-reply to any of them binds to this prompt.
  sent_ids         text[] not null default '{}',
  sent_at          timestamptz not null default now(),
  closed_at        timestamptz,
  close_reason     text,
  check ((kind = 'ask') = (cardinality(option_ids) = 0)),
  check (kind <> 'book' or cardinality(option_ids) = 1)
);
create index consent_prompts_open_idx on consent_prompts (request_id) where closed_at is null;
create index consent_prompts_wa_idx on consent_prompts (wa_message_id);

-- Default 1 matches a new request's version, so rows written before 0004 stay valid.
alter table consents
  add column request_version int not null default 1,
  add column prompt_id       uuid references consent_prompts on delete set null,
  add column voided_at       timestamptz,
  add column void_reason     text check (void_reason in (
                               'edited', 'replaced', 'expired', 'cancelled',
                               'reopened', 'reactivated', 'options_changed'));

create table reply_templates (
  key         text not null,
  language    text not null,
  text        text not null,
  updated_by  text not null default 'seed',
  updated_at  timestamptz not null default now(),
  primary key (key, language)
);

create table router_log (
  id             bigint generated always as identity primary key,
  message_id     uuid references messages on delete cascade,
  request_id     uuid references requests on delete set null,
  jev_mode       text not null,
  model          text,
  intent         text,
  probabilities  jsonb,
  injection      numeric,
  mode           text check (mode in ('task', 'redirect', 'rec')),
  luna_tools     text[],
  l3_result      text check (l3_result in ('pass', 'retry_pass', 'fallback')),
  l3_failed      text[],
  latency_ms     int,
  at             timestamptz not null default now()
);

alter table consent_prompts enable row level security;
alter table reply_templates enable row level security;
alter table router_log      enable row level security;

-- English only for now. hi, ml and ta need a native speaker's wording (E4 design 2.3);
-- until then other languages get English and the gap is logged.
insert into reply_templates (key, language, text) values
  ('fallback_generic',    'en', 'Sorry, that got stuck on my side. Could you send it again?'),
  ('fallback_known',      'en', 'Sorry, that got stuck on my side. So far I have: {details}. Send the rest and I''ll carry on.'),
  ('offscope_limit',      'en', 'I can only make calls to businesses for you. Tell me one and I''ll take it from there.'),
  ('daily_cap',           'en', 'That''s a lot of messages for one day, so I''ll reply again after midnight. STOP still works any time.'),
  ('stale_approval',      'en', 'That one was for an earlier version, so I didn''t act on it. This is the current plan:'),
  ('stale_approval_none', 'en', 'That was for an earlier plan, so I didn''t act on it.');

-- Ihaz, 25 Oct: an exact time means that time. 8:15 for "8 pm" is not a match; it comes
-- back to the user as an option. A fuzzy time ("around 8") is a window instead.
select set_limit('match_tolerance_minutes', '0', 'Ihaz, 25 Oct: an exact time means that time');

-- Placeholders, like every limit (E4 design 5). Set the router thresholds from shadow-mode data.
insert into limits (key, value, value_type, nullable, description) values
  ('jev_mode',                              '"shadow"', 'text', false, 'off | shadow | gate (E4 design 4)'),
  ('jev_model',                             'null',     'text', true,  'pinned Jev model name; never jev-latest'),
  ('router_offscope_threshold_pct',         '85',       'int',  false, 'Jev off_scope probability (%) for redirect mode'),
  ('router_injection_threshold_pct',        '80',       'int',  false, 'Jev injection probability (%) for redirect mode'),
  ('router_timeout_ms',                     '1500',     'int',  false, 'Jev timeout; on timeout the message goes to task mode'),
  ('l3_claims_threshold_pct',               '50',       'int',  false, 'L3 claims_action probability (%) that fails a reply'),
  ('l3_offtask_threshold_pct',              '30',       'int',  false, 'L3 off_task_content probability (%) that fails a reply'),
  ('luna_redirect_max_tokens',              '80',       'int',  false, 'max output tokens in redirect mode'),
  ('max_luna_redirects_per_user_per_day',   '5',        'int',  false, 'then the offscope_limit template, never silence'),
  ('request_idle_expiry_hours',             '12',       'int',  false, 'an idle request before consent, or after call 1, expires'),
  ('rec_enabled',                           'false',    'bool', false, 'Google-rated recommendations (off for v1, Oct 24)'),
  ('rec_min_reviews',                       '50',       'int',  false, 'recommendations: minimum Google reviews'),
  ('rec_count',                             '3',        'int',  false, 'recommendations: places shown'),
  ('max_recommendations_per_user_per_day',  '5',        'int',  false, 'recommendations per user per day'),
  ('max_inbound_per_user_per_day',          '60',       'int',  false, 'then one daily_cap message; later messages are stored, not answered'),
  ('max_luna_calls_per_request',            '30',       'int',  false, 'Luna turns for one request'),
  ('luna_model',                            '"gpt-6-luna"', 'text', false, 'OpenAI model for the chat agent; pinned, never an alias'),
  ('luna_reasoning_effort',                 '"low"',    'text', false, 'Responses API reasoning effort for Luna: none | low | medium'),
  ('max_advance_rs',                        '500',      'int',  false, 'largest UPI advance the read-back offers to hold (eng plan 2.1)');

-- State groups (E4 design 2.5) -------------------------------------------------

create function request_group(p_state text) returns text
language sql immutable as $$
  select case
    when p_state in ('collecting', 'choosing_place', 'confirming', 'awaiting_yes') then 'before_consent'
    when p_state in ('options_ready', 'awaiting_pick', 'stale_options') then 'after_call_1'
    when p_state in ('calling_1', 'calling_2', 'verifying') then 'in_flight'
    when p_state = 'queued' then 'queued'
    when p_state = 'awaiting_payment' then 'awaiting_payment'
    else 'ended'
  end
$$;

create function chat_refused(p_reason text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'reason', p_reason)
$$;

-- Same lock key as reserve_call(), so a chat change and a dial for one user never interleave.
create function lock_user(p_user_id uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended('desk:user:' || p_user_id, 0))
$$;

-- The one way to change a request's version. Closes every open prompt and voids
-- every open approval and option. Callers insert new options after this, not before.
create function bump_request(p_request_id uuid, p_reason text, p_now timestamptz)
returns int
language plpgsql as $$
declare
  v int;
begin
  update requests set version = version + 1, updated_at = p_now
   where id = p_request_id returning version into v;
  update consent_prompts set closed_at = p_now, close_reason = p_reason
   where request_id = p_request_id and closed_at is null;
  update consents set voided_at = p_now, void_reason = p_reason
   where request_id = p_request_id and voided_at is null;
  update options set voided_at = p_now, void_reason = p_reason
   where request_id = p_request_id and voided_at is null;
  return v;
end $$;

create function end_request(p_request_id uuid, p_state text, p_end_reason text, p_now timestamptz)
returns void
language plpgsql as $$
begin
  perform bump_request(p_request_id,
    case p_end_reason when 'replaced' then 'replaced'
                      when 'user' then 'cancelled'
                      else 'expired' end,
    p_now);
  update requests set state = p_state, end_reason = p_end_reason, updated_at = p_now
   where id = p_request_id;
end $$;

-- Lifecycle ----------------------------------------------------------------

-- Starts a request for this task. A request before consent or waiting on the
-- user after call 1 is replaced. One in flight can't be, so the new one is queued
-- and becomes active after the report (activate_queued). A queued request is
-- replaced by a newer one.
-- → {"ok": true, "request_id", "state", "replaced_request_id"}
create function start_request(p_user_id uuid, p_task text, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  cur       requests;
  replaced  uuid;
  st        text := 'collecting';
  rid       uuid;
begin
  perform lock_user(p_user_id);

  for cur in select * from requests
              where user_id = p_user_id
                and request_group(state) in ('before_consent', 'after_call_1', 'in_flight', 'queued')
              order by created_at loop
    if request_group(cur.state) = 'in_flight' then
      st := 'queued';
    else
      perform end_request(cur.id, 'cancelled', 'replaced', p_now);
      replaced := cur.id;
    end if;
  end loop;

  insert into requests (user_id, task, state, last_user_msg_at, created_at, updated_at)
  values (p_user_id, p_task, st, p_now, p_now, p_now)
  returning id into rid;

  return jsonb_build_object('ok', true, 'request_id', rid, 'state', st,
                            'replaced_request_id', replaced);
end $$;

-- The user cancels. Not allowed while a call is in flight (2.5).
create function cancel_request(p_request_id uuid, p_now timestamptz default now())
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

  if request_group(r.state) = 'in_flight' then
    return chat_refused('in_flight');
  end if;
  if request_group(r.state) not in ('before_consent', 'after_call_1', 'queued') then
    return chat_refused('not_active');
  end if;
  perform end_request(r.id, 'cancelled', 'user', p_now);
  return jsonb_build_object('ok', true);
end $$;

-- Merges slot values (a JSON null removes a key). Code validates the values first.
-- Any real change bumps the version, so an earlier YES or pick can't ride on it.
-- After call 1, an edit voids the options and goes back to a new read-back, which
-- means another availability call, so it is refused at the limit (2.1).
-- → {"ok": true, "changed", "state", "version"}
create function update_slots(p_request_id uuid, p_fields jsonb, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  r       requests;
  merged  jsonb;
  st      text;
  lim     int;
begin
  if jsonb_typeof(p_fields) is distinct from 'object' then
    raise exception 'fields must be a JSON object' using errcode = '22023';
  end if;
  select * into r from requests where id = p_request_id;
  if not found then
    return chat_refused('no_request');
  end if;
  perform lock_user(r.user_id);
  select * into r from requests where id = p_request_id;

  case request_group(r.state)
    when 'in_flight' then return chat_refused('in_flight');
    when 'before_consent', 'after_call_1', 'queued' then null;
    else return chat_refused('not_active');
  end case;

  merged := jsonb_strip_nulls(r.fields || p_fields);
  if merged = r.fields then
    return jsonb_build_object('ok', true, 'changed', false, 'state', r.state, 'version', r.version);
  end if;

  st := r.state;
  if request_group(r.state) = 'after_call_1' then
    lim := limit_int('max_availability_calls_per_request', r.user_id);
    if lim is not null and (select count(*) from calls c
                             where c.request_id = r.id and c.kind in ('first', 'reschedule')
                               and not c.is_retry) >= lim then
      return chat_refused('limit_availability_calls');
    end if;
    st := 'confirming';
  elsif r.state = 'awaiting_yes' then
    st := 'confirming';
  end if;

  perform bump_request(r.id, 'edited', p_now);
  update requests set fields = merged, state = st, updated_at = p_now
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'changed', true, 'state', r.state, 'version', r.version);
end $$;

-- Sets the business the user picked. Only before consent (or while queued);
-- after call 1 another business is a new request.
create function set_request_business(p_request_id uuid, p_business_id uuid, p_now timestamptz default now())
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

  if request_group(r.state) not in ('before_consent', 'queued') then
    return chat_refused(case request_group(r.state)
                          when 'in_flight' then 'in_flight'
                          when 'after_call_1' then 'after_call_1'
                          else 'not_active' end);
  end if;
  if r.business_id is not distinct from p_business_id then
    return jsonb_build_object('ok', true, 'changed', false, 'state', r.state, 'version', r.version);
  end if;
  perform bump_request(r.id, 'edited', p_now);
  update requests
     set business_id = p_business_id,
         state = case when state = 'awaiting_yes' then 'confirming' else state end,
         updated_at = p_now
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'changed', true, 'state', r.state, 'version', r.version);
end $$;

-- Moves between the collecting states as slots fill. Code computes p_to from the
-- missing slots. Never reaches awaiting_yes: only open_prompt('ask') does.
create function advance_request(p_request_id uuid, p_to text, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  r requests;
begin
  if p_to not in ('collecting', 'choosing_place', 'confirming') then
    raise exception 'advance_request cannot move to %', p_to using errcode = '22023';
  end if;
  select * into r from requests where id = p_request_id;
  if not found then
    return chat_refused('no_request');
  end if;
  if r.state not in ('collecting', 'choosing_place', 'confirming') then
    return chat_refused('wrong_state');
  end if;
  update requests set state = p_to, updated_at = p_now where id = r.id;
  return jsonb_build_object('ok', true, 'state', p_to, 'version', r.version);
end $$;

-- Prompts and consents (2.8) ---------------------------------------------------

-- Opens a code-built prompt bound to the request's current version and closes
-- any other open prompt. The caller makes the id, so it can put it in the button
-- ids before the row exists, then sends the message and calls set_prompt_sent().
create function open_prompt(
  p_prompt_id     uuid,
  p_request_id    uuid,
  p_kind          text,
  p_option_ids    uuid[],
  p_confirm_word  text,
  p_text          text,
  p_message       jsonb,
  p_now           timestamptz default now()
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

  if p_kind = 'ask' then
    if r.state not in ('confirming', 'awaiting_yes') then
      return chat_refused('wrong_state');
    end if;
  elsif p_kind in ('options', 'book') then
    if request_group(r.state) <> 'after_call_1' then
      return chat_refused('wrong_state');
    end if;
    if exists (select 1 from unnest(p_option_ids) x(id)
                where not exists (select 1 from options o
                                   where o.id = x.id and o.request_id = r.id and o.voided_at is null)) then
      return chat_refused('bad_option');
    end if;
  else
    raise exception 'unknown prompt kind: %', p_kind using errcode = '22023';
  end if;

  update consent_prompts set closed_at = p_now, close_reason = 'superseded'
   where request_id = r.id and closed_at is null;
  insert into consent_prompts (id, request_id, request_version, kind, option_ids,
                               confirm_word, text_shown, message, sent_at)
  values (p_prompt_id, r.id, r.version, p_kind, coalesce(p_option_ids, '{}'),
          coalesce(p_confirm_word, 'yes'), p_text, p_message, p_now);

  update requests
     set state = case when p_kind = 'ask' then 'awaiting_yes'
                      when state = 'options_ready' then 'awaiting_pick'
                      else state end,
         updated_at = p_now
   where id = r.id;
  return jsonb_build_object('ok', true, 'prompt_id', p_prompt_id, 'version', r.version);
end $$;

-- Records a send of the prompt's message. The latest one is what a bare typed YES binds to.
create function prompt_sent(p_prompt_id uuid, p_wa_message_id text) returns void
language sql as $$
  update consent_prompts
     set wa_message_id = p_wa_message_id, sent_ids = array_append(sent_ids, p_wa_message_id)
   where id = p_prompt_id
$$;

-- Stores consent from a button tap, list pick, typed word or digit. Valid only if
-- the prompt is open and on the current version, the word is the prompt's word,
-- and a pick names an unvoided option on that prompt. Then the request moves to
-- calling_1 (consent #1) or calling_2 (consent #2). The caller starts the call.
-- → {"ok": true, "consent_id", "kind": "ask"|"book", "request_id", "option_id"}
create function record_consent(
  p_prompt_id      uuid,
  p_option_id      uuid,
  p_word           text,
  p_wa_message_id  text,
  p_now            timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  p    consent_prompts;
  r    requests;
  k    text;
  cid  uuid;
begin
  select * into p from consent_prompts where id = p_prompt_id;
  if not found then
    return chat_refused('no_prompt');
  end if;
  select * into r from requests where id = p.request_id;
  perform lock_user(r.user_id);
  select * into p from consent_prompts where id = p_prompt_id;
  select * into r from requests where id = p.request_id;

  if p.closed_at is not null then
    return chat_refused('prompt_closed');
  end if;
  if p.request_version <> r.version then
    return chat_refused('stale_version');
  end if;
  if p_word is distinct from p.confirm_word then
    return chat_refused('wrong_word');
  end if;

  if p.kind = 'ask' then
    if r.state <> 'awaiting_yes' then
      return chat_refused('wrong_state');
    end if;
    if p_option_id is not null then
      return chat_refused('bad_option');
    end if;
    k := 'ask';
  else
    if request_group(r.state) <> 'after_call_1' then
      return chat_refused('wrong_state');
    end if;
    if p_option_id is null or not (p_option_id = any (p.option_ids))
       or not exists (select 1 from options o where o.id = p_option_id and o.voided_at is null) then
      return chat_refused('bad_option');
    end if;
    k := 'book';
  end if;

  insert into consents (request_id, kind, option_id, text_shown, fields_hash, wa_message_id,
                        at, request_version, prompt_id)
  values (r.id, k, p_option_id, p.text_shown, fields_hash(r.fields), p_wa_message_id,
          p_now, r.version, p.id)
  returning id into cid;

  update consent_prompts set closed_at = p_now, close_reason = 'answered' where id = p.id;
  update requests set state = case k when 'ask' then 'calling_1' else 'calling_2' end,
                      updated_at = p_now
   where id = r.id;

  return jsonb_build_object('ok', true, 'consent_id', cid, 'kind', k,
                            'request_id', r.id, 'option_id', p_option_id);
end $$;

-- Expiry, reopening, queued activation (2.5) -----------------------------------

-- The end of the requested time: window_end, else exact_time plus its tolerance.
create function request_window_end(p_fields jsonb) returns timestamptz
language sql stable as $$
  select coalesce(
    (p_fields ->> 'window_end')::timestamptz,
    (p_fields ->> 'exact_time')::timestamptz
      + make_interval(mins => coalesce((p_fields ->> 'tolerance_min')::int, 0)))
$$;

-- pg_cron, every 15 min (scheduled with the other jobs in E7). Returns how many expired.
create function expire_requests(p_now timestamptz default now()) returns int
language plpgsql as $$
declare
  r  requests;
  n  int := 0;
begin
  for r in select * from requests
            where request_group(state) in ('before_consent', 'after_call_1', 'queued') loop
    if request_window_end(r.fields) is not null and request_window_end(r.fields) <= p_now then
      perform end_request(r.id, 'expired', 'window_passed', p_now);
      n := n + 1;
    elsif coalesce(r.last_user_msg_at, r.updated_at)
          + make_interval(hours => limit_int('request_idle_expiry_hours', r.user_id)) <= p_now then
      perform end_request(r.id, 'expired', 'expired', p_now);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- "Still want Paragon for tonight?": an expired request comes back as collecting
-- with a new version, so it needs a fresh read-back and a fresh YES.
create function reopen_request(p_request_id uuid, p_now timestamptz default now())
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

  if r.state <> 'expired' then
    return chat_refused('not_expired');
  end if;
  if r.end_reason = 'window_passed'
     or (request_window_end(r.fields) is not null and request_window_end(r.fields) <= p_now) then
    return chat_refused('window_passed');
  end if;
  if exists (select 1 from requests x
              where x.user_id = r.user_id and x.id <> r.id
                and request_group(x.state) in ('before_consent', 'after_call_1', 'in_flight')) then
    return chat_refused('active_exists');
  end if;

  perform bump_request(r.id, 'reopened', p_now);
  update requests set state = 'collecting', end_reason = null, last_user_msg_at = p_now, updated_at = p_now
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'state', r.state, 'version', r.version);
end $$;

-- After a report: if the user has no active request, the oldest queued one becomes
-- collecting with a new version. One whose window has passed expires instead.
-- The chat agent then re-checks the slots and the business before any read-back.
-- → {"ok": true, "request_id": uuid or null, "expired": [ids]}
create function activate_queued(p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  r        requests;
  expired  uuid[] := '{}';
begin
  perform lock_user(p_user_id);
  if exists (select 1 from requests x
              where x.user_id = p_user_id
                and request_group(x.state) in ('before_consent', 'after_call_1', 'in_flight')) then
    return jsonb_build_object('ok', true, 'request_id', null, 'expired', '[]'::jsonb);
  end if;

  for r in select * from requests where user_id = p_user_id and state = 'queued' order by created_at loop
    if request_window_end(r.fields) is not null and request_window_end(r.fields) <= p_now then
      perform end_request(r.id, 'expired', 'window_passed', p_now);
      expired := expired || r.id;
      continue;
    end if;
    perform bump_request(r.id, 'reactivated', p_now);
    update requests set state = 'collecting', updated_at = p_now where id = r.id;
    return jsonb_build_object('ok', true, 'request_id', r.id, 'expired', to_jsonb(expired));
  end loop;
  return jsonb_build_object('ok', true, 'request_id', null, 'expired', to_jsonb(expired));
end $$;

-- check_dial() -------------------------------------------------------------------
-- As in 0003, plus step 3 now requires an unvoided consent on the request's current
-- version, and refuses a voided option. New reasons: consent_voided, option_voided.
create or replace function check_dial(
  p_request_id  uuid,
  p_kind        text,
  p_option_id   uuid default null,
  p_is_retry    boolean default false,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql stable as $$
declare
  r           requests;
  u           users;
  b           businesses;
  o           options;
  num         caller_numbers;
  is_tester   boolean;
  open_now    boolean;
  agent       text;
  day0        timestamptz := ist_day_start(p_now);
  flags       text[] := '{}';
  must_reask  boolean := false;
  lim         int;
  n           int;
  v           jsonb;
  last_at     timestamptz;
  credit      numeric;
begin
  if p_kind is null or p_kind not in ('first', 'booking', 'question', 'reschedule') then
    raise exception 'unknown call kind: %', p_kind using errcode = '22023';
  end if;

  select * into r from requests where id = p_request_id;
  if not found then
    return dial_refused('no_request');
  end if;
  select * into u from users where id = r.user_id;
  if r.business_id is null then
    return dial_refused('no_business');
  end if;
  select * into b from businesses where id = r.business_id;

  -- 1. Kill switch.
  if limit_bool('kill_switch') then
    return dial_refused('kill_switch');
  end if;

  -- 2. Caller number. A request is sticky to the number of its first call.
  is_tester := exists (select 1 from test_numbers t where t.phone_e164 = b.phone_e164);
  if r.caller_number_id is not null then
    select * into num from caller_numbers where id = r.caller_number_id;
    if not num.active then
      return dial_refused('caller_number_inactive');
    end if;
    if num.a2p_declared_at is null and not is_tester then
      return dial_refused('caller_number_undeclared');
    end if;
    if num.daily_cap is not null
       and (select count(*) from calls c
             where c.caller_number_id = num.id and c.created_at >= day0) >= num.daily_cap then
      return dial_refused('caller_number_cap');
    end if;
  else
    select cn.* into num
      from caller_numbers cn
     where cn.active
       and (cn.a2p_declared_at is not null or is_tester)
       and (cn.daily_cap is null
            or (select count(*) from calls c
                 where c.caller_number_id = cn.id and c.created_at >= day0) < cn.daily_cap)
     order by (select count(*) from calls c
                where c.caller_number_id = cn.id and c.business_id = b.id and c.created_at >= day0),
              (select count(*) from calls c
                where c.caller_number_id = cn.id and c.created_at >= day0),
              cn.created_at
     limit 1;
    if not found then
      return dial_refused('no_caller_number');
    end if;
  end if;

  -- 3. Consent. Call 1 needs consent #1 for the current fields;
  --    call 2 needs consent #2 for this exact option. Either must be unvoided and
  --    given on the request's current version (E4 design 2.8).
  if p_kind = 'booking' then
    select * into o from options where id = p_option_id and request_id = r.id;
    if not found then
      return dial_refused('no_option');
    end if;
    if o.voided_at is not null then
      return dial_refused('option_voided');
    end if;
    if not exists (select 1 from consents k
                    where k.request_id = r.id and k.kind = 'book' and k.option_id = o.id
                      and k.voided_at is null and k.request_version = r.version) then
      if exists (select 1 from consents k
                  where k.request_id = r.id and k.kind = 'book' and k.option_id = o.id) then
        return dial_refused('consent_voided');
      end if;
      return dial_refused('no_consent');
    end if;
    if (o.stale_at is not null and o.stale_at <= p_now)
       or o.created_at + make_interval(mins => limit_int('option_hold_minutes', u.id)) <= p_now then
      must_reask := true;
    end if;
  else
    if not exists (select 1 from consents k
                    where k.request_id = r.id and k.kind = 'ask'
                      and k.fields_hash = fields_hash(r.fields)
                      and k.voided_at is null and k.request_version = r.version) then
      if exists (select 1 from consents k
                  where k.request_id = r.id and k.kind = 'ask'
                    and k.voided_at is null and k.request_version = r.version) then
        return dial_refused('fields_changed');
      end if;
      if exists (select 1 from consents k where k.request_id = r.id and k.kind = 'ask') then
        return dial_refused('consent_voided');
      end if;
      return dial_refused('no_consent');
    end if;
  end if;

  -- 4. Opt-outs (global, all caller numbers) and blocks.
  if u.blocked then
    return dial_refused('user_blocked');
  end if;
  if exists (select 1 from opt_outs x where x.phone_e164 = b.phone_e164) then
    return dial_refused('opted_out');
  end if;
  if exists (select 1 from user_blocks ub where ub.user_id = u.id and ub.business_id = b.id) then
    return dial_refused('user_block');
  end if;

  -- 5. Timing. No fixed cutoff: the business is open and the call fits the request.
  open_now := business_is_open(b.opening_hours, p_now);
  if open_now is null then
    flags := array_append(flags, 'hours_unknown');
  elsif not open_now and limit_bool('respect_opening_hours', u.id) then
    return dial_refused('business_closed');
  end if;

  if p_kind = 'booking' and (o.value ->> 'time') is not null
     and (o.value ->> 'time')::timestamptz <= p_now then
    return dial_refused('too_late');
  end if;
  -- window_end, or exact_time plus its tolerance when only an exact time was given.
  if p_kind = 'first' and request_window_end(r.fields) is not null
     and request_window_end(r.fields) <= p_now then
    return dial_refused('too_late');
  end if;

  v := get_limit('calling_window', u.id);
  if jsonb_typeof(v) = 'object' and not in_window(v, p_now) then
    return dial_refused('outside_calling_window');
  end if;
  v := get_limit('provider_blocked_hours', u.id);
  if jsonb_typeof(v) = 'array'
     and exists (select 1 from jsonb_array_elements(v) w where in_window(w, p_now)) then
    return dial_refused('provider_blocked_hours');
  end if;

  -- 6. Limits. SQL NULL from limit_int() means the limit is off.
  lim := limit_int('max_calls_per_user_per_day', u.id);
  if lim is not null and (select count(*) from calls c
                           where c.user_id = u.id and c.created_at >= day0) >= lim then
    return dial_refused('limit_user_day');
  end if;

  lim := limit_int('max_calls_per_request', u.id);
  if lim is not null and (select count(*) from calls c where c.request_id = r.id) >= lim then
    return dial_refused('limit_request');
  end if;

  if p_is_retry then
    lim := limit_int('max_retries_no_answer', u.id);
    if lim is not null and (select count(*) from calls c
                             where c.request_id = r.id and c.kind = p_kind and c.is_retry) >= lim then
      return dial_refused('limit_retries');
    end if;
    select max(c.created_at) into last_at from calls c where c.request_id = r.id and c.kind = p_kind;
    if last_at is null then
      return dial_refused('nothing_to_retry');
    end if;
    if last_at + make_interval(mins => limit_int('retry_delay_minutes', u.id)) > p_now then
      return dial_refused('retry_too_soon');
    end if;
  else
    lim := case p_kind
             when 'first'   then limit_int('max_availability_calls_per_request', u.id)
             when 'booking' then limit_int('max_booking_calls_per_request', u.id)
           end;
    if lim is not null and (select count(*) from calls c
                             where c.request_id = r.id and c.kind = p_kind and not c.is_retry) >= lim then
      return dial_refused(case p_kind when 'first' then 'limit_availability_calls'
                                      else 'limit_booking_calls' end);
    end if;
  end if;

  -- Per-business limits count every Desk call to this phone, from any request or user.
  lim := limit_int('max_calls_per_business_per_day', u.id);
  if lim is not null then
    select count(*) into n
      from calls c join businesses cb on cb.id = c.business_id
     where cb.phone_e164 = b.phone_e164 and c.created_at >= day0;
    if n >= lim then
      return dial_refused('limit_business_day');
    end if;
  end if;
  lim := limit_int('max_calls_per_business_per_number_per_day', u.id);
  if lim is not null then
    select count(*) into n
      from calls c join businesses cb on cb.id = c.business_id
     where cb.phone_e164 = b.phone_e164 and c.caller_number_id = num.id and c.created_at >= day0;
    if n >= lim then
      return dial_refused('limit_business_number_day');
    end if;
  end if;

  -- 7. Credit.
  select coalesce(sum(delta_rs), 0) into credit from credit_ledger;
  if credit < limit_int('min_credit_rs') then
    return dial_refused('low_credit');
  end if;

  -- 8. The agent version has passed its test suite.
  agent := limit_text('active_agent_version');
  if agent is null then
    return dial_refused('no_agent_version');
  end if;
  if not exists (select 1 from gate_passes g where g.agent_version = agent and g.passed) then
    return dial_refused('agent_not_gated');
  end if;

  return jsonb_build_object(
    'ok', true,
    'caller_number_id', num.id,
    'agent_version', agent,
    'must_reask', must_reask,
    'flags', to_jsonb(flags));
end $$;
