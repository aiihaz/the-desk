-- 0010_admin.sql: admin commands on WhatsApp (eng plan 8). chat/admin.ts parses the
-- message; these do the work, so every change is in the database's own log
-- (limit_changes, credit_ledger, opt_outs, alerts.resolved_by).

-- "status": what Ihaz needs at a glance. Days are IST days.
create function admin_status(p_now timestamptz default now()) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'kill_switch',    coalesce((select value from limits where key = 'kill_switch'), 'false'::jsonb),
    'agent_version',  (select value from limits where key = 'active_agent_version'),
    'credit_rs',      coalesce((select sum(delta_rs) from credit_ledger), 0),
    'calls_today',    coalesce((select jsonb_object_agg(status, n) from (
                         select status, count(*) as n from calls
                          where (created_at at time zone 'Asia/Kolkata')::date = (p_now at time zone 'Asia/Kolkata')::date
                          group by status) s), '{}'::jsonb),
    'bookings_today', (select count(*) from bookings
                        where (created_at at time zone 'Asia/Kolkata')::date = (p_now at time zone 'Asia/Kolkata')::date),
    'active_requests', (select count(*) from requests
                         where request_group(state) in ('before_consent', 'after_call_1', 'in_flight')),
    'open_alerts',    (select count(*) from alerts where resolved_at is null),
    'stopped_users',  (select count(*) from users where stopped_at is not null));
$$;

-- "resolve ab12cd": closes the alert whose id starts with the prefix (as review shows it).
-- → {"ok": true, "id"} | {"ok": false, "reason": "not_found" | "ambiguous"}
create function resolve_alert(p_prefix text, p_by text, p_now timestamptz default now()) returns jsonb
language plpgsql as $$
declare
  ids uuid[];
begin
  select array_agg(id) into ids from alerts
   where resolved_at is null and length(p_prefix) >= 4 and id::text like lower(p_prefix) || '%';
  if ids is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if array_length(ids, 1) > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous');
  end if;
  update alerts set resolved_at = p_now, resolved_by = p_by where id = ids[1];
  return jsonb_build_object('ok', true, 'id', ids[1]);
end $$;

-- "number off +918041234567" (or the id prefix "numbers" shows).
-- → {"ok": true, "e164", "active"} | {"ok": false, "reason": "not_found" | "ambiguous"}
create function set_caller_number_active(p_ref text, p_active boolean) returns jsonb
language plpgsql as $$
declare
  ids  uuid[];
  c    caller_numbers;
begin
  select array_agg(id) into ids from caller_numbers
   where e164 = p_ref or (length(p_ref) >= 4 and id::text like lower(p_ref) || '%');
  if ids is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if array_length(ids, 1) > 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous');
  end if;
  update caller_numbers set active = p_active where id = ids[1] returning * into c;
  return jsonb_build_object('ok', true, 'e164', c.e164, 'active', c.active);
end $$;

-- "numbers": each caller number with today's calls.
create function caller_numbers_today(p_now timestamptz default now()) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', left(n.id::text, 6), 'e164', n.e164, 'active', n.active,
           'declared', n.a2p_declared_at is not null,
           'calls_today', (select count(*) from calls c
                            where c.caller_number_id = n.id
                              and (c.created_at at time zone 'Asia/Kolkata')::date
                                  = (p_now at time zone 'Asia/Kolkata')::date))
         order by n.e164), '[]'::jsonb)
    from caller_numbers n;
$$;

-- "credit 500": a Sarvam top-up. Returns the new balance.
create function add_credit(p_rs numeric, p_by text) returns numeric
language plpgsql as $$
begin
  if p_rs is null or p_rs <= 0 or p_rs > 100000 then
    raise exception 'credit must be between 0 and 100000 rupees: %', p_rs using errcode = '22023';
  end if;
  insert into credit_ledger (delta_rs, reason) values (p_rs, 'top-up by ' || p_by);
  return (select sum(delta_rs) from credit_ledger);
end $$;

-- "optout +91…": no Desk number calls it again (eng plan 5.3). false if already out.
create function admin_opt_out(p_phone text) returns boolean
language plpgsql as $$
begin
  insert into opt_outs (phone_e164, source) values (p_phone, 'admin')
  on conflict (phone_e164) do nothing;
  return found;
end $$;

-- Alerts not yet sent to the admins, oldest first; marked once delivered.
create function mark_alerts_notified(p_ids uuid[], p_now timestamptz default now()) returns int
language sql as $$
  with u as (update alerts set notified_at = p_now where id = any(p_ids) and notified_at is null returning 1)
  select count(*)::int from u;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
