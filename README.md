# The Desk — iMessage alternate

This branch (`imessage-linq`) adds Linq iMessage with RCS/SMS fallback to the same Supabase project, with separate conversation records per channel. Setup and deployment: [README.imessage.md](README.imessage.md). The WhatsApp version remains on `main`.

# The Desk

A WhatsApp calling and booking agent for India. The bounded product scope, recovery design, and deployment checks are documented in [ARCHITECTURE.md](ARCHITECTURE.md). Plan: `../the-desk-plan.md`, engineering plan: `../the-desk-eng-plan.md`.

## Status

| Milestone | State |
|---|---|
| E1 Repo + CI | done |
| E2 Schema, `limits`, `check_dial()`, pgTAP | done |
| E3 WhatsApp in/out | built and tested locally; live round trip needs the Meta test number |
| E4 Chat state machine, Luna, business search | built and tested locally (Places search live on the bench); Jev router and L3 Jev check on `jev-1.14.0`, shadow by default, measured live with `deno task jev`; L3 facts check still to do |
| E5/E6 Sarvam plumbing (client, `dial`, `sarvam-webhook`) | built and tested locally; outputs read in the eng plan 3.4 or the Genie brief contract; booking verification (3.5) built. The Sarvam agent itself and a live two-call run still to do |
| E7 jobs, admin, advances, booking changes | built and tested locally: stale options, expiry, reconcile, retention (pg_cron), admin commands, alerts, health; advances (terms back to the user, screenshot check, confirm call); cancel and reschedule of Desk bookings; Serper fallback. Live runs need WhatsApp and Sarvam |

## Run the tests locally

Needs Docker and the Supabase CLI.

```
supabase start
supabase test db      # guards and limits (pgTAP)
deno task test        # WhatsApp and Sarvam functions
deno task check       # fmt, lint, type-check
```

## WhatsApp secrets

Set these on the Supabase project (`supabase secrets set ...`):

| Name | From |
|---|---|
| `WA_APP_SECRET` | Meta app → App settings → Basic → App secret |
| `WA_VERIFY_TOKEN` | any long random string; paste the same one into Meta's webhook setup |
| `WA_ACCESS_TOKEN` | WhatsApp → API setup (temporary token, then a system-user token) |
| `WA_PHONE_NUMBER_ID` | WhatsApp → API setup → Phone number ID |
| `DESK_ECHO` | `1` to echo every message back instead of running the chat agent (E3 round-trip test only) |
| `DESK_ADMIN_WA_IDS` | comma-separated wa_ids allowed admin commands (the commands themselves are E7) |

Webhook URL for Meta: `https://<project-ref>.supabase.co/functions/v1/wa-inbound`, subscribed to the `messages` field.

## Sarvam secrets

Local values go in `supabase/functions/.env` (gitignored, template in `.env.example`). Set the same ones on the project with `supabase secrets set ...`.

| Name | From |
|---|---|
| `SARVAM_API_KEY` | Sarvam dashboard → Settings → API Key |
| `SARVAM_ORG_ID`, `SARVAM_WORKSPACE_ID` | the dashboard URL, or Settings |
| `SARVAM_APP_ID` | the Desk caller agent's id (agent page URL) |
| `SARVAM_CONNECTION_ID` | the telephony connection the caller numbers belong to |
| `SARVAM_WEBHOOK_TOKEN` | any long random string (`openssl rand -hex 32`). Sarvam signs nothing, so `dial` puts it in the webhook URL as `?token=` and `sarvam-webhook` checks it |

The agent version comes from the `active_agent_version` limit, which must be the integer version Sarvam shows for a committed agent.

## OpenAI secrets

Same place as the Sarvam ones: `supabase/functions/.env` locally, `supabase secrets set ...` on the project.

| Name | From |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com → API keys (project key) |
| `TYPESAFE_API_KEY` | console.typesafe.ai → API keys (Jev router and output check, E4 design 3) |
| `GOOGLE_MAPS_API_KEY` | Google Cloud console → APIs & Services → Credentials (Places API (New) enabled; restrict the key to that API) |
| `SERPER_API_KEY` | serper.dev → API key. Optional: without it, places Google lists with no phone stay uncallable |

