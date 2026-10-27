-- 0006_evidence_fixes.sql: fixes from the problem-evidence review (27 Oct 2026, P1-P16).
-- STOP and pause are states the database enforces, not just words Luna agrees with.
-- Inbound messages run one turn per user at a time, so a burst is one turn (P6).
-- No advance allowance by default (P5). A consent whose call can't start ends its
-- request instead of sitting in calling_1 (P14, P15). router_log records Luna's settings (P16).

-- Schema --------------------------------------------------------------------

-- STOP (P1): set by stop_user(), cleared by resume_user(). While set, no prompt opens,
-- no consent is stored and no call is reserved, whatever the chat code does.
alter table users
  add column stopped_at          timestamptz,
  -- "delete my data": recorded here for the deletion job (E7); the user is stopped meanwhile.
  add column delete_requested_at timestamptz;

-- Pause (P3): "hang on, don't do anything yet". The read-back is closed, so a stray
-- YES binds to nothing, and none is sent again until the user says to carry on.
alter table requests add column paused_at timestamptz;

-- Turns (P6). seq orders messages that share a second; handled_at marks the inbound
-- messages a turn has taken. Older rows count as handled.
alter table messages
  add column seq        bigint generated always as identity,
  add column handled_at timestamptz;
update messages set handled_at = at where direction = 'in';
create index messages_unhandled_idx on messages (user_id, seq)
  where direction = 'in' and handled_at is null;

-- The turn running for a user. A lease, so a crashed turn frees the user when it runs out.
create table user_turns (
  user_id  uuid primary key references users on delete cascade,
  holder   text not null,
  until    timestamptz not null
);
alter table user_turns enable row level security;

-- P16: the settings that produced each Luna turn.
alter table router_log
  add column luna_model             text,
  add column luna_reasoning_effort  text,
  add column luna_max_output_tokens int;

-- Limits and templates ----------------------------------------------------------

-- P5: YES must cover only what the read-back states, and the default states no advance.
-- A per-user override (set_limit with p_user_id) still offers one in the read-back.
select set_limit('max_advance_rs', '0', 'evidence review P5: no advance unless set for the user');
update limits set description = 'largest UPI advance the read-back offers to hold; 0 = never agree to one'
 where key = 'max_advance_rs';

insert into limits (key, value, value_type, nullable, description) values
  ('turn_debounce_ms', '1500', 'int', false, 'wait after a message before answering, so a burst is one turn');

insert into reply_templates (key, language, text) values
  ('stopped',           'en', 'Stopped. I''ve cancelled what was waiting and won''t call anyone for you. Reply START when you want me again.'),
  ('stopped_in_flight', 'en', 'Stopped. The call already under way will finish, but I won''t make any more calls or book anything. Reply START when you want me again.'),
  ('stopped_reminder',  'en', 'You''ve stopped me, so I''m not doing anything. Reply START when you want me again.'),
  ('started',           'en', 'I''m back on. Tell me the place and what you need.'),
  ('delete_requested',  'en', 'Stopped, and I''ve recorded your request to delete your data. I won''t call anyone for you meanwhile.'),
  ('admin_not_built',   'en', 'Admin commands aren''t built yet, so nothing was done.'),
  ('paused_hold',       'en', 'You asked me to wait, so I haven''t called anyone. Say "carry on" when you''re ready and I''ll show the plan again.'),
  ('call_not_started',  'en', 'I couldn''t start the call, so nothing has happened. {reason}');

-- STOP (P1) -------------------------------------------------------------------

create function user_stopped(p_user_id uuid) returns boolean
language sql stable as $$
  select coalesce((select stopped_at is not null from users where id = p_user_id), false)
$$;

-- Ends every request that hasn't started a call (closing its prompts and voiding its
-- approvals) and stops the user. A call already in flight can't be hung up, but
-- reserve_call() refuses every later call, so nothing follows it.
-- → {"ok": true, "cancelled": n, "in_flight": bool}
create function stop_user(p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  r  requests;
  n  int := 0;
begin
  perform lock_user(p_user_id);
  update users set stopped_at = coalesce(stopped_at, p_now) where id = p_user_id;
  for r in select * from requests
            where user_id = p_user_id
              and request_group(state) in ('before_consent', 'after_call_1', 'queued') loop
    perform end_request(r.id, 'cancelled', 'user', p_now);
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'cancelled', n, 'in_flight',
    exists (select 1 from requests x where x.user_id = p_user_id and request_group(x.state) = 'in_flight'));
end $$;

-- START. Nothing that STOP cancelled comes back.
create function resume_user(p_user_id uuid) returns jsonb
language plpgsql as $$
begin
  perform lock_user(p_user_id);
  update users set stopped_at = null where id = p_user_id and stopped_at is not null;
  return jsonb_build_object('ok', true, 'was_stopped', found);
end $$;

