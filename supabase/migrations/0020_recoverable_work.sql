-- Accepting work, claiming it, and completing it are distinct operations.
-- Kept in Postgres so webhook workers and scheduled recovery share one authority.
alter table messages add column turn_token uuid;
alter table user_turns add column token uuid, add column input_seq bigint;

create function ingest_inbound(p_user_id uuid, p_message_id text, p_body jsonb, p_at timestamptz)
returns boolean language plpgsql as $$
declare n int;
begin
  perform lock_user(p_user_id);
  insert into messages(user_id, wa_message_id, direction, body, at,handled_at)
  values (p_user_id, p_message_id, 'in', p_body, p_at,
    case when (select blocked from users where id=p_user_id) then now() end)
  on conflict (wa_message_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    update deliveries set status='dropped' where user_id=p_user_id and status='pending'
      and dedupe_key like 'window:' || p_user_id || ':%';
    update deliveries set next_attempt_at = now(), last_error = null
     where user_id = p_user_id and status = 'pending' and next_attempt_at = 'infinity';
  end if;
  return n > 0;
end $$;

create function pending_inbound() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x), '[]') from (
    select distinct on (m.user_id) m.user_id, u.wa_id, u.blocked, u.channel, m.body
      from messages m join users u on u.id = m.user_id
     where m.direction = 'in' and m.handled_at is null
       and not exists (select 1 from user_turns t where t.user_id = m.user_id and t.until > now())
     order by m.user_id, m.seq desc limit 50
  ) x;
$$;

create or replace function claim_turn(p_user_id uuid, p_message_id text,
  p_ttl_s int default 90, p_now timestamptz default now()) returns jsonb language plpgsql as $$
declare m messages; batch jsonb; tok uuid := gen_random_uuid();
begin
  perform lock_user(p_user_id);
  select * into m from messages where user_id = p_user_id and wa_message_id = p_message_id;
  if not found or m.handled_at is not null then return jsonb_build_object('status','handled'); end if;
  if exists (select 1 from user_turns where user_id = p_user_id and until > p_now) then
    return jsonb_build_object('status','busy');
  end if;
  if exists (select 1 from messages where user_id = p_user_id and direction = 'in'
              and handled_at is null and seq > m.seq) then
    return jsonb_build_object('status','newer');
  end if;
  insert into user_turns(user_id, holder, until, token, input_seq)
  values (p_user_id, p_message_id, p_now + make_interval(secs => p_ttl_s), tok, m.seq)
  on conflict(user_id) do update set holder = excluded.holder, until = excluded.until,
    token = excluded.token, input_seq = excluded.input_seq;
  with taken as (
    update messages set turn_token = tok where user_id = p_user_id and direction = 'in'
      and handled_at is null and seq <= m.seq returning body, seq
  ) select coalesce(jsonb_agg(body order by seq),'[]') into batch from taken;
  return jsonb_build_object('status','claimed','batch',batch,'token',tok,'input_seq',m.seq);
end $$;

create function assert_turn(p_user_id uuid, p_token uuid, p_now timestamptz default now())
returns void language plpgsql as $$
begin
  perform lock_user(p_user_id);
  if not exists (select 1 from user_turns where user_id = p_user_id
                 and token = p_token and until > p_now) then
    raise exception 'turn lease lost' using errcode = '55000';
  end if;
end $$;

create function renew_turn(p_user_id uuid, p_token uuid, p_now timestamptz default now())
returns void language plpgsql as $$
begin
  perform assert_turn(p_user_id, p_token, p_now);
  update user_turns set until = p_now + interval '90 seconds' where user_id = p_user_id and token = p_token;
end $$;

create function complete_turn(p_user_id uuid, p_token uuid, p_now timestamptz default now())
returns void language plpgsql as $$
begin
  perform assert_turn(p_user_id, p_token, p_now);
  update messages set handled_at = p_now where user_id = p_user_id and turn_token = p_token;
  delete from user_turns where user_id = p_user_id and token = p_token;
end $$;