## Before the first real call

The agent that dials must have every output in `agent/contract.json`, because Desk reads each call's result from those alone. Sarvam has no API that shows an agent's output variables, so `0013` works from what each version actually returned. Every completed call records the contract outputs it came back with (`gate_passes.outputs_seen`), and `check_dial` refuses a real business (`caller_contract_mismatch`) until that version has returned all 26. Numbers in `test_numbers` stay open, so a new version earns this with test calls; nothing is typed in by hand. Outputs a test call doesn't return stay missing, so if Sarvam leaves out empty variables, one call won't be enough.

A call that connects and reports no readable result blocks its version for real businesses (`caller_contract_broken`), tells the user the result is unknown and to check before retrying, and raises `caller_contract_missing`. Fix the agent and commit a new version, or clear `contract_broken_at` on the gate row. `deno task caller-check <file>` previews any list of names or saved result; it's a convenience, not the guard.

Every call is refused until the caller setup is pinned (`0012`): the active version needs a passed gate on the hash of the instructions it runs, or `check_dial` answers `no_instructions_pin` / `agent_instructions_mismatch` and the user hears that calls aren't working. After the Sarvam agent passes its suite:

```
cat agent/instructions.md agent/contract.json | shasum -a 256    # as committed to Sarvam
insert into gate_passes (agent_version, suite, passed, instructions_sha256) values ('<version>', '<suite>', true, '<hash>');
set limit active_agent_version <version>   # on WhatsApp, from an admin
set limit agent_instructions_sha256 <hash>
```

Sarvam's API isn't read back, so this catches a change on our side of the pin; change the instructions, and the hash and gate must be redone.

## Which version is running

Set `DESK_GIT_SHA` when deploying (`supabase secrets set DESK_GIT_SHA=$(git rev-parse HEAD)`). `health` answers with it, the newest migration applied, when `reconcile` last finished, and how many owed messages are overdue, and fails if the job has stopped.

## Scheduled jobs

`0009_jobs.sql` schedules them with pg_cron when the migrations run: stale options (every 5 min), request expiry (every 15 min), `reconcile` (every 5 min, `0012`), retention (daily, 03:00 IST). `reconcile` also sends what the Desk owes users (`chat/followup.ts`): reminders, one nudge on an unanswered plan, a payment deadline coming up, word that an errand expired, a deadline that passed, and any report or reply whose write or send failed. **None of this runs until the two Vault secrets below are set.** After the 24-hour window closes, updates stay pending until the user messages again; paid templates are disabled. Migration 0021 adds a one-minute follow-through tick and one useful near-expiry update for unfinished work. `reconcile` is an edge function that pg_cron calls through pg_net, using two Vault secrets you set once in the SQL editor:

```
select vault.create_secret('https://<project-ref>.supabase.co', 'desk_project_url');
select vault.create_secret('<service role key>', 'desk_service_key');
```

