alter table webhook_events add column ingested_at timestamptz;
alter table messages add column processing_attempts int not null default 0,
  add column retry_at timestamptz not null default now();

-- A crashed claim waits for its lease; an explicit failure backs off and alerts.
create function count_turn_claim() returns trigger language plpgsql as $$
begin
  if new.turn_token is distinct from old.turn_token and new.turn_token is not null then
    new.processing_attempts:=old.processing_attempts+1;
    new.retry_at:=now()+interval '2 minutes';
  end if;
  return new;
end $$;
create trigger count_turn_claim before update on messages for each row execute function count_turn_claim();
create or replace function pending_inbound() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x),'[]') from (
    select distinct on(m.user_id) m.user_id,u.wa_id,u.blocked,u.channel,m.body
    from messages m join users u on u.id=m.user_id
    where m.direction='in' and m.handled_at is null and m.retry_at<=now() and not u.blocked
      and not exists(select 1 from user_turns t where t.user_id=m.user_id and t.until>now())
      and (u.channel='linq' or exists(select 1 from messages recent where recent.user_id=m.user_id and recent.direction='in'
        and recent.at>now()-interval '24 hours'))
    order by m.user_id,m.seq desc limit 10
  ) x;
$$;
create or replace function abandon_turn(p_user_id uuid,p_token uuid) returns void language plpgsql as $$
begin
  perform lock_user(p_user_id);
  delete from user_turns where user_id=p_user_id and token=p_token;
  if found then
    if exists(select 1 from messages where user_id=p_user_id and turn_token=p_token and processing_attempts=3)
      and not exists(select 1 from alerts a join requests r on r.id=a.request_id
        where r.user_id=p_user_id and a.kind='turn_failed' and a.resolved_at is null) then
      perform raise_alert('turn_failed',(select id from requests where user_id=p_user_id order by updated_at desc limit 1),
        null,jsonb_build_object('user_id',p_user_id));
    end if;
    update messages set turn_token=null,retry_at=now()+make_interval(mins=>least(power(2,least(processing_attempts,5))::int,30))
      where user_id=p_user_id and turn_token=p_token and handled_at is null;
  end if;
end $$;

-- Consent may have committed just before a worker died, before any call row existed.
-- Recovery uses the same reservation guard, and never repeats a consumed consent.
create function pending_consents() returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x),'[]') from (
    select k.id as consent_id,k.kind,k.request_id,k.option_id,r.user_id,u.wa_id,u.blocked
    from consents k join requests r on r.id=k.request_id join users u on u.id=r.user_id
    where k.voided_at is null and k.request_version=r.version and k.at<now()-interval '90 seconds'
      and r.state in ('calling_1','calling_2','verifying') and u.stopped_at is null and not u.blocked
      and not exists(select 1 from calls where consent_id=k.id)
      and not exists(select 1 from user_turns where user_id=u.id and until>now())
    order by k.at limit 10
  ) x;
$$;
create function defer_changed_consent(p_request_id uuid) returns void language plpgsql as $$
declare uid uuid;
begin
  select user_id into uid from requests where id=p_request_id;
  perform lock_user(uid);
  if exists(select 1 from calls where request_id=p_request_id and status in ('queued','dialing','in_progress')) then return; end if;
  perform bump_request(p_request_id,'new_inbound',now());
  update requests set state='confirming',updated_at=now() where id=p_request_id;
end $$;
-- Add the single-consumption check without weakening any previous guard.
alter function check_dial(uuid,text,uuid,boolean,timestamptz) rename to check_dial_before_dispatch;
create function check_dial(p_request_id uuid,p_kind text,p_option_id uuid default null,
  p_is_retry boolean default false,p_now timestamptz default now()) returns jsonb language plpgsql stable as $$
declare res jsonb;
begin
  res:=check_dial_before_dispatch(p_request_id,p_kind,p_option_id,p_is_retry,p_now);
  if (res ->> 'ok')::boolean and not p_is_retry and exists(select 1 from calls
    where consent_id=(res ->> 'consent_id')::uuid) then return dial_refused('consent_spent'); end if;
  return res;
end $$;

-- Real, operator/provider-reported cost only. No invented per-minute estimates.
create function record_call_cost(p_call_id uuid,p_cost_rs numeric) returns void language plpgsql as $$
declare previous numeric;
begin
  if p_cost_rs is null or p_cost_rs<0 then raise exception 'cost must be nonnegative'; end if;
  select coalesce(cost_rs_est,0) into previous from calls where id=p_call_id for update;
  if not found then raise exception 'unknown call'; end if;
  if previous<>p_cost_rs then
    insert into credit_ledger(delta_rs,reason,call_id) values(previous-p_cost_rs,'reported call cost',p_call_id);
  end if;
  update calls set cost_rs_est=p_cost_rs where id=p_call_id;
