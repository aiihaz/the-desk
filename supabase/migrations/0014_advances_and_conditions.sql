-- 0014_advances_and_conditions.sql: an advance is never agreed on a call. The caller takes
-- down the business's terms and says it will check with the customer. The user decides and
-- pays them directly; only a payment that passes the check leads to the call that says it's
-- done. Until then the errand waits with nothing agreed, and stays open until the user
-- closes it. What the business required on a call is kept in their words, judged, and
-- brought to the user. What the Desk doesn't know is recorded as not known: an unconfirmed
-- change leaves the booking as it stood, with the change pending beside it.

-- Schema --------------------------------------------------------------------------

alter table bookings drop constraint bookings_status_check;
update bookings set status = 'advance_due' where status = 'held_pending_deposit';
-- advance_due: the business's terms are in and the user hasn't paid. Whether the business
-- is keeping the slot meanwhile is in advance_terms: this says nothing about it.
-- dropped: the user walked away from an unpaid advance. Says nothing about the business.
alter table bookings add constraint bookings_status_check check (status in (
  'booked', 'advance_due', 'probably_booked', 'cancelled', 'unconfirmed', 'moved', 'dropped'));

alter table bookings
  -- Everything the business said about the advance (report.ts AdvanceTerms).
  add column advance_terms        jsonb,
  -- [{"words", "what", "required", "covered"}]: each condition from the call (verify.ts).
  add column conditions           jsonb not null default '[]',
  -- A required condition the user never approved: theirs to accept or refuse.
  add column decision_open        boolean not null default false,
  add column decision_basis       jsonb,
  -- A move or cancel the business didn't clearly confirm: {"kind", "at", ...}. The booking
  -- keeps its status, because not knowing it changed isn't knowing it did.
  add column pending_change       jsonb,
  -- They said cancelling costs something, with or without an amount (known_fee_rs).
  add column charge_stated        boolean not null default false,
  add column replaces_booking_id  uuid references bookings on delete set null;

-- The user was told a payment deadline passed: once.
alter table requests add column deadline_told_at timestamptz;

-- No call agrees an advance, so there is no cap to set.
delete from limits where key = 'max_advance_rs';

-- agent/contract.json. The caller takes down all of an advance's terms, wherever they pay.
delete from caller_contract where name = 'upi_id';
insert into caller_contract (name) values
  ('advance_redeemable'),
  ('advance_refund'),
  ('advance_hold'),
  ('payment_mode'),
  ('payment_address');

-- Call results --------------------------------------------------------------------

-- As in 0011, with these changes:
--   advance:     replaces held. The business wants an advance: its terms are stored, nothing
--                is agreed, and the request waits in awaiting_payment for the user.
--   done:        keeps the call's conditions. An unverified move leaves the original booking
--                as it stood, with the move pending, and links the new row to it.
--   unconfirmed: a move or cancel leaves the booking as it stood, with the change pending.
--                A confirm call still marks the booking unconfirmed: money has moved.
--   cancelled:   an errand still waiting for an advance on that booking ends with it.
--   back:        a stated charge is recorded even when no amount was given.
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
  nb   uuid;
  src  uuid;
begin
  if p_result not in ('done', 'options', 'back', 'advance', 'retry', 'unconfirmed', 'cancelled') then
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
  -- The booking this call is about: the one waiting on its advance for a confirm call, the
  -- original for a cancel or reschedule.
  if c.kind = 'payment_confirm' then
    select id into hb from bookings
     where request_id = r.id and status = 'advance_due' order by created_at desc limit 1;
  else
    hb := r.booking_id;
  end if;

  if p_result = 'done' then
    if p_booking is not null then
      ok := coalesce((p_booking ->> 'verified')::boolean, false);
      if c.kind = 'payment_confirm' and hb is not null then
        update bookings set status = case when ok then 'booked' else 'probably_booked' end,
                            time = coalesce((p_booking ->> 'time')::timestamptz, time),
                            reference = coalesce(p_booking ->> 'reference', reference),
                            conditions = coalesce(p_booking -> 'conditions', conditions),
                            decision_open = coalesce((p_booking ->> 'decision_open')::boolean, false)
         where id = hb;
      else
        insert into bookings (request_id, call_id, status, time, reference, conditions, decision_open,
                              replaces_booking_id)
        values (r.id, c.id, case when ok then 'booked' else 'probably_booked' end,
                (p_booking ->> 'time')::timestamptz, p_booking ->> 'reference',
                coalesce(p_booking -> 'conditions', '[]'),
                coalesce((p_booking ->> 'decision_open')::boolean, false),
                case when r.task = 'reschedule' then hb end)
        returning id into nb;
        if r.task = 'reschedule' and hb is not null then
          if ok then
            update bookings set status = 'moved', pending_change = null where id = hb;
          else
            update bookings
               set pending_change = jsonb_build_object('kind', 'move', 'at', p_now, 'booking', nb,
                                                       'to', p_booking -> 'time')
             where id = hb;
          end if;
        end if;
      end if;
      update calls set verified = ok where id = c.id;
      if not ok then
        perform raise_alert('booking_unverified', r.id, c.id,
                            jsonb_build_object('problems', coalesce(p_booking -> 'problems', '[]')), p_now);
      end if;
    end if;
    perform end_request(r.id, 'done', 'done', p_now);
  elsif p_result = 'advance' then
    insert into bookings (request_id, call_id, status, time, deposit_amount, upi_id, payee_name,
                          payment_deadline, advance_terms)
    values (r.id, c.id, 'advance_due', (p_booking ->> 'time')::timestamptz,
            (p_booking ->> 'amount_rs')::numeric, p_booking ->> 'upi_id', p_booking ->> 'payee_name',
            (p_booking ->> 'deadline')::timestamptz, p_booking -> 'terms');
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
      if c.kind = 'payment_confirm' then
        update bookings set status = 'unconfirmed' where id = hb;
      else
        update bookings
           set pending_change = jsonb_build_object('kind', c.kind, 'at', p_now, 'said', p_booking -> 'said')
         where id = hb;
      end if;
    end if;
    perform raise_alert('booking_unconfirmed', r.id, c.id, coalesce(p_booking, '{}'), p_now);
    perform end_request(r.id, 'done', 'done', p_now);
  elsif p_result = 'cancelled' then
    if hb is not null then
      update bookings set status = 'cancelled', pending_change = null, decision_open = false
       where id = hb returning request_id into src;
      if src is distinct from r.id and exists (select 1 from requests x
                                                where x.id = src and x.state = 'awaiting_payment') then
        perform end_request(src, 'cancelled', 'user', p_now);
      end if;
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
    if hb is not null and coalesce((p_booking ->> 'charge_stated')::boolean, false) then
      update bookings set charge_stated = true,
                          known_fee_rs = coalesce((p_booking ->> 'fee_rs')::numeric, known_fee_rs)
       where id = hb;
    end if;
    perform bump_request(r.id, 'call_ended', p_now);
    update requests set state = case when c.kind = 'payment_confirm' then 'awaiting_payment' else 'confirming' end,
                        updated_at = p_now
     where id = r.id;
  end if;

  select * into r from requests where id = r.id;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'state', r.state, 'option_ids', to_jsonb(ids));
