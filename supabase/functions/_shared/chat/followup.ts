// Follow-through: what the Desk owes a user outside a turn. Call reports, reminders the
// user asked for, one nudge on an unanswered plan, a payment deadline coming up, and
// word that an errand expired. Everything goes through deliveries (0012): the message is
// stored first, then sent, so a failed send is retried and a crash loses nothing. The
// report path drains its own call at once; reconcile runs runFollowThrough every 5
// minutes as the recovery pass, and the bench runs the same code.
import { OutsideServiceWindow } from "../deliver.ts";
import type { User } from "../store.ts";
import { fmtTime } from "./readback.ts";
import type { State, Task } from "./states.ts";
import type { ChatStore } from "./store.ts";
import type { PromptDeps } from "./turn.ts";

export type FollowUpDeps = PromptDeps & { trace?: (event: string, data: unknown) => void };

export type DueFollowUp = {
  requestId: string;
  userId: string;
  reason: "reminder" | "nudge" | "payment" | "expired";
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
};

export type Delivery = {
  id: string;
  userId: string;
  waId: string;
  message: Parameters<PromptDeps["send"]>[1];
  attempts: number;
  kind: string;
};

export type DrainSummary = { sent: number; retrying: number; failed: number };

function errand(d: DueFollowUp): string {
  const what = d.task === "question"
    ? "question"
    : d.task === "reschedule"
    ? "move"
    : d.task === "cancel"
    ? "cancellation"
    : d.fields.party_size
    ? `table for ${d.fields.party_size}`
    : d.fields.service ?? "booking";
  return `${what}${d.place ? ` at ${d.place}` : ""}`;
}

// The next step, in the same words the plan used, so a plain "yes" can answer it.
function nextStep(d: DueFollowUp): string {
  switch (d.state) {
    case "awaiting_yes":
      return "Shall I go ahead?";
    case "awaiting_pick":
    case "stale_options":
      return "Tell me which option you'd like, or that you'd rather drop it.";
    case "awaiting_payment":
      return "Send me the payment screenshot once you've paid.";
    default:
      return "Shall I carry on with it?";
  }
}

export function followUpText(d: DueFollowUp): string {
  switch (d.reason) {
    case "reminder":
      return `Reminder about your ${errand(d)}${d.waitingFor ? `: ${d.waitingFor}` : ""}. ${nextStep(d)}`;
    case "nudge":
      return `Your ${errand(d)} is still waiting on you. ${nextStep(d)}`;
    case "payment":
      return `Your hold at ${d.place ?? "the business"} needs the ${
        d.amountRs ? `Rs ${d.amountRs} ` : ""
      }advance by ${d.deadline ? fmtTime(d.deadline) : "their deadline"}. ${nextStep(d)}`;
    case "expired":
      return d.endReason === "window_passed"
        ? `The time for your ${errand(d)} has passed, so I've closed it. Nothing was booked.`
        : `I've closed your ${
          errand(d)
        } since it's been quiet. Nothing was booked. Tell me if you want it again.`;
  }
}

// Sends what's due, in order, a batch at a time. callId: only this call's report.
export async function drainDeliveries(deps: FollowUpDeps, callId?: string): Promise<DrainSummary> {
  const { store } = deps;
  const sum: DrainSummary = { sent: 0, retrying: 0, failed: 0 };
  // A report's parts come one per pass, so this also bounds a run.
  for (let pass = 0; pass < 10; pass++) {
    const batch = await store.takeDeliveries(deps.now?.(), callId);
    if (!batch.length) break;
    for (const d of batch) await sendOne(deps, d, sum);
  }
  deps.trace?.("deliveries", sum);
  return sum;
}

async function sendOne(deps: FollowUpDeps, d: Delivery, sum: DrainSummary): Promise<void> {
  const { store } = deps;
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

// Meta takes only a template past 24 hours of silence. Without an approved one the
// message can't go, and the alert from delivery_failed says so.
async function outsideWindow(
  deps: FollowUpDeps,
  d: Delivery,
  user: User,
  sum: DrainSummary,
): Promise<void> {
  const { store } = deps;
  const name = await store.limitText("follow_up_template", d.userId);
  const body = (d.message as { body?: string }).body;
  if (name && body) {
    try {
      const { language } = await store.user(d.userId);
      const id = await deps.send(user, {
        kind: "template",
        name,
        language: language.split("-")[0],
        params: [body],
      });
      await store.deliverySent(d.id, id);
      sum.sent++;
      return;
    } catch (e) {
      await store.deliveryFailed(d.id, String((e as Error)?.message ?? e), false);
      sum.retrying++;
      return;
    }
  }
  await store.deliveryFailed(d.id, "outside the 24-hour window, no template set", true);
  sum.failed++;
}

export async function queueFollowUps(store: ChatStore, now?: Date): Promise<number> {
  let n = 0;
  for (const d of await store.dueFollowUps(now)) {
    const message = { kind: "text" as const, body: followUpText(d) };
    if (await store.queueFollowUp(d.requestId, d.reason, d.stamp, message, now)) n++;
  }
  return n;
}

export async function runFollowThrough(deps: FollowUpDeps): Promise<DrainSummary & { queued: number }> {
  const queued = await queueFollowUps(deps.store, deps.now?.());
  return { queued, ...(await drainDeliveries(deps)) };
}
