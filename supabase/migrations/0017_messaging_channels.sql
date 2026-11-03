-- Both channels can share the same Supabase project. Preserve all existing
-- WhatsApp identity keys, unique constraints and foreign keys.
alter table users add column channel text not null default 'whatsapp'
  check (channel in ('whatsapp', 'linq'));

-- A separate UUID keeps history, memories, consent, STOP state and deliveries
-- separate when the same phone uses WhatsApp and iMessage.
alter table users add constraint users_linq_identity_check
  check (channel <> 'linq' or
    (phone_e164 is not null and wa_id = 'linq:' || substring(phone_e164 from 2)));

create index users_channel_idx on users (channel);
