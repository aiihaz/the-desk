-- 0016_call_meaning.sql: what a call established reaches the user as it was, and the Desk
-- does what its message says.
--   - A confirm call's redial happens when the message says it will: report.ts works out
--     the time (the one the business asked for, or the Desk's own interval) and passes it
--     as retry_at, so the business's "call back in 40 minutes" isn't replaced by a default.
--   - A number that reached someone else isn't dialled again for that user, until the
--     business's number changes: the next try is another branch or place.

-- Schema --------------------------------------------------------------------------

create table wrong_numbers (
  user_id      uuid not null references users on delete cascade,
  business_id  uuid not null references businesses on delete cascade,
  -- The number that was wrong: a new number for the business is dialled again.
  phone_e164   e164 not null,
  call_id      uuid references calls on delete set null,
  at           timestamptz not null default now(),
  primary key (user_id, business_id, phone_e164)
);
alter table wrong_numbers enable row level security;

insert into limits (key, value, value_type, nullable, description) values
  ('payment_confirm_callback_max_minutes', '720', 'int', false,
   'the longest a confirm call waits for the time the business asked; later than this, the user is told to check');

-- Settling a call -----------------------------------------------------------------

-- As in 0014, plus retry_at for the redial and wrong_number for a back result.
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
           next_call_at = greatest(p_now, coalesce(
             (p_booking ->> 'retry_at')::timestamptz,
             p_now + make_interval(mins => limit_int('payment_confirm_retry_minutes', r.user_id))))
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
    if coalesce((p_booking ->> 'wrong_number')::boolean, false) then
      insert into wrong_numbers (user_id, business_id, phone_e164, call_id, at)
      select c.user_id, b.id, b.phone_e164, c.id, p_now from businesses b where b.id = c.business_id
      on conflict (user_id, business_id, phone_e164) do nothing;
    end if;
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

-- Dialling ------------------------------------------------------------------------

-- The wrong numbers, then check_dial() as in 0013.
alter function check_dial(uuid, text, uuid, boolean, timestamptz) rename to check_dial_contract;

create function check_dial(
  p_request_id  uuid,
  p_kind        text,
  p_option_id   uuid default null,
  p_is_retry    boolean default false,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql stable as $$
begin
  -- Like an opt-out, it holds whatever else is true of the request.
  if exists (select 1 from requests r
               join businesses b on b.id = r.business_id
               join wrong_numbers w on w.user_id = r.user_id and w.business_id = b.id
                                   and w.phone_e164 = b.phone_e164
              where r.id = p_request_id) then
    return dial_refused('wrong_number');
  end if;
  return check_dial_contract(p_request_id, p_kind, p_option_id, p_is_retry, p_now);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