-- "delete my data": stop first, then record the request.
create function request_data_deletion(p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  res jsonb;
begin
  res := stop_user(p_user_id, p_now);
  update users set delete_requested_at = coalesce(delete_requested_at, p_now) where id = p_user_id;
  return res;
end $$;

-- Pause (P3) ------------------------------------------------------------------

-- Closes the open read-back and holds the request before consent. Edits still apply;
-- no read-back goes out until resume_request().
create function pause_request(p_request_id uuid, p_now timestamptz default now())
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
    return chat_refused(case request_group(r.state) when 'in_flight' then 'in_flight' else 'wrong_state' end);
  end if;
  update consent_prompts set closed_at = p_now, close_reason = 'paused'
   where request_id = r.id and closed_at is null;
  update requests
     set paused_at = coalesce(paused_at, p_now),
         state = case when state = 'awaiting_yes' then 'confirming' else state end,
         updated_at = p_now
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'state', r.state);
end $$;

create function resume_request(p_request_id uuid, p_now timestamptz default now())
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

  if r.paused_at is null then
    return jsonb_build_object('ok', true, 'changed', false, 'state', r.state);
  end if;
  update requests set paused_at = null, last_user_msg_at = p_now, updated_at = p_now
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'changed', true, 'state', r.state);
end $$;

-- Prompts and consents: as in 0004, refused while stopped or paused ------------

create or replace function open_prompt(
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

  if user_stopped(r.user_id) then
    return chat_refused('stopped');
  end if;
  if r.paused_at is not null then
    return chat_refused('paused');
  end if;

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

create or replace function record_consent(
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

  if user_stopped(r.user_id) then
    return chat_refused('stopped');
  end if;
  if r.paused_at is not null then
    return chat_refused('paused');
  end if;
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

-- reserve_call(): as in 0003, plus a stopped user is refused before check_dial().
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
                     option_id, is_retry, agent_version, created_at)
  values (r.id, r.user_id, r.business_id, (res ->> 'caller_number_id')::uuid, p_kind,
          case when p_kind = 'booking' then p_option_id end, p_is_retry,
          res ->> 'agent_version', p_now)
  returning id into cid;

  update requests
     set caller_number_id = coalesce(caller_number_id, (res ->> 'caller_number_id')::uuid),
         updated_at = p_now
   where id = r.id;

  return res || jsonb_build_object('call_id', cid);
end $$;

-- A consent whose call could not start (refused by reserve_call, or the dial failed):
-- the request ends, so it never waits in calling_1 or calling_2 for a call that isn't coming.
create function call_not_started(p_request_id uuid, p_now timestamptz default now())
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

  if r.state not in ('calling_1', 'calling_2') then
    return chat_refused('wrong_state');
  end if;
  if exists (select 1 from calls c
              where c.request_id = r.id and c.status in ('queued', 'dialing', 'in_progress')) then
    return chat_refused('call_open');
  end if;
  perform end_request(r.id, 'cancelled', 'limit', p_now);
  return jsonb_build_object('ok', true);
end $$;

-- Turns (P6) ------------------------------------------------------------------

-- Called by a message's turn after the debounce wait. If a newer message is waiting,
-- its turn takes this one too ('newer'). If another turn holds the user, try again
-- shortly ('busy'). Otherwise take the lease and every unhandled message up to this
-- one, oldest first, as the turn's batch.
-- → {"status": "claimed", "batch": [raw bodies]} | {"status": "busy" | "newer" | "handled"}
create function claim_turn(
  p_user_id     uuid,
  p_message_id  text,
  p_ttl_s       int default 90,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  m      messages;
  batch  jsonb;
begin
  perform lock_user(p_user_id);
  select * into m from messages where wa_message_id = p_message_id and user_id = p_user_id;
  if not found or m.handled_at is not null then
    return jsonb_build_object('status', 'handled');
  end if;
  if exists (select 1 from messages x
              where x.user_id = p_user_id and x.direction = 'in'
                and x.handled_at is null and x.seq > m.seq) then
    return jsonb_build_object('status', 'newer');
  end if;
  if exists (select 1 from user_turns t where t.user_id = p_user_id and t.until > p_now) then
    return jsonb_build_object('status', 'busy');
  end if;

  insert into user_turns (user_id, holder, until)
  values (p_user_id, p_message_id, p_now + make_interval(secs => p_ttl_s))
  on conflict (user_id) do update set holder = excluded.holder, until = excluded.until;

  with taken as (
    update messages set handled_at = p_now
     where user_id = p_user_id and direction = 'in' and handled_at is null and seq <= m.seq
    returning seq, body
  )
  select coalesce(jsonb_agg(body order by seq), '[]'::jsonb) into batch from taken;
  return jsonb_build_object('status', 'claimed', 'batch', batch);
end $$;

create function release_turn(p_user_id uuid, p_message_id text) returns void
language sql as $$
  delete from user_turns where user_id = p_user_id and holder = p_message_id
$$;

-- As in 0003: only the service role runs these.
revoke execute on all functions in schema public from public, anon, authenticated;
