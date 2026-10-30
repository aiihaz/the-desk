-- 0009_jobs.sql: the scheduled jobs (eng plan 3.1, 7): stale options, request expiry,
-- reconcile, retention. Each job is a function that takes the clock, so pgTAP can run
-- it; the pg_cron schedule at the bottom only calls them.

insert into limits (key, value, value_type, nullable, description) values
  ('reconcile_after_minutes',    '15',  'int', false, 'a call with no result after this long is looked up in Sarvam Analytics'),
  ('reconcile_give_up_minutes',  '120', 'int', false, 'a call still without a result after this long is closed as timeout and flagged'),
  ('transcript_retention_days',  '90',  'int', false, 'call transcripts and raw webhook payloads are deleted after this many days (DPDP)');

-- Options the user hasn't picked within option_hold_minutes go stale: call 2 then asks
-- whether the option is still there before booking (check_dial's must_reask). The
-- request shows it as stale_options. Returns how many options went stale.
create function mark_stale_options(p_now timestamptz default now()) returns int
language plpgsql as $$
declare
  n int;
begin
  with stale as (
    update options o set stale_at = p_now
      from requests r
     where r.id = o.request_id
       and o.stale_at is null and o.voided_at is null
       and r.state in ('options_ready', 'awaiting_pick')
       and o.created_at + make_interval(mins => limit_int('option_hold_minutes', r.user_id)) <= p_now
    returning o.request_id
  )
  update requests set state = 'stale_options', updated_at = p_now
   where id in (select request_id from stale);
  get diagnostics n = row_count;
  return n;
end $$;

-- A call Sarvam never reported on: closed as timeout, flagged, never redialled (eng plan
-- 7). false if it already has a result.
create function timeout_call(p_call_id uuid, p_now timestamptz default now()) returns boolean
language plpgsql as $$
declare
  c calls;
begin
  update calls set status = 'timeout', outcome = 'no_result'
   where id = p_call_id and status in ('queued', 'dialing', 'in_progress')
  returning * into c;
  if not found then
    return false;
  end if;
  perform raise_alert('call_lost', c.request_id, c.id,
                      jsonb_build_object('attempt_id', c.provider_call_id, 'kind', c.kind), p_now);
  return true;
end $$;

-- DPDP (eng plan 6): transcripts and raw payloads go after transcript_retention_days.
-- Outputs, bookings and the call rows stay: they are the record of what was agreed.
create function purge_old_data(p_now timestamptz default now()) returns jsonb
language plpgsql as $$
declare
  cutoff  timestamptz := p_now - make_interval(days => limit_int('transcript_retention_days'));
  t       int;
  w       int;
begin
  update calls set transcript = null where created_at < cutoff and transcript is not null;
  get diagnostics t = row_count;
  delete from webhook_events where received_at < cutoff;
  get diagnostics w = row_count;
  return jsonb_build_object('transcripts', t, 'webhook_events', w);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;

-- Schedule -----------------------------------------------------------------------
-- pg_cron runs the SQL jobs. reconcile is an edge function, called with pg_net; it
-- needs two Vault secrets, set once per project (README):
--   select vault.create_secret('https://<ref>.supabase.co', 'desk_project_url');
--   select vault.create_secret('<service role key>', 'desk_service_key');
-- Without them the call is skipped. Where pg_cron isn't available (a plain Postgres for
-- tests), nothing is scheduled.
create function call_edge_function(p_name text) returns void
language plpgsql security definer as $$
declare
  base  text;
  key   text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'desk_project_url';
  select decrypted_secret into key  from vault.decrypted_secrets where name = 'desk_service_key';
  if base is null or key is null then
    raise notice 'call_edge_function(%): vault secrets not set, skipped', p_name;
    return;
  end if;
  perform net.http_post(
    url     := base || '/functions/v1/' || p_name,
    headers := jsonb_build_object('Authorization', 'Bearer ' || key, 'Content-Type', 'application/json'),
    body    := '{}'::jsonb);
end $$;
revoke execute on function call_edge_function(text) from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron or pg_net not available: jobs not scheduled';
    return;
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net;
  perform cron.schedule('desk-stale-options', '*/5 * * * *',  'select mark_stale_options()');
  perform cron.schedule('desk-expire',        '*/15 * * * *', 'select expire_requests()');
  perform cron.schedule('desk-reconcile',     '*/15 * * * *', 'select call_edge_function(''reconcile'')');
  perform cron.schedule('desk-retention',     '30 21 * * *',  'select purge_old_data()');
exception when others then
  -- pg_cron can only be created in its own database (cron.database_name).
  raise notice 'jobs not scheduled: %', sqlerrm;
end $$;
