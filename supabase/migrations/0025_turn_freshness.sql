-- Ownership alone does not authorize work based on an obsolete inbox snapshot.
-- Ingestion and fenced mutations take the same user lock. Writes attempted after
-- a newer input commits are rejected; already committed earlier work is retained
-- for the successor to reconsider, not falsely described as rolled back.
create or replace function assert_turn(p_user_id uuid, p_token uuid, p_now timestamptz default now())
returns void language plpgsql as $$
declare watermark bigint;
begin
  perform lock_user(p_user_id);
  select input_seq into watermark from user_turns
    where user_id=p_user_id and token=p_token and until>p_now;
  if not found then
    raise exception 'turn lease lost' using errcode='55000';
  end if;
  if exists(select 1 from messages where user_id=p_user_id and direction='in' and seq>watermark) then
    raise exception 'turn superseded' using errcode='55000';
  end if;
end $$;
revoke execute on function assert_turn(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function assert_turn(uuid,uuid,timestamptz) to service_role;
