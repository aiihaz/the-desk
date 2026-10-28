import { DbCallStore } from "../_shared/call_store.ts";
import { reportCall } from "../_shared/chat/report.ts";
import { DbChatStore } from "../_shared/chat/store.ts";
import { deliver } from "../_shared/deliver.ts";
import { DbStore } from "../_shared/store.ts";
import { send as waSend, waConfigFromEnv } from "../_shared/whatsapp.ts";
import { handle } from "./handler.ts";

const store = new DbCallStore();
const chat = new DbChatStore();
const wa = waConfigFromEnv();
const waStore = new DbStore();

Deno.serve((req) =>
  handle(req, {
    store,
    webhookToken: Deno.env.get("SARVAM_WEBHOOK_TOKEN") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    // Settle the request and tell the user what the call established (chat/report.ts).
    // Booking verification (eng plan 3.5) is still to come; a reported booking is stored
    // as probably_booked meanwhile.
    handOff: (callId, r) =>
      reportCall(
        {
          store: chat,
          send: (user, msg) => deliver(waStore, (to, m) => waSend(wa, to, m), user, msg),
        },
        callId,
        r,
      ),
  })
);
