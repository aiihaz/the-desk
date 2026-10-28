# The Desk

A WhatsApp calling and booking agent for India. Plan: `../the-desk-plan.md`, engineering plan: `../the-desk-eng-plan.md`.

## Status

| Milestone | State |
|---|---|
| E1 Repo + CI | done |
| E2 Schema, `limits`, `check_dial()`, pgTAP | done |
| E3 WhatsApp in/out | built and tested locally; live round trip needs the Meta test number |
| E4 Chat state machine, Luna, business search | built and tested locally (Places search live on the bench); Jev router and L3 Jev check built (shadow by default, needs `jev_model` pinned); L3 facts check still to do |
| E5/E6 Sarvam plumbing (client, `dial`, `sarvam-webhook`) | built and tested locally, ahead of E4; agent, mapping and verification still to do |

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

## Where things are

- `supabase/migrations/0001_core.sql`: tables (eng plan section 4)
- `supabase/migrations/0002_limits.sql`: configurable limits, `set_limit()`, `get_limit()` (5.2)
- `supabase/migrations/0003_guards.sql`: `check_dial()` and `reserve_call()` (5.1). Every call goes through `reserve_call()`.
- `supabase/migrations/0004_chat.sql`: the chat state machine: request lifecycle, consent prompts, version bumps that void old approvals (E4 design 2.5, 2.8)
- `supabase/migrations/0007_conversation.sql`: errands that wait behind the current one (`queue_request()`) instead of replacing it, consents that record what they were read from (`consents.basis`), and `settle_call()`, which settles a request from a finished call
- `supabase/migrations/0006_evidence_fixes.sql`: fixes from the 27 Oct evidence review: STOP/START and "delete my data" (`stop_user()`; while stopped no prompt, consent or call), pause (`pause_request()`), one turn per user with bursts merged (`claim_turn()`), `max_advance_rs` 0 by default, `call_not_started()`, Luna's settings in `router_log`
- `supabase/tests/`: pgTAP suites for guards, limits, the chat state machine and the 0006 fixes
- `supabase/functions/_shared/chat/`: the chat agent. Luna holds the conversation (`luna.ts`, OpenAI Responses API via `_shared/openai.ts`; model pinned in the `luna_model` limit) and works the errand through tools (`tools.ts`): details, the place (`find.ts`), errands lined up behind each other. When the conversation is ready it asks for the plan (`propose_plan`); code writes the plan from the stored fields as plain WhatsApp text ending in a question (`readback.ts`), so what the user approves is what the call does. No buttons, no "reply YES": the user answers in their own words and Luna calls `approve_plan`, which is not a consent on its own (`approval.ts`): the plan must be open on its current version, the user must have answered after it (by stored order), nothing new may be waiting from them, and a separate check that sees only the plan and the replies must agree and quote their words; then `record_consent()` and `reserve_call()` check again. The code gate (`gate.ts`) only handles STOP/START/delete and the stopped state
- `supabase/functions/_shared/chat/report.ts`: after a call, reads the voice agent's outputs, settles the request (`settle_call()`) and tells the user what the call established, built by code, so nothing is called booked unless the agent reported it. A waiting errand comes up next
- `dev/`: local test bench while WhatsApp is blocked. `supabase start`, then `deno task dev`, then open http://localhost:8787. Real chat agent and Luna against the local database; WhatsApp and Sarvam are faked, so no message or call leaves the machine. With the bench running, `deno task eval` plays 8 live conversations through it and reports pass/fail, user messages to the read-back, Luna steps, time and tokens (`dev/evals.ts`; costs a few OpenAI calls)
- `supabase/functions/_shared/places.ts`: Google Places Text Search (New), India only; `_shared/chat/find.ts` decides the city (named in the chat, else the saved one; the first one named is saved), keeps callable matches, and tells Luna when to ask which branch or check a match in another city. The bench uses real Places when `GOOGLE_MAPS_API_KEY` is set
- `supabase/functions/_shared/chat/agent.ts`: the one entry for an inbound message, used by `wa-inbound` and the bench alike: commands at once, else a `turn_debounce_ms` wait and one turn per user. `commands.ts` runs STOP/START/delete; `calls.ts` starts the call after a consent and ends the request if it can't start
- `supabase/functions/wa-inbound/`: Meta webhook (signature check, dedupe, hand-off to the chat agent)
- `supabase/functions/wa-send/`: internal send endpoint; `_shared/deliver.ts` is the one send path (24-hour window check + log)
- `supabase/functions/_shared/sarvam.ts`: Instant Outbound request, webhook parsing, token check
- `supabase/functions/dial/` and `_shared/dial.ts`: internal; `reserve_call()` first, then Sarvam. The only way to start a call. The voice agent's variables are built from the request's stored, consented fields (`_shared/call_vars.ts`); a request body carrying `variables` is refused
- `supabase/functions/sarvam-webhook/`: token check, raw event stored, call row closed once, hand-off to `chat/report.ts`

## What the chat side reads from the caller

`report.ts` reads these from Sarvam's `final_agent_variables` (eng plan 3.4). Anything else, or a value it doesn't recognise, is reported to the user as "no clear answer" and nothing is treated as done.

| Output | Call kinds | Values |
|---|---|---|
| `booking_status` | first, booking | `booked`, `held_pending_deposit`, `not_booked` (first); `option_gone`, `not_available` (booking) |
| `booked_time`, `booking_reference` | first, booking | ISO 8601 with offset; text |
| `options` / `alternatives` | first / booking | up to 3 of `{time, party_size?, label?, advance_required?}` |
| `no_match_reason` | first | `no_slot`, `several_options`, `advance`, `price`, `new_condition`, `unclear` |
| `advance_amount` | first, booking | rupees |
| `answer` | question | what the business said, in English. **Not in eng plan 3.4 yet**: the caller needs to produce it |
| `opt_out_requested` | all | `yes` / `no` |

The `question` input is one string; several questions go as `1) ... 2) ...`.
