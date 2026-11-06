// The cards Luna sees on each turn (E4 design 1.1): profile, task, recent requests.
// Built by code from rows, never written by a model. Plain lines, well under 3k tokens.
import { fmtFull, fmtWhen, maskPhone, type Place, placeName } from "./readback.ts";
import { currentQuestions, type Fields, type Has, missing } from "./slots.ts";
import { type Open, type State, type Task, toolsFor } from "./states.ts";
import type { HeldBooking, Memory, OpenDecision } from "./store.ts";

export type Profile = {
  name: string | null;
  language: string;
  city: string | null;
  phone: string | null;
  bookOnFirstCall: boolean;
  placeLabels: string[];
  // Saved under their own labels (0026). A visit uses one only when the chat says which.
  addresses?: SavedAddress[];
};

export type SavedAddress = { label: string; address: string };

export type TaskView = {
  // Short id Luna names this errand by when there is more than one.
  ref: string;
  task: Task;
  state: State;
  fields: Fields;
  place: Place | null;
  hasBooking: boolean;
  options: { label: string; detail: string | null }[];
  // The user asked the Desk to wait (pause_request).
  paused?: boolean;
  // What it's waiting for, and the reminder set for it (set_follow_up).
  waitingFor?: string | null;
  remindAt?: Date | null;
  // Asked to cancel during the call.
  cancelRequested?: boolean;
  // A plan or option list is waiting for the user's answer, sent at this time.
  planSentAt?: Date | null;
  // For missing(): a profile name to book under, and whether the call books.
  has?: Pick<Has, "profileName" | "mayBook">;
};

// "r-1a2b3c4d": the first 8 hex of the request id.
export function errandRef(requestId: string): string {
  return `r-${requestId.slice(0, 8)}`;
}

export type RecentRequest = {
  at: Date;
  task: Task;
  state: State;
  endReason: string | null;
  placeName: string | null;
  fields: Fields;
};

const STATE_NOTE: Partial<Record<State, string>> = {
  collecting: "collecting details",
  choosing_place: "the user is picking the place",
  confirming: "nothing missing; propose_plan when they have nothing more to add or ask",
  awaiting_yes: "plan sent; waiting for their answer",
  calling_1: "calling the business now",
  options_ready: "call 1 done; options being sent",
  awaiting_pick: "options sent; waiting for their pick",
  stale_options: "options sent a while ago; call 2 will re-ask before booking",
  calling_2: "calling to book the picked option",
  verifying: "checking the call result",
  queued: "waiting behind the current errand; gets its plan when that one ends",
};

export function profileCard(p: Profile): string {
  return [
    "PROFILE",
    `name: ${p.name ?? "unknown"}`,
    `language: ${p.language}`,
    `home city: ${p.city ?? "unknown"}`,
    `phone: ${p.phone ? maskPhone(p.phone) : "unknown"}`,
    `book_on_first_call: ${p.bookOnFirstCall ? "yes" : "no"}`,
    `saved places: ${p.placeLabels.length ? p.placeLabels.join(", ") : "none"}`,
    `saved addresses: ${
      p.addresses?.length ? p.addresses.map((a) => `${a.label}: ${a.address}`).join("; ") : "none"
    }`,
  ].join("\n");
}

// What the Desk keeps for them. Facts to fill details from; each still shows in the plan.
export function memoryCard(ms: Memory[]): string {
  if (!ms.length) return "MEMORY\nnone";
  return [
    "MEMORY (use these to fill details, which the plan then shows; never an approval)",
    ...ms.map((m) =>
      `m-${m.id.slice(0, 8)} [${m.scope}${m.source === "learned" ? ", learned" : ""}] ${m.text}`
    ),
  ].join("\n");
}

// What's waiting on the user outside the current errand, with everything the business said,
// so nothing has to be asked twice.
// owed: places whose call result is in, with the message about it still being written.
export function openCard(advances: HeldBooking[], decisions: OpenDecision[], owed: string[] = []): string {
  if (!advances.length && !decisions.length && !owed.length) return "OPEN\nnothing";
  return [
    "OPEN",
    ...owed.map((p) =>
      `update being written: the call to ${p} is finished; its result is on its way to them`
    ),
    ...advances.map((a) => {
      const t = (a.terms ?? {}) as Record<string, string | number | null>;
      return [
        `advance ${errandRef(a.requestId)} at ${a.place ?? "the business"}: ${
          a.paid
            ? "their screenshot passed; the business hasn't confirmed it yet"
            : "not paid, nothing agreed"
        }`,
        a.amountRs !== null ? `Rs ${a.amountRs}` : null,
        a.time ? `slot ${fmtFull(a.time)}` : null,
        t.address ? `pay to ${t.address}` : null,
        a.payeeName ? `payee ${a.payeeName}` : null,
        t.mode ? `by ${t.mode}` : null,
        a.deadline ? `by ${fmtFull(a.deadline)}` : "no deadline given",
        t.redeemable ? `adjusted against the bill: "${t.redeemable}"` : null,
        t.refund ? `refund: "${t.refund}"` : null,
        `keeping the slot: ${t.holding ?? "they didn't say"}`,
      ].filter(Boolean).join("; ");
    }),
    ...decisions.map((d) =>
      `decision ${d.bookingId.slice(0, 8)} at ${d.place}${
        d.time ? `, ${fmtFull(d.time)}` : ""
      }: they require ${d.conditions.map((c) => `"${c.words}"`).join(", ")}, not yet accepted`
    ),
  ].join("\n");
}

