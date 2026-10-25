// The cards Luna sees on each turn (E4 design 1.1): profile, task, recent requests.
// Built by code from rows, never written by a model. Plain lines, well under 3k tokens.
import { fmtWhen, maskPhone, type Place, placeName } from "./readback.ts";
import { type Fields, missing } from "./slots.ts";
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
  task: Task;
  state: State;
  fields: Fields;
  place: Place | null;
  hasBooking: boolean;
  options: { label: string; detail: string | null }[];
};

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
  confirming: "details complete; code is sending the read-back",
  awaiting_yes: "read-back sent; waiting for YES",
  calling_1: "calling the business now",
  options_ready: "call 1 done; code is sending the options",
  awaiting_pick: "options sent; waiting for a pick",
  stale_options: "options sent a while ago; call 2 will re-ask before booking",
  calling_2: "calling to book the picked option",
  verifying: "checking the call result",
  queued: "waiting for the current call to finish; no read-back yet",
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

export function taskCard(t: TaskView | null, now: Date): string {
  if (!t) return ["TASK", "none active", `tools: ${toolsFor(null).join(", ")}`].join("\n");
  const filled = describeFields(t.fields, now);
  const need = missing(t.task, t.fields, { business: !!t.place, booking: t.hasBooking });
  const lines = [
    "TASK",
    `task: ${t.task}`,
    `state: ${t.state}${STATE_NOTE[t.state] ? ` (${STATE_NOTE[t.state]})` : ""}`,
    `filled: ${filled.length ? filled.join("; ") : "nothing yet"}`,
    `missing: ${need.length ? need.join(", ") : "nothing"}`,
    `business: ${t.place ? placeName(t.place) : "not picked"}`,
  ];
  if (t.options.length) {
    lines.push(
      `options: ${
        t.options.map((o, i) => `${i + 1}) ${o.label}${o.detail ? `, ${o.detail}` : ""}`).join(" · ")
      }`,
    );
  }
  lines.push(`tools: ${toolsFor(t.state).join(", ")}`);
  return lines.join("\n");
}

// At most 3 lines: "Oct 12 booked Paragon, table for 4, 8:15 pm".
export function recentCard(rs: RecentRequest[], now: Date): string {
  if (!rs.length) return "RECENT\nnone";
  return ["RECENT", ...rs.slice(0, 3).map((r) => recentLine(r, now))].join("\n");
}

function recentLine(r: RecentRequest, now: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", month: "short", day: "numeric" })
    .format(r.at);
  const what = r.task === "question" ? `question${r.fields.question ? `: "${r.fields.question}"` : ""}` : [
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
  if (f.question) out.push(`question="${f.question}"`);
  if (f.also_ask) out.push(`also_ask="${f.also_ask}"`);
  if (f.place_query) out.push(`place_query=${f.place_query}`);
  return out;
}
