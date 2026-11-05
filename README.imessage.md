# The Desk on iMessage (Linq)

> Current conversation-quality work is unfinished and not deployed. Start with [HANDOFF.md](HANDOFF.md) for the checkpoint, failing tests, evidence, and next steps.

Alternate branch: `imessage-linq`. Both channels use the **same Supabase project**.
Linq provides iMessage with RCS/SMS fallback. The existing Luna conversation,
consent checks, Sarvam caller, booking verification, payment screenshot checks,
and follow-through jobs are shared.

Hosted project: `rvglpiyctuzpegbvlane` (`thedesk`). The Linq webhook is deployed at
`https://rvglpiyctuzpegbvlane.supabase.co/functions/v1/linq-inbound?version=2026-02-03`.
The branch includes main `c658630` and Codex reliability/memory `dd60d98`.
All 22 migrations are applied. Migrations 0019–0022 integrate their schema changes
after the original 18 Linq migrations, preserving the existing project and history.

## Owner-only calling, paused

At the user's request, the final Sarvam request **always** sets its recipient to
`+918848878757`, for every call kind, retry, and follow-up. Google Maps numbers and
caller-supplied overrides cannot change that destination. This restriction is
hardcoded in `buildOutbound()`; removing it requires an explicit code change.

Calling is paused until the user explicitly says they are ready. The hosted
`kill_switch` is true and `DESK_CALLS_PAUSED=1`. The transport also defaults to paused
when that environment variable is missing, so a fresh deployment cannot ring a phone.
No automatic unpause is scheduled. A future explicit resume needs both the database
kill switch cleared and `DESK_CALLS_PAUSED=0`; it still calls only the owner's number.

The hosted iMessage agent has replied through the real model, with delivery/read
confirmed by Linq. The Sarvam organization, workspace, supplied connection identifier and Desk Caller
app are configured. Committed version 4 was identified from authenticated API
history and selected in the database. Purchased outbound caller ID `+918064269395` is registered. It is distinct from the
only permitted test destination, `+918848878757`. Real-line validation remains
deferred until the user explicitly allows calling. No
live phone tests should run while the user is sleeping, and caller gates must not
be marked passed without evidence.

## How the channels stay separate

Migration `0017_messaging_channels.sql` adds `users.channel`, defaulting existing
users to `whatsapp`. Existing WhatsApp `wa_id` keys and their unique constraint
stay intact, so already deployed WhatsApp code can keep upserting users.

Linq stores its identity as `linq:<international-phone-digits>` and keeps the real
phone in `phone_e164`. The same phone gets a separate user UUID on each channel,
which separates history, memories, errands, consents, and STOP state. Application
code normalizes the phone before sending. Reports, retries and alerts look up the
persisted channel by user UUID, so a call started in iMessage reports there even
if that phone also uses WhatsApp.

Caller numbers, credit, business opt-outs, global limits and the caller's proven
gates remain shared. Existing OpenAI, Places and Sarvam credentials stay in the
same Supabase project. There is no global `DESK_CHANNEL` switch.

## Secrets to add

Put the Linq additions in the ignored `supabase/functions/.env` file:

| Secret | Value |
|---|---|
| `LINQ_API_TOKEN` | Linq dashboard API token |
| `LINQ_WEBHOOK_SECRET` | Signing secret returned when creating the webhook subscription |
| `DESK_ADMIN_LINQ_IDS` | iMessage admin phone digits, including country code, without `+`, comma-separated |
| `DESK_LINQ_ECHO` | `1` for an iMessage echo test, `0` or absent to run the agent |

`DESK_ADMIN_WA_IDS` and `DESK_ECHO` continue to control WhatsApp only. Do not upload
blank OpenAI or Sarvam entries from the template: that would overwrite the existing
project's working secrets. Keep an external copy of Linq keys in a password manager.

## Deploy to the existing project

These commands use **Supabase CLI 3.x** (`supabase --version`). A management access
token is required (`supabase login` or `SUPABASE_ACCESS_TOKEN`). Use the existing
project reference:

