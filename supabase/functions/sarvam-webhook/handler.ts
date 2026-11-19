// Sarvam result webhook: check the token, store the raw event, close the call row,
// hand off, return 200 fast (eng plan 3.1). The hand-off (chat/report.ts) maps the
// outputs, verifies any booking, saves options and sends the next message.
import type { CallStore } from "../_shared/call_store.ts";
import { type CallResult, parseWebhook, verifyWebhookToken } from "../_shared/sarvam.ts";

export type Deps = {
  store: CallStore;
  webhookToken: string;
  // Runs after the response is sent (EdgeRuntime.waitUntil in production).
  background: (p: Promise<unknown>) => void;
  handOff: (callId: string, result: CallResult) => Promise<void>;
  // Archives the call's recording to private storage (0031). Wired only when the
  // deployment supports it; the handler calls it only when comparison_mode is on.
  // A failure here must never fail the hand-off or the webhook response.
  archiveAudio?: (callId: string, interactionId: string) => Promise<void>;
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
    (async () => {
      await deps.handOff(callId, result).catch((e) => console.error("handoff failed", callId, e));
      // Audio archive runs after the hand-off, only under the comparison switch, and
      // only for calls that produced a recording. Errors are logged, never thrown.
      if (deps.archiveAudio && result.interactionId) {
        try {
          if (await deps.store.comparisonMode(callId)) {
            await deps.archiveAudio(callId, result.interactionId);
          }
        } catch (e) {
          console.error("audio archive failed", callId, e);
        }
      }
    })(),
  );
  return new Response("ok");
}
