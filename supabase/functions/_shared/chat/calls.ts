// After a stored consent: start the call it allows, through dial() (eng plan 5.4).
// If the call can't start, the request ends (call_not_started) and the user is told why,
// so nothing waits in calling_1 for a call that isn't coming.
// The result comes back through sarvam-webhook to report.ts.
import type { DialArgs, DialResult } from "../dial.ts";
import type { User } from "../store.ts";
import type { CallKind } from "../sarvam.ts";
import { tell } from "./followup.ts";
import type { Task } from "./states.ts";
import type { ConsentStored } from "./store.ts";
import type { TellDeps } from "./tell.ts";

export type CallDeps = TellDeps & { dial: (a: DialArgs) => Promise<DialResult> };

// check_dial() reasons a user can act on, as facts. Anything else is on the Desk's side.
const WHY: Record<string, string> = {
  business_closed: "the business is closed right now; they can try when it's open",
  outside_calling_window: "it's outside calling hours; they can try later",
  provider_blocked_hours: "it's outside calling hours; they can try later",
  too_late: "the time they asked for has already passed",
  opted_out: "this business has asked not to be called",
  user_block: "they blocked this business",
  user_stopped: "they stopped the Desk; they need to reply START first",
  limit_user_day: "they've reached today's call limit; they can try tomorrow",
  limit_business_day: "this business has had too many calls today; they can try tomorrow",
  limit_business_number_day: "this business has had too many calls today; they can try tomorrow",
  limit_request: "this errand has used all its calls",
  limit_availability_calls: "this errand has used all its calls",
  limit_booking_calls: "this errand has used all its calls",
  limit_retries: "the Desk already tried them again with no answer; they could call themselves",
  retry_too_soon: "the Desk only just tried them; they can ask again in a few minutes",
};
const OUR_SIDE = "calls aren't working on the Desk's side right now; they can try again later";

// The call a consent allows: the pick books (or, for a reschedule, moves to) one option;
// the screenshot allows the confirm call; a plan's YES allows the task's call.
export function callKind(consent: ConsentStored["kind"], task: Task): CallKind {
  if (consent === "pay") return "payment_confirm";
  if (consent === "book") return task === "reschedule" ? "reschedule" : "booking";
  switch (task) {
    case "question":
      return "question";
    case "reschedule":
      return "reschedule";
    case "cancel":
      return "cancel";
    default:
      return "first";
  }
}

// started: the call is dialing. false: the request has ended and the user has been told why.
export async function callAfterConsent(
  deps: CallDeps,
  user: User,
  c: ConsentStored,
): Promise<{ started: boolean }> {
  const r = await deps.store.request(c.request_id);
  const kind = callKind(c.kind, r.task);
  // Calling again after no answer or busy is a retry: it counts against
  // max_retries_no_answer and waits retry_delay_minutes, not against the request's calls.
  const last = await deps.store.lastCall(c.request_id);
  const args: DialArgs = {
    requestId: c.request_id,
    kind,
    optionId: c.option_id,
    isRetry: !!last && last.kind === kind && (last.status === "no_answer" || last.status === "busy"),
  };
  const res = await deps.dial(args);
  deps.trace?.("dial", { args, res });
  if (res.ok) return { started: true };

  if (res.error === "refused" && res.reason === "new_inbound") {
    await deps.store.deferChangedConsent?.(c.request_id);
    return { started: false };
  }
  if (res.error === "refused" && res.reason === "consent_spent") return { started: false };
  console.warn("call not started", c.request_id, res.error === "refused" ? res.reason : res.detail);
  const ended = res.error === "submission_unknown" ? null : await deps.store.callNotStarted(c.request_id);
  deps.trace?.("call_not_started", ended);
  if (res.error === "refused" && res.reason.startsWith("caller_contract_")) {
    await deps.store.raiseAlert(res.reason, c.request_id, null, { kind });
  }
  await tell(deps, user, c.request_id, `dial:${c.consent_id}`, {
    event: "call_not_started",
    happened: {
      status: res.error === "submission_unknown"
        ? "call_submission_uncertain_may_have_started_do_not_retry"
        : "the_call_did_not_start_nothing_done",
      why: res.error === "refused" ? WHY[res.reason] ?? OUR_SIDE : OUR_SIDE,
    },
    values: {},
    next_step: res.error === "submission_unknown" ? "check_with_business_themselves" : null,
  });
  return { started: false };
}
