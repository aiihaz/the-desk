// Sarvam result webhook: check the token, store the raw event, close the call row,
// hand off, return 200 fast (eng plan 3.1). E6 fills in the hand-off: map the outputs,
// verify any booking, save options and send the next message.
import type { CallStore } from "../_shared/call_store.ts";
import { type CallResult, parseWebhook, verifyWebhookToken } from "../_shared/sarvam.ts";

export type Deps = {
  store: CallStore;
  webhookToken: string;
  // Runs after the response is sent (EdgeRuntime.waitUntil in production).
  background: (p: Promise<unknown>) => void;
  handOff: (callId: string, result: CallResult) => Promise<void>;
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!verifyWebhookToken(new URL(req.url), deps.webhookToken)) {
    return new Response("bad token", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const result = parseWebhook(payload);
  if (!result) return new Response("not an outbound result", { status: 400 });

  // A redelivery still runs finishCall (it is a no-op on a closed call), so a
  // database error on the first delivery heals on the retry.
  await deps.store.saveEvent(result.attemptId, payload);
  const callId = await deps.store.finishCall(result);
  if (!callId) {
    // Already closed, or a call started outside the Desk (eng plan 5.4). The raw
    // event is stored either way.
    if (!result.callId) console.warn("sarvam result for unknown call", result.attemptId);
    return new Response("ok");
  }

  deps.background(
    deps.handOff(callId, result).catch((e) => console.error("handoff failed", callId, e)),
  );
  return new Response("ok");
}
