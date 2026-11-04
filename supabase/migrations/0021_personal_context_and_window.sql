-- Small, evidence-backed memory and free service-window messaging. No new agent system.
alter table user_memories add column source_message_id uuid references messages on delete set null;

create function remember_fact(p_user_id uuid,p_kind text,p_scope text,p_text text,p_source text,
  p_message_id text,p_evidence text default null,p_replaces text default null) returns jsonb language plpgsql as $$
declare m messages; prior uuid; kept user_memories;
begin
  perform lock_user(p_user_id);
  select * into m from messages where user_id=p_user_id and direction='in' and wa_message_id=p_message_id;
  if not found then raise exception 'memory needs a stored user message'; end if;
  if p_source='learned' and (nullif(trim(p_evidence),'') is null
    or position(lower(p_evidence) in lower(coalesce(m.body -> 'text' ->> 'body',m.body ->> 'text','')))=0) then
    raise exception 'memory evidence must quote the user message';
  end if;
  if p_replaces is not null then
    if (select count(*) from user_memories where user_id=p_user_id and forgotten_at is null
      and id::text like replace(p_replaces,'m-','') || '%')<>1 then raise exception 'memory to replace is ambiguous'; end if;
    select id into prior from user_memories where user_id=p_user_id and forgotten_at is null
      and id::text like replace(p_replaces,'m-','') || '%';
    if prior is null then raise exception 'memory to replace not found'; end if;
  end if;
  select * into kept from user_memories where user_id=p_user_id and forgotten_at is null
    and lower(text)=lower(p_text);
  if found then
    if prior is not null and prior<>kept.id then delete from user_memories where id=prior; end if;
    return to_jsonb(kept);
  end if;
  if prior is null and (select count(*) from user_memories where user_id=p_user_id and forgotten_at is null)
    >= limit_int('max_memories_per_user',p_user_id) then raise exception 'memory full'; end if;
  -- Replacement and insertion are one transaction: a failed insert loses no preference.
  if prior is not null then delete from user_memories where id=prior; end if;
  insert into user_memories(user_id,kind,scope,text,source,evidence,source_message_id)
    values(p_user_id,p_kind,p_scope,p_text,p_source,p_evidence,m.id) returning * into kept;
  return to_jsonb(kept);
end $$;

create function recall_errands(p_user_id uuid,p_query text default '') returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x),'[]') from (
    select r.id, r.task,r.state,r.fields,r.waiting_for,r.remind_at,r.updated_at,
      b.name as place,b.id as business_id,
      (select jsonb_build_object('at',d.created_at,'facts',d.facts) from deliveries d
        where d.request_id=r.id and d.user_id=p_user_id and d.kind='report' and d.facts is not null
        order by d.created_at desc limit 1) as last_report,
      (select jsonb_build_object('status',k.status,'time',k.time,'date',k.booked_on,
        'pending_change',k.pending_change) from bookings k where k.request_id=r.id order by k.created_at desc limit 1) as outcome
    from requests r left join businesses b on b.id=r.business_id
    where r.user_id=p_user_id and (p_query='' or position(lower(p_query) in
      lower(coalesce(b.name,'') || ' ' || r.fields::text || ' ' || coalesce(r.waiting_for,'')))>0)
    order by r.updated_at desc limit 5
  ) x;
$$;

-- Writer leases last longer than the bounded write/check loop and fence stale completions.
alter table deliveries add column write_token uuid;
create or replace function take_unwritten(p_now timestamptz default now(),p_limit int default 20,p_call_id uuid default null)
returns jsonb language plpgsql as $$
declare res jsonb; owner uuid; tok text;
begin
  tok:=nullif(current_setting('request.headers',true),'')::jsonb ->> 'x-desk-turn';
  if tok is not null then
    select user_id into owner from user_turns where token=tok::uuid and until>p_now;
    if owner is null then raise exception 'turn lease lost' using errcode='55000'; end if;
  end if;
  update deliveries d set status='dropped' from users u where (owner is null or d.user_id=owner) and u.id=d.user_id and d.status='pending'
    and d.message is null and d.kind<>'report' and u.stopped_at is not null;
  with due as (
    select id from deliveries where (owner is null or user_id=owner) and status='pending' and message is null and next_attempt_at<=p_now
      and (p_call_id is null or call_id=p_call_id) order by next_attempt_at limit p_limit for update skip locked
  ), taken as (
    update deliveries d set write_attempts=write_attempts+1,next_attempt_at=p_now+interval '10 minutes',
      write_token=gen_random_uuid() from due where d.id=due.id returning d.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'request_id',request_id,
      'facts',facts,'write_attempts',write_attempts,'created_at',created_at,'write_token',write_token)),'[]') into res from taken;
  return res;
