-- When Luna's repair fails within a turn, the fallback says so honestly (luna.ts fallbackKind):
-- nothing was called or booked, and it asks for more only when something is actually missing.
-- fallback_held: nothing is missing; {details} is the stored errand, which no check refused.
-- fallback_unsure: a check refused the stored details this turn, so none are recited.
-- fallback_known (0004) stays for when details are genuinely missing.
-- Until this is applied the code falls back to fallback_generic.
insert into reply_templates (key, language, text) values
  ('fallback_held', 'en',
   'Sorry, I couldn''t put the plan together on my side, so I haven''t called anyone or booked anything. I already have what I need: {details}. Reply when you''re ready and I''ll try again.'),
  ('fallback_unsure', 'en',
   'Sorry, I couldn''t get the details right on my side, so I haven''t called anyone or booked anything. Nothing you told me is lost. Reply when you''re ready and I''ll try again.')
on conflict (key, language) do update set text = excluded.text;