`.github/workflows/daily.yml` calls `health` every morning. It needs the repo secrets `SUPABASE_PROJECT_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and fails (GitHub emails you) when an alert couldn't reach WhatsApp.

## Admin on WhatsApp

From a wa_id in `DESK_ADMIN_WA_IDS`: `status`, `review`, `resolve <id>`, `stop all`, `resume`, `credit <rs>`, `optout <+91…>`, `limits`, `set limit <key> <value> [for <wa_id>]`, `numbers`, `number off|on <number or id>`. Alerts (an unverified booking, a call with no result, an unconfirmed payment, a failed redial) are checked by reconciliation every 5 minutes. An admin must have messaged the Desk in the last 24 hours to receive them.

## Where things are

- `supabase/migrations/0001_core.sql`: tables (eng plan section 4)
- `supabase/migrations/0002_limits.sql`: configurable limits, `set_limit()`, `get_limit()` (5.2)
- `supabase/migrations/0003_guards.sql`: `check_dial()` and `reserve_call()` (5.1). Every call goes through `reserve_call()`.
- `supabase/migrations/0004_chat.sql`: the chat state machine: request lifecycle, consent prompts, version bumps that void old approvals (E4 design 2.5, 2.8)
- `supabase/migrations/0007_conversation.sql`: errands that wait behind the current one (`queue_request()`) instead of replacing it, consents that record what they were read from (`consents.basis`), and `settle_call()`, which settles a request from a finished call
- `supabase/migrations/0006_evidence_fixes.sql`: fixes from the 27 Oct evidence review: STOP/START and "delete my data" (`stop_user()`; while stopped no prompt, consent or call), pause (`pause_request()`), one turn per user with bursts merged (`claim_turn()`), `max_advance_rs` 0 by default, `call_not_started()`, Luna's settings in `router_log`
- `supabase/tests/`: pgTAP suites for guards, limits, the chat state machine and the 0006 fixes
- `supabase/functions/_shared/chat/`: the chat agent. Luna holds the conversation (`luna.ts`, OpenAI Responses API via `_shared/openai.ts`; model pinned in the `luna_model` limit) and works the errand through tools (`tools.ts`): details, the place (`find.ts`), errands lined up behind each other. When the conversation is ready it asks for the plan (`propose_plan`); code writes the plan from the stored fields as plain WhatsApp text ending in a question (`readback.ts`), so what the user approves is what the call does. No buttons, no "reply YES": the user answers in their own words and Luna calls `approve_plan`, which is not a consent on its own (`approval.ts`): the plan must be open on its current version, the user must have answered after it (by stored order), nothing new may be waiting from them, and a separate check that sees only the plan and the replies (`reading.ts`) must agree and point at the message that says so, which works in any language because nothing is matched as words; then `record_consent()` and `reserve_call()` check again. The code gate (`gate.ts`) only handles STOP/START/delete and the stopped state
- `supabase/functions/_shared/chat/report.ts`: after a call, reads the voice agent's outputs, verifies them, settles the request (`settle_call()`) and stores the facts the user is owed. Nothing is called booked unless the agent reported it. A waiting errand comes up in the same message
- `supabase/functions/_shared/chat/tell.ts`: the model writes what the user hears, from those facts, in their language. Code writes none of it. Amounts, addresses, times and numbers go in as `{{key}}` and code fills them exactly, and a second model reads the finished message against the facts before it can go. If writing fails it's retried, an alert goes to the review surface after `report_alert_attempts`, and when it finally goes the message says it's late. Nothing written by code stands in for it. `deno task report-eval` measures all of this live
- `dev/`: local test bench while WhatsApp is blocked. `supabase start`, then `deno task dev`, then open http://localhost:8787. Real chat agent and Luna against the local database; WhatsApp and Sarvam are faked, so no message or call leaves the machine. With the bench running, `deno task eval` plays live conversations through it, whole errands included, and reports pass/fail, user messages to the read-back, Luna steps, time and tokens (`dev/evals.ts`; costs OpenAI calls; `JEV=gate` sets the mode, `ONLY=word` filters; start the bench with `DEV_PLACES=fake` for the dev businesses). The page switches Jev between off, shadow and gate for the dev user and shows each decision. `deno task jev` runs labelled messages through Jev alone, with no database
- `supabase/functions/_shared/places.ts`: Google Places Text Search (New), India only; `_shared/chat/find.ts` decides the city (named in the chat, else the saved one; the first one named is saved), keeps callable matches, and tells Luna when to ask which branch or check a match in another city. The bench uses real Places when `GOOGLE_MAPS_API_KEY` is set
- `supabase/functions/_shared/chat/agent.ts`: the one entry for an inbound message, used by `wa-inbound` and the bench alike: commands at once, else a `turn_debounce_ms` wait and one turn per user. `commands.ts` runs STOP/START/delete; `calls.ts` starts the call after a consent and ends the request if it can't start
- `supabase/functions/wa-inbound/`: Meta webhook (signature check, dedupe, hand-off to the chat agent)
- `supabase/functions/_shared/deliver.ts`: the shared send path (24-hour service window, no paid templates, and message log). The legacy `wa-send` HTTP endpoint is retired with an authenticated 410 response.
- `supabase/functions/_shared/sarvam.ts`: Instant Outbound request, webhook parsing, token check
- `supabase/functions/_shared/dial.ts`: internal module; `reserve_call()` first, then Sarvam. The only way to start a call. The voice agent's variables are built from the request's stored, consented fields (`_shared/call_vars.ts`); a request body carrying `variables` is refused
- `supabase/functions/sarvam-webhook/`: token check, raw event stored, call row closed once, hand-off to `chat/report.ts`
- `supabase/migrations/0008_verification.sql` and `_shared/chat/verify.ts`: booking verification (eng plan 3.5). A booking is stored as booked only when the time matches what the user approved and a separate model pass points at the business's line confirming it; otherwise probably booked, the user asked to check with the business, and an alert raised. The pass lists every condition the business attached, and judges whether they required it and whether the user approved it. One rule in code: a required, unapproved condition stops the booking being verified and goes to the user to accept or refuse. Everything else is told in the business's words, and blocks nothing. Cancels and confirm calls get the same transcript check (`checkClaim`)
- `_shared/chat/outputs.ts`: reads the caller's outputs in either contract, including strings for numbers and JSON-string lists
- `supabase/migrations/0009_jobs.sql`, `_shared/reconcile.ts`, `functions/reconcile/`, `functions/health/`: the scheduled jobs above
- `supabase/migrations/0010_admin.sql`, `_shared/chat/admin.ts`, `_shared/alerts.ts`: admin commands and alerts
- `supabase/migrations/0011_booking_changes.sql`: the payment check and confirm call (eng plan 2.2), cancel and reschedule of Desk bookings (E4 design 2.7, 2.9). `_shared/chat/payment.ts` reads the screenshot with a model and checks it in code; `find_booking` in `chat/tools.ts`
- `supabase/migrations/0013_caller_contract.sql`: a version reaches real businesses only after returning every contract output
- `supabase/migrations/0014_advances_and_conditions.sql`: no call agrees an advance. The caller collects the terms and says it'll check with the customer; the user decides, pays the business directly and sends the screenshot; only then does the confirm call say it's done. The errand waits in `awaiting_payment` until the user closes it: told once if a deadline passes, never expired. Several can be open, and a screenshot binds to the one it fits, then the user's words, then a question. A move or cancel the business didn't clearly confirm leaves the booking as it stood, with the change pending
- `supabase/migrations/0015_model_reports.sql`: what's owed is stored as facts with the settlement, written after, then sent; an options prompt opens with the exact words the user gets
- `supabase/migrations/0019_call_meaning.sql`, `_shared/chat/report.ts`, `chat/tell.ts`: the report's writer and its check both read the call itself (transcript and the caller's notes) beside what code settled, so a report is checked against what was said, not only against code's reading of it. A confirm call's redial is at the time the business asked for (`retry_at`); a number that reached someone else isn't dialled again for that user (`wrong_numbers`)
- `supabase/migrations/0024_never_silent.sql` (0017 on `main`), `chat/tell.ts`, `chat/report.ts`: a call report that can't be written yet doesn't leave the user in silence. After `report_stall_notice_attempts` failed writes they're told the result is still being written up; after `report_plain_after_attempts` it's written from the record alone, saying the rest of the call couldn't be checked. A long call keeps its opening and its end for the writer and its check, and each check sees why earlier drafts were refused. A payment address reaches the user only if the call shows the business confirmed it whole. A number recorded as wrong can't be picked or planned again (`wrong_number_for`).
- `supabase/migrations/0012_follow_through.sql`, `_shared/chat/followup.ts`: errands record what they wait for; `settle_and_report()` stores a result with everything it owes the user, sent through tracked `deliveries`, retried, and alerted if it can't arrive; `user_memories` (said, or learned from a correction; never a permission, and nothing in the approval or dial path reads it); bookings keep the captured value beside the approved one; `check_dial` names the consent a call rests on and requires the pinned caller setup
- `_shared/serper.ts`: phone numbers for places Google lists without one, taken only from a result whose name fits, and said in the read-back as found on the web

## What the chat side reads from the caller

`report.ts` reads these from Sarvam's `final_agent_variables` (eng plan 3.4), through `outputs.ts`, which also accepts the Genie brief's names (`outcome`, `advance_amount_rs`, options with `details`, `summary`). Anything else, or a value it doesn't recognise, is recorded as no clear answer and nothing is treated as done.

| Output | Call kinds | Values |
|---|---|---|
| `booking_status` | first, booking | `booked`, `advance_required`, `not_booked` (first); `option_gone`, `not_available` (booking) |
| `booked_time`, `booking_reference` | first, booking | ISO 8601 with offset; text |
| `options` / `alternatives` | first / booking | up to 3 of `{time, party_size?, label?, advance_required?}` |
| `no_match_reason` | first | `no_slot`, `several_options`, `advance`, `price`, `new_condition`, `unclear` |
| `advance_amount` | first, booking | rupees |
| `answer` | question | what the business said, in English. In `agent/contract.json`, which every caller that dials must have |
| `also_answer` | first, booking | the answer to `also_ask`, reported on every outcome; a first call with none says so |
| `options` | question | an offer to book, as on a first call. Brought to the user to pick; never accepted on the call |
| `advance_redeemable`, `advance_refund` | first, booking | in their words |
| `advance_hold` | first, booking | `yes`, `no`: will they keep the slot meanwhile |
| `payment_mode`, `payment_address`, `payee_name`, `payment_deadline` | first, booking | how, where and by when; a UPI ID in `payment_address` is what the screenshot is checked against |
| `payment_status` | payment_confirm | `received`, `not_seen`, `wrong_amount`, `disputed`, `unclear` |
| `cancel_status`, `cancel_charge_rs`, `refund_stated` | cancel | `cancelled`, `charge_pending`, `not_cancelled`, `unclear`; rupees; their words |
| `original_booking_status` | reschedule | `moved`, `kept`, `cancelled`, `unclear` |
| `summary` | all | 2-3 factual sentences; quoted to the user when a payment or change isn't confirmed |
| `opt_out_requested` | all | `yes` / `no` |

The `question` input is one string; several questions go as `1) ... 2) ...`.

## What the caller is given

Beside the fields for each call kind, every call gets the errand already resolved (`call_vars.ts`), from what the user approved: `resolved_when`, `request_summary`, `decided`, `flexible`, `may_accept`, `already_happened`, `call_date`, `timezone`. Names follow the Genie brief; the eng plan's older names go too until the agent is built.


## Reliability and personal context

The normal errand flow still prepares a calling plan and requires approval before every new call. Explicit preferences and clear corrections can be remembered, corrected or forgotten; relevant past errands can be recalled without broadening the Desk into a companion product.

Only the user's latest message refreshes the 24-hour WhatsApp service window. Pending results wait for the next inbound message after expiry. Unfinished work may receive one useful near-expiry update; no paid templates or repeated keep-alives are sent. Reminders outside the window must not be promised.

Migrations 0020–0022 add recoverable inbox/turn processing, fenced claims, atomic consent watermarks, uncertain-submission handling, result settlement recovery, tracked delivery ownership, local erasure, and operational measurements. The one-minute `follow-through` endpoint handles due messages; the five-minute reconcile job handles provider analytics and recovery. Both require the configured machine credential. See [deployment instructions](ARCHITECTURE.md#deployment), including retirement of already deployed obsolete HTTP endpoints and qualification of the actual external voice caller.

Additional local checks:

```sh
deno task test:auth
python3 scripts/test_db_concurrency.py
```
