-- 0036: the comparison bench (scripts/comparison_bench.ts, owner's request 20 Nov 2026).
-- Runs a comparison errand against real businesses with no chat in front of it. Its
-- user is on the 'bench' channel: everything the Desk would send that user (the
-- "calling these" notice, the ranked summary, alerts about the errand) is written and
-- stored in messages as usual, and never leaves the Desk.
-- (0035 is reserved for the Bolna caller on its own branch.)

alter table users drop constraint users_channel_check;
alter table users add constraint users_channel_check
  check (channel in ('whatsapp', 'linq', 'bench'));
-- Bench identities can't collide with a phone-keyed WhatsApp or Linq user.
alter table users add constraint users_bench_identity_check
  check (channel <> 'bench' or wa_id like 'bench:%');

-- One row per bench run: what was asked, who was picked, and per call its outcome,
-- outputs, transcript and audio path, with the summary the user would have read.
-- Call transcripts are purged on the normal retention clock (0023); this copy is the
-- record of the test and is kept until deleted by hand.
create table bench_runs (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null unique references requests on delete cascade,
  user_id     uuid not null references users on delete cascade,
  query       text not null,
  questions   jsonb not null,
  picked      jsonb not null default '[]',
  calls       jsonb not null default '[]',
  summary     jsonb,
  status      text not null default 'dialing'
    check (status in ('dialing', 'complete', 'timed_out', 'not_started')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table bench_runs enable row level security;
revoke all on table bench_runs from public, anon, authenticated;
grant all on table bench_runs to service_role;