export function taskCard(t: TaskView | null, now: Date, waiting: TaskView[] = [], open: Open = {}): string {
  if (!t) {
    return [
      "TASK",
      "none active",
      ...waiting.map((w) => `waiting: ${errandLine(w, now)}`),
      `tools: ${toolsFor(null, false, open).join(", ")}`,
    ].join("\n");
  }
  const need = missing(t.task, t.fields, { business: !!t.place, booking: t.hasBooking, ...t.has });
  const lines = [
    "TASK",
    `errand: ${t.ref}`,
    `task: ${t.task}`,
    // Paused: the state's usual next step (a plan, an approval) is on hold.
    `state: ${t.state}${!t.paused && STATE_NOTE[t.state] ? ` (${STATE_NOTE[t.state]})` : ""}`,
    ...(t.paused ? ["paused: yes (they asked you to wait; no plan or call until resume_request)"] : []),
    ...(t.planSentAt ? [`plan sent: ${clock(t.planSentAt)}; it is in the chat above`] : []),
    ...(t.cancelRequested ? ["cancel requested during the call; it ends when the result comes"] : []),
    ...followUpLines(t),
    `known: ${describeFields(t.fields, now).join("; ") || "nothing yet"}`,
    `missing_for_plan: ${need.length ? need.join(", ") : "nothing"}`,
    `business: ${t.place ? placeName(t.place) : "not picked"}`,
    ...(!t.place && t.fields.place_query
      ? [
        "business lookup: resolve the named place internally; ask only for genuine ambiguity, mismatch, or competing branches",
      ]
      : []),
  ];
  if (t.options.length) {
    lines.push(
      `options: ${
        t.options.map((o, i) => `${i + 1}) ${o.label}${o.detail ? `, ${o.detail}` : ""}`).join(" · ")
      }`,
    );
  }
  for (const w of waiting) lines.push(`waiting behind it: ${errandLine(w, now)}`);
  lines.push(`tools: ${toolsFor(t.state, t.paused, open).join(", ")}`);
  return lines.join("\n");
}

function followUpLines(t: TaskView): string[] {
  return [
    ...(t.waitingFor ? [`waiting for: ${t.waitingFor}`] : []),
    ...(t.remindAt ? [`reminder set: ${longClock(t.remindAt)}`] : []),
  ];
}

// "r-1a2b3c4d question at Test Dental: known: ...; missing_for_plan: which business".
function errandLine(t: TaskView, now: Date): string {
  const need = missing(t.task, t.fields, { business: !!t.place, booking: t.hasBooking, ...t.has });
  return [
    `${t.ref} ${t.task}${t.place ? ` at ${t.place.name}` : ""}`,
    `known: ${describeFields(t.fields, now).join("; ") || "nothing yet"}`,
    `missing_for_plan: ${need.join(", ") || "nothing"}`,
    ...followUpLines(t),
  ].join("; ");
}

function longClock(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function clock(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// At most 3 lines: "Oct 12 booked Paragon, table for 4, 8:15 pm".
export function recentCard(rs: RecentRequest[], now: Date): string {
  if (!rs.length) return "RECENT\nnone";
  return ["RECENT", ...rs.slice(0, 3).map((r) => recentLine(r, now))].join("\n");
}

function recentLine(r: RecentRequest, now: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "short", day: "numeric" })
    .format(r.at);
  const qs = currentQuestions(r.fields);
  const what = r.task === "question" ? `question${qs.length ? `: "${qs.join(" / ")}"` : ""}` : [
    r.task === "booking" ? null : r.task,
    r.fields.party_size ? `table for ${r.fields.party_size}` : r.fields.service,
    fmtWhen(r.fields, now),
  ].filter(Boolean).join(", ");
  const status = r.state === "expired"
    ? (r.endReason === "window_passed" ? "expired (time passed)" : "expired, not confirmed")
    : r.state === "cancelled"
    ? (r.endReason === "replaced" ? "replaced" : "cancelled")
    : r.state;
  return `${day} ${status}: ${[r.placeName, what].filter(Boolean).join(", ")}`;
}

function describeFields(f: Fields, now: Date): string[] {
  const out: string[] = [];
  const when = fmtWhen(f, now);
  if (when) out.push(`time=${when}`);
  if (f.party_size) out.push(`party_size=${f.party_size}`);
  if (f.service) out.push(`service=${f.service}`);
  if (f.visit) out.push("visit: the business comes to them");
  if (f.service_address) out.push(`service_address=${f.service_address}`);
  if (f.service_details) out.push(`service_details=${f.service_details}`);
  if (f.customer_name) out.push(`customer_name=${f.customer_name}`);
  if (f.share_name) out.push("gives their name on the call");
  if (f.share_phone) out.push("gives their number on the call");
  if (f.max_price_rs !== undefined) out.push(`max_price_rs=${f.max_price_rs}`);
  currentQuestions(f).forEach((q, i) => out.push(`question ${i + 1}="${q}"`));
  if (f.also_ask) out.push(`also_ask="${f.also_ask}"`);
  if (f.place_query) out.push(`place_query=${f.place_query}`);
  return out;
}
