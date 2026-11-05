-- 0024_never_silent.sql: a report that can't be written yet doesn't leave the user in silence,
-- and a number that reached someone else isn't put back in front of them.
--   - A call report whose writes keep failing (its drafts don't pass the check against the
--     call, or a model can't be reached) owes the user a short notice once: the call is
--     over and its result is still being written up. The report itself stays owed, and
--     after report_plain_after_attempts it's written from what the Desk records alone
--     (chat/tell.ts plain), so it goes out even when the call can't be put into words the
--     check accepts.
--   - wrong_number_for() lets the chat refuse a plan for a number already recorded as wrong
--     (0019), before the user approves it, not only at the dial.

insert into limits (key, value, value_type, nullable, description) values
  ('report_stall_notice_attempts', '2', 'int', false,
   'failed writes of a call report before the user is told its result is still being written up'),
  ('report_plain_after_attempts',  '3', 'int', false,
   'failed writes of a call report before it is written from the record alone, without the call');

-- As in 0015, plus the notice. 0021 moved this body to desk_private behind the public
-- writer-claim wrapper, so it's replaced there; a public one would clash with the wrapper.
create or replace function desk_private.delivery_unwritten(p_id uuid, p_error text, p_now timestamptz default now())
returns void
language plpgsql as $$
declare
  d deliveries;
begin
  select * into d from deliveries where id = p_id;
  update deliveries
     set last_error = p_error,
         next_attempt_at = p_now + make_interval(mins => least(power(2, d.write_attempts)::int, 30))
   where id = p_id;
  if d.write_attempts = limit_int('report_alert_attempts', d.user_id) then
    perform raise_alert('report_unwritten', d.request_id, d.call_id,
                        jsonb_build_object('delivery', d.id, 'error', p_error), p_now);
  end if;
  -- Its own delivery, outside the call's sequence, so it isn't held behind the report it's
  -- about. Owed once per report.
  if d.kind = 'report' and d.call_id is not null
     and d.write_attempts = limit_int('report_stall_notice_attempts', d.user_id) then
    perform owe_facts(d.user_id, d.request_id, 'stalled:' || d.id, 'notice',
      jsonb_build_object(
        'event', 'call_report_delayed',
        'place', d.facts -> 'place',
        'errand', d.facts -> 'errand',
        'happened', jsonb_build_object(
          'status', 'the_call_is_over_its_result_is_still_being_written_up',
          'what_the_business_said_is_not_in_this_message', true,
          'desk_will_send_the_result_as_soon_as_it_is_written', true),
        'values', '{}'::jsonb,
        'next_step', null),
      p_now);
  end if;
end $$;

-- A number recorded as reaching someone else, for this user and this business's current
-- number. A new number for the business clears it, as in check_dial.
create function wrong_number_for(p_user_id uuid, p_business_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from wrong_numbers w join businesses b on b.id = w.business_id
                  where w.user_id = p_user_id and w.business_id = p_business_id
                    and w.phone_e164 = b.phone_e164);
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
