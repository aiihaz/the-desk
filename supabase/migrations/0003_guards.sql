-- 0003_guards.sql: check_dial() and reserve_call() (eng plan 5.1).
-- Every call goes through reserve_call(). Nothing else inserts into calls
-- with status 'queued', so no call can skip these checks.
-- All clock times are IST; the Desk covers India only.

create function ist_day_start(p_at timestamptz) returns timestamptz
language sql immutable as $$
  select date_trunc('day', p_at at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
$$;

-- md5 of the canonical jsonb text; jsonb normalises key order.
create function fields_hash(p_fields jsonb) returns text
language sql immutable as $$
  select md5(p_fields::text)
$$;

-- {"from":"HH:MM","to":"HH:MM"} in IST; a window with from > to wraps midnight.
create function in_window(p_window jsonb, p_at timestamptz) returns boolean
language sql immutable as $$
  select case
    when p_window ->> 'from' < p_window ->> 'to'
      then t >= p_window ->> 'from' and t < p_window ->> 'to'
    else t >= p_window ->> 'from' or t < p_window ->> 'to'
  end
  from (select to_char(p_at at time zone 'Asia/Kolkata', 'HH24:MI') as t) s
$$;

-- Google Places regularOpeningHours → open now? NULL when hours are unknown.
-- A period with no close means open 24 hours. Periods may cross midnight
-- or the end of the week (Saturday night into Sunday).
create function business_is_open(p_hours jsonb, p_at timestamptz) returns boolean
language plpgsql immutable as $$
declare
  local  timestamp := p_at at time zone 'Asia/Kolkata';
  now_w  int := extract(dow from local)::int * 1440
              + extract(hour from local)::int * 60
              + extract(minute from local)::int;
  p      jsonb;
  o      int;
  c      int;
begin
  if p_hours is null
     or jsonb_typeof(p_hours -> 'periods') is distinct from 'array'
     or jsonb_array_length(p_hours -> 'periods') = 0 then
    return null;
  end if;

  for p in select * from jsonb_array_elements(p_hours -> 'periods') loop
    if p -> 'close' is null then
      return true;
    end if;
    o := (p -> 'open' ->> 'day')::int * 1440
       + coalesce((p -> 'open' ->> 'hour')::int, 0) * 60
       + coalesce((p -> 'open' ->> 'minute')::int, 0);
    c := (p -> 'close' ->> 'day')::int * 1440
       + coalesce((p -> 'close' ->> 'hour')::int, 0) * 60
       + coalesce((p -> 'close' ->> 'minute')::int, 0);
    if c <= o then
      c := c + 10080;
    end if;
    if (now_w >= o and now_w < c) or (now_w + 10080 >= o and now_w + 10080 < c) then
      return true;
    end if;
  end loop;
  return false;
end $$;

create function dial_refused(p_reason text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'reason', p_reason)
$$;

-- Runs the checks in eng plan 5.1, in order, and returns the first refusal:
--   {"ok": false, "reason": "..."}
-- or, when every check passes:
--   {"ok": true, "caller_number_id": ..., "agent_version": ..., "must_reask": bool, "flags": [...]}
-- must_reask: the picked option is past option_hold_minutes, so call 2 asks
-- "is it still available?" before booking (eng plan 7, stale options).
-- Read-only. Use reserve_call() to dial; it adds the locks and the call row.
create function check_dial(
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
  --    call 2 needs consent #2 for this exact option.
  if p_kind = 'booking' then
    select * into o from options where id = p_option_id and request_id = r.id;
    if not found then
      return dial_refused('no_option');
    end if;
    if not exists (select 1 from consents k
                    where k.request_id = r.id and k.kind = 'book' and k.option_id = o.id) then
      return dial_refused('no_consent');
    end if;
    if (o.stale_at is not null and o.stale_at <= p_now)
       or o.created_at + make_interval(mins => limit_int('option_hold_minutes', u.id)) <= p_now then
      must_reask := true;
    end if;
  else
    if not exists (select 1 from consents k
                    where k.request_id = r.id and k.kind = 'ask'
                      and k.fields_hash = fields_hash(r.fields)) then
      if exists (select 1 from consents k where k.request_id = r.id and k.kind = 'ask') then
        return dial_refused('fields_changed');
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
  if p_kind = 'first' and (r.fields ->> 'window_end') is not null
     and (r.fields ->> 'window_end')::timestamptz <= p_now then
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

-- The only way to start a call. Locks the user, the request and the business
-- phone (always in that order), runs check_dial(), and inserts the call row in
-- the same transaction, so two requests racing for one business cannot both pass
-- a business limit. The dial function then calls Sarvam with the returned call_id.
create function reserve_call(
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

-- Supabase exposes public functions through the REST API. Only the service
-- role (edge functions) may run these.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