end $$;

-- Errands -------------------------------------------------------------------------

-- As in 0004, plus an errand waiting on an unpaid advance can be dropped: the user's work
-- stops, and that says nothing about the business, so the booking row says dropped. Once
-- a payment has passed it's a cancellation, which needs its own plan and the user's yes.
create or replace function cancel_request(p_request_id uuid, p_now timestamptz default now())
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
  if r.state = 'awaiting_payment' then
    if exists (select 1 from bookings b where b.request_id = r.id and b.paid_reported_at is not null) then
      return chat_refused('paid');
    end if;
    update bookings set status = 'dropped' where request_id = r.id and status = 'advance_due';
  elsif request_group(r.state) not in ('before_consent', 'after_call_1', 'queued') then
    return chat_refused('not_active');
  end if;
  perform end_request(r.id, 'cancelled', 'user', p_now);
  return jsonb_build_object('ok', true);
end $$;

-- The user accepted a condition the business required. p_basis: the reading of their words
-- (reading.ts). It settles that one question, so a booking waiting on it becomes booked.
-- → {"ok": true} | {"ok": false, "reason": "no_booking" | "no_decision"}
create function accept_condition(
  p_booking_id  uuid,
  p_user_id     uuid,
  p_basis       jsonb,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql as $$
declare
  bk  bookings;
  rq  requests;
begin
  perform lock_user(p_user_id);
  select * into bk from bookings where id = p_booking_id;
  select * into rq from requests where id = bk.request_id;
  if not found or rq.user_id <> p_user_id then
    return chat_refused('no_booking');
  end if;
  if not bk.decision_open then
    return chat_refused('no_decision');
  end if;
  update bookings
     set decision_open = false, decision_basis = p_basis || jsonb_build_object('at', p_now),
         status = case when status = 'probably_booked' then 'booked' else status end
   where id = bk.id;
  return jsonb_build_object('ok', true);
end $$;

-- As in 0011, plus a booking the business may have made can be cancelled: calling to undo
-- it is the way to find out. Only a booking known to stand can be moved.
create or replace function set_request_booking(p_request_id uuid, p_booking_id uuid, p_now timestamptz default now())
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
  if bk.status not in ('booked', 'advance_due', 'probably_booked')
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

-- Payments ------------------------------------------------------------------------

-- As in 0011, for the booking waiting on its advance. A payee matched only by name, or
-- with nothing to match against, is flagged: the check passed on weak evidence.
create or replace function record_payment(
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
   where request_id = r.id and status = 'advance_due' order by created_at desc limit 1;
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

  if coalesce((p_payment ->> 'weak_payee_match')::boolean, false) then
    perform raise_alert('payment_payee_weak', r.id, null,
                        jsonb_build_object('payee', p_payment ->> 'payee', 'booking', bk.id), p_now);
  end if;
  update bookings set paid_reported_at = p_now where id = bk.id;
  insert into consents (request_id, kind, text_shown, fields_hash, at, request_version, basis)
  values (r.id, 'pay', 'payment screenshot', fields_hash(r.fields), p_now, r.version, p_payment)
  returning id into cid;
  update requests set state = 'verifying', next_call_at = null, updated_at = p_now where id = r.id;
  return jsonb_build_object('ok', true, 'consent_id', cid);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
