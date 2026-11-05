-- 0023: the language a call opens in, and call transcripts the user can read.
--
-- businesses.state: the state Google Maps gives, so dial() can open the call in the
-- local language (call_language.ts).
--
-- Transcripts: a user can ask to see what was said on a call (show_transcript). Each one
-- is kept only until 12 hours after the event it led to, or 48 hours after the call when
-- there is no event (nothing booked, a question, a cancelled booking). Every copy goes
-- then: the call's own, the provider result and raw webhook payload, the report facts,
-- and any message that showed it to the user. The 90-day purge (0009) stays as a backstop.

alter table businesses add column state text;

insert into limits (key, value, value_type, nullable, description) values
  ('transcript_hours_after_event',   '12', 'int', false, 'a call transcript is deleted this many hours after the booked time it led to'),
  ('transcript_hours_without_event', '48', 'int', false, 'a call transcript with no booked event is deleted this many hours after the call');

alter table calls add column transcript_purged_at timestamptz;
-- A message that showed the user this call's transcript (show_transcript).
alter table messages add column transcript_call_id uuid references calls on delete set null;
create index messages_transcript_call_idx on messages (transcript_call_id) where transcript_call_id is not null;

-- When a call's transcript goes. The event is the newest booking along the errand's chain
-- (the errand that made it, and any reschedule or cancel of it), so a move carries the
-- deadline to the new time. A cancelled or dropped booking, or one with no date, is no event.
create function transcript_until(p_call_id uuid) returns timestamptz
language sql stable as $$
  with recursive c as (
    select id, request_id, user_id, created_at from calls where id = p_call_id
  ),
  -- Request a made a booking that request b changes.
  edges as (
    select b.request_id as a, r.id as b
      from requests r join bookings b on b.id = r.booking_id
     where r.user_id = (select user_id from c)
  ),
  chain(rid) as (
    select request_id from c
    union
    select case when e.a = chain.rid then e.b else e.a end
      from chain join edges e on chain.rid in (e.a, e.b)
  ),
  latest as (
    select k.status, k.time, k.booked_on from bookings k
     where k.request_id in (select rid from chain)
     order by k.created_at desc limit 1
  ),
  event as (
    select coalesce(time, ((booked_on + 1)::timestamp at time zone 'Asia/Kolkata')) as at
      from latest where status not in ('cancelled', 'dropped')
  )
  select coalesce(
    (select at + make_interval(hours => limit_int('transcript_hours_after_event')) from event where at is not null),
    (select created_at + make_interval(hours => limit_int('transcript_hours_without_event')) from c)
  );
$$;

-- The user's calls whose transcript is still kept, newest first.
create function user_transcripts(p_user_id uuid, p_now timestamptz default now()) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x order by x.at desc), '[]') from (
    select c.id, c.kind, c.created_at as at, b.name as place, transcript_until(c.id) as until
      from calls c join businesses b on b.id = c.business_id
     where c.user_id = p_user_id and c.transcript is not null
       and jsonb_typeof(c.transcript) = 'array' and jsonb_array_length(c.transcript) > 0
       and transcript_until(c.id) > p_now
     order by c.created_at desc limit 10
  ) x;
$$;

-- Runs every 15 minutes. A call still open, or with a result not yet settled, is left
-- alone: its report and booking check still read the transcript.
create function purge_transcripts(p_now timestamptz default now()) returns jsonb
language plpgsql as $$
declare
  c  record;
  n  int := 0;
  m  int := 0;
  k  int;
begin
  for c in
    select id, provider_call_id from calls
     where (transcript_purged_at is null or transcript is not null)
       and status not in ('queued', 'dialing', 'in_progress')
       and (provider_result is null or settled_at is not null)
  loop
    continue when transcript_until(c.id) > p_now;
    update calls
       set transcript = null,
           provider_result = case when provider_result ? 'transcript'
                                  then jsonb_set(provider_result, '{transcript}', 'null') else provider_result end,
           transcript_purged_at = p_now
     where id = c.id;
    if c.provider_call_id is not null then
      update webhook_events set payload = payload - 'interaction_transcript'
       where source = 'sarvam' and external_id = c.provider_call_id and payload ? 'interaction_transcript';
    end if;
    update deliveries set facts = facts #- '{call,transcript}'
     where call_id = c.id and facts #> '{call,transcript}' is not null;
    update messages set body = jsonb_build_object('kind', 'text', 'body', '(Call transcript deleted.)')
     where transcript_call_id = c.id;
    get diagnostics k = row_count;
    m := m + k;
    n := n + 1;
  end loop;
  return jsonb_build_object('calls', n, 'messages', m);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('desk-transcripts', '*/15 * * * *', 'select purge_transcripts()');
  end if;
end $$;
