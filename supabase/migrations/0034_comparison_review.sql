-- Forward-only corrections to deployed 0031-0033. Never edit deployed history.
-- 0031_bolna.sql was absent from the repository; its reconciliation is a separate
-- source-dependent step. Do not mark Bolna applied or overwrite its contents.

-- Existing global value is ignored for comparison. Require an explicit per-user row.
create or replace function requests_comparison_snapshot() returns trigger language plpgsql as $$
begin
  new.comparison := new.task in ('question','booking') and exists(
    select 1 from user_limits where user_id=new.user_id and key='comparison_mode' and value='true'::jsonb
  );
  if not new.comparison then new.comparison_dispatching:=false; end if;
  return new;
end $$;
alter table requests alter column comparison_dispatching set default false;
-- No comparison state existed at preflight. Defensive normalization also covers
-- deployment after an older comparison build created an unsupported task.
update requests set comparison=false,comparison_dispatching=false where task in ('cancel','reschedule');

alter table calls add column comparison_result jsonb;

create or replace function settle_comparison_call(
  p_call_id       uuid,
  p_opt_out       boolean default false,
  p_wrong_number  boolean default false,
  p_facts         jsonb default '{}',
  p_now           timestamptz default now(),
  p_claim_token   uuid default null
) returns jsonb
language plpgsql as $$
declare
  c          calls;
  r          requests;
  ph         text;
  remaining  int;
  st         text;
begin
  select * into c from calls where id = p_call_id for update;
  if not found then
    return chat_refused('no_call');
  end if;
  if p_claim_token is null or c.settlement_token is distinct from p_claim_token
     or c.settlement_until is null or c.settlement_until <= p_now then
    return chat_refused('settlement_lease_lost');
  end if;
  perform lock_user(c.user_id);
  select * into r from requests where id = c.request_id;
  if not r.comparison then
    return chat_refused('not_comparison');
  end if;
  if r.comparison_dispatching and r.comparison_dispatch_until>p_now and r.state in ('calling_1','calling_2','verifying') then
    return chat_refused('batch_dispatching');
  end if;
  -- A crashed submitter cannot strand settled provider results forever. Once its
  -- lease expires reservations fail closed, and recovery may finish existing calls.
  if r.comparison_dispatching then
    update requests set comparison_dispatching=false where id=r.id;
  end if;
  if c.settled_at is not null then
    return chat_refused('already_settled');
  end if;

  if p_opt_out then
    select phone_e164 into ph from businesses where id = c.business_id;
    insert into opt_outs (phone_e164, source, call_id, at) values (ph, 'call', c.id, p_now)
    on conflict (phone_e164) do nothing;
  end if;
  if p_wrong_number then
    insert into wrong_numbers (user_id, business_id, phone_e164, call_id, at)
    select c.user_id, b.id, b.phone_e164, c.id, p_now from businesses b where b.id = c.business_id
    on conflict (user_id,business_id,phone_e164) do nothing;
  end if;

  -- settled_at is normally the deliveries trigger's mark; a batch's earlier calls get
  -- no delivery of their own, so it is set here for every call of the batch.
  update calls set settled_at = p_now, settlement_until = null,
    comparison_result = coalesce(p_facts -> '_comparison_result',jsonb_build_object('rank',2,'outcome','unclear'))
    where id = c.id;

  -- Cancellation/expiry ends the errand, not our duty to settle received results.
  -- Retain opt-out/wrong-number bookkeeping, never resurrect or deliver a stale report.
  if r.state not in ('calling_1','calling_2','verifying') then
    return jsonb_build_object('ok',true,'batch_complete',false,'state',r.state,'request_id',r.id,'suppressed',true);
  end if;

  -- Still to come: calls dialling or with a result not yet reported. Calls that never
  -- started (failed) or timed out with no result are done: the summary reads them as
  -- unreachable.
  select count(*) into remaining from calls x
   where x.request_id = r.id and x.id <> c.id and x.settled_at is null
     and (x.status in ('queued','dialing','in_progress') or x.provider_result is not null);

  if remaining > 0 then
    return jsonb_build_object('ok', true, 'request_id', r.id, 'batch_complete', false, 'state', r.state);
  end if;

  -- Facts are assembled under the same user lock that decides the final delivery.
  -- Each prior settlement has committed its own result. Never reuse a pre-lock batch snapshot.
  p_facts := p_facts - '_comparison_result';
  p_facts := jsonb_set(p_facts,'{happened,results}',coalesce((
    select jsonb_agg(jsonb_build_object(
      'place',coalesce(b.name,'a selected business') || case when b.area is not null then ', '||b.area else '' end,
      'outcome',coalesce(x.comparison_result->>'outcome',case when x.status='completed' then 'unclear' else 'unreachable' end),
      'detail',coalesce(x.comparison_result->'detail',to_jsonb(case when x.status='completed' then 'result not captured' else 'call did not connect or no result returned' end))
    ) order by coalesce((x.comparison_result->>'rank')::int,case when x.status='completed' then 2 else 3 end),array_position(r.recipient_ids,x.business_id))
    from calls x left join businesses b on b.id=x.business_id where x.request_id=r.id
  ),'[]'::jsonb),true);
  p_facts := jsonb_set(p_facts,'{happened,not_called}',coalesce((
    select jsonb_agg(jsonb_build_object('place',coalesce(b.name,'a selected business'),'outcome','not called') order by t.pos)
    from unnest(r.recipient_ids) with ordinality t(id,pos) left join businesses b on b.id=t.id
    where not exists(select 1 from calls x where x.request_id=r.id and x.business_id=t.id)
  ),'[]'::jsonb),true);
  perform end_request(r.id, 'done', 'done', p_now);
  perform activate_queued(c.user_id, p_now);

  insert into deliveries (user_id, request_id, call_id, dedupe_key, kind, facts, created_at, next_attempt_at)
  values (c.user_id, r.id, c.id, 'comparison:' || r.id || ':summary', 'report', p_facts, p_now, p_now)
  on conflict (dedupe_key) do nothing;

  select state into st from requests where id = r.id;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'batch_complete', true, 'state', st);
