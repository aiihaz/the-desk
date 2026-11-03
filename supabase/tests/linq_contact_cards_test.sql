begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into users (id,wa_id,phone_e164,channel) values
 ('a0000000-0000-0000-0000-000000000001','linq:919800000001','+919800000001','linq'),
 ('a0000000-0000-0000-0000-000000000002','919800000001','+919800000001','whatsapp'),
 ('a0000000-0000-0000-0000-000000000003','linq:919800000003','+919800000003','linq'),
 ('a0000000-0000-0000-0000-000000000004','linq:919800000004','+919800000004','linq');
insert into messages (user_id,wa_message_id,direction,body) values
 ('a0000000-0000-0000-0000-000000000001','linq-inbound-1','in','{}'),
 ('a0000000-0000-0000-0000-000000000003','linq-inbound-3','in','{}');
create temp table claims (name text primary key, token uuid);
insert into claims values ('first',claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','chat-1','2026-11-04T12:00:00Z'));
select ok((select token is not null from claims where name='first'),'first eligible reply claims a share');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','chat-1','2026-11-04T12:00:00Z'),null::uuid,
  'concurrent reply cannot claim the same chat');
select finish_linq_contact_share('chat-1',(select token from claims where name='first'),true,'2026-11-04T12:00:00Z');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','chat-1','2026-11-05T11:59:59Z'),null::uuid,
  'successful card is not shared again within 24 hours');
insert into claims values ('next-day',claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','chat-1','2026-11-05T12:00:00Z'));
select ok((select token is not null from claims where name='next-day'),'share is eligible again after 24 hours');
select finish_linq_contact_share('chat-1',(select token from claims where name='first'),true,'2026-11-06T12:00:00Z');
select is((select last_shared_at from linq_contact_shares where chat_id='chat-1'),'2026-11-04T12:00:00Z'::timestamptz,
  'stale worker cannot overwrite a later claim');
select finish_linq_contact_share('chat-1',(select token from claims where name='next-day'),false,'2026-11-05T12:00:00Z');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','chat-1','2026-11-05T12:04:59Z'),null::uuid,
  'failed share does not retry on every reply');
select ok(claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','chat-1','2026-11-05T12:05:00Z') is not null,
  'failed share is eligible on a later reply after backoff');
select ok(claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','new-line-chat','2026-11-04T12:01:00Z') is not null,
  'a failover chat has an independent contact-card cadence');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000003','chat-1','2026-11-07T12:00:00Z'),null::uuid,
  'another user cannot claim an existing chat');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000002','wa-chat','2026-11-04T12:00:00Z'),null::uuid,
  'WhatsApp users never get iMessage identity shares');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000004','no-inbound','2026-11-04T12:00:00Z'),null::uuid,
  'a contact with no inbound message is not eligible');
update users set blocked=true where id='a0000000-0000-0000-0000-000000000003';
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000003','blocked-chat','2026-11-04T12:00:00Z'),null::uuid,
  'blocked users do not get identity shares');
select stop_user('a0000000-0000-0000-0000-000000000001');
select is(claim_linq_contact_share('a0000000-0000-0000-0000-000000000001','stopped-chat','2026-11-04T12:00:00Z'),null::uuid,
  'STOP disables contact-card sharing');
select is(has_function_privilege('anon','claim_linq_contact_share(uuid,text,timestamptz)','execute'),false,
  'anonymous callers cannot claim shares');
select is(has_table_privilege('authenticated','linq_contact_shares','select'),false,
  'contact metadata is not exposed to app clients');
delete from users where id='a0000000-0000-0000-0000-000000000001';
select is((select count(*)::int from linq_contact_shares),0,'deleting a user deletes their contact-share state');

select * from finish();
rollback;
