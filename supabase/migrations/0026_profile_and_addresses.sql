-- What the Desk learns about a person once and keeps: their own name on the profile, and
-- the places a visit can go to, each under their own label (home, work, mum's place).
-- Nothing here is a permission: a saved address fills a detail the plan then shows back.
-- Whether the Desk has ever written to someone (their first conversation) is one indexed
-- lookup. Plans also name a business by its area ("Mani's Dum Biryani in Bellandur"), not the
-- whole listing, so the area is kept beside the short address.

alter table businesses add column area text;
create index messages_outbound_idx on messages (user_id) where direction = 'out';

create table user_addresses (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users on delete cascade,
  label              text not null check (length(trim(label)) between 1 and 30),
  address            text not null check (length(trim(address)) between 1 and 500),
  source_message_id  uuid references messages on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index user_addresses_label_idx on user_addresses (user_id, lower(label));
alter table user_addresses enable row level security;
create trigger fence_addresses before insert or update or delete on user_addresses
  for each row execute function fence_turn_write();

insert into limits (key, value, value_type, nullable, description) values
  ('max_addresses_per_user', '5', 'int', false, 'saved addresses a user can keep, each under its own label');

-- A user message of the last day that says p_evidence, newest first; null if none does.
create function quoting_message(p_user_id uuid, p_evidence text, p_now timestamptz)
returns messages language sql stable as $$
  select * from messages where user_id=p_user_id and direction='in' and at>p_now-interval '24 hours'
    and position(lower(trim(p_evidence)) in lower(coalesce(body -> 'text' ->> 'body',body ->> 'text','')))>0
  order by seq desc limit 1;
$$;

-- Their own name, as they said it. The words must be from one of their messages and hold
-- the name, so a model can't put a name on the profile that they never wrote. Whether the
-- name is theirs (not a one-off "book under Priya") is read separately before this runs.
create function set_profile_name(p_user_id uuid, p_name text, p_evidence text, p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare m messages; before text; said text;
begin
  perform lock_user(p_user_id);
  if length(trim(coalesce(p_name,''))) not between 1 and 60 then return chat_refused('bad_name'); end if;
  if nullif(trim(p_evidence),'') is null then return chat_refused('no_evidence'); end if;
  m := quoting_message(p_user_id, p_evidence, p_now);
  if m.id is null then return chat_refused('evidence_not_said'); end if;
  said := lower(coalesce(m.body -> 'text' ->> 'body',m.body ->> 'text',''));
  if position(lower(trim(p_name)) in said)=0 then return chat_refused('name_not_in_evidence'); end if;
  select name into before from users where id=p_user_id for update;
  update users set name=trim(p_name) where id=p_user_id;
  return jsonb_build_object('ok',true,'name',trim(p_name),'previous',before);
end $$;

-- Saves or replaces the address under a label; a null address removes that label. That
-- they gave it and agreed to keep it is read from the chat before this runs.
create function save_address(p_user_id uuid, p_label text, p_address text, p_message_id text,
  p_now timestamptz default now())
returns jsonb language plpgsql as $$
declare m messages; kept user_addresses;
begin
  perform lock_user(p_user_id);
  if length(trim(coalesce(p_label,''))) not between 1 and 30 then return chat_refused('bad_label'); end if;
  if p_address is null then
    delete from user_addresses where user_id=p_user_id and lower(label)=lower(trim(p_label)) returning * into kept;
    if kept.id is null then return chat_refused('no_such_label'); end if;
    return jsonb_build_object('ok',true,'removed',kept.label);
  end if;
  if length(trim(p_address)) not between 1 and 500 then return chat_refused('bad_address'); end if;
  select * into m from messages where user_id=p_user_id and direction='in' and wa_message_id=p_message_id;
  if not found then return chat_refused('needs_user_message'); end if;
  if not exists(select 1 from user_addresses where user_id=p_user_id and lower(label)=lower(trim(p_label)))
    and (select count(*) from user_addresses where user_id=p_user_id)>=limit_int('max_addresses_per_user',p_user_id)
  then return chat_refused('addresses_full'); end if;
  insert into user_addresses(user_id,label,address,source_message_id,created_at,updated_at)
    values(p_user_id,trim(p_label),trim(p_address),m.id,p_now,p_now)
  on conflict (user_id, lower(label)) do update
    set address=excluded.address, source_message_id=excluded.source_message_id, updated_at=p_now
  returning * into kept;
  return jsonb_build_object('ok',true,'label',kept.label,'address',kept.address);
end $$;

-- Deleting data takes the saved addresses with the memories, at once.
create or replace function request_data_deletion(p_user_id uuid, p_now timestamptz default now())
returns jsonb
language plpgsql as $$
declare
  res jsonb;
begin
  res := stop_user(p_user_id, p_now);
  update users set delete_requested_at = coalesce(delete_requested_at, p_now) where id = p_user_id;
  delete from user_memories where user_id = p_user_id;
  delete from user_addresses where user_id = p_user_id;
  return res;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
