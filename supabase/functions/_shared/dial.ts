// Starting a call (eng plan 5.4): reserve_call() runs every check in 5.1 and inserts
// the call row; only then is Sarvam called. The voice agent's variables are built here
// from the stored, consented fields (call_vars.ts), never taken from the caller. The
// dial function and the chat agent's consent hand-off both start calls through here.
import { isTurnInvalidated } from "./chat/turn_control.ts";
import type { CallStore } from "./call_store.ts";
import { openingLanguage } from "./call_language.ts";
import { callVariables } from "./call_vars.ts";
import type { CallKind, Language, StartCall } from "./sarvam.ts";
import { CallRejected } from "./sarvam.ts";

export type DialDeps = {
  store: CallStore;
  start: (call: StartCall) => Promise<string>;
  beforeStart?: () => Promise<void>;
  // Cleanup of this reserved call after proven non-submission must survive a lost turn.
  markNotSubmitted?: (callId: string, reason: string) => Promise<void>;
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

// A dial inside a chat turn. The turn is checked before the reservation and again before
// Sarvam. A turn lost anywhere here started no call, so the request is put back where it
// can be decided again (release, outside the turn's fence) instead of waiting in calling_1.
export async function dialForTurn(
  deps: Omit<DialDeps, "beforeStart"> & { assertTurn: () => Promise<void>; release: () => Promise<unknown> },
  a: DialArgs,
): Promise<DialResult> {
  try {
    await deps.assertTurn();
    return await dial({ ...deps, beforeStart: deps.assertTurn }, a);
  } catch (e) {
    if (isTurnInvalidated(e)) {
      await deps.release().catch(() =>
        console.error("could not release request after a lost turn", a.requestId)
      );
    }
    throw e;
  }
}

export async function dial(deps: DialDeps, a: DialArgs): Promise<DialResult> {
  const r = await deps.store.reserveCall(a.requestId, a.kind, a.optionId, a.isRetry);
  if (!r.ok) return { ok: false, error: "refused", reason: r.reason };

  const notSubmitted = async (error: unknown) => {
    const mark = deps.markNotSubmitted ?? ((id: string, reason: string) => deps.store.markFailed(id, reason));
    await mark(r.call_id, String(error)).catch(() =>
      console.error("could not persist non-submission", r.call_id)
    );
  };
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
      // An explicit language (the dial function's body) wins over where the business is.
      language: a.language ?? openingLanguage(target.city, target.state),
    };
  } catch (e) {
    // The row stays, marked failed, so the attempt counts against the limits.
    await notSubmitted(e);
    if (isTurnInvalidated(e)) throw e;
    return { ok: false, error: "dial_failed", call_id: r.call_id, detail: String(e) };
  }
  let attemptId: string | undefined;
  let transportStarted = false;
  try {
    await deps.store.beginSubmission(r.call_id);
    await deps.beforeStart?.();
    transportStarted = true;
    attemptId = await deps.start(call);
    await deps.store.markDialing(r.call_id, attemptId);
    return { ok: true, call_id: r.call_id, attempt_id: attemptId, flags: r.flags };
  } catch (e) {
    if (!transportStarted || e instanceof CallRejected) {
      await notSubmitted(e);
      if (isTurnInvalidated(e)) throw e;
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