```bash
git switch imessage-linq
export DESK_PROJECT_REF="your-existing-project-ref"
supabase db push --remote="$DESK_PROJECT_REF" --yes
supabase functions deploy linq-inbound sarvam-webhook reconcile health follow-through dial wa-send \
  --remote="$DESK_PROJECT_REF" --use-api
```

Keep any existing WhatsApp webhook subscription and secrets. If WhatsApp is
active in this project, deploy `wa-inbound` with this release as well: both channel
adapters now use the shared fenced runtime. Deploy the shared workers with the
migrations, including the minute `follow-through` tick. `dial` and `wa-send` deploy
authenticated retirement responses (410), replacing legacy direct-action endpoints.

Install Node 22+ and Linq CLI 2.6+ (verified here with 2.7.0), then authenticate:

```bash
npm install -g @linqapp/cli@latest
linq login
linq whoami
linq webhooks create \
  --url "https://${DESK_PROJECT_REF}.supabase.co/functions/v1/linq-inbound?version=2026-02-03" \
  --events message.received --json
```

Save the returned signing secret as `LINQ_WEBHOOK_SECRET`. Upload **only** the four
Linq secrets in the table above using the dashboard, or a dedicated ignored env file
containing only those values:

```bash
supabase secrets set --env-file .env.linq --remote="$DESK_PROJECT_REF"
```

The version query parameter is required. Standard Webhooks HMAC is checked on the
raw body, with five-minute replay protection. JWT verification is disabled only
for the inbound function in `supabase/config.toml`. Storage failures return 503 for
Linq to retry, and message UUIDs deduplicate redeliveries. Subscribe only once per
Desk endpoint. The account's existing welcome subscription can remain.

Existing cron/Vault configuration and caller gates stay in the shared database.
If Desk has never been deployed, apply all migrations and configure the original
OpenAI/Places/Sarvam secrets, Vault cron secrets and proven caller gates from
[README.md](README.md) as well. Deployment must not fabricate a passed caller gate.

## Verify

1. Set `DESK_LINQ_ECHO=1` without changing WhatsApp's `DESK_ECHO`.
2. Text the number from `linq whoami` using your own phone. Sandbox accounts require
   the recipient to text first. Shared lines also require contact registration and
   support up to 20 contacts; follow the actual account's dashboard restrictions.
3. Expect `The Desk got: ...`. In Supabase, the event source is `linq`, the user has
   `channel=linq`, and the message IDs are Linq UUIDs.
4. Set `DESK_LINQ_ECHO=0` and ask for an errand. Confirm the read-back in your own
   words. The existing consent and call guards still apply.
5. Check that a WhatsApp conversation still receives WhatsApp replies, including
   call results and overdue reports.

Linq sends use `POST /api/partner/v3/messages` with `to` and no pinned `from`, so
Linq selects the appropriate line/service. There is no WhatsApp 24-hour template
restriction on Linq. Plans retain their original text; legacy button/list messages
render as text choices, and WhatsApp templates are rejected on the Linq transport.

Supported inbound: direct phone-number conversations, text, threaded text replies,
and image attachments (including payment screenshots). Email handles, group chats,
Tapbacks/reaction events and edits are not Desk inputs in this version. Unsupported
media is represented as a marker. Presigned image URLs expire after about an hour;
a delayed screenshot retry may need a fresh image. RCS/SMS fallback cannot guarantee
all iMessage attachment/features.

For live event inspection: `linq webhooks listen --events message.received` (temporary
subscription, Ctrl+C cleans up).

## Checks

```bash
deno task check
deno task test
deno task test:auth
deno task test:bench
supabase db start
supabase test db
```

Tests cover webhook authenticity and retries, blocked users, text/reply/screenshot
normalization, Linq API payloads, cross-channel identity and delivery isolation,
old WhatsApp upsert compatibility, and channel-specific STOP handling. Unit tests
mock sends and calls. GitHub CI checks this branch on push.

API reference: https://docs.linqapp.com/channel/imessage/llms.txt


## Hosted verification record