-- A stale worker cannot mutate requests, insert calls/consents, or change memories.
-- Recovery and immediate STOP run without a turn header; their own RPCs hold user locks.
create function fence_turn_write() returns trigger language plpgsql as $$
declare tok text; uid uuid;
begin
  tok := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-desk-turn';
  if tok is null then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name = 'consents' then
    select user_id into uid from requests where id = coalesce(new.request_id,old.request_id);
  elsif tg_table_name='users' then uid:=coalesce(new.id,old.id);
  else uid := coalesce(new.user_id,old.user_id); end if;
  perform assert_turn(uid, tok::uuid);
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger fence_requests before insert or update on requests for each row execute function fence_turn_write();
create trigger fence_users before update on users for each row execute function fence_turn_write();
create trigger fence_calls before insert or update on calls for each row execute function fence_turn_write();
create trigger fence_consents before insert on consents for each row execute function fence_turn_write();
create trigger fence_outbox before insert on deliveries for each row execute function fence_turn_write();
create trigger fence_memories before insert or update or delete on user_memories for each row execute function fence_turn_write();

-- A consent binds the exact inbox watermark evaluated, not merely the request version.
alter function record_consent(uuid,uuid,text,text,timestamptz,jsonb) rename to record_consent_before_watermark;
create function record_consent(p_prompt_id uuid, p_option_id uuid, p_word text,
  p_wa_message_id text, p_now timestamptz default now(), p_basis jsonb default null)
returns jsonb language plpgsql as $$
declare uid uuid; watermark bigint;
begin
  select r.user_id into uid from consent_prompts p join requests r on r.id = p.request_id where p.id = p_prompt_id;
  if uid is null then return chat_refused('no_prompt'); end if;
  perform lock_user(uid);
  -- Legacy SQL maintenance/tests may omit the watermark; HTTP clients may not.
  if p_basis ? 'input_seq' then
    watermark := (p_basis ->> 'input_seq')::bigint;
    if watermark is null or not exists (select 1 from messages where user_id = uid
      and direction = 'in' and seq = watermark and wa_message_id = p_wa_message_id)
      or exists (select 1 from messages where user_id = uid and direction = 'in' and seq > watermark) then
      return chat_refused('new_inbound');
    end if;
  elsif current_user <> 'postgres' then return chat_refused('missing_watermark');
  end if;
  return desk_private.record_consent_before_watermark(p_prompt_id,p_option_id,p_word,p_wa_message_id,p_now,p_basis);
end $$;

-- The same check immediately before reserving a real-world action closes the gap
-- between recording consent and reserving the call. Ingestion shares lock_user.
alter function check_dial(uuid,text,uuid,boolean,timestamptz) rename to check_dial_before_recovery;
alter table calls add column submission_state text not null default 'reserved'
  check (submission_state in ('reserved','accepted','unknown','rejected','resolved')),
  add column provider_result jsonb, add column settled_at timestamptz,
  add column settlement_token uuid, add column settlement_until timestamptz;
create function check_dial(p_request_id uuid,p_kind text,p_option_id uuid default null,
  p_is_retry boolean default false,p_now timestamptz default now()) returns jsonb language plpgsql stable as $$
declare r requests; k consents; res jsonb;
begin
  select * into r from requests where id = p_request_id;
  if exists (select 1 from calls where user_id = r.user_id and business_id = r.business_id
    and submission_state = 'unknown' and provider_result is null) then return dial_refused('submission_unresolved'); end if;
  res := check_dial_before_recovery(p_request_id,p_kind,p_option_id,p_is_retry,p_now);
  if not (res ->> 'ok')::boolean then return res; end if;
  select * into k from consents where id = (res ->> 'consent_id')::uuid;
  if k.basis ? 'input_seq' and exists (select 1 from messages where user_id = r.user_id
    and direction = 'in' and seq > (k.basis ->> 'input_seq')::bigint) then return dial_refused('new_inbound'); end if;
  return res;
end $$;

create function finish_provider_call(p_result jsonb) returns uuid language plpgsql as $$
declare c calls;
begin
  select * into c from calls where case when p_result ->> 'callId' is not null
    then id = (p_result ->> 'callId')::uuid else provider_call_id = p_result ->> 'attemptId' end for update;
  if not found then return null; end if;
  if c.provider_call_id is not null and c.provider_call_id <> p_result ->> 'attemptId' then
    raise exception 'provider attempt mismatch';
  end if;
  if c.settled_at is not null then
    if c.provider_result ->> 'failureReason'='no_result' and p_result ->> 'failureReason' is distinct from 'no_result' then
      update calls set provider_result=p_result,submission_state='resolved',status=p_result ->> 'status',
        outputs=nullif(p_result -> 'outputs','null'),transcript=nullif(p_result -> 'transcript','null') where id=c.id;
      perform raise_alert('late_call_result',c.request_id,c.id,jsonb_build_object('provider_status',p_result ->> 'status'));
      insert into deliveries(user_id,request_id,call_id,dedupe_key,kind,facts)
        values(c.user_id,c.request_id,c.id,'late-call:' || c.id,'report',jsonb_build_object('event','late_call_result',
          'happened',jsonb_build_object('status','a_result_arrived_after_we_reported_it_unknown',
            'provider_reported',p_result -> 'outputs','not_verified',true),
          'values','{}'::jsonb,'next_step','check_with_business_themselves')) on conflict(dedupe_key) do nothing;
    end if;
    return null;
  end if;
  update calls set provider_call_id = p_result ->> 'attemptId', status = p_result ->> 'status',
    outcome = coalesce(p_result ->> 'failureReason',p_result ->> 'status'),
    outputs = nullif(p_result -> 'outputs','null'), transcript = nullif(p_result -> 'transcript','null'),
    duration_s = (p_result ->> 'durationS')::int, submission_state = 'resolved', provider_result = p_result
    where id = c.id and provider_result is null;
  return c.id;