end $$;
alter function delivery_written(uuid,jsonb,timestamptz) set schema desk_private;
create function delivery_written(p_id uuid,p_message jsonb,p_now timestamptz default now(),p_claim_token uuid default null)
returns void language plpgsql as $$
begin
  perform 1 from deliveries where id=p_id for update;
  if exists(select 1 from deliveries where id=p_id and status='dropped') then return; end if;
  if p_claim_token is not null then
    if not exists(select 1 from deliveries where id=p_id and status='pending' and message is null
      and write_token=p_claim_token and next_attempt_at>p_now) then raise exception 'writer lease lost'; end if;
  elsif current_user<>'postgres' then raise exception 'writer claim required'; end if;
  perform desk_private.delivery_written(p_id,p_message,p_now);
  update deliveries set write_token=null where id=p_id;
end $$;
alter function delivery_unwritten(uuid,text,timestamptz) set schema desk_private;
create function delivery_unwritten(p_id uuid,p_error text,p_now timestamptz default now(),p_claim_token uuid default null)
returns void language plpgsql as $$
begin
  perform 1 from deliveries where id=p_id for update;
  if exists(select 1 from deliveries where id=p_id and status='dropped') then return; end if;
  if p_claim_token is not null then
    if not exists(select 1 from deliveries where id=p_id and status='pending' and message is null
      and write_token=p_claim_token and next_attempt_at>p_now) then raise exception 'writer lease lost'; end if;
  elsif current_user<>'postgres' then raise exception 'writer claim required'; end if;
  perform desk_private.delivery_unwritten(p_id,p_error,p_now);
  update deliveries set write_token=null where id=p_id;
end $$;

-- One useful update for unfinished work shortly before the 24-hour window closes.
-- The one-minute scheduler supplies a delivery buffer; our own message never extends it.
alter function due_follow_ups(timestamptz) rename to due_follow_ups_before_window;
create function due_follow_ups(p_now timestamptz default now()) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x),'[]') from (
    select old as x from jsonb_array_elements(due_follow_ups_before_window(p_now)) old
      where old ->> 'reason'<>'nudge' or exists (select 1 from requests r join users u on u.id=r.user_id
        where r.id=(old ->> 'request_id')::uuid and u.channel='linq')
    union all
    select to_jsonb(w) from (
      select distinct on(r.user_id) r.id as request_id,r.user_id,'window' as reason,r.task,r.state,r.fields,
        r.waiting_for,r.end_reason,b.name as place,null::numeric as amount_rs,null::timestamptz as deadline,
        null::jsonb as terms,last_in.seq as stamp
      from requests r join users u on u.id=r.user_id left join businesses b on b.id=r.business_id
      cross join lateral (select at,seq from messages where user_id=u.id and direction='in' order by at desc,seq desc limit 1) last_in
      where u.channel='whatsapp' and u.stopped_at is null and r.paused_at is null
        and request_group(r.state) in ('before_consent','after_call_1','in_flight','queued','awaiting_payment')
        and last_in.at+interval '24 hours'>p_now
        and last_in.at+interval '24 hours'<=p_now+interval '2 minutes'
        and not exists(select 1 from deliveries d where d.dedupe_key='window:' || u.id || ':' || last_in.seq)
      order by r.user_id,r.created_at
    ) w
  ) all_rows;
