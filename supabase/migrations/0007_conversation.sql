-- 0007_conversation.sql: the chat agent holds a conversation instead of running a form.
-- Approval is understood in context (chat/approval.ts) instead of matched against a word
-- list, so each consent records what it was based on. Errands can wait behind the
-- current one instead of replacing it. A finished call settles its request
-- (settle_call), so the user hears what actually happened.

-- Schema --------------------------------------------------------------------

-- What the approval was read from: the user's own words and the check that read them.
alter table consents add column basis jsonb;

-- A call that ended without a result the user approved goes back to them ('call_ended').
alter table consents drop constraint consents_void_reason_check;
alter table consents add constraint consents_void_reason_check check (void_reason in (
  'edited', 'replaced', 'expired', 'cancelled', 'reopened', 'reactivated', 'options_changed', 'call_ended'));

insert into limits (key, value, value_type, nullable, description) values
  ('place_search_by_kind',      'true', 'bool', false,
   'find_business may search by kind of place ("dentist near Koramangala") and list what Google shows, unranked'),
  ('max_queued_requests',       '3',    'int',  false, 'errands waiting behind the current one'),
  ('approval_model',            'null', 'text', true,  'model that checks an approval; null = luna_model'),
  ('approval_reasoning_effort', '"low"', 'text', false, 'reasoning effort for the approval check');

-- Errands -------------------------------------------------------------------

-- As in 0004, but an errand waiting in the queue is no longer dropped when the current
-- one is replaced: replacing is about the current errand only.
create or replace function start_request(p_user_id uuid, p_task text, p_now timestamptz default now())
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
                and request_group(state) in ('before_consent', 'after_call_1', 'in_flight')
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

-- "Also ask the dentist about Saturday": a second errand waits behind the current one,
-- collecting details, and becomes current when that one ends (activate_queued).
-- With nothing current it starts at once.
-- → {"ok": true, "request_id", "state"} | {"ok": false, "reason": "queue_full"}
create function queue_request(p_user_id uuid, p_task text, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  st   text := 'queued';
  lim  int;
  rid  uuid;
begin
  perform lock_user(p_user_id);
  if not exists (select 1 from requests x
                  where x.user_id = p_user_id
                    and request_group(x.state) in ('before_consent', 'after_call_1', 'in_flight')) then
    st := 'collecting';
  else
    lim := limit_int('max_queued_requests', p_user_id);
    if lim is not null and (select count(*) from requests x
                             where x.user_id = p_user_id and x.state = 'queued') >= lim then
      return chat_refused('queue_full');
    end if;
  end if;

  insert into requests (user_id, task, state, last_user_msg_at, created_at, updated_at)
  values (p_user_id, p_task, st, p_now, p_now, p_now)
  returning id into rid;
  return jsonb_build_object('ok', true, 'request_id', rid, 'state', st);
end $$;

-- Consents ------------------------------------------------------------------

-- As in 0006, plus p_basis: the approving words and the check that read them.
drop function record_consent(uuid, uuid, text, text, timestamptz);
create function record_consent(
  p_prompt_id      uuid,
  p_option_id      uuid,
  p_word           text,
  p_wa_message_id  text,
  p_now            timestamptz default now(),
  p_basis          jsonb default null
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
                        at, request_version, prompt_id, basis)
  values (r.id, k, p_option_id, p.text_shown, fields_hash(r.fields), p_wa_message_id,
          p_now, r.version, p.id, p_basis)
  returning id into cid;

  update consent_prompts set closed_at = p_now, close_reason = 'answered' where id = p.id;
  update requests set state = case k when 'ask' then 'calling_1' else 'calling_2' end,
                      updated_at = p_now
   where id = r.id;

  return jsonb_build_object('ok', true, 'consent_id', cid, 'kind', k,
                            'request_id', r.id, 'option_id', p_option_id);
end $$;

-- Call results ----------------------------------------------------------------

-- Settles the request of a finished call (chat/report.ts reads the caller's outputs):
--   done:    the errand is finished (a booking the business confirmed, or a question answered).
--            p_booking {"time", "reference"} records what they said was booked.
--   options: the business offered other times; they become the request's options.
--            p_options [{"label", "value", "advance_required"}].
--   back:    nothing usable (no answer, not available, unclear): back to the user before
--            consent. The approval is spent, so calling again needs a new one.
-- p_opt_out: the business asked not to be called again (all caller numbers).
-- A redelivered result finds the request no longer calling and changes nothing.
-- → {"ok": true, "request_id", "state", "option_ids"} | {"ok": false, "reason"}
create function settle_call(
  p_call_id   uuid,
  p_result    text,
  p_options   jsonb default '[]',
  p_booking   jsonb default null,
  p_opt_out   boolean default false,
  p_now       timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  c    calls;
  r    requests;
  ph   text;
  o    jsonb;
  oid  uuid;
  ids  uuid[] := '{}';
begin
  if p_result not in ('done', 'options', 'back') then
    raise exception 'unknown call result: %', p_result using errcode = '22023';
  end if;
  if p_result = 'options'
     and (jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options) = 0) then
    raise exception 'options result needs options' using errcode = '22023';
  end if;
  select * into c from calls where id = p_call_id;
  if not found then
    return chat_refused('no_call');
  end if;
  perform lock_user(c.user_id);
  select * into r from requests where id = c.request_id;

  if p_opt_out then
    select phone_e164 into ph from businesses where id = c.business_id;
    insert into opt_outs (phone_e164, source, call_id, at) values (ph, 'call', c.id, p_now)
    on conflict (phone_e164) do nothing;
  end if;

  if r.state not in ('calling_1', 'calling_2', 'verifying') then
    return chat_refused('not_calling');
  end if;

  if p_result = 'done' then
    if p_booking is not null then
      insert into bookings (request_id, call_id, status, time, reference)
      values (r.id, c.id, 'probably_booked', (p_booking ->> 'time')::timestamptz, p_booking ->> 'reference');
    end if;
    perform end_request(r.id, 'done', 'done', p_now);
  elsif p_result = 'options' then
    perform bump_request(r.id, 'options_changed', p_now);
    update requests set state = 'options_ready', updated_at = p_now where id = r.id;
    for o in select * from jsonb_array_elements(p_options) loop
      insert into options (request_id, call_id, label, value, advance_required)
      values (r.id, c.id, o ->> 'label', coalesce(o -> 'value', '{}'::jsonb),
              coalesce((o ->> 'advance_required')::boolean, false))
      returning id into oid;
      ids := ids || oid;
    end loop;
  else
    perform bump_request(r.id, 'call_ended', p_now);
    update requests set state = 'confirming', updated_at = p_now where id = r.id;
  end if;

  select * into r from requests where id = r.id;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'state', r.state, 'option_ids', to_jsonb(ids));
end $$;

-- As in 0003: only the service role runs these.
revoke execute on all functions in schema public from public, anon, authenticated;