end $$;

create function claim_settlement(p_call_id uuid, p_now timestamptz default now()) returns uuid language plpgsql as $$
declare tok uuid := gen_random_uuid();
begin
  update calls set settlement_token = tok, settlement_until = p_now + interval '10 minutes'
   where id = p_call_id and settled_at is null and (settlement_until is null or settlement_until <= p_now);
  if not found then return null; end if;
  return tok;
end $$;

-- Settlement and the owed result are already atomic; attach completion to that transaction.
create function mark_settlement_complete() returns trigger language plpgsql as $$
begin
  if new.kind = 'report' and new.call_id is not null then
    update calls set settled_at = now(), settlement_until = null where id = new.call_id;
    if new.facts -> 'happened' ? 'possible_unintended_commitment' then
      perform raise_alert('unintended_commitment',new.request_id,new.call_id,new.facts -> 'happened');
    end if;
  end if;
  return new;
end $$;
create trigger settlement_complete after insert on deliveries for each row execute function mark_settlement_complete();
-- Existing reports establish completion; recover older terminal results with no report.
update calls c set settled_at = d.created_at from deliveries d where d.call_id = c.id and d.kind = 'report';
update calls set provider_result = jsonb_build_object('attemptId',coalesce(provider_call_id,''),'callId',id,
  'status',case when status = 'timeout' then 'failed' else status end,'outputs',outputs,
  'transcript',transcript,'durationS',duration_s,'failureReason',case when provider_call_id is null then 'no_result' else outcome end,'interactionId',null,'agentNumber',null)
 where settled_at is null and status in ('completed','no_answer','busy','failed','timeout')
;

-- Concurrent send claims are exclusive; an expired owner's completion cannot overwrite a successor.
alter table deliveries add column claim_token uuid;
create or replace function take_deliveries(p_now timestamptz default now(),p_limit int default 50,p_call_id uuid default null)
returns jsonb language plpgsql as $$
declare res jsonb; owner uuid; tok text;
begin
  tok:=nullif(current_setting('request.headers',true),'')::jsonb ->> 'x-desk-turn';
  if tok is not null then
    select user_id into owner from user_turns where token=tok::uuid and until>p_now;
    if owner is null then raise exception 'turn lease lost' using errcode='55000'; end if;
  end if;
  update deliveries d set status = 'dropped' from users u
   where (owner is null or d.user_id=owner) and u.id = d.user_id and d.status = 'pending' and d.kind <> 'report' and u.stopped_at is not null;
  with due as (
    select d.id from deliveries d where (owner is null or d.user_id=owner) and d.status = 'pending' and d.message is not null
      and d.next_attempt_at <= p_now and (p_call_id is null or d.call_id = p_call_id)
      and not exists (select 1 from deliveries earlier where earlier.status = 'pending'
        and earlier.call_id = d.call_id and (earlier.seq,earlier.created_at,earlier.id) < (d.seq,d.created_at,d.id))
      order by d.next_attempt_at,d.id limit p_limit for update of d skip locked
  ), taken as (
    update deliveries d set attempts = attempts + 1, next_attempt_at = p_now + interval '10 minutes',
      claim_token = gen_random_uuid() from due where d.id = due.id
    returning d.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'user_id',t.user_id,'wa_id',u.wa_id,
      'message',t.message,'attempts',t.attempts,'kind',t.kind,'claim_token',t.claim_token)),'[]') into res
    from taken t join users u on u.id = t.user_id;
  return res;
end $$;

