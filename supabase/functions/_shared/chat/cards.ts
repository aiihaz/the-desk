// The cards Luna sees on each turn (E4 design 1.1): profile, task, recent requests.
// Built by code from rows, never written by a model. Plain lines, well under 3k tokens.
import { fmtWhen, maskPhone, type Place, placeName } from "./readback.ts";
import { currentQuestions, type Fields, type Has, missing } from "./slots.ts";
import { type State, type Task, toolsFor } from "./states.ts";

export type Profile = {
  name: string | null;
  language: string;
  city: string | null;
  phone: string | null;
  bookOnFirstCall: boolean;
  placeLabels: string[];
};

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
    `city: ${p.city ?? "unknown"}`,
    `phone: ${p.phone ? maskPhone(p.phone) : "unknown"}`,
    `book_on_first_call: ${p.bookOnFirstCall ? "yes" : "no"}`,
    `saved places: ${p.placeLabels.length ? p.placeLabels.join(", ") : "none"}`,
  ].join("\n");
}

export function taskCard(t: TaskView | null, now: Date, waiting: TaskView[] = []): string {
  if (!t) {
    return [
      "TASK",
      "none active",
      ...waiting.map((w) => `waiting: ${errandLine(w, now)}`),
      `tools: ${toolsFor(null).join(", ")}`,
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
    `known: ${describeFields(t.fields, now).join("; ") || "nothing yet"}`,
    `still needed for a plan: ${need.length ? need.join(", ") : "nothing"}`,
    `business: ${t.place ? placeName(t.place) : "not picked"}`,
  ];
  if (t.options.length) {
    lines.push(
      `options: ${
        t.options.map((o, i) => `${i + 1}) ${o.label}${o.detail ? `, ${o.detail}` : ""}`).join(" · ")
      }`,
    );
  }
  for (const w of waiting) lines.push(`waiting behind it: ${errandLine(w, now)}`);
  lines.push(`tools: ${toolsFor(t.state, t.paused).join(", ")}`);
  return lines.join("\n");
}

// "r-1a2b3c4d question at Test Dental: known: ...; still needed: which business".
function errandLine(t: TaskView, now: Date): string {
  const need = missing(t.task, t.fields, { business: !!t.place, booking: t.hasBooking, ...t.has });
  return [
    `${t.ref} ${t.task}${t.place ? ` at ${t.place.name}` : ""}`,
    `known: ${describeFields(t.fields, now).join("; ") || "nothing yet"}`,
    `still needed: ${need.join(", ") || "nothing"}`,
  ].join("; ");
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
  if (f.customer_name) out.push(`customer_name=${f.customer_name}`);
  if (f.max_price_rs !== undefined) out.push(`max_price_rs=${f.max_price_rs}`);
  currentQuestions(f).forEach((q, i) => out.push(`question ${i + 1}="${q}"`));
  if (f.also_ask) out.push(`also_ask="${f.also_ask}"`);
  if (f.place_query) out.push(`place_query=${f.place_query}`);
  return out;
}
