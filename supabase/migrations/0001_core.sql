-- 0001_core.sql: core tables (eng plan section 4).
-- RLS is on for every table with no policies: only the service role
-- (edge functions) and the dashboard can read or write.

create extension if not exists pgcrypto;

create domain e164 as text
  check (value ~ '^\+[1-9][0-9]{6,14}$');

create table users (
  id          uuid primary key default gen_random_uuid(),
  wa_id       text not null unique,
  name        text,
  phone_e164  e164,
  language    text not null default 'en-IN',
  blocked     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table businesses (
  id             uuid primary key default gen_random_uuid(),
  place_id       text unique,
  phone_e164     e164 not null,
  name           text not null,
  city           text,
  -- Places regularOpeningHours as returned (periods with day/hour/minute).
  opening_hours  jsonb,
  source         text not null check (source in ('places', 'serper', 'user')),
  updated_at     timestamptz not null default now()
);
create index businesses_phone_idx on businesses (phone_e164);

create table user_places (
  user_id     uuid not null references users on delete cascade,
  label       text not null,
  place_id    text,
  phone_e164  e164,
  primary key (user_id, label)
);

create table user_blocks (
  user_id      uuid not null references users on delete cascade,
  business_id  uuid not null references businesses on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (user_id, business_id)
);

create table caller_numbers (
  id               uuid primary key default gen_random_uuid(),
  e164             e164 not null unique,
  provider         text not null check (provider in ('sarvam', 'byo')),
  a2p_declared_at  timestamptz,
  active           boolean not null default true,
  daily_cap        int check (daily_cap >= 0),
  created_at       timestamptz not null default now()
);

-- Numbers whose owners agreed to receive test calls (Ihaz, friends playing shops).
-- An undeclared caller number may only dial these (check_dial step 2).
create table test_numbers (
  phone_e164    e164 primary key,
  name          text not null,
  consented_at  timestamptz not null default now()
);

create table requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users on delete cascade,
  task              text not null check (task in ('booking', 'question', 'reschedule')),
  state             text not null default 'collecting' check (state in (
                      'collecting', 'choosing_place', 'confirming', 'awaiting_yes',
                      'calling_1', 'options_ready', 'awaiting_pick', 'calling_2',
                      'verifying', 'done', 'awaiting_payment', 'stale_options', 'cancelled')),
  -- Slots filled by the chat agent: window_start, window_end, exact_time,
  -- party_size, service, max_price, ... (ISO timestamps with offset).
  fields            jsonb not null default '{}',
  business_id       uuid references businesses,
  caller_number_id  uuid references caller_numbers,
  call_language     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index requests_user_idx on requests (user_id);

create table calls (
  id                uuid primary key default gen_random_uuid(),
  provider_call_id  text unique,
  request_id        uuid not null references requests on delete cascade,
  user_id           uuid not null references users on delete cascade,
  business_id       uuid not null references businesses,
  caller_number_id  uuid not null references caller_numbers,
  -- Matches the Sarvam agent's call_kind input (eng plan 3.4).
  kind              text not null check (kind in ('first', 'booking', 'question', 'reschedule')),
  option_id         uuid,
  -- A redial after no answer or busy; counts against max_retries_no_answer.
  is_retry          boolean not null default false,
  agent_version     text not null,
  status            text not null default 'queued' check (status in (
                      'queued', 'dialing', 'in_progress', 'completed',
                      'no_answer', 'busy', 'failed', 'timeout')),
  outcome           text,
  outputs           jsonb,
  transcript        jsonb,
  verified          boolean,
  cost_rs_est       numeric(10, 2),
  duration_s        int,
  created_at        timestamptz not null default now()
);
create index calls_business_day_idx on calls (business_id, created_at);
create index calls_user_day_idx on calls (user_id, created_at);
create index calls_request_idx on calls (request_id);

create table options (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references requests on delete cascade,
  call_id           uuid references calls on delete set null,
  label             text not null,
  -- e.g. {"time": "2026-10-23T21:30:00+05:30", "party_size": 4}
  value             jsonb not null,
  advance_required  boolean not null default false,
  created_at        timestamptz not null default now(),
  stale_at          timestamptz
);
alter table calls add foreign key (option_id) references options on delete set null;

create table consents (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references requests on delete cascade,
  -- ask = consent #1 (YES to the read-back), book = consent #2 (the pick).
  kind           text not null check (kind in ('ask', 'book')),
  option_id      uuid references options on delete cascade,
  text_shown     text not null,
  -- md5 of requests.fields when the user said YES; a later edit voids the consent.
  fields_hash    text not null,
  wa_message_id  text,
  at             timestamptz not null default now(),
  check ((kind = 'book') = (option_id is not null))
);
create index consents_request_idx on consents (request_id);

create table bookings (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references requests on delete cascade,
  call_id           uuid not null references calls,
  status            text not null check (status in (
                      'booked', 'held_pending_deposit', 'probably_booked', 'cancelled')),
  time              timestamptz,
  reference         text,
  deposit_amount    numeric(10, 2),
  upi_id            text,
  paid_reported_at  timestamptz,
  created_at        timestamptz not null default now()
);

-- Global across all caller numbers (eng plan 5.3).
create table opt_outs (
  phone_e164  e164 primary key,
  source      text not null check (source in ('call', 'admin', 'complaint')),
  call_id     uuid references calls on delete set null,
  at          timestamptz not null default now()
);

create table messages (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references users on delete cascade,
  wa_message_id  text unique,
  direction      text not null check (direction in ('in', 'out')),
  body           jsonb not null,
  at             timestamptz not null default now()
);

-- Sarvam credit: top-ups are positive, call costs negative.
create table credit_ledger (
  id       uuid primary key default gen_random_uuid(),
  delta_rs numeric(10, 2) not null,
  reason   text not null,
  call_id  uuid references calls on delete set null,
  at       timestamptz not null default now()
);

-- An agent version may dial only after its Sarvam test suite passed.
create table gate_passes (
  agent_version  text primary key,
  suite          text not null,
  passed         boolean not null,
  notes          text,
  at             timestamptz not null default now()
);

create table webhook_events (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('meta', 'sarvam')),
  external_id  text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  unique (source, external_id)
);

alter table users          enable row level security;
alter table businesses     enable row level security;
alter table user_places    enable row level security;
alter table user_blocks    enable row level security;
alter table caller_numbers enable row level security;
alter table test_numbers   enable row level security;
alter table requests       enable row level security;
alter table calls          enable row level security;
alter table options        enable row level security;
alter table consents       enable row level security;
alter table bookings       enable row level security;
alter table opt_outs       enable row level security;
alter table messages       enable row level security;
alter table credit_ledger  enable row level security;
alter table gate_passes    enable row level security;
alter table webhook_events enable row level security;
