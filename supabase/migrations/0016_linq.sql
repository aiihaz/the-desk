-- Apply on the separate iMessage Supabase project as well as new WhatsApp projects.
alter table webhook_events drop constraint webhook_events_source_check;
alter table webhook_events add constraint webhook_events_source_check
  check (source in ('meta', 'sarvam', 'linq'));
