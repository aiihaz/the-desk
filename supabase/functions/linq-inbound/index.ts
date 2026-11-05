import { createAgentRuntime } from "../_shared/agent_runtime.ts";
import { handle } from "./handler.ts";

const runtime = createAgentRuntime("linq");
Deno.serve((req) =>
  handle(req, {
    store: runtime.store,
    secret: Deno.env.get("LINQ_WEBHOOK_SECRET") ?? "",
    // deno-lint-ignore no-explicit-any
    background: (p) => (globalThis as any).EdgeRuntime?.waitUntil(p) ?? p,
    handOff: runtime.handOff,
    markRead: runtime.markRead,
  })
);
