-- 0002_limits.sql: configurable limits (eng plan 5.2).
-- check_dial() reads these on every call; nothing is hard-coded.
-- Ihaz changes them on WhatsApp through set_limit(); every change is logged.

create table limits (
  key          text primary key,
  value        jsonb not null,  -- JSON null means "off" where nullable
  value_type   text not null check (value_type in ('int', 'bool', 'window', 'windows', 'text')),
  nullable     boolean not null default false,
  description  text not null,
  updated_by   text not null default 'seed',
  updated_at   timestamptz not null default now()
);

create table user_limits (
  user_id     uuid not null references users on delete cascade,
  key         text not null references limits on delete cascade,
  value       jsonb not null,
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

create table limit_changes (
  id          bigint generated always as identity primary key,
  key         text not null,
  user_id     uuid,
  old_value   jsonb,
  new_value   jsonb not null,
  changed_by  text not null,
  at          timestamptz not null default now()
);

alter table limits        enable row level security;
alter table user_limits   enable row level security;
alter table limit_changes enable row level security;

-- Placeholder defaults from the eng plan. Real values are an open decision.
insert into limits (key, value, value_type, nullable, description) values
  ('kill_switch',                                'false', 'bool',    false, 'admin "stop all": refuse every call'),
  ('active_agent_version',                       'null',  'text',    true,  'Sarvam agent version used for new calls; must have a gate pass'),
  ('max_calls_per_user_per_day',                 '10',    'int',     false, 'all AI calls for one user in a day (IST)'),
  ('max_calls_per_request',                      '4',     'int',     false, 'all calls for one request, all kinds'),
  ('book_on_first_call',                         'true',  'bool',    false, 'book on call 1 when the offer is an exact match'),
  ('match_tolerance_minutes',                    '15',    'int',     false, 'distance from an exact requested time that still counts as a match'),
  ('max_availability_calls_per_request',         '2',     'int',     false, 'call 1 attempts, including re-asks after stale options'),
  ('max_booking_calls_per_request',              '2',     'int',     false, 'call 2 attempts, including one after an alternative'),
  ('max_retries_no_answer',                      '1',     'int',     false, 'redials after no answer or busy'),
  ('retry_delay_minutes',                        '30',    'int',     false, 'wait before a redial'),
  ('option_hold_minutes',                        '60',    'int',     false, 'after this, call 2 re-asks before booking'),
  ('max_calls_per_business_per_day',             'null',  'int',     true,  'all Desk calls to one business, all numbers (open decision)'),
  ('max_calls_per_business_per_number_per_day',  'null',  'int',     true,  'Desk calls to one business from one caller number (open decision)'),
  ('calling_window',                             'null',  'window',  true,  'optional global window in IST, e.g. {"from":"07:00","to":"23:00"}'),
  ('provider_blocked_hours',                     'null',  'windows', true,  'IST windows the provider or law forbids, e.g. [{"from":"21:00","to":"09:00"}]'),
  ('respect_opening_hours',                      'true',  'bool',    false, 'refuse calls when Places says the business is closed'),
  ('min_credit_rs',                              '200',   'int',     false, 'refuse calls below this estimated Sarvam credit');

create function is_hhmm(v jsonb) returns boolean
language sql immutable as $$
  select coalesce(jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false)
$$;

create function is_window(v jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(v) = 'object'
     and is_hhmm(v -> 'from') and is_hhmm(v -> 'to')
     and v ->> 'from' <> v ->> 'to'
$$;

create function limit_value_ok(p_type text, p_nullable boolean, v jsonb) returns boolean
language sql immutable as $$
  select case
    when jsonb_typeof(v) = 'null' then p_nullable
    when p_type = 'int'    then jsonb_typeof(v) = 'number'
                                and (v #>> '{}') ~ '^[0-9]{1,9}$'
    when p_type = 'bool'   then jsonb_typeof(v) = 'boolean'
    when p_type = 'text'   then jsonb_typeof(v) = 'string' and length(v #>> '{}') between 1 and 200
    when p_type = 'window' then is_window(v)
    when p_type = 'windows' then jsonb_typeof(v) = 'array'
                                and jsonb_array_length(v) > 0
                                and not exists (select 1 from jsonb_array_elements(v) w where not is_window(w))
    else false
  end
$$;

-- set_limit('max_calls_per_request', '6', 'wa:+9198...')            global
-- set_limit('max_calls_per_request', '6', 'wa:+9198...', <user id>) per-user override
create function set_limit(p_key text, p_value jsonb, p_changed_by text, p_user_id uuid default null)
returns void
language plpgsql as $$
declare
  l    limits;
  old  jsonb;
begin
  select * into l from limits where key = p_key;
  if not found then
    raise exception 'unknown limit: %', p_key using errcode = '22023';
  end if;
  if p_value is null or not coalesce(limit_value_ok(l.value_type, l.nullable, p_value), false) then
    raise exception 'bad value for % (expects %): %', p_key,
      l.value_type || case when l.nullable then ' or null' else '' end, p_value
      using errcode = '22023';
  end if;

  if p_user_id is null then
    old := l.value;
    update limits set value = p_value, updated_by = p_changed_by, updated_at = now()
     where key = p_key;
  else
    select value into old from user_limits where user_id = p_user_id and key = p_key;
    insert into user_limits (user_id, key, value, updated_by)
    values (p_user_id, p_key, p_value, p_changed_by)
    on conflict (user_id, key) do update
      set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into limit_changes (key, user_id, old_value, new_value, changed_by)
  values (p_key, p_user_id, old, p_value, p_changed_by);
end $$;

-- Removes a per-user override so the global value applies again.
create function clear_user_limit(p_key text, p_user_id uuid, p_changed_by text)
returns void
language plpgsql as $$
declare
  old jsonb;
begin
  delete from user_limits where user_id = p_user_id and key = p_key returning value into old;
  if found then
    insert into limit_changes (key, user_id, old_value, new_value, changed_by)
    values (p_key, p_user_id, old, (select value from limits where key = p_key), p_changed_by);
  end if;
end $$;

-- The value in force for a user: the override if one exists (even a JSON null), else the global.
create function get_limit(p_key text, p_user_id uuid default null)
returns jsonb
language plpgsql stable as $$
declare
  v jsonb;
begin
  if p_user_id is not null then
    select value into v from user_limits where user_id = p_user_id and key = p_key;
    if found then return v; end if;
  end if;
  select value into v from limits where key = p_key;
  if not found then
    raise exception 'unknown limit: %', p_key using errcode = '22023';
  end if;
  return v;
end $$;

-- Typed readers. SQL NULL means the limit is off.
create function limit_int(p_key text, p_user_id uuid default null) returns int
language sql stable as $$
  select case when jsonb_typeof(v) = 'null' then null else (v #>> '{}')::int end
    from get_limit(p_key, p_user_id) v
$$;

create function limit_bool(p_key text, p_user_id uuid default null) returns boolean
language sql stable as $$
  select (v #>> '{}')::boolean from get_limit(p_key, p_user_id) v
$$;

create function limit_text(p_key text, p_user_id uuid default null) returns text
language sql stable as $$
  select v #>> '{}' from get_limit(p_key, p_user_id) v
$$;
