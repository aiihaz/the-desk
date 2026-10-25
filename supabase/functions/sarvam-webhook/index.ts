import { DbCallStore } from "../_shared/call_store.ts";
import { handle } from "./handler.ts";

const store = new DbCallStore();

Deno.serve((req) =>
  handle(req, {
    store,
    webhookToken: Deno.env.get("SARVAM_WEBHOOK_TOKEN") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    // E6 replaces this with mapping, verification and the next WhatsApp message.
    handOff: async (callId, r) => {
      console.log("call finished", callId, r.status, r.outputs?.outcome ?? null);
    },
  })
);
