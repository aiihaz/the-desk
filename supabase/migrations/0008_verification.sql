-- 0008_verification.sql: booking verification (eng plan 3.5) and the alerts it raises.
-- A booking the agent reports is stored as booked only when report.ts verified it
-- (chat/verify.ts); otherwise probably_booked, with an alert for the admin review.

-- Things for Ihaz to look at: unverified bookings, calls with no result, failed jobs.
-- Admin "review" lists the open ones; the health job sends the new ones.
create table alerts (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  request_id   uuid references requests on delete cascade,
  call_id      uuid references calls on delete set null,
  detail       jsonb not null default '{}',
  at           timestamptz not null default now(),
  notified_at  timestamptz,
  resolved_at  timestamptz,
  resolved_by  text
);
create index alerts_open_idx on alerts (at) where resolved_at is null;
alter table alerts enable row level security;

create function raise_alert(
  p_kind        text,
  p_request_id  uuid,
  p_call_id     uuid,
  p_detail      jsonb default '{}',
  p_now         timestamptz default now()
) returns uuid
language sql as $$
  insert into alerts (kind, request_id, call_id, detail, at)
  values (p_kind, p_request_id, p_call_id, coalesce(p_detail, '{}'), p_now)
  returning id;
$$;

insert into limits (key, value, value_type, nullable, description) values
  ('verify_model',            'null',  'text', true,  'model that checks a booking against the transcript; null = luna_model'),
  ('verify_reasoning_effort', '"low"', 'text', false, 'reasoning effort for the booking check');

-- As in 0007, but a booking carries its verification: verified → booked, otherwise
-- probably_booked plus a booking_unverified alert with the problems found.
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
begin
  if p_result not in ('done', 'options', 'back') then
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

  if p_result = 'done' then
    if p_booking is not null then
      ok := coalesce((p_booking ->> 'verified')::boolean, false);
      insert into bookings (request_id, call_id, status, time, reference)
      values (r.id, c.id, case when ok then 'booked' else 'probably_booked' end,
              (p_booking ->> 'time')::timestamptz, p_booking ->> 'reference');
      update calls set verified = ok where id = c.id;
      if not ok then
        perform raise_alert('booking_unverified', r.id, c.id,
                            jsonb_build_object('problems', coalesce(p_booking -> 'problems', '[]')), p_now);
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
    perform bump_request(r.id, 'call_ended', p_now);
    update requests set state = 'confirming', updated_at = p_now where id = r.id;
  end if;

  select * into r from requests where id = r.id;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'state', r.state, 'option_ids', to_jsonb(ids));
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
