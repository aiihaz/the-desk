# Local chat and phone testing

The browser bench runs the Desk's existing agent, database state machine, consent,
report verification, memory and follow-through. WhatsApp transport is replaced by
browser messages. The production WhatsApp handlers and product scope are unchanged.

## Run

Install Docker, Supabase CLI 3.0.0 and Deno 2.9.6. From the repository:

```sh
supabase start --agent no
# Copy supabase/functions/.env.example to supabase/functions/.env if it does not exist.
# Add OPENAI_API_KEY (or DESK_OPENAI_API_KEY) in that ignored file.
deno task dev
```

Open the local server at port 8787 on your own machine. It binds to loopback and
rejects foreign origins. No frontend build, account or additional service is needed.
For a smaller stack, exclude unused services:

```sh
supabase start --agent no --exclude studio,imgproxy,mailpit,storage-api,realtime,edge-runtime,logflare,vector,supavisor,postgres-meta
```

Send a message to open the same 24-hour service window the product uses. Chat
naturally, or use **Table for two** / **Ask closing time** to prepare a plan through
the real tools. The buttons populate test details; inspect the read-back before
approving. Natural chat and independent approval/report checks require the model
key. With no key, the interface explains the missing setup; it never fabricates an
agent response, consent, booking or phone call.

In the default simulation mode, approve the calling plan in chat and then play a
booked result or alternatives from the workflow panel. Results go through the real
settlement and report path. **Run follow-through** exercises owed deliveries and
unfinished work. Memories and previous errands appear alongside the conversation.
Attach a JPG, PNG or WebP for the existing payment screenshot workflow. The
workflow inspector exposes trace data, model/tool decisions and stored state;
trace downloads can contain personal conversation content.

## Receive a test call

Keep these values in the ignored `supabase/functions/.env`:

```dotenv
DEV_REAL_CALLS=1
DEV_TEST_PHONE=+<your already-consenting test-business number>
SARVAM_API_KEY=<secret>
SARVAM_ORG_ID=<organization>
SARVAM_WORKSPACE_ID=<workspace>
SARVAM_APP_ID=<app>
SARVAM_CONNECTION_ID=<telephony connection>
SARVAM_WEBHOOK_TOKEN=<secret>
SARVAM_WEBHOOK_URL=https://<public endpoint>/functions/v1/sarvam-webhook
```

Restart the bench. Select **Consenting test line**, prepare a plan and approve it
in chat. This calls the phone as the business receiving the errand. The number is
server configuration, never an arbitrary browser parameter. Other destinations
are refused both before reservation and immediately before provider submission.
Simulation controls are unavailable in real phone mode.

Use a dedicated local/test database. The Sarvam caller version, contract evidence,
caller number, credit and test-number allowlist must be configured using the
existing process in [agent/README.md](../agent/README.md) and the project README.
The bench does not invent passing caller-contract evidence or disable call limits,
calling hours, approval watermarks, lease fencing or submission-uncertainty checks.
“Configured” means values are present, not that provider access has been verified.

The public webhook must write to the same database as this bench, usually through
a tunnel to a locally served Supabase function. A callback to a different deployed
project cannot settle local rows. Keep the browser server on loopback; expose only
the token-protected Sarvam function if using a tunnel. Local mode additionally
polls Sarvam analytics every 15 seconds while a call is active. **Refresh phone
result** retries result recovery and pending settlement without placing a call.
Provider-unknown submissions are never automatically dialed again. A real call
without a recorded result blocks resetting the local user.

Provider keys were supplied later in the session and stored only in the ignored
local file. Live model and phone validation still require the cloud provider
network settings to be activated; Sarvam IDs, callback routing and caller-contract
configuration must also be completed.

## Checks

```sh
deno task check
deno task test:bench
deno task test
# Once an agent key is configured and the bench is running:
deno task eval
```

The interface follows the installed Stageshow messages example's blue/gray bubble
hierarchy, system typography, composer proportions and restrained motion. It is a
functional app, so controls, content and states are real rather than an animated
marketing mockup. Reduced motion and narrow phone layouts are supported.
