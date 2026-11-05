-- Reply latency per Linq turn, for comparing a release against the 2026-11-05 baseline.
-- Run: supabase db query --linked --project-ref rvglpiyctuzpegbvlane -f dev/turn_latency.sql
-- Change the window below to the test session.
--
-- One row per reply: the messages since the previous reply are its burst. A burst of 2+
-- is a correction (a second message while the first was being answered), so report
-- single messages and corrections separately; an overall average hides the restart cost.
-- model_usage has no user on every row, so model time is the window's, which is only
-- right while one person is testing.
with win as (
  select timestamptz '2026-11-05 17:28:00+05:30' as since, timestamptz '2026-11-05 17:35:00+05:30' as until
),
m as (
  select m.user_id, m.at, m.direction,
         sum((m.direction = 'out')::int) over (partition by m.user_id order by m.at
           rows between unbounded preceding and 1 preceding) as turn_no
  from messages m join users u on u.id = m.user_id, win
  where u.channel = 'linq' and m.at between win.since and win.until
),
turns as (
  select user_id, coalesce(turn_no, 0) as turn_no,
         min(at) filter (where direction = 'in') as first_in,
         max(at) filter (where direction = 'in') as last_in,
         count(*) filter (where direction = 'in') as burst,
         min(at) filter (where direction = 'out') as reply_at
  from m group by user_id, coalesce(turn_no, 0)
)
select to_char(t.first_in at time zone 'Asia/Kolkata', 'HH24:MI:SS') as ist,
       case when t.burst > 1 then 'correction' else 'single' end as kind,
       t.burst,
       round(extract(epoch from t.reply_at - t.last_in)::numeric, 1) as reply_after_last_s,
       round(extract(epoch from t.reply_at - t.first_in)::numeric, 1) as reply_after_first_s,
       (select count(*) from router_log r where r.at > t.first_in and r.at <= t.reply_at + interval '3 seconds')
         as turns_started,
       (select count(*) from model_usage u where u.at > t.first_in and u.at <= t.reply_at) as model_calls,
       (select round(sum(u.latency_ms) / 1000.0, 1) from model_usage u
         where u.at > t.first_in and u.at <= t.reply_at) as model_s
from turns t
where t.first_in is not null and t.reply_at is not null
order by t.first_in;
