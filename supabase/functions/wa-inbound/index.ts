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
import { dial } from "../_shared/dial.ts";
import { jevClient } from "../_shared/jev.ts";
import { responsesClient } from "../_shared/openai.ts";
import { placesClient, type SearchPlaces } from "../_shared/places.ts";
import { sarvamConfigFromEnv, startCall } from "../_shared/sarvam.ts";
import { DbStore, type User } from "../_shared/store.ts";
import { type Outbound, send as waSend, waConfigFromEnv } from "../_shared/whatsapp.ts";
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
const onApproved: LunaDeps["onApproved"] = (user, consent) =>
  callAfterConsent(
    { store: chat, send, dial: (a) => dial({ store: calls, start: (c) => startCall(sarvam, c) }, a) },
    user,
    consent,
  );

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
  // The screenshot check is E7 (eng plan 2.2). No booking holds a deposit before then.
  onPayment: async (_user, route) => console.warn("payment check is E7; nothing done", route.kind),
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
