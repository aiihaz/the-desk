-- Restores the production call checks that 0028 commented out (live definitions as of 7 Nov 2026,
-- before 0028). Copy into a new migration when the owner enables production calling.

CREATE OR REPLACE FUNCTION public.check_dial_base(p_request_id uuid, p_kind text, p_option_id uuid DEFAULT NULL::uuid, p_is_retry boolean DEFAULT false, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.check_dial_pinned(p_request_id uuid, p_kind text, p_option_id uuid DEFAULT NULL::uuid, p_is_retry boolean DEFAULT false, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION public.check_dial_contract(p_request_id uuid, p_kind text, p_option_id uuid DEFAULT NULL::uuid, p_is_retry boolean DEFAULT false, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  res  jsonb;
  g    gate_passes;
begin
  res := check_dial_pinned(p_request_id, p_kind, p_option_id, p_is_retry, p_now);
  if not (res ->> 'ok')::boolean then
    return res;
  end if;
  if exists (select 1 from requests r
               join businesses b on b.id = r.business_id
               join test_numbers t on t.phone_e164 = b.phone_e164
              where r.id = p_request_id) then
    return res;
  end if;

  select * into g from gate_passes where agent_version = res ->> 'agent_version';
  if g.contract_broken_at is not null then
    return dial_refused('caller_contract_broken');
  end if;
  if exists (select name from caller_contract except select unnest(g.outputs_seen)) then
    return dial_refused('caller_contract_mismatch');
  end if;
  return res;
end $function$
;