$$;
alter function queue_follow_up(uuid,text,bigint,jsonb,timestamptz) rename to queue_follow_up_before_window;
create function queue_follow_up(p_request_id uuid,p_reason text,p_stamp bigint,p_facts jsonb,p_now timestamptz default now())
returns boolean language plpgsql as $$
declare r requests; n int;
begin
  if p_reason<>'window' then return queue_follow_up_before_window(p_request_id,p_reason,p_stamp,p_facts,p_now); end if;
  select * into r from requests where id=p_request_id;
  if not found then return false; end if;
  perform lock_user(r.user_id);
  if user_stopped(r.user_id) or r.paused_at is not null or request_group(r.state)='ended'
    or not exists(select 1 from users where id=r.user_id and channel='whatsapp') then return false; end if;
  -- Recheck the selected window after acquiring the user lock.
  if not exists(select 1 from messages m where m.user_id=r.user_id and m.seq=p_stamp and m.direction='in'
    and m.at+interval '24 hours'>p_now and m.at+interval '24 hours'<=p_now+interval '2 minutes'
    and not exists(select 1 from messages newer where newer.user_id=m.user_id and newer.direction='in' and newer.seq>m.seq)) then return false; end if;
  insert into deliveries(user_id,request_id,dedupe_key,kind,facts,created_at,next_attempt_at)
    values(r.user_id,r.id,'window:' || r.user_id || ':' || p_stamp,'nudge',p_facts,p_now,p_now)
    on conflict(dedupe_key) do nothing;
  get diagnostics n=row_count;
  return n>0;
end $$;

-- Local erasure completes only after outstanding real-world calls/results are resolved.
-- Retain an anonymous completion audit, never the WhatsApp ID in the audit.
create table erasure_audit(id uuid primary key default gen_random_uuid(),completed_at timestamptz not null default now());
alter table erasure_audit enable row level security;
create function erase_requested_users(p_now timestamptz default now()) returns jsonb language plpgsql as $$
declare u users; notices jsonb:='[]'; latest timestamptz;
begin
  for u in select * from users where delete_requested_at<=p_now-interval '1 minute' order by delete_requested_at limit 20 loop
    perform lock_user(u.id);
    perform 1 from users where id=u.id and delete_requested_at is not null;
    if not found then continue; end if;
    if exists(select 1 from calls where user_id=u.id and
      (status in ('queued','dialing','in_progress') or (provider_result is not null and settled_at is null)
       or (submission_state='unknown' and provider_result is null))) then continue; end if;
    if exists(select 1 from user_turns where user_id=u.id and until>p_now) then continue; end if;
    select max(at) into latest from messages where user_id=u.id and direction='in';
    -- Raw provider events contain copies of the user's messages/call result.
    delete from webhook_events where (source='sarvam' and external_id in
      (select provider_call_id from calls where user_id=u.id))
      or (source='meta' and u.channel='whatsapp' and position(u.wa_id in payload::text)>0)
      or (source='linq' and payload #>> '{data,sender_handle,handle}'=u.phone_e164::text);
    delete from alerts where detail ->> 'user_id'=u.id::text;
    delete from limit_changes where user_id=u.id;
    delete from deliveries where user_id=u.id;
    delete from bookings where request_id in(select id from requests where user_id=u.id);
    delete from users where id=u.id; -- remaining user-owned rows cascade
    insert into erasure_audit default values;
    if u.channel='linq' or latest+interval '24 hours'>p_now then
      notices:=notices || jsonb_build_array(jsonb_build_object('wa_id',case when u.channel='linq' then substring(u.phone_e164 from 2) else u.wa_id end,
        'channel',u.channel,'last_inbound_at',latest));
    end if;
  end loop;
  return notices;
end $$;

create function recovery_health() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'oldest_unhandled_at',(select min(at) from messages where direction='in' and handled_at is null),
    'unsettled_calls',(select count(*) from calls where provider_result is not null and settled_at is null and created_at<now()-interval '15 minutes'),
    'unknown_submissions',(select count(*) from calls where submission_state='unknown' and provider_result is null),
    'failed_deliveries',(select count(*) from deliveries where status='failed'),
    'pending_erasure',(select count(*) from users where delete_requested_at<now()-interval '1 day'));
$$;

grant execute on all functions in schema desk_private to service_role;
revoke execute on all functions in schema public from public,anon,authenticated;

do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('desk-window-updates','* * * * *','select call_edge_function(''follow-through'')');
  end if;
end $$;
