# The Desk

A WhatsApp calling and booking agent for India. Plan: `../the-desk-plan.md`, engineering plan: `../the-desk-eng-plan.md`.

## Status

| Milestone | State |
|---|---|
| E1 Repo + CI | done |
| E2 Schema, `limits`, `check_dial()`, pgTAP | done |
| E3 WhatsApp in/out | built and tested locally; live round trip needs the Meta test number |
| E4 Chat state machine, Luna, business search | built and tested locally (Places search live on the bench); Jev router and L3 check still to do |
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
| `DESK_ECHO` | `1` to echo every message back (E3 round-trip test only) |

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
- `supabase/tests/`: pgTAP suites for guards, limits and the chat state machine
- `supabase/functions/_shared/chat/`: the chat agent: code gate (`gate.ts`), slot checks, code-built read-backs, Luna's cards, the turn router (`turn.ts`), tool actions (`tools.ts`), Luna's prompt and tool loop (`luna.ts`, OpenAI Responses API via `_shared/openai.ts`; model pinned in the `luna_model` limit)
- `dev/`: local test bench while WhatsApp is blocked. `supabase start`, then `deno task dev`, then open http://localhost:8787. Real chat agent and Luna against the local database; WhatsApp and Sarvam are faked, so no message or call leaves the machine. With the bench running, `deno task eval` plays 5 live conversations through it and reports pass/fail, user messages to the read-back, Luna steps, time and tokens (`dev/evals.ts`; costs a few OpenAI calls)
- `supabase/functions/_shared/places.ts`: Google Places Text Search (New), India only; `_shared/chat/find.ts` decides the city (named in the chat, else the saved one; the first one named is saved), keeps callable matches, and tells Luna when to ask which branch or check a match in another city. The bench uses real Places when `GOOGLE_MAPS_API_KEY` is set
- `supabase/functions/wa-inbound/`: Meta webhook (signature check, dedupe, hand-off)
- `supabase/functions/wa-send/`: internal send endpoint; `_shared/deliver.ts` is the one send path (24-hour window check + log)
- `supabase/functions/_shared/sarvam.ts`: Instant Outbound request, webhook parsing, token check
- `supabase/functions/dial/`: internal; `reserve_call()` first, then Sarvam. The only way to start a call
- `supabase/functions/sarvam-webhook/`: token check, raw event stored, call row closed once, hand-off (E6 fills it in)
