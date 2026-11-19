-- 0031: the comparison-version switch and the private call-audio archive.
--
-- comparison_mode (limits, default false) is the ONE switch for the Aurora-matched
-- comparison version (owner's decision, 19 Nov 2026). When off, nothing changes.
-- When on: the Desk picks which businesses to call itself (the businesses from the
-- owner's Aurora recordings first, otherwise the highest-rated matching five, at most
-- five distinct businesses per errand) and every settled call's recording is archived
-- to private storage. Both behaviours read this key; there is no second switch.
insert into limits (key, value, value_type, nullable, description) values
  ('comparison_mode', 'false', 'bool', false,
   'admin "comparison on/off": Aurora-matched version - the Desk selects businesses itself and call audio is archived');

-- Where a call's archived recording lives: storage object path inside the call-audio
-- bucket. Null when archiving was off or the provider had no recording.
alter table calls add column audio_path text;

-- Private bucket for archived recordings (dual-channel WAV from the provider's
-- analytics API). Service role only; never public, no user-facing URL.
insert into storage.buckets (id, name, public) values ('call-audio', 'call-audio', false);

-- Comparison requests: comparison snapshots the switch at creation (a request keeps
-- its mode if the switch flips mid-flight); recipient_ids is the errand's call list
-- when the owner supplies one (the matched test's frozen sets) - null means the Desk
-- picks from search results (design: docs/comparison-mode.md).
alter table requests
  add column comparison boolean not null default false,
  add column recipient_ids uuid[],
  add column comparison_dispatching boolean not null default true,
  add column comparison_dispatch_until timestamptz not null default now()+interval '10 minutes';
