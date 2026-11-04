-- 0023 (after imessage-linq's 0018-0022): the invite list behind the landing page (web/).
-- The waitlist edge function checks the form and calls join_waitlist() with the service
-- role; anon gets nothing here.

create table waitlist (
  id          uuid primary key default gen_random_uuid(),
  phone_e164  text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  handle      text not null check (length(handle) between 1 and 100),
  -- sha256 of the visitor's IP with a secret salt, only to count signups per hour.
  ip_hash     text,
  created_at  timestamptz not null default now(),
  invited_at  timestamptz
);
create index waitlist_created_idx on waitlist (created_at);
create index waitlist_ip_recent_idx on waitlist (ip_hash, created_at);
alter table waitlist enable row level security;

-- The IP comes from a header the visitor may be able to set, so the hourly total is the
-- cap that holds whatever the IP says.
insert into limits (key, value, value_type, nullable, description) values
  ('max_waitlist_signups_per_ip_per_hour', '5', 'int', true,
   'new numbers one IP may add to the invite list in an hour; null = no limit'),
  ('max_waitlist_signups_per_hour',      '200', 'int', true,
   'new numbers the invite list takes in an hour from everyone; null = no limit');

-- A number already on the list keeps its place and its first handle: anyone who knows a
-- number could send it again, so a repeat changes nothing and isn't counted.
-- → {"ok": true, "new": bool} | {"ok": false, "reason": "rate_limited"}
create function join_waitlist(p_phone text, p_handle text, p_ip_hash text, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  per_ip  int := limit_int('max_waitlist_signups_per_ip_per_hour');
  total   int := limit_int('max_waitlist_signups_per_hour');
begin
  if exists (select 1 from waitlist where phone_e164 = p_phone) then
    return jsonb_build_object('ok', true, 'new', false);
  end if;
  -- One new signup at a time, so two at once can't both pass the counts below.
  perform pg_advisory_xact_lock(hashtext('join_waitlist'));
  if total is not null
     and (select count(*) from waitlist where created_at > p_now - interval '1 hour') >= total then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  if per_ip is not null and p_ip_hash is not null
     and (select count(*) from waitlist
           where ip_hash = p_ip_hash and created_at > p_now - interval '1 hour') >= per_ip then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  insert into waitlist (phone_e164, handle, ip_hash, created_at)
  values (p_phone, p_handle, p_ip_hash, p_now)
  on conflict (phone_e164) do nothing;
  return jsonb_build_object('ok', true, 'new', found);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