end $$;

create table model_usage (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),user_id uuid references users on delete cascade,
  model text not null,purpose text not null,input_tokens int not null,output_tokens int not null,latency_ms int not null
);
alter table model_usage enable row level security;
create index model_usage_at_idx on model_usage(at);

create or replace function recovery_health() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'follow_through_last_ok',(select last_ok_at from job_runs where name='follow-through'),
    'oldest_uningested_at',(select min(received_at) from webhook_events where source in ('meta','linq') and ingested_at is null),
    'overdue_calls',(select count(*) from calls where status in ('queued','dialing','in_progress') and created_at<now()-interval '30 minutes'),
    'oldest_unhandled_at',(select min(m.at) from messages m where m.direction='in' and m.handled_at is null
      and (exists(select 1 from users u where u.id=m.user_id and u.channel='linq')
        or exists(select 1 from messages recent where recent.user_id=m.user_id and recent.direction='in' and recent.at>now()-interval '24 hours'))),
    'unsettled_calls',(select count(*) from calls where provider_result is not null and settled_at is null and created_at<now()-interval '15 minutes'),
    'unknown_submissions',(select count(*) from calls where submission_state='unknown' and provider_result is null),
    'failed_deliveries',(select count(*) from deliveries where status='failed'),
    'pending_erasure',(select count(*) from users where delete_requested_at<now()-interval '1 day'),
    'unpriced_calls',(select count(*) from calls where duration_s>0 and cost_rs_est is null));
$$;
revoke execute on all functions in schema public from public,anon,authenticated;

-- Crashes before the submission marker are known not to have reached the provider.
create function recover_reserved_calls() returns int language plpgsql as $$
declare n int;
begin
  update calls c set status='failed',submission_state='rejected',outcome='not_submitted',
    provider_result=jsonb_build_object('attemptId','','callId',c.id,'status','failed','outputs',null,
      'transcript',null,'durationS',null,'failureReason','not_submitted','interactionId',null,'agentNumber',null)
    where c.status='queued' and c.submission_state='reserved' and c.created_at<now()-interval '2 minutes'
      and not exists(select 1 from user_turns where user_id=c.user_id and until>now());
  get diagnostics n=row_count;
  return n;
end $$;

-- Contract gating and warnings belong to the same transaction as settlement.
create or replace function mark_settlement_complete() returns trigger language plpgsql as $$
declare c calls;
begin
  if new.kind='report' and new.call_id is not null then
    update calls set settled_at=now(),settlement_until=null where id=new.call_id returning * into c;
    if c.status='completed' and jsonb_typeof(c.outputs)='object' then
      perform record_caller_outputs(c.id,array(select jsonb_object_keys(c.outputs)));
    end if;
    if new.facts -> 'happened' ? 'caller_contract_missing' then
      perform caller_contract_broken(c.id);
      perform raise_alert('caller_contract_missing',new.request_id,c.id,'{}');
    end if;
    if new.facts -> 'happened' ? 'possible_unintended_commitment' then
      perform raise_alert('unintended_commitment',new.request_id,c.id,new.facts -> 'happened');
    end if;
  end if;
  return new;
end $$;

-- Redelivery and recovery can report the same incident, but must not create duplicate alerts.
alter table alerts add column incident_key text unique;
create or replace function raise_alert(p_kind text,p_request_id uuid,p_call_id uuid,
 p_detail jsonb default '{}',p_now timestamptz default now()) returns uuid language plpgsql as $$
declare aid uuid;
begin
  insert into alerts(kind,request_id,call_id,detail,at,incident_key)
    values(p_kind,p_request_id,p_call_id,coalesce(p_detail,'{}'),p_now,
      case when p_call_id is not null and p_kind in ('caller_contract_missing','unintended_commitment') then p_kind || ':' || p_call_id end) on conflict do nothing returning id into aid;
  if aid is null then select id into aid from alerts where call_id=p_call_id and kind=p_kind order by at limit 1; end if;
  return aid;
end $$;
revoke execute on all functions in schema public from public,anon,authenticated;

