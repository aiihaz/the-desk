// After a stored consent: start the call it allows, through dial() (eng plan 5.4).
// If the call can't start, the request ends (call_not_started) and the user hears why
// in plain words, so nothing waits in calling_1 for a call that isn't coming.
// The call's result and the report to the user come with E6 (sarvam-webhook hand-off).
import type { DialArgs, DialResult } from "../dial.ts";
import type { User } from "../store.ts";
import type { ConsentStored } from "./store.ts";
import type { PromptDeps } from "./turn.ts";

export type CallDeps = PromptDeps & {
  dial: (a: DialArgs) => Promise<DialResult>;
  trace?: (event: string, data: unknown) => void;
};

// check_dial() reasons a user can act on. Anything else is on the Desk's side.
const WHY: Record<string, string> = {
  business_closed: "They're closed right now; try again when they're open.",
  outside_calling_window: "It's outside calling hours; try again later.",
  provider_blocked_hours: "It's outside calling hours; try again later.",
  too_late: "The time you asked for has already passed.",
  opted_out: "This business has asked not to be called.",
  user_block: "You've blocked this business.",
  user_stopped: "You've stopped me; reply START first.",
  limit_user_day: "You've reached today's call limit; try again tomorrow.",
  limit_business_day: "They've had too many calls today; try again tomorrow.",
  limit_business_number_day: "They've had too many calls today; try again tomorrow.",
  limit_request: "This request has used all its calls.",
  limit_availability_calls: "This request has used all its calls.",
  limit_booking_calls: "This request has used all its calls.",
};
const OUR_SIDE = "Calls aren't working on my side right now; please try again later.";

export async function callAfterConsent(deps: CallDeps, user: User, c: ConsentStored): Promise<void> {
  const r = await deps.store.request(c.request_id);
  const args: DialArgs = {
    requestId: c.request_id,
    kind: c.kind === "book" ? "booking" : r.task === "question" ? "question" : "first",
    optionId: c.option_id,
    isRetry: false,
  };
  const res = await deps.dial(args);
  deps.trace?.("dial", { args, res });
  if (res.ok) return;

  console.warn("call not started", c.request_id, res.error === "refused" ? res.reason : res.detail);
  const ended = await deps.store.callNotStarted(c.request_id);
  deps.trace?.("call_not_started", ended);
  const why = res.error === "refused" ? WHY[res.reason] ?? OUR_SIDE : OUR_SIDE;
  const { language } = await deps.store.user(user.id);
  const tpl = await deps.store.template("call_not_started", language);
  await deps.send(user, {
    kind: "text",
    body: (tpl ?? "I couldn't start the call. {reason}").replace("{reason}", why),
  });
}
