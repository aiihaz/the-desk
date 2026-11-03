// Linq webhook into the same booking agent and consent gates as WhatsApp.
import { DbCallStore } from "../_shared/call_store.ts";
import { callAfterConsent } from "../_shared/chat/calls.ts";
import { DbAdminStore } from "../_shared/chat/admin.ts";
import { runCommand } from "../_shared/chat/commands.ts";
import { type AgentDeps, handleInbound } from "../_shared/chat/agent.ts";
import { type LunaDeps, runLuna } from "../_shared/chat/luna.ts";
import { DbChatStore } from "../_shared/chat/store.ts";
import { createDelivery } from "../_shared/messaging.ts";
import { downloadLinqImage } from "../_shared/linq.ts";
import { dial, type DialArgs } from "../_shared/dial.ts";
import { handleScreenshot } from "../_shared/chat/payment.ts";
import { jevClient } from "../_shared/jev.ts";
import { responsesClient } from "../_shared/openai.ts";
import { placesClient, type SearchPlaces } from "../_shared/places.ts";
import { serperClient, withWebPhones } from "../_shared/serper.ts";
import { sarvamConfigFromEnv, startCall } from "../_shared/sarvam.ts";
import { DbStore } from "../_shared/store.ts";

import { handle } from "./handler.ts";

const store = new DbStore(undefined, "linq");
const chat = new DbChatStore();
const calls = new DbCallStore();
const sarvam = sarvamConfigFromEnv();
const env = (k: string) => Deno.env.get(k) ?? "";

const send = createDelivery(store);

// Google Places, then a web lookup for places listed with no phone (eng plan 3.3).
const places: SearchPlaces = env("GOOGLE_MAPS_API_KEY")
  ? placesClient(env("GOOGLE_MAPS_API_KEY"))
  : () => Promise.reject(new Error("GOOGLE_MAPS_API_KEY is not set"));
const searchPlaces: SearchPlaces = env("SERPER_API_KEY")
  ? withWebPhones(places, serperClient(env("SERPER_API_KEY")))
  : places;

// After an approval: reserve_call() and Sarvam, through dial().
const dialer = (a: DialArgs) => dial({ store: calls, start: (c) => startCall(sarvam, c) }, a);
const onApproved: LunaDeps["onApproved"] = (user, consent) =>
  callAfterConsent(
    { store: chat, send, dial: dialer, create: responsesClient(env("OPENAI_API_KEY")) },
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
const adminStore = new DbAdminStore(undefined, "linq");
const admins = new Set(env("DESK_ADMIN_LINQ_IDS").split(",").map((s) => s.trim()).filter(Boolean));

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
  onPayment: (user, _route, msg) =>
    handleScreenshot(
      {
        store: chat,
        send,
        dial: dialer,
        create: responsesClient(env("OPENAI_API_KEY")),
        image: downloadLinqImage,
        notAPayment: async (u) => {
          if (luna) await runLuna(luna, u, msg.at, msg.messageId);
        },
      },
      user,
      msg.raw,
      msg.messageId,
    ),
};

Deno.serve((req) =>
  handle(req, {
    store,
    secret: env("LINQ_WEBHOOK_SECRET"),
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    handOff: async (user, msg) => {
      if (env("DESK_LINQ_ECHO") !== "1") return handleInbound(user, msg, agent);
      await send(user, { kind: "text", body: `The Desk got: ${msg.text ?? `(${msg.type})`}` });
    },
  })
);
