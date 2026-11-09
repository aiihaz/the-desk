-- The state's code from Google Places (shortText of administrative_area_level_1, the ISO
-- 3166-2:IN code: KA, KL), kept beside its name. The language a call opens in is read by the
-- code, which stays the same when a state's name changes (Google now gives "Keralam" for
-- Kerala, code KL). Rows saved before this keep only the name, used as the fallback, and
-- gain the code the next time a search returns them.
alter table businesses add column state_code text;