alter function record_payment(uuid,boolean,jsonb,timestamptz) set schema desk_private;
create function record_payment(p_request_id uuid,p_passed boolean,p_payment jsonb,p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare uid uuid;
begin
  select user_id into uid from requests where id=p_request_id;
  if uid is null then return chat_refused('no_request'); end if;
  perform lock_user(uid);
  if p_payment ? 'input_seq' and exists(select 1 from messages where user_id=uid and direction='in'
    and seq>(p_payment ->> 'input_seq')::bigint) then return chat_refused('new_inbound'); end if;
  return desk_private.record_payment(p_request_id,p_passed,p_payment,p_now);
end $$;
grant execute on all functions in schema desk_private to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;

alter function set_follow_up(uuid,text,timestamptz,timestamptz) set schema desk_private;
create function set_follow_up(p_request_id uuid,p_waiting_for text,p_remind_at timestamptz default null,p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare uid uuid; latest timestamptz;
begin
  select user_id into uid from requests where id=p_request_id;
  if uid is null then return chat_refused('no_request'); end if;
  perform lock_user(uid);
  select max(at) into latest from messages where user_id=uid and direction='in';
  if p_remind_at is not null and latest is not null and p_remind_at>=latest+interval '24 hours'
    and exists(select 1 from users where id=uid and channel='whatsapp') then
    return chat_refused('outside_service_window');
  end if;
  return desk_private.set_follow_up(p_request_id,p_waiting_for,p_remind_at,p_now);
end $$;

alter function purge_old_data(timestamptz) set schema desk_private;
create function purge_old_data(p_now timestamptz default now()) returns jsonb language plpgsql as $$
declare res jsonb;
begin
  res:=desk_private.purge_old_data(p_now);
  delete from model_usage where at<p_now-make_interval(days=>limit_int('transcript_retention_days'));
  return res;
end $$;
grant execute on all functions in schema desk_private to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;

create index webhook_events_uningested on webhook_events(received_at) where source in ('meta','linq') and ingested_at is null;
-- Existing events whose individual messages are all present need no ingest replay.
update webhook_events e set ingested_at=now() where e.source='meta' and not exists(
  select 1 from jsonb_array_elements(case when jsonb_typeof(e.payload -> 'entry')='array' then e.payload -> 'entry' else '[]'::jsonb end) entry,
    jsonb_array_elements(case when jsonb_typeof(entry -> 'changes')='array' then entry -> 'changes' else '[]'::jsonb end) change,
    jsonb_array_elements(case when jsonb_typeof(change -> 'value' -> 'messages')='array' then change -> 'value' -> 'messages' else '[]'::jsonb end) m
  where m ->> 'id' is not null and m ->> 'from' is not null
    and not exists(select 1 from messages where wa_message_id=m ->> 'id')
);

-- The old Linq deployment already stored verified envelopes and normalized inbox rows.
update webhook_events e set ingested_at=now() where e.source='linq' and (
  e.payload ->> 'event_type' is distinct from 'message.received' or exists (
    select 1 from messages m where m.wa_message_id=e.payload #>> '{data,id}'));

-- STOP invalidates the running generation, rather than merely hoping it finishes soon.
-- Old unfinished turns were explicitly cancelled; their inputs need no replay.
alter function stop_user(uuid,timestamptz) set schema desk_private;
create function stop_user(p_user_id uuid,p_now timestamptz default now()) returns jsonb language plpgsql as $$
declare res jsonb;
begin
  res:=desk_private.stop_user(p_user_id,p_now);
  delete from user_turns where user_id=p_user_id;
  update messages set handled_at=p_now,turn_token=null where user_id=p_user_id and direction='in' and handled_at is null;
  return res;
end $$;
update messages m set handled_at=now() from users u where u.id=m.user_id and u.blocked and m.handled_at is null;
grant execute on all functions in schema desk_private to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;

-- Revalidate ownership immediately before external work, not only after it. Batch
-- members may wait while earlier messages are sent; expired members must be reclaimed.
create function renew_delivery(p_id uuid,p_claim_token uuid,p_writer boolean default false,p_now timestamptz default now())
returns boolean language plpgsql as $$
begin
  update deliveries d set status='dropped' from users u where d.id=p_id and d.user_id=u.id
    and u.stopped_at is not null and d.kind<>'report' and d.status='pending';
  update deliveries set next_attempt_at=p_now+interval '10 minutes' where id=p_id and status='pending'
    and next_attempt_at>p_now and case when p_writer then write_token=p_claim_token and message is null
      else claim_token=p_claim_token and message is not null end;
  return found;
end $$;
revoke execute on all functions in schema public from public,anon,authenticated;

-- A pending deletion cannot silently be cancelled by the general START command.
alter function resume_user(uuid) set schema desk_private;
create function resume_user(p_user_id uuid) returns jsonb language plpgsql as $$
begin
  perform lock_user(p_user_id);
  if exists(select 1 from users where id=p_user_id and delete_requested_at is not null) then
    return chat_refused('deletion_pending');
  end if;
  return desk_private.resume_user(p_user_id);
end $$;
insert into reply_templates(key,language,text) values('delete_pending','en',
 'Your deletion request is still being completed. I won''t start new errands meanwhile.');
grant execute on all functions in schema desk_private to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;
