import { deliver } from "../_shared/deliver.ts";
import { DbStore } from "../_shared/store.ts";
import { send, waConfigFromEnv } from "../_shared/whatsapp.ts";
import { handle } from "./handler.ts";

const store = new DbStore();
const wa = waConfigFromEnv();

Deno.serve((req) =>
  handle(req, {
    store,
    appSecret: Deno.env.get("WA_APP_SECRET") ?? "",
    verifyToken: Deno.env.get("WA_VERIFY_TOKEN") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    // E3: echo to prove the round trip. E4 replaces this with chat-agent.
    handOff: async (user, msg) => {
      if (Deno.env.get("DESK_ECHO") !== "1") return;
      await deliver(store, (to, m) => send(wa, to, m), user, {
        kind: "text",
        body: `The Desk got: ${msg.text ?? `(${msg.type})`}`,
      });
    },
  })
);