end $$;

-- Durable archive work. No recording is fetched until an operator has verified
-- recording/retention consent and explicitly enabled the deployment gate.
create table call_audio_jobs(
  call_id uuid primary key references calls(id) on delete cascade,
  interaction_id text not null,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  token uuid,
  expires_at timestamptz not null,
  last_error text
);
alter table call_audio_jobs enable row level security;
create table call_audio_deletions(
  path text primary key,
  created_at timestamptz not null default now()
);
alter table call_audio_deletions enable row level security;

create function queue_call_audio() returns trigger language plpgsql as $$
begin
  if new.provider_result->>'interactionId' is not null and new.audio_path is null
     and exists(select 1 from requests where id=new.request_id and comparison)
     and not exists(select 1 from users where id=new.user_id and delete_requested_at is not null) then
    insert into call_audio_jobs(call_id,interaction_id,expires_at)
    values(new.id,new.provider_result->>'interactionId',least(transcript_until(new.id),now()+interval '24 hours'))
    on conflict(call_id) do nothing;
  end if;
  return new;
end $$;
create trigger queue_call_audio after insert or update of provider_result on calls
for each row execute function queue_call_audio();

-- Deletion tombstones survive cascaded account erasure. Never delete Storage rows
-- directly: the worker removes the actual bytes through the Storage API.
create function queue_deleted_audio() returns trigger language plpgsql as $$
begin
  -- Deterministic path also catches an upload that completed before its worker crashed.
  insert into call_audio_deletions(path)values(coalesce(old.audio_path,old.id::text||'.wav')) on conflict do nothing;
  return old;
end $$;
create trigger queue_deleted_audio before delete on calls
for each row execute function queue_deleted_audio();

create function prepare_audio_cleanup(p_now timestamptz default now()) returns void language plpgsql as $$
begin
  insert into call_audio_deletions(path)
    select audio_path from calls c where audio_path is not null and
      (transcript_until(c.id)<=p_now or exists(select 1 from users u where u.id=c.user_id and u.delete_requested_at is not null))
    on conflict do nothing;
  insert into call_audio_deletions(path)select call_id::text||'.wav' from call_audio_jobs where expires_at<=p_now and (lease_until is null or lease_until<=p_now) on conflict do nothing;
  delete from call_audio_jobs j where (lease_until is null or lease_until<=p_now) and (expires_at<=p_now or exists(
    select 1 from calls c join users u on u.id=c.user_id where c.id=j.call_id and
      (u.delete_requested_at is not null or transcript_until(c.id)<=p_now)));
end $$;

create function take_audio_jobs(p_now timestamptz default now()) returns jsonb language plpgsql as $$
declare picked jsonb;
begin
  perform prepare_audio_cleanup(p_now);
  with selected as (
    select j.call_id from call_audio_jobs j join calls c on c.id=j.call_id join users u on u.id=c.user_id
    where j.next_attempt_at<=p_now and (j.lease_until is null or j.lease_until<=p_now)
      and j.expires_at>p_now and u.delete_requested_at is null and transcript_until(c.id)>p_now
    order by j.next_attempt_at limit 1 for update of j skip locked
  ), taken as (
    update call_audio_jobs j set token=gen_random_uuid(),lease_until=p_now+interval '10 minutes',attempts=attempts+1
    from selected s where j.call_id=s.call_id returning j.*
  )select coalesce(jsonb_agg(to_jsonb(taken)),'[]') into picked from taken;
  return picked;
end $$;

