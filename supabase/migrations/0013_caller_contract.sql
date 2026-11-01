-- 0013_caller_contract.sql: the wrong caller setup can't reach a business. Sarvam has no
-- API that shows an agent's output variables, so what a version can do is known only from
-- what it returned. Each finished call records the contract outputs it came back with, and
-- a real business is dialled only by a version that has returned all of them. Calls to
-- test_numbers are how a new version earns that. A call that connects and reports no
-- result blocks its version for real businesses at once.

-- agent/contract.json, by name. outputs_test.ts keeps the two the same.
create table caller_contract (name text primary key);
alter table caller_contract enable row level security;
insert into caller_contract (name) values
  ('outcome'),
  ('no_match_reason'),
  ('booked_time'),
  ('booking_reference'),
  ('options'),
  ('answer'),
  ('also_answer'),
  ('advance_amount_rs'),
  ('upi_id'),
  ('payee_name'),
  ('payment_deadline'),
  ('payment_status'),
  ('callback_time'),
  ('cancel_status'),
  ('cancel_charge_rs'),
  ('refund_stated'),
  ('original_booking_status'),
  ('contact_name'),
  ('possible_unintended_commitment'),
  ('unintended_commitment_details'),
  ('opt_out_requested'),
  ('summary');

alter table gate_passes
  add column outputs_seen        text[] not null default '{}',
  add column contract_broken_at  timestamptz;

-- Adds what this call's version returned. Only contract names count.
create function record_caller_outputs(p_call_id uuid, p_outputs text[]) returns void
language sql as $$
  update gate_passes g
     set outputs_seen = (select coalesce(array_agg(distinct x order by x), '{}')
                           from unnest(g.outputs_seen || p_outputs) x
                          where x in (select name from caller_contract))
    from calls c
   where c.id = p_call_id and g.agent_version = c.agent_version;
$$;

-- The call connected and reported no result: nobody can tell what it did.
create function caller_contract_broken(p_call_id uuid, p_now timestamptz default now()) returns void
language sql as $$
  update gate_passes g set contract_broken_at = coalesce(g.contract_broken_at, p_now)
    from calls c
   where c.id = p_call_id and g.agent_version = c.agent_version;
$$;

-- check_dial() as in 0012, then the contract. test_numbers stay open, or no version could
-- ever earn it, and a blocked version could never be shown to be fixed.
alter function check_dial(uuid, text, uuid, boolean, timestamptz) rename to check_dial_pinned;

create function check_dial(
  p_request_id  uuid,
  p_kind        text,
  p_option_id   uuid default null,
  p_is_retry    boolean default false,
  p_now         timestamptz default now()
) returns jsonb
language plpgsql stable as $$
declare
  res  jsonb;
  g    gate_passes;
begin
  res := check_dial_pinned(p_request_id, p_kind, p_option_id, p_is_retry, p_now);
  if not (res ->> 'ok')::boolean then
    return res;
  end if;
  if exists (select 1 from requests r
               join businesses b on b.id = r.business_id
               join test_numbers t on t.phone_e164 = b.phone_e164
              where r.id = p_request_id) then
    return res;
  end if;

  select * into g from gate_passes where agent_version = res ->> 'agent_version';
  if g.contract_broken_at is not null then
    return dial_refused('caller_contract_broken');
  end if;
  if exists (select name from caller_contract except select unnest(g.outputs_seen)) then
    return dial_refused('caller_contract_mismatch');
  end if;
  return res;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
