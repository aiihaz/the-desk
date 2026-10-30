// Reconcile (eng plan 3.1, 7): every 15 minutes, look up calls that have had no result
// for reconcile_after_minutes in Sarvam Analytics. A finished attempt goes through the
// same path as its webhook would have (store, close, report). A call still without a
// result after reconcile_give_up_minutes is closed as timeout, flagged, and the user is
// told to check with the business. Nothing is ever redialled from here.
import type { Attempt, CallResult } from "./sarvam.ts";
import { attemptResult } from "./sarvam.ts";

export type OpenCall = { id: string; attemptId: string | null; createdAt: Date };

export type ReconcileDeps = {
  // Calls still queued, dialing or in progress, created before the cutoff.
  openCalls(before: Date): Promise<OpenCall[]>;
  limitInt(key: string): Promise<number | null>;
  listAttempts(from: Date, to: Date): Promise<Attempt[]>;
  transcript(interactionId: string): Promise<CallResult["transcript"]>;
  // As the webhook: store the raw attempt, close the call, hand off to the report.
  finish(result: CallResult, raw: unknown): Promise<void>;
  // timeout_call(): false if the call got a result meanwhile.
  timeoutCall(callId: string): Promise<boolean>;
  // Tells the user there is no result (report.ts, failureReason no_result).
  reportLost(callId: string): Promise<void>;
  now(): Date;
  trace?: (event: string, data: unknown) => void;
};

export type ReconcileSummary = { checked: number; found: number; timed_out: number; waiting: number };

const MIN = 60_000;

export async function reconcile(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const now = deps.now();
  const after = (await deps.limitInt("reconcile_after_minutes")) ?? 15;
  const giveUp = (await deps.limitInt("reconcile_give_up_minutes")) ?? 120;
  const calls = await deps.openCalls(new Date(now.getTime() - after * MIN));
  const sum: ReconcileSummary = { checked: calls.length, found: 0, timed_out: 0, waiting: 0 };
  if (!calls.length) return sum;

  // One listing covers every open call: from a little before the oldest to now.
  const oldest = Math.min(...calls.map((c) => c.createdAt.getTime()));
  let attempts: Map<string, Attempt> = new Map();
  try {
    const list = await deps.listAttempts(new Date(oldest - 5 * MIN), now);
    attempts = new Map(list.map((a) => [a.attempt_id, a]));
  } catch (e) {
    // Analytics down: nothing is closed on a guess; timeouts still apply below.
    deps.trace?.("reconcile_list_failed", String((e as Error)?.message ?? e));
  }

  for (const c of calls) {
    const a = c.attemptId ? attempts.get(c.attemptId) : undefined;
    if (a) {
      let transcript: CallResult["transcript"] = null;
      if (a.interaction_id && a.connectivity_status === "connected") {
        try {
          transcript = await deps.transcript(a.interaction_id);
        } catch (e) {
          // Without a transcript a booking can't verify; it's reported as probably booked.
          deps.trace?.("reconcile_transcript_failed", {
            call: c.id,
            error: String((e as Error)?.message ?? e),
          });
        }
      }
      const result = attemptResult(a, c.id, transcript);
      if (result) {
        await deps.finish(result, { reconciled: true, attempt: a });
        sum.found++;
        continue;
      }
    }
    if (now.getTime() - c.createdAt.getTime() >= giveUp * MIN) {
      if (await deps.timeoutCall(c.id)) {
        await deps.reportLost(c.id);
        sum.timed_out++;
      }
      continue;
    }
    sum.waiting++;
  }
  deps.trace?.("reconcile", sum);
  return sum;
}
