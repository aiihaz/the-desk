import { DbCallStore } from "../_shared/call_store.ts";
import { reportCall } from "../_shared/chat/report.ts";
import { DbChatStore } from "../_shared/chat/store.ts";
import { verifier } from "../_shared/chat/verify.ts";
import { deliver } from "../_shared/deliver.ts";
import { responsesClient } from "../_shared/openai.ts";
import { DbStore } from "../_shared/store.ts";
import { send as waSend, waConfigFromEnv } from "../_shared/whatsapp.ts";
import { handle } from "./handler.ts";

const store = new DbCallStore();
const chat = new DbChatStore();
const wa = waConfigFromEnv();
const waStore = new DbStore();
const verify = verifier(chat, responsesClient(Deno.env.get("OPENAI_API_KEY") ?? ""));

Deno.serve((req) =>
  handle(req, {
    store,
    webhookToken: Deno.env.get("SARVAM_WEBHOOK_TOKEN") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    // Verify any booking, settle the request and tell the user what the call
    // established (chat/report.ts, chat/verify.ts).
    handOff: (callId, r) =>
      reportCall(
        {
          store: chat,
          verify,
          send: (user, msg) => deliver(waStore, (to, m) => waSend(wa, to, m), user, msg),
        },
        callId,
        r,
      ),
  })
);
