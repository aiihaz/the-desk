-- Comparison reservations. Staged only; not applied to production.
-- Keep the existing five-argument RPC intact for all ordinary calls.
-- The overload holds the same user/request/phone locks and uses the entire existing
-- guard stack. The temporary business pointer is restored before the transaction ends.
create function reserve_call(
  p_request_id uuid, p_kind text, p_option_id uuid,
  p_is_retry boolean, p_business_id uuid
) returns jsonb language plpgsql as $$
declare
  r requests;
  original_business uuid;
  target_phone text;
  res jsonb;
begin
  select * into r from requests where id=p_request_id;
  if not found then return dial_refused('no_request'); end if;
  if not r.comparison then
    if p_business_id is not null then return dial_refused('not_comparison'); end if;
    return reserve_call(p_request_id,p_kind,p_option_id,p_is_retry,now());
  end if;
  perform lock_user(r.user_id);
  select * into r from requests where id=p_request_id for update;
  if not r.comparison_dispatching or r.comparison_dispatch_until<=now() then
    return dial_refused('batch_dispatch_closed');
  end if;
  if p_kind <> 'question' or p_option_id is not null or p_is_retry then
    return dial_refused('comparison_question_only');
  end if;
  if r.state <> 'calling_1' then return dial_refused('not_calling'); end if;
  if p_business_id is null or not coalesce(p_business_id=any(r.recipient_ids),false) then
    return dial_refused('not_recipient');
  end if;
  select phone_e164 into target_phone from businesses where id=p_business_id;
  if target_phone is null then return dial_refused('no_business'); end if;
  perform pg_advisory_xact_lock(hashtextextended('desk:phone:'||target_phone,0));
  if (select count(*) from calls where request_id=r.id)>=5 then
    return dial_refused('limit_request');
  end if;
  if exists(select 1 from calls c join businesses b on b.id=c.business_id
    where c.request_id=r.id and (c.business_id=p_business_id or b.phone_e164=target_phone)) then
    return dial_refused('consent_spent');
  end if;
  original_business := r.business_id;
  update requests set business_id=p_business_id where id=r.id;
  res := reserve_call(p_request_id,p_kind,p_option_id,p_is_retry,now());
  update requests set business_id=original_business where id=r.id;
  return res;
end $$;

-- Patch only the reviewed guards, fail closed if their source has changed.
-- pg_get_functiondef preserves comments and newlines; no rendered SQL is re-used.
do $$
declare src text; old text; replacement text;
begin
  src := pg_get_functiondef('public.check_dial(uuid,text,uuid,boolean,timestamptz)'::regprocedure);
  old := 'where consent_id=(res ->> ''consent_id'')::uuid';
  replacement := 'where consent_id=(res ->> ''consent_id'')::uuid and (not exists(select 1 from requests r where r.id=p_request_id and r.comparison) or business_id=(select business_id from requests where id=p_request_id))';
  if position(old in src)=0 then raise exception 'check_dial source changed: review required'; end if;
  execute replace(src,old,replacement);

  src := pg_get_functiondef('public.check_dial_base(uuid,text,uuid,boolean,timestamptz)'::regprocedure);
  old := 'lim := limit_int(''max_calls_per_request'', u.id);';
  replacement := 'lim := case when r.comparison then 5 else limit_int(''max_calls_per_request'', u.id) end;';
  if position(old in src)=0 then raise exception 'check_dial_base source changed: review required'; end if;
  execute replace(src,old,replacement);
end $$;

revoke execute on function reserve_call(uuid,text,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function reserve_call(uuid,text,uuid,boolean,uuid) to service_role;
