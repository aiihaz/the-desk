-- 0032: the comparison errand's flow (the other half of 0031's comparison_mode switch).
--
-- A comparison errand (requests.comparison, snapshotted at creation) names no single
-- business: the Desk picks up to five (requests.recipient_ids), the plan names every
-- one, one 'ask' consent covers the batch, each call settles on its own, and when the
-- last call settles the request ends and ONE summary delivery goes out.
--
-- This migration is ADDITIVE on purpose: the live check_dial/reserve_call stack has
-- diverged from the repo's chain (0028's test-mode work), so the per-business dial
-- override (p_business_id through check_dial, the consent-spent check per business
-- instead of per consent, and reserve_call's p_business_id) ships separately, written
-- against the verified live functions, together with the owner's standing "restore
-- 0028 checks before business calls" step. Nothing here replaces an existing function.

-- Mode snapshot at creation, however the request is created (start_request,
-- queue_request, a future path): an explicit true wins, otherwise the switch reads.
create or replace function requests_comparison_snapshot() returns trigger
language plpgsql as $$
begin
  if not new.comparison then
    new.comparison := limit_bool('comparison_mode');
  end if;
  return new;
end $$;

drop trigger if exists requests_comparison_snapshot on requests;
create trigger requests_comparison_snapshot
  before insert on requests for each row execute function requests_comparison_snapshot();

-- The picked businesses for a comparison errand. Only before consent: after the
-- go-ahead the list is what they approved and doesn't change. Deduped, at most five.
create function set_recipients(p_request_id uuid, p_business_ids uuid[]) returns jsonb
language plpgsql as $$
declare
  r    requests;
  ids  uuid[];
begin
  select * into r from requests where id = p_request_id for update;
  if not found then
    return chat_refused('no_request');
  end if;
  if not r.comparison then
    return chat_refused('not_comparison');
  end if;
  if request_group(r.state) <> 'before_consent' or r.state='awaiting_yes' then
    return chat_refused('wrong_state');
  end if;
  select coalesce(array_agg(b order by first_pos), '{}') into ids from (
    select b, min(pos) first_pos from unnest(p_business_ids) with ordinality t(b,pos)
    where b is not null group by b
  ) picked;
  ids := ids[1:5];
  update requests set recipient_ids = ids, comparison_dispatching=true, comparison_dispatch_until=now()+interval '10 minutes', updated_at = now() where id = r.id;
  return jsonb_build_object('ok', true, 'count', coalesce(array_length(ids, 1), 0));
end $$;

-- One call of a comparison batch settles: per-call bookkeeping only (opt-out, wrong
-- number), never a booking, never the request's end. When no call of the batch still
-- waits on a result or a report, the request ends, the queue moves on, and the single
-- summary delivery carries p_facts (report.ts built it from every call of the batch).
create function settle_comparison_call(
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
  if r.comparison_dispatching and r.comparison_dispatch_until>p_now then
    return chat_refused('batch_dispatching');
  end if;
  -- A crashed submitter cannot strand settled provider results forever. Once its
  -- lease expires reservations fail closed, and recovery may finish existing calls.
  if r.comparison_dispatching then
    update requests set comparison_dispatching=false where id=r.id;
  end if;
  if r.state not in ('calling_1', 'calling_2', 'verifying') then
    return chat_refused('not_calling');
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
  update calls set settled_at = p_now, settlement_until = null where id = c.id;

  -- Still to come: calls dialling or with a result not yet reported. Calls that never
  -- started (failed) or timed out with no result are done: the summary reads them as
  -- unreachable.
  select count(*) into remaining from calls x
   where x.request_id = r.id and x.id <> c.id and x.settled_at is null
     and (x.status in ('queued','dialing','in_progress') or x.provider_result is not null);

  if remaining > 0 then
    return jsonb_build_object('ok', true, 'request_id', r.id, 'batch_complete', false, 'state', r.state);
  end if;

  perform end_request(r.id, 'done', 'done', p_now);
  perform activate_queued(c.user_id, p_now);

  insert into deliveries (user_id, request_id, call_id, dedupe_key, kind, facts, created_at, next_attempt_at)
  values (c.user_id, r.id, c.id, 'comparison:' || r.id || ':summary', 'report', p_facts, p_now, p_now)
  on conflict (dedupe_key) do nothing;

  select state into st from requests where id = r.id;
  return jsonb_build_object('ok', true, 'request_id', r.id, 'batch_complete', true, 'state', st);
end $$;

revoke execute on function set_recipients(uuid,uuid[]) from public,anon,authenticated;
revoke execute on function settle_comparison_call(uuid,boolean,boolean,jsonb,timestamptz,uuid) from public,anon,authenticated;

-- A webhook that arrives during submission stays unsettled for the existing recovery
-- pass. Only after every reservation attempt is decided can a batch finish.
create function finish_comparison_dispatch(p_request_id uuid) returns jsonb
language plpgsql as $$
begin
  update requests set comparison_dispatching=false where id=p_request_id and comparison;
  return jsonb_build_object('ok',true);
end $$;
revoke execute on function finish_comparison_dispatch(uuid) from public,anon,authenticated;
grant execute on function finish_comparison_dispatch(uuid) to service_role;
grant execute on function set_recipients(uuid,uuid[]) to service_role;
grant execute on function settle_comparison_call(uuid,boolean,boolean,jsonb,timestamptz,uuid) to service_role;

-- Start the submission lease when approval changes the request to calling, not at
-- search time. The user may take longer than ten minutes to approve the plan.
create function comparison_dispatch_lease() returns trigger language plpgsql as $$
begin
  if new.comparison and new.state='calling_1' and old.state is distinct from new.state then
    new.comparison_dispatching := true;
    new.comparison_dispatch_until := now()+interval '10 minutes';
  end if;
  return new;
end $$;
create trigger comparison_dispatch_lease before update on requests
for each row execute function comparison_dispatch_lease();
revoke execute on function comparison_dispatch_lease() from public,anon,authenticated;
