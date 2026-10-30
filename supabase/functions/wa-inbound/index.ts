// Production: Meta's webhook into the chat agent, the same code the dev bench runs
// (chat/agent.ts). DESK_ECHO=1 swaps the agent for an echo, for the WhatsApp round-trip test.
import { DbCallStore } from "../_shared/call_store.ts";
import { callAfterConsent } from "../_shared/chat/calls.ts";
import { DbAdminStore } from "../_shared/chat/admin.ts";
import { runCommand } from "../_shared/chat/commands.ts";
import { type AgentDeps, handleInbound } from "../_shared/chat/agent.ts";
import { type LunaDeps, runLuna } from "../_shared/chat/luna.ts";
import { DbChatStore } from "../_shared/chat/store.ts";
import { deliver } from "../_shared/deliver.ts";
import { dial, type DialArgs } from "../_shared/dial.ts";
import { handleScreenshot } from "../_shared/chat/payment.ts";
import { jevClient } from "../_shared/jev.ts";
import { responsesClient } from "../_shared/openai.ts";
import { placesClient, type SearchPlaces } from "../_shared/places.ts";
import { sarvamConfigFromEnv, startCall } from "../_shared/sarvam.ts";
import { DbStore, type User } from "../_shared/store.ts";
import {
  downloadMedia,
  imageId,
  type Outbound,
  send as waSend,
  waConfigFromEnv,
} from "../_shared/whatsapp.ts";
import { handle } from "./handler.ts";

const store = new DbStore();
const chat = new DbChatStore();
const calls = new DbCallStore();
const wa = waConfigFromEnv();
const sarvam = sarvamConfigFromEnv();
const env = (k: string) => Deno.env.get(k) ?? "";

const send = (user: User, msg: Outbound) => deliver(store, (to, m) => waSend(wa, to, m), user, msg);

const searchPlaces: SearchPlaces = env("GOOGLE_MAPS_API_KEY")
  ? placesClient(env("GOOGLE_MAPS_API_KEY"))
  : () => Promise.reject(new Error("GOOGLE_MAPS_API_KEY is not set"));

// After an approval: reserve_call() and Sarvam, through dial().
const dialer = (a: DialArgs) => dial({ store: calls, start: (c) => startCall(sarvam, c) }, a);
const onApproved: LunaDeps["onApproved"] = (user, consent) =>
  callAfterConsent({ store: chat, send, dial: dialer }, user, consent);

const luna: LunaDeps | null = env("OPENAI_API_KEY")
  ? {
    store: chat,
    send,
    create: responsesClient(env("OPENAI_API_KEY")),
    jev: env("TYPESAFE_API_KEY") ? jevClient(env("TYPESAFE_API_KEY")) : undefined,
    searchPlaces,
    onApproved,
  }
  : null;

// Comma-separated wa_ids (no +), allowed the admin commands (chat/admin.ts).
const adminStore = new DbAdminStore();
const admins = new Set(env("DESK_ADMIN_WA_IDS").split(",").map((s) => s.trim()).filter(Boolean));

const agent: AgentDeps = {
  store: chat,
  send,
  isAdmin: (waId) => admins.has(waId),
  luna: async (user, _text, msg) => {
    if (luna) return runLuna(luna, user, msg.at, msg.messageId);
    // Misconfigured: say something rather than leave the user in silence.
    console.error("OPENAI_API_KEY is not set");
    const tpl = await chat.template("fallback_generic", (await chat.user(user.id)).language);
    if (tpl) await send(user, { kind: "text", body: tpl });
  },
  onCommand: (user, route) => runCommand({ store: chat, send, admin: adminStore }, user, route),
  // The payment screenshot check (eng plan 2.2), then the confirm call.
  onPayment: (user, route, msg) =>
    handleScreenshot(
      {
        store: chat,
        send,
        dial: dialer,
        create: responsesClient(env("OPENAI_API_KEY")),
        image: async (raw) => {
          const id = imageId(raw);
          return id ? await downloadMedia(wa, id) : null;
        },
      },
      user,
      msg.raw,
      route.typed,
    ),
};

Deno.serve((req) =>
  handle(req, {
    store,
    appSecret: env("WA_APP_SECRET"),
    verifyToken: env("WA_VERIFY_TOKEN"),
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    handOff: async (user, msg) => {
      if (env("DESK_ECHO") !== "1") return handleInbound(user, msg, agent);
      await send(user, { kind: "text", body: `The Desk got: ${msg.text ?? `(${msg.type})`}` });
    },
  })
);
