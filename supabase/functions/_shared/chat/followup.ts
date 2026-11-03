// Follow-through: what the Desk owes a user outside a turn. Call reports, reminders the
// user asked for, one nudge on an unanswered plan, a payment deadline coming up or gone
// by, and word that an errand expired. Everything goes through deliveries (0012, 0015): the
// facts are stored first, then written (tell.ts), then sent, so a failed write or send is
// retried and a crash loses nothing. The report path drains its own call at once; reconcile
// runs runFollowThrough every 5 minutes as the recovery pass, and the bench runs the same code.
import { OutsideServiceWindow } from "../deliver.ts";
import type { User } from "../store.ts";
import { fmtFull } from "./readback.ts";
import type { State, Task } from "./states.ts";
import type { ChatStore } from "./store.ts";
import { type Facts, type NextStep, type TellDeps, writeOwed } from "./tell.ts";

export type FollowUpDeps = TellDeps;

export type DueFollowUp = {
  requestId: string;
  userId: string;
  reason: "reminder" | "nudge" | "payment" | "deadline" | "expired" | "window";
  task: Task;
  state: State;
  // Identifies this occurrence, so a job that runs twice can't queue it twice.
  stamp: number;
  fields: { party_size?: number; service?: string };
  waitingFor: string | null;
  endReason: string | null;
  place: string | null;
  amountRs: number | null;
  deadline: Date | null;
  terms?: Record<string, unknown> | null;
};

export type Delivery = {
  id: string;
  userId: string;
  waId: string;
  message: Parameters<TellDeps["send"]>[1];
  attempts: number;
  kind: string;
};

export type DrainSummary = { sent: number; retrying: number; failed: number };

// What they can do about this errand now.
function nextStep(d: DueFollowUp): NextStep | null {
  switch (d.state) {
    case "awaiting_yes":
    case "awaiting_pick":
    case "stale_options":
      return "answer_the_open_plan";
    case "awaiting_payment":
      return d.reason === "deadline" ? "check_with_business_or_drop" : "send_payment_screenshot";
    default:
      return null;
  }
}

export function followUpFacts(d: DueFollowUp): Facts {
  const errand = {
    task: d.task,
    state: d.state,
    party_size: d.fields.party_size,
    service: d.fields.service,
  };
  const values: Record<string, string> = {};
  if (d.amountRs) values.advance = `Rs ${d.amountRs}`;
  if (d.deadline) values.deadline = fmtFull(d.deadline);
  const happened = (() => {
    switch (d.reason) {
      case "reminder":
        return { status: "reminder_they_asked_for", waiting_for: d.waitingFor };
      case "window":
        return {
          status: "unfinished_errand_service_window_closing",
          waiting_for: d.waitingFor,
          note:
            "give a useful status; if they want to continue later they can message again; no call or payment is implied",
        };
      case "nudge":
        return { status: "still_waiting_on_their_answer" };
      case "payment":
        return { status: "payment_deadline_coming_up", terms: d.terms ?? null };
      case "deadline":
        return {
          status: "payment_deadline_passed_nothing_paid",
          note: "the errand stays open; nothing says the business has dropped it",
          terms: d.terms ?? null,
        };
      case "expired":
        return {
          status: d.endReason === "window_passed"
            ? "closed_because_the_time_passed"
            : "closed_after_going_quiet",
          nothing_was_booked: true,
        };
    }
  })();
  return { event: "follow_up", place: d.place, errand, happened, values, next_step: nextStep(d) };
}

// Sends what's due, in order, a batch at a time. callId: only this call's report.
export async function drainDeliveries(
  deps: Pick<TellDeps, "store" | "send" | "now" | "trace">,
  callId?: string,
): Promise<DrainSummary> {
  const { store } = deps;
  const sum: DrainSummary = { sent: 0, retrying: 0, failed: 0 };
  // A batch at a time, so this also bounds a run.
  for (let pass = 0; pass < 10; pass++) {
    const batch = await store.takeDeliveries(deps.now?.(), callId);
    if (!batch.length) break;
    for (const d of batch) await sendOne(deps, d, sum);
  }
  deps.trace?.("deliveries", sum);
  return sum;
}

async function sendOne(
  deps: Pick<TellDeps, "store" | "send" | "trace">,
  d: Delivery,
  sum: DrainSummary,
): Promise<void> {
  const { store } = deps;
  if (store.assertDelivery && !await store.assertDelivery(d.id)) {
    sum.retrying++;
    return;
  }
  const user: User = { id: d.userId, waId: d.waId, blocked: false };
  try {
    const id = await deps.send(user, d.message);
    await store.deliverySent(d.id, id);
    sum.sent++;
  } catch (e) {
    if (e instanceof OutsideServiceWindow) return outsideWindow(deps, d, user, sum);
    const left = await store.deliveryFailed(d.id, String((e as Error)?.message ?? e), false);
    deps.trace?.("delivery_failed", { delivery: d.id, error: String(e), left });
    if (left === "failed") sum.failed++;
    else sum.retrying++;
  }
}

// No paid templates: an expired window pauses delivery until the user writes again.
async function outsideWindow(
  deps: Pick<TellDeps, "store" | "send">,
  d: Delivery,
  _user: User,
  sum: DrainSummary,
): Promise<void> {
  if (!deps.store.deferDelivery) throw new Error("delivery deferral is not configured");
  await deps.store.deferDelivery(d.id);
  sum.retrying++;
}

export async function queueFollowUps(store: ChatStore, now?: Date): Promise<number> {
  let n = 0;
  for (const d of await store.dueFollowUps(now)) {
    if (await store.queueFollowUp(d.requestId, d.reason, d.stamp, followUpFacts(d), now)) n++;
  }
  return n;
}

// Stores what's owed for something outside a call, then writes and sends it. key: what it
// answers, so it's owed once.
export async function tell(
  deps: TellDeps,
  user: User,
  requestId: string | null,
  key: string,
  facts: Facts,
): Promise<void> {
  await deps.store.oweFacts(user.id, requestId, key, "notice", facts);
  await writeOwed(deps);
  await drainDeliveries(deps);
}

export async function runFollowThrough(
  deps: FollowUpDeps,
): Promise<DrainSummary & { queued: number; written: number; waiting: number }> {
  const queued = await queueFollowUps(deps.store, deps.now?.());
  const written = await writeOwed(deps);
  return { queued, ...written, ...(await drainDeliveries(deps)) };
}
