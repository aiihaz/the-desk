-- Native iMessage contact-card sharing after an outbound reply. A successful
-- share waits 24 hours; failures retry only on a later reply, after five minutes.
create table linq_contact_shares (
  chat_id text primary key,
  user_id uuid not null references users on delete cascade,
  claim_token uuid not null,
  next_attempt_at timestamptz not null,
  last_shared_at timestamptz
);
alter table linq_contact_shares enable row level security;

create function claim_linq_contact_share(
  p_user_id uuid, p_chat_id text, p_now timestamptz default now()
) returns uuid
language plpgsql set search_path = public as $$
declare
  token uuid := gen_random_uuid();
  claimed uuid;
begin
  if not exists (select 1 from users u where u.id = p_user_id
                  and u.channel = 'linq' and not u.blocked and u.stopped_at is null
                  and exists (select 1 from messages m where m.user_id = u.id and m.direction = 'in')) then
    return null;
  end if;
  insert into linq_contact_shares as shares (chat_id, user_id, claim_token, next_attempt_at)
  values (p_chat_id, p_user_id, token, p_now + interval '5 minutes')
  on conflict (chat_id) do update
    set claim_token = excluded.claim_token, next_attempt_at = excluded.next_attempt_at
    where shares.user_id = excluded.user_id and shares.next_attempt_at <= p_now
  returning claim_token into claimed;
  return claimed;
end $$;

create function finish_linq_contact_share(
  p_chat_id text, p_claim uuid, p_shared boolean, p_now timestamptz default now()
) returns void
language sql set search_path = public as $$
  update linq_contact_shares
     set last_shared_at = case when p_shared then p_now else last_shared_at end,
         next_attempt_at = p_now + case when p_shared then interval '24 hours' else interval '5 minutes' end
   where chat_id = p_chat_id and claim_token = p_claim;
$$;

revoke all on linq_contact_shares from public, anon, authenticated;
grant select, insert, update, delete on linq_contact_shares to service_role;
revoke execute on function claim_linq_contact_share(uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function finish_linq_contact_share(text, uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function claim_linq_contact_share(uuid, text, timestamptz) to service_role;
grant execute on function finish_linq_contact_share(text, uuid, boolean, timestamptz) to service_role;