alter function delivery_sent(uuid,text,timestamptz) rename to delivery_sent_unfenced;
create function delivery_sent(p_id uuid,p_wa_message_id text,p_now timestamptz default now(),p_claim_token uuid default null)
returns void language plpgsql as $$
begin
  perform 1 from deliveries where id = p_id for update;
  if p_claim_token is not null then
    if not exists(select 1 from deliveries where id=p_id and status='pending' and claim_token=p_claim_token
      and next_attempt_at > p_now) then raise exception 'delivery lease lost'; end if;
  elsif current_user <> 'postgres' then raise exception 'delivery claim required'; end if;
  perform desk_private.delivery_sent_unfenced(p_id,p_wa_message_id,p_now);
  update deliveries set claim_token=null where id=p_id;
end $$;
alter function delivery_failed(uuid,text,boolean,timestamptz) rename to delivery_failed_unfenced;
create function delivery_failed(p_id uuid,p_error text,p_final boolean default false,p_now timestamptz default now(),
  p_claim_token uuid default null) returns text language plpgsql as $$
declare res text;
begin
  perform 1 from deliveries where id=p_id for update;
  if p_claim_token is not null then
    if not exists(select 1 from deliveries where id=p_id and status='pending' and claim_token=p_claim_token
      and next_attempt_at > p_now) then raise exception 'delivery lease lost'; end if;
  elsif current_user <> 'postgres' then raise exception 'delivery claim required'; end if;
  res := desk_private.delivery_failed_unfenced(p_id,p_error,p_final,p_now);
  update deliveries set claim_token=null where id=p_id;
  return res;
end $$;
create function defer_delivery(p_id uuid,p_claim_token uuid) returns void language plpgsql as $$
begin
  update deliveries d set next_attempt_at=case when exists(select 1 from messages m where m.user_id=d.user_id
      and m.direction='in' and m.at>now()-interval '24 hours') then now() else 'infinity'::timestamptz end,
    claim_token=null, attempts=greatest(attempts-1,0),
    last_error='waiting for the user to reopen the service window'
    where id=p_id and status='pending' and claim_token=p_claim_token;
  if not found then raise exception 'delivery lease lost'; end if;
end $$;

-- Private helpers must not be callable through the public API to bypass wrappers.
revoke execute on all functions in schema public from public,anon,authenticated;
create schema if not exists desk_private;
grant usage on schema desk_private to service_role;
alter function record_consent_before_watermark(uuid,uuid,text,text,timestamptz,jsonb) set schema desk_private;
alter function delivery_sent_unfenced(uuid,text,timestamptz) set schema desk_private;
alter function delivery_failed_unfenced(uuid,text,boolean,timestamptz) set schema desk_private;
grant execute on all functions in schema desk_private to service_role;

create function abandon_turn(p_user_id uuid,p_token uuid) returns void language plpgsql as $$
begin
  perform lock_user(p_user_id);
  delete from user_turns where user_id=p_user_id and token=p_token;
  if found then update messages set turn_token=null where user_id=p_user_id and turn_token=p_token
    and handled_at is null; end if;
end $$;

alter function settle_and_report(uuid,text,jsonb,jsonb,boolean,jsonb,jsonb,boolean,timestamptz)
  set schema desk_private;
create function settle_and_report(p_call_id uuid,p_result text,p_options jsonb default '[]',
  p_booking jsonb default null,p_opt_out boolean default false,p_facts jsonb default '{}',
  p_next jsonb default null,p_end boolean default false,p_now timestamptz default now(),p_claim_token uuid default null)
returns jsonb language plpgsql as $$
begin
  perform 1 from calls where id=p_call_id for update;
  if p_claim_token is not null then
    if not exists(select 1 from calls where id=p_call_id and settled_at is null
      and settlement_token=p_claim_token and settlement_until>p_now) then return chat_refused('settlement_lease_lost'); end if;
  elsif current_user <> 'postgres' then return chat_refused('settlement_claim_required'); end if;
  return desk_private.settle_and_report(p_call_id,p_result,p_options,p_booking,p_opt_out,p_facts,p_next,p_end,p_now);
end $$;
grant execute on all functions in schema desk_private to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;

create function retain_timeout_result() returns trigger language plpgsql as $$
begin
  if new.status='timeout' and new.provider_result is null then
    new.provider_result := jsonb_build_object('attemptId',coalesce(new.provider_call_id,''),'callId',new.id,
      'status','failed','outputs',null,'transcript',null,'durationS',null,'failureReason','no_result',
      'interactionId',null,'agentNumber',null);
  end if;
  return new;
end $$;
create trigger retain_timeout before update on calls for each row execute function retain_timeout_result();
revoke execute on all functions in schema public from public,anon,authenticated;