create function finish_audio_job(p_call_id uuid,p_token uuid,p_uploaded boolean,p_now timestamptz default now())
returns boolean language plpgsql as $$
declare j call_audio_jobs; c calls; v_path text:=p_call_id::text||'.wav';
begin
  select * into j from call_audio_jobs where call_id=p_call_id for update;
  if not found or j.token is distinct from p_token or j.lease_until<=p_now then
    if p_uploaded then insert into call_audio_deletions(path) values(v_path) on conflict do nothing; end if;
    return false;
  end if;
  select * into c from calls where id=p_call_id for update;
  if p_uploaded and c.id is not null and transcript_until(c.id)>p_now and
    not exists(select 1 from users where id=c.user_id and delete_requested_at is not null) then
    update calls set audio_path=v_path where id=c.id;
    delete from call_audio_jobs where call_id=p_call_id;
    return true;
  end if;
  if p_uploaded then insert into call_audio_deletions(path)values(v_path)on conflict do nothing; end if;
  update call_audio_jobs set token=null,lease_until=null,
    next_attempt_at=p_now+interval '5 minutes',last_error='recording unavailable or archive failed'
    where call_id=p_call_id;
  return false;
end $$;

revoke all on call_audio_jobs,call_audio_deletions from public,anon,authenticated;
grant all on call_audio_jobs,call_audio_deletions to service_role;
revoke execute on function queue_call_audio(),queue_deleted_audio(),prepare_audio_cleanup(timestamptz),take_audio_jobs(timestamptz),finish_audio_job(uuid,uuid,boolean,timestamptz) from public,anon,authenticated;
grant execute on function prepare_audio_cleanup(timestamptz),take_audio_jobs(timestamptz),finish_audio_job(uuid,uuid,boolean,timestamptz) to service_role;

-- Stop a superseded batch without reusing its turn lease or silently dropping calls.
create function interrupt_comparison_dispatch(p_request_id uuid) returns void language plpgsql as $$
declare r requests; remaining jsonb;
begin
  select * into r from requests where id=p_request_id;
  if not found or not r.comparison then return; end if;
  perform lock_user(r.user_id);
  update requests set comparison_dispatching=false where id=r.id;
  select coalesce(jsonb_agg(jsonb_build_object('place',coalesce(b.name,'a selected business'),'reason','a newer message stopped the remaining calls; a new approved plan is needed') order by t.pos),'[]')
  into remaining from unnest(r.recipient_ids) with ordinality t(id,pos) left join businesses b on b.id=t.id
  where not exists(select 1 from calls c where c.request_id=r.id and c.business_id=t.id and c.submission_state is distinct from 'not_submitted');
  insert into deliveries(user_id,request_id,dedupe_key,kind,facts)
  values(r.user_id,r.id,'comparison:'||r.id||':interrupted','notice',jsonb_build_object(
    'event','comparison_interrupted','happened',jsonb_build_object('status','a newer message stopped further calls; calls already submitted may still finish','not_called',remaining),
    'values','{}'::jsonb,'next_step',null)) on conflict(dedupe_key)do nothing;
end $$;
revoke execute on function interrupt_comparison_dispatch(uuid) from public,anon,authenticated;
grant execute on function interrupt_comparison_dispatch(uuid) to service_role;

-- An already leased upload must finish (or lose its lease) before account erasure.
-- New uploads cannot claim work once delete_requested_at is set.
do $$
declare src text; needle text:='perform lock_user(u.id);';
begin
 src:=pg_get_functiondef('public.erase_requested_users(timestamptz)'::regprocedure);
 if position(needle in src)=0 then raise exception 'erasure source changed: review required'; end if;
 execute replace(src,needle,needle||' if exists(select 1 from call_audio_jobs j join calls c on c.id=j.call_id where c.user_id=u.id and j.lease_until>p_now) then continue; end if;');
end $$;

-- If earlier calls already produced results, a newer message must not rewind their
-- request to confirming and strand settlement. Their final report remains owed.
do $$
declare src text; needle text:='perform lock_user(uid);';
begin
 src:=pg_get_functiondef('public.defer_changed_consent(uuid)'::regprocedure);
 if position(needle in src)=0 then raise exception 'defer consent source changed: review required'; end if;
 execute replace(src,needle,needle||' if exists(select 1 from requests r join calls c on c.request_id=r.id where r.id=p_request_id and r.comparison and (c.provider_call_id is not null or c.provider_result is not null)) then return; end if;');
end $$;

create function restrict_comparison_task() returns trigger language plpgsql as $$
begin
 if new.task in ('cancel','reschedule') then new.comparison:=false;new.comparison_dispatching:=false;end if;
 return new;
end $$;
create trigger restrict_comparison_task before update of task on requests for each row execute function restrict_comparison_task();
revoke execute on function restrict_comparison_task() from public,anon,authenticated;
