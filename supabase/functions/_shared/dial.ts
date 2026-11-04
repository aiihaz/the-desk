// Starting a call (eng plan 5.4): reserve_call() runs every check in 5.1 and inserts
// the call row; only then is Sarvam called. The voice agent's variables are built here
// from the stored, consented fields (call_vars.ts), never taken from the caller. The
// dial function and the chat agent's consent hand-off both start calls through here.
import type { CallStore } from "./call_store.ts";
import { callVariables } from "./call_vars.ts";
import type { CallKind, Language, StartCall } from "./sarvam.ts";
import { CallRejected } from "./sarvam.ts";

export type DialDeps = {
  store: CallStore;
  start: (call: StartCall) => Promise<string>;
};

export type DialArgs = {
  requestId: string;
  kind: CallKind;
  optionId: string | null;
  isRetry: boolean;
  language?: Language;
};

export type DialResult =
  | { ok: true; call_id: string; attempt_id: string; flags: string[] }
  | { ok: false; error: "refused"; reason: string }
  | { ok: false; error: "dial_failed" | "submission_unknown"; call_id: string; detail: string };

export async function dial(deps: DialDeps, a: DialArgs): Promise<DialResult> {
  const r = await deps.store.reserveCall(a.requestId, a.kind, a.optionId, a.isRetry);
  if (!r.ok) return { ok: false, error: "refused", reason: r.reason };

  let call: StartCall;
  try {
    // No proof, no call: reserve_call names the consent this call rests on.
    if (!r.consent_id) throw new Error("no consent behind this call");
    // A missing input fails here, after the reservation, so the attempt still counts.
    const variables = callVariables(a.kind, await deps.store.callInputs(r.call_id), r.must_reask);
    const target = await deps.store.dialTarget(r.call_id);
    call = {
      callId: r.call_id,
      kind: a.kind,
      agentVersion: r.agent_version,
      callerNumber: target.callerNumber,
      businessPhone: target.businessPhone,
      variables,
      language: a.language,
    };
  } catch (e) {
    // The row stays, marked failed, so the attempt counts against the limits.
    await deps.store.markFailed(r.call_id, String(e)).catch((e2) => console.error("markFailed", e2));
    return { ok: false, error: "dial_failed", call_id: r.call_id, detail: String(e) };
  }
  let attemptId: string | undefined;
  try {
    await deps.store.beginSubmission(r.call_id);
    attemptId = await deps.start(call);
    await deps.store.markDialing(r.call_id, attemptId);
    return { ok: true, call_id: r.call_id, attempt_id: attemptId, flags: r.flags };
  } catch (e) {
    if (e instanceof CallRejected) {
      await deps.store.markFailed(r.call_id, String(e));
      return { ok: false, error: "dial_failed", call_id: r.call_id, detail: String(e) };
    }
    // An external side effect cannot be rolled back by a failed local write.
    // Leave it open for the webhook/reconciler; never automatically resubmit it.
    await deps.store.markUnknown(r.call_id, String(e), attemptId).catch(() => {
      console.error("could not persist uncertain submission", r.call_id);
    });
    return {
      ok: false,
      error: "submission_unknown",
      call_id: r.call_id,
      detail: "provider submission could not be confirmed",
    };
  }
}
