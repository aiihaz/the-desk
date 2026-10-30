-- 0011_booking_changes.sql: advances (eng plan 2.2), cancelling and rescheduling a Desk
-- booking (E4 design 2.7, 2.9). New call kinds payment_confirm and cancel; the payment
-- screenshot is the approval for the confirm call (consent kind 'pay').

-- Schema --------------------------------------------------------------------------
alter table calls drop constraint calls_kind_check;
alter table calls add constraint calls_kind_check check (kind in (
  'first', 'booking', 'question', 'reschedule', 'payment_confirm', 'cancel'));

alter table consents drop constraint consents_kind_check;
alter table consents add constraint consents_kind_check check (kind in ('ask', 'book', 'pay'));

-- moved: a reschedule replaced it with a new booking row.
alter table bookings drop constraint bookings_status_check;
alter table bookings add constraint bookings_status_check check (status in (
  'booked', 'held_pending_deposit', 'probably_booked', 'cancelled', 'unconfirmed', 'moved'));
alter table bookings
  add column payee_name        text,
  add column payment_deadline  timestamptz,
  -- A cancellation charge the business stated (cancel call), for the next read-back.
  add column known_fee_rs      numeric(10, 2);

-- What a payment screenshot showed, and whether it passed the check (chat/payment.ts).
-- The image itself is never stored.
create table payments (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references bookings on delete cascade,
  user_id     uuid not null references users on delete cascade,
  passed      boolean not null,
  amount_rs   numeric(10, 2),
  payee       text,
  utr         text,
  paid_at     timestamptz,
  problems    jsonb not null default '[]',
  at          timestamptz not null default now()
);
-- A UTR that passed for one booking can't pass for another (a reused screenshot);
-- record_payment checks it under the user lock. The same screenshot sent again for the
-- same hold (the confirm call couldn't start) is fine.
create index payments_utr_idx on payments (utr) where passed;
alter table payments enable row level security;

-- The confirm call's one redial after "we'll check later" (eng plan 2.2 step 4).
alter table requests add column next_call_at timestamptz;

insert into limits (key, value, value_type, nullable, description) values
  ('payment_confirm_retry_minutes', '30',     'int',  false, 'after "not seen yet", the confirm call is tried once more after this long'),
  ('screenshot_model',              'null',   'text', true,  'model that reads payment screenshots; null = luna_model'),
  ('screenshot_reasoning_effort',   '"low"',  'text', false, 'reasoning effort for reading a payment screenshot');

-- Bookings to change ----------------------------------------------------------------

-- The booking a reschedule or cancel request is about. It must be this user's Desk
-- booking, still on (booked, or held for a cancel), and in the future. The request
-- takes its business and its caller number, and a new version.
-- → {"ok": true, "changed", "state", "version"} | {"ok": false, "reason"}
create function set_request_booking(p_request_id uuid, p_booking_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  r    requests;
  bk   bookings;
  src  requests;
  num  uuid;
begin
  select * into r from requests where id = p_request_id;
  if not found then
    return chat_refused('no_request');
  end if;
  perform lock_user(r.user_id);
  select * into r from requests where id = p_request_id;
  if r.task not in ('reschedule', 'cancel') then
    return chat_refused('wrong_task');
  end if;
  if request_group(r.state) not in ('before_consent', 'queued') then
    return chat_refused('wrong_state');
  end if;
  select * into bk from bookings where id = p_booking_id;
  select * into src from requests where id = bk.request_id;
  if not found or src.user_id <> r.user_id then
    return chat_refused('no_booking');
  end if;
  if bk.status not in ('booked', 'held_pending_deposit')
     or (r.task = 'reschedule' and bk.status <> 'booked') then
    return chat_refused('booking_not_active');
  end if;
  if bk.time is not null and bk.time <= p_now then
    return chat_refused('booking_past');
  end if;
  if r.booking_id = bk.id then
    return jsonb_build_object('ok', true, 'changed', false, 'state', r.state, 'version', r.version);
  end if;
  select c.caller_number_id into num from calls c where c.id = bk.call_id;
  perform bump_request(r.id, 'edited', p_now);
  update requests set booking_id = bk.id, business_id = src.business_id, caller_number_id = num,
                      updated_at = p_now
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'changed', true, 'state', r.state, 'version', r.version);
end $$;

-- Payments --------------------------------------------------------------------------

-- A screenshot that passed the code check (chat/payment.ts): stored, and it becomes the
-- approval for the confirm call. The request goes to verifying while that call runs.
-- A failed check is stored too (p_passed false), and changes nothing else.
-- → {"ok": true, "consent_id" | null} | {"ok": false, "reason": "no_hold" | "utr_used" | "stopped"}
create function record_payment(
  p_request_id  uuid,
  p_passed      boolean,
  p_payment     jsonb,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  r    requests;
  bk   bookings;
  cid  uuid;
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
  select * into bk from bookings
   where request_id = r.id and status = 'held_pending_deposit' order by created_at desc limit 1;
  if not found or r.state <> 'awaiting_payment' then
    return chat_refused('no_hold');
  end if;
  if p_passed and exists (select 1 from payments p
                           where p.utr = p_payment ->> 'utr' and p.passed and p.booking_id <> bk.id) then
    p_passed := false;
    p_payment := jsonb_set(p_payment, '{problems}', coalesce(p_payment -> 'problems', '[]') || '["utr_used"]');
  end if;

  insert into payments (booking_id, user_id, passed, amount_rs, payee, utr, paid_at, problems, at)
  values (bk.id, r.user_id, p_passed, (p_payment ->> 'amount_rs')::numeric, p_payment ->> 'payee',
          p_payment ->> 'utr', (p_payment ->> 'paid_at')::timestamptz,
          coalesce(p_payment -> 'problems', '[]'), p_now);
  if not p_passed then
    if p_payment -> 'problems' ? 'utr_used' then
      return chat_refused('utr_used');
    end if;
    return jsonb_build_object('ok', true, 'consent_id', null);
  end if;

  update bookings set paid_reported_at = p_now where id = bk.id;
  insert into consents (request_id, kind, text_shown, fields_hash, at, request_version, basis)
  values (r.id, 'pay', 'payment screenshot', fields_hash(r.fields), p_now, r.version, p_payment)
  returning id into cid;
  update requests set state = 'verifying', next_call_at = null, updated_at = p_now where id = r.id;
  return jsonb_build_object('ok', true, 'consent_id', cid);
end $$;

-- Confirm calls whose redial is due (reconcile dials them). Each goes back to verifying
-- now, so a second run doesn't take it again.
create function take_due_calls(p_now timestamptz default now()) returns setof uuid
language sql as $$
  update requests set state = 'verifying', next_call_at = null, updated_at = p_now
   where state = 'awaiting_payment' and next_call_at is not null and next_call_at <= p_now
  returning id;
$$;

-- As in 0006, plus a confirm call that couldn't start goes back to awaiting the payment
-- check instead of ending: the booking is still held.
create or replace function call_not_started(p_request_id uuid, p_now timestamptz default now())
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

  if r.state not in ('calling_1', 'calling_2', 'verifying') then
    return chat_refused('wrong_state');
  end if;
  if exists (select 1 from calls c
              where c.request_id = r.id and c.status in ('queued', 'dialing', 'in_progress')) then
    return chat_refused('call_open');
  end if;
  if r.state = 'verifying' then
    update requests set state = 'awaiting_payment', updated_at = p_now where id = r.id;
  else
    perform end_request(r.id, 'cancelled', 'limit', p_now);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Dialling ----------------------------------------------------------------------------
-- check_dial() as in 0004, plus: payment_confirm needs a 'pay' consent; cancel and
-- reschedule call from the booking's number; a reschedule call 2 (with an option) needs
-- consent #2 like a booking call. reserve_call() as in 0006, keeping the option for any kind.
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
  if p_kind is null or p_kind not in ('first', 'booking', 'question', 'reschedule', 'payment_confirm', 'cancel') then
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
  -- A change to a Desk booking calls from the number that made it, so the shop knows us.
  if r.caller_number_id is null and r.booking_id is not null then
    select c.caller_number_id into r.caller_number_id
      from bookings bk join calls c on c.id = bk.call_id where bk.id = r.booking_id;
  end if;

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
  if p_kind = 'booking' or (p_kind = 'reschedule' and p_option_id is not null) then
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
  elsif p_kind = 'payment_confirm' then
    -- The screenshot that passed the check is the approval (eng plan 2.2).
    if not exists (select 1 from consents k
                    where k.request_id = r.id and k.kind = 'pay'
                      and k.voided_at is null and k.request_version = r.version) then
      return dial_refused('no_consent');
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

  if p_option_id is not null and (o.value ->> 'time') is not null
     and (o.value ->> 'time')::timestamptz <= p_now then
    return dial_refused('too_late');
  end if;
  -- window_end, or exact_time plus its tolerance when only an exact time was given.
  if p_kind in ('first', 'reschedule') and p_option_id is null and request_window_end(r.fields) is not null
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
          p_option_id, p_is_retry,
          res ->> 'agent_version', p_now)
  returning id into cid;

  update requests
     set caller_number_id = coalesce(caller_number_id, (res ->> 'caller_number_id')::uuid),
         updated_at = p_now
   where id = r.id;

  return res || jsonb_build_object('call_id', cid);
end $$;
-- Settling ----------------------------------------------------------------------------
-- As in 0008, with the results the new call kinds need (chat/report.ts decides which):
--   done:        as before. A confirm call's booking updates the held one; a reschedule's
--                new booking marks the original moved (or unconfirmed if not verified).
--   held:        an advance hold (eng plan 2.2): the booking is held_pending_deposit with
--                the payment details, and the request waits in awaiting_payment.
--   retry:       confirm call, "not seen yet": back to awaiting_payment with a redial due.
--   unconfirmed: the business didn't confirm what we asked (payment, move, cancel): the
--                booking is unconfirmed, flagged, and the errand ends.
--   cancelled:   the business cancelled the booking.
--   back:        as before; a stated cancellation charge is kept for the next read-back,
--                and a confirm call goes back to awaiting_payment.
create or replace function settle_call(
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
  ok   boolean;
  hb   uuid;
begin
  if p_result not in ('done', 'options', 'back', 'held', 'retry', 'unconfirmed', 'cancelled') then
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
  -- The booking this call is about: the held one for a confirm call, the original for
  -- a cancel or reschedule.
  if c.kind = 'payment_confirm' then
    select id into hb from bookings
     where request_id = r.id and status = 'held_pending_deposit' order by created_at desc limit 1;
  else
    hb := r.booking_id;
  end if;

  if p_result = 'done' then
    if p_booking is not null then
      ok := coalesce((p_booking ->> 'verified')::boolean, false);
      if c.kind = 'payment_confirm' and hb is not null then
        update bookings set status = case when ok then 'booked' else 'probably_booked' end,
                            time = coalesce((p_booking ->> 'time')::timestamptz, time),
                            reference = coalesce(p_booking ->> 'reference', reference)
         where id = hb;
      else
        insert into bookings (request_id, call_id, status, time, reference)
        values (r.id, c.id, case when ok then 'booked' else 'probably_booked' end,
                (p_booking ->> 'time')::timestamptz, p_booking ->> 'reference');
        if r.task = 'reschedule' and hb is not null then
          update bookings set status = case when ok then 'moved' else 'unconfirmed' end where id = hb;
        end if;
      end if;
      update calls set verified = ok where id = c.id;
      if not ok then
        perform raise_alert('booking_unverified', r.id, c.id,
                            jsonb_build_object('problems', coalesce(p_booking -> 'problems', '[]')), p_now);
      end if;
    end if;
    perform end_request(r.id, 'done', 'done', p_now);
  elsif p_result = 'held' then
    insert into bookings (request_id, call_id, status, time, reference, deposit_amount, upi_id,
                          payee_name, payment_deadline)
    values (r.id, c.id, 'held_pending_deposit', (p_booking ->> 'time')::timestamptz,
            p_booking ->> 'reference', (p_booking ->> 'amount_rs')::numeric, p_booking ->> 'upi_id',
            p_booking ->> 'payee_name', (p_booking ->> 'deadline')::timestamptz);
    perform bump_request(r.id, 'call_ended', p_now);
    update requests set state = 'awaiting_payment', updated_at = p_now where id = r.id;
  elsif p_result = 'retry' then
    -- The screenshot's approval stands for the one redial: no version bump.
    update requests
       set state = 'awaiting_payment', updated_at = p_now,
           next_call_at = p_now + make_interval(mins => limit_int('payment_confirm_retry_minutes', r.user_id))
     where id = r.id;
  elsif p_result = 'unconfirmed' then
    if hb is not null then
      update bookings set status = 'unconfirmed' where id = hb;
    end if;
    perform raise_alert('booking_unconfirmed', r.id, c.id, coalesce(p_booking, '{}'), p_now);
    perform end_request(r.id, 'done', 'done', p_now);
  elsif p_result = 'cancelled' then
    if hb is not null then
      update bookings set status = 'cancelled' where id = hb;
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
    if hb is not null and (p_booking ->> 'fee_rs') is not null then
      update bookings set known_fee_rs = (p_booking ->> 'fee_rs')::numeric where id = hb;
    end if;
    perform bump_request(r.id, 'call_ended', p_now);
    update requests set state = case when c.kind = 'payment_confirm' then 'awaiting_payment' else 'confirming' end,
                        updated_at = p_now
     where id = r.id;
  end if;

  select * into r from requests where id = r.id;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'state', r.state, 'option_ids', to_jsonb(ids));
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
