// verify_jwt is on, so only callers holding the service role key get here.
import { DbCallStore } from "../_shared/call_store.ts";
import { sarvamConfigFromEnv, startCall } from "../_shared/sarvam.ts";
import { handle } from "./handler.ts";

const store = new DbCallStore();
const cfg = sarvamConfigFromEnv();

Deno.serve((req) => handle(req, { store, start: (call) => startCall(cfg, call) }));
