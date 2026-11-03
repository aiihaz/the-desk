# The Desk on iMessage (Linq)

Alternate branch: `imessage-linq`. The WhatsApp version stays on `main`.
Linq handles iMessage with RCS/SMS fallback; Desk still uses the existing Luna
conversation, consent checks, Sarvam calls, booking verification, payment screenshot
checks, and follow-through jobs. This branch does not deploy itself.

## Configuration

Use a **separate Supabase project** for this alternate version. The database still
uses the legacy names `wa_id` and `wa_message_id` internally: a `wa_id` is the user's
international phone digits without `+`, and message IDs are Linq UUIDs. This avoids
rewriting consent and call guards, but means a database must serve only one channel.
Do not point this deployment at the WhatsApp database.

Copy `supabase/functions/.env.example` to `supabase/functions/.env` and fill in:

| Secret | Value |
|---|---|
| `DESK_CHANNEL` | `linq` (required for `linq-inbound`) |
| `LINQ_API_TOKEN` | Linq dashboard API token |
| `LINQ_WEBHOOK_SECRET` | Signing secret returned when creating the webhook subscription |
| `DESK_ADMIN_WA_IDS` | Admin phone numbers as country code + digits, without `+`, comma-separated |
| `DESK_ECHO` | Optional: `1` for an echo test; remove or set `0` to run the agent |

Add the existing OpenAI, Places, Sarvam, and optional Jev/Serper secrets from
[README.md](README.md). The `.env` file is ignored by Git; never commit a token.
Keep an external copy in a password manager. No Meta app, WhatsApp access token,
WhatsApp template approval, or WhatsApp 24-hour window is required for Linq.

All production sends select the same transport: conversation replies, call reports,
reconciliation/retries, health/admin alerts, and the legacy internal `wa-send`
endpoint. Linq uses `POST /api/partner/v3/messages` with `to` and no pinned `from`,
letting Linq select the line/service. Plans are sent as their original plain text;
legacy button/list messages render as text choices. WhatsApp templates are rejected
on Linq rather than silently sending a template name.

## Deploy the alternate project

From this branch, after installing the Supabase CLI and logging into Supabase:

```bash
git switch imessage-linq
# Set this to the NEW project's reference, not the WhatsApp project's reference.
export IMESSAGE_PROJECT_REF="your-new-project-ref"
supabase link --project-ref "$IMESSAGE_PROJECT_REF"
supabase db push --linked
supabase secrets set --env-file supabase/functions/.env --project-ref "$IMESSAGE_PROJECT_REF"
supabase functions deploy linq-inbound --project-ref "$IMESSAGE_PROJECT_REF"
supabase functions deploy wa-send --project-ref "$IMESSAGE_PROJECT_REF"
supabase functions deploy dial --project-ref "$IMESSAGE_PROJECT_REF"
supabase functions deploy sarvam-webhook --project-ref "$IMESSAGE_PROJECT_REF"
supabase functions deploy reconcile --project-ref "$IMESSAGE_PROJECT_REF"
supabase functions deploy health --project-ref "$IMESSAGE_PROJECT_REF"
```

Do not deploy `wa-inbound` for this project. It refuses to start when `DESK_CHANNEL=linq`.
`linq-inbound` has JWT verification disabled in `supabase/config.toml`; it verifies
Standard Webhooks HMAC signatures against the **raw request body** and rejects
timestamps more than five minutes in either direction. Database errors return 503
so Linq can retry; message UUIDs deduplicate redeliveries. The agent runs in the
Supabase background task as in the WhatsApp version.

Install Node 22+ and the Linq CLI (verified here with 2.7.0), then authenticate:

```bash
npm install -g @linqapp/cli@latest
linq login
linq whoami
linq webhooks create \
  --url "https://${IMESSAGE_PROJECT_REF}.supabase.co/functions/v1/linq-inbound?version=2026-02-03" \
  --events message.received --json
```

Save the returned signing secret as `LINQ_WEBHOOK_SECRET` in the local `.env` and
run the `supabase secrets set` command again. The `?version=2026-02-03` parameter is
required: this handler intentionally rejects older message payload formats. Keep
the subscription ID for later management. Create only one Desk inbound subscription
per deployment. Any welcome subscription on the Linq sandbox can remain as it is.

Set the two Vault secrets for **this project's** cron jobs, as documented in the
original README: `desk_project_url` and `desk_service_key`. Set `DESK_GIT_SHA` for
health/version reporting. Before real calls, configure the existing caller gate,
test numbers, committed Sarvam agent version, and instruction/contract pins in the
new database. A new project does not inherit the WhatsApp project's passed gates.

GitHub CI checks this branch on push. The existing daily health workflow uses
repository-wide Supabase secrets; leave those pointing at the WhatsApp deployment.
This branch does not replace the main deployment's monitoring or secrets.

## First live round trip

1. Set `DESK_ECHO=1` in the alternate project.
2. From your own phone, text the Linq number shown by `linq whoami`. Shared lines
   require adding the contact first (`linq contacts add +<country-code><number>`)
   and support up to 20 contacts. This sandbox also requires the recipient to text
   first; use the actual account's restrictions shown by the CLI/dashboard.
3. Expect `The Desk got: ...` back in Messages. Check the alternate project's
   `webhook_events` (`source=linq`) and `messages` tables for the inbound/outbound IDs.
4. Set `DESK_ECHO=0`, then ask for an errand. Confirm the plan in your own words.
   Booking and call guards apply exactly as before.

For event inspection, `linq webhooks listen --events message.received` opens a
temporary subscription that cleans up on Ctrl+C. It can run alongside Desk's
permanent subscription.

Supported inbound: direct phone-number conversations, text, threaded text replies,
and image attachments (including payment screenshots). Email handles, group chats,
Tapbacks/reaction events, edits, and unsupported media are not implemented as Desk
inputs in this version. Images use Linq's presigned download URLs, which expire
after about an hour; a delayed retry may require a fresh screenshot. Text-only
RCS/SMS fallback cannot guarantee every iMessage attachment/feature.

## Checks

```bash
deno task check
deno task test
supabase db start
supabase test db
```

The added tests cover signed webhooks, replay/tamper rejection, duplicate delivery,
database retry, blocked users, normalized identity/history/replies/screenshots,
the Linq API send shape, and delivery outside WhatsApp's service window. Unit tests
mock outbound requests and do not send real messages or place calls.

API reference: https://docs.linqapp.com/channel/imessage/llms.txt
