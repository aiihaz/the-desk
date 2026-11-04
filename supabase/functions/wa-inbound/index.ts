import { createAgentRuntime } from "../_shared/agent_runtime.ts";
import { handle } from "./handler.ts";
const runtime = createAgentRuntime();
Deno.serve((req) =>
  handle(req, {
    store: runtime.store,
    handOff: runtime.handOff,
    appSecret: Deno.env.get("WA_APP_SECRET") ?? "",
    verifyToken: Deno.env.get("WA_VERIFY_TOKEN") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
  })
);