- Runtime source deployed: `fc443f5`, merging main `c658630` and Codex `dd60d98`.
- [Combined CI](https://github.com/aiihaz/the-desk/actions/runs/41788303987) passed:
  378 function tests, 476 pgTAP assertions, independent-session database concurrency,
  3 local bench safety tests, endpoint authorization, formatting, lint, and type checks.
- Hosted rollback-only validation passed all 14 Linq recovery/reminder/erasure
  assertions and the main call-meaning checks before migration rollout.
- Hosted schema is `0022`; `follow-through` and reconciliation both completed.
  Legacy `dial` and `wa-send` endpoints now return authenticated 410 responses.
- The scheduled-worker Vault credential was aligned with the platform-injected
  Supabase secret key; legacy service-role JWTs do not match that key.
- Updating the optional GitHub daily monitor's repository secrets was denied by
  the GitHub integration (403: resource not accessible). Those repository secrets
  remain unchanged; an administrator must configure them with the current hosted
  project URL and matching Supabase secret key to qualify that backup monitor.
- Live Linq reply from the hosted model: delivered and read.
- Signed webhook probe: 200; unsigned webhook probe: 401.
- Reconciliation heartbeat is running; health reports `ok=true`, `kill_switch=true`,
  `calling.paused=true`, and `calling.test_recipient=+918848878757`.
- Sarvam version 4 returned all 26 caller-contract variable names in its saved
  history. That observation is not a fabricated passed gate in the new database.
- Simulated question suite with variables generated by the actual Desk call code:
  suite `01M6HF4B6MPFQZE2A1EMQ3AKJA`, run `01M6HF4FDSADTVJ99HAXMY4GFZ`, 1/1 passed.
  This uses virtual conversation, with no telephony configuration or destination.
- The older suite's question smoke failed because its saved variable mapping
  supplied only `user_name`, leaving the business name/task inputs blank. The
  runtime-input check above preserves the actual integration inputs and passed.
- No telephone calls have been placed by this deployment. No automatic unpause is
  scheduled. The final real-line caller test and full caller gate remain pending
  until the owner explicitly allows daytime testing.


## Native iMessage identity sharing

The Linq line `+16504440515` has an active name card for **The Desk**. Set
`LINQ_SHARE_CONTACT_CARD=1` after configuring the line's card in Linq. The sender
sends its text first, then shares the native identity card for iMessage chats.
It never sends a .vcf attachment or adds links/media to the opening reply.

Migration `0018_linq_contact_cards.sql` stores a claim per resolved Linq chat. An
atomic five-minute lease prevents concurrent replies from sharing twice. A
successful share has a rolling 24-hour cooldown; a failed lookup/share can retry
only after five minutes, and only after another outbound reply. New failover chats
have independent cooldowns. The sender checks that the selected sending line's
card is active and skips sharing for RCS/SMS, blocked/stopped users, and contacts
without an inbound message. A card failure never fails or resends the text.

Existing automatic Linq line selection stays in place. Normal turn debouncing and
one-nudge follow-through continue to govern the conversational flow; this feature
adds no broadcast job and no messages to non-responders.

Native contact-card deployment verified: active card **The Desk**, accepted share
in the owner's existing iMessage chat, and a recorded 24-hour cooldown. All 16
contact-card pgTAP checks also passed in a rolled-back test on the hosted database.
The purchased caller ID `+918064269395` is registered; calling remains paused.

## Shared upgraded agent

Both messaging adapters run `createAgentRuntime(channel)`: renewable fenced turns,
input-watermark consent checks, durable submission/settlement recovery, tracked
message ownership, evidence-backed memory corrections, and past-errand recall.
Reconciliation replays signed stored Linq envelopes and reconstructs normalized
Linq inbox messages through the Linq parser. Native contact-card sharing, threaded
replies, screenshot handling, and per-channel identities remain in place.

WhatsApp service-window expiry and closing-window nudges apply only to WhatsApp.
Linq keeps ordinary follow-ups and can recover inbox work after 24 hours. Erasure
removes Linq raw envelopes and contact-card state, then attempts its confirmation
through the original channel without recreating the profile.

When rotating the platform API key, update the `desk_service_key` Vault binding
and the GitHub daily monitor's `SUPABASE_SERVICE_ROLE_KEY` together. Internal
endpoints authorize the exact platform-injected service key; a legacy JWT with
the same role is not interchangeable. The scheduled worker has been updated;
repository-secret writes require additional GitHub permissions.
