// Slot values Luna proposes through set_slots, and what each task needs before a plan.
// Code checks every value (E4 design 2, L2 tool table); the database stores only
// what passes. Times are ISO 8601 with an offset. Understanding what the user meant
// (a time or a party size, a reworded question) is Luna's job; the plan shows the
// result back to them before anything happens, so a misreading is caught there.
import type { State, Task } from "./states.ts";

export type Fields = {
  window_start?: string;
  window_end?: string;
  // The part of day they left to the business ("afternoon"), in their words, when the
  // window is that part of day's usual span. The plan shows the span; the call settles a
  // time inside it.
  day_part?: string;
  exact_time?: string;
  // They left the time to the business ("anything works", "any time after 2"): the call asks
  // what suits them. The window still holds both ends, so every later step reads one shape:
  // an end they didn't give is that day's own bound, and time_given (set by code) says which
  // ends are theirs, so the plan and the call never present a day bound as their limit.
  time_open?: boolean;
  time_given?: "start" | "end" | "both" | "none";
  tolerance_min?: number;
  party_size?: number;
  service?: string;
  // User-supplied location and operational details needed for this particular service.
  // Optional unless the grounded requested action needs them; never inferred defaults.
  service_address?: string;
  service_details?: string;
  // Booking: the business comes to them (a plumber, a cleaner). Luna's reading of the
  // request; it makes the address and the job part of what the plan needs.
  visit?: boolean;
  customer_name?: string;
  max_price_rs?: number;
  // Set by code from limits when the plan is built, so the consent hash covers it.
  may_book?: boolean;
  // Question task: each thing to ask, in the user's terms. Edited one item at a time
  // (questionOps), so a follow-up never replaces what they asked before.
  questions?: string[];
  // Before 0007 a question was one string; old rows still have it.
  question?: string;
  // Booking: one extra thing to ask on the call ("do they have parking?"). In the plan.
  also_ask?: string;
  // What the user called the place, for find_business.
  place_query?: string;
  // Question task about something of their own (an order, a booking made elsewhere):
  // the business needs to know who is asking. Both are said in the plan.
  share_name?: boolean;
  // Question task: as above. Booking: false when they don't want their number given; the
  // plan says so, and no call on the errand carries it. Unset, a booking gives it.
  share_phone?: boolean;
};

// Keys Luna may set for each task. may_book is code-only; questions
// change through questionOps.
const ALLOWED: Record<Task, (keyof Fields)[]> = {
  booking: [
    "window_start",
    "window_end",
    "day_part",
    "exact_time",
    "time_open",
    "tolerance_min",
    "party_size",
    "service",
    "service_address",
    "service_details",
    "visit",
    "customer_name",
    "max_price_rs",
    "also_ask",
    "place_query",
    "share_phone",
  ],
  question: [
    "place_query",
    "share_name",
    "share_phone",
    "customer_name",
    "service_address",
    "service_details",
  ],
  reschedule: [
    "window_start",
    "window_end",
    "day_part",
    "exact_time",
    "time_open",
    "tolerance_min",
    "service_address",
    "service_details",
  ],
  cancel: [],
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_QUESTIONS = 4;
const SHORT_WINDOW_MS = 5 * 60_000;

export type SlotCheck =
  | { ok: true; patch: Partial<Record<keyof Fields, unknown>> }
  // narrow: the only error is a window under 5 minutes, which their words may support.
  | { ok: false; errors: string[]; narrow?: boolean };

// Edits to the question list: add new ones, reword one (1-based), remove some.
export type QuestionOps = {
  add?: string[];
  reword?: { number: number; text: string }[];
  remove?: number[];
};

// windowConfirmed: a reading of the chat found they asked for this narrow a window (tools.ts).
export type SlotOps = QuestionOps & { windowConfirmed?: boolean };

// Checks a proposed patch on its own and merged with the current fields.
// A null value clears that slot. Errors are short and go back to Luna as the tool result.
export function checkSlots(
  task: Task,
  current: Fields,
  patch: Record<string, unknown>,
  now: Date,
  ops: SlotOps = {},
): SlotCheck {
  const errors: string[] = [];
  const allowed = ALLOWED[task];
  const out: Record<string, unknown> = {};
  // day: the date a time left to the business is on. Read here, never stored on its own.
  const { day, ...rest } = patch;
  patch = rest;
  if (day !== undefined && (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))) {
    errors.push("day: the date as YYYY-MM-DD");
  }
  if ("time_given" in patch) errors.push("time_given: set by code from the ends they gave");
  delete patch.time_given;

  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key as keyof Fields)) {
      errors.push(
        key === "questions" || key === "question"
          ? `${key}: use add_questions, reword_questions or remove_questions`
          : `${key}: not a ${task} slot`,
      );
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    const err = checkValue(key as keyof Fields, value, now);
    if (err) errors.push(`${key}: ${err}`);
    else out[key] = typeof value === "string" ? value.trim() : value;
  }

  if (ops.add?.length || ops.reword?.length || ops.remove?.length) {
    if (task !== "question") errors.push("questions: only a question errand has questions");
    else {
      const q = applyQuestionOps(currentQuestions(current), ops);
      if (typeof q === "string") errors.push(q);
      else out.questions = q.length ? q : null;
      // An old single-string question is folded into the list.
      if (current.question !== undefined) out.question = null;
    }
  }
  if (errors.length) return { ok: false, errors };

  // A tolerance is room around a time they chose; time_open leaves the choice to the business.
  // One patch claiming both can't be stored: which one they meant is Luna's to read, not code's.
  if (out.time_open === true && typeof out.tolerance_min === "number") {
    return { ok: false, errors: [CONFLICT_OPEN_TOLERANCE] };
  }

  // A time left to the business: the ends they gave, and the day's own bounds for the rest.
  if (out.time_open === true) {
    const given = (k: "window_start" | "window_end") => typeof out[k] === "string" ? out[k] as string : null;
    const start = given("window_start");
    const end = given("window_end");
    const on = typeof day === "string" ? day : istDate(start ?? end);
    if (!on) errors.push("day: the date they mean, as YYYY-MM-DD, when they gave no time");
    else if ((start && istDate(start) !== on) || (end && istDate(end) !== on)) {
      errors.push("window_start/window_end: on the day given");
    } else if (out.day_part !== undefined && out.day_part !== null) {
      errors.push("day_part: not with time_open; a part of day has its own window");
    } else if (out.exact_time !== undefined && out.exact_time !== null) {
      errors.push("exact_time: not with time_open");
    } else {
      out.window_start = start ?? `${on}T00:00:00+05:30`;
      out.window_end = end ?? `${on}T23:59:00+05:30`;
      out.time_given = start && end ? "both" : start ? "start" : end ? "end" : "none";
      if (Date.parse(out.window_end as string) <= now.getTime()) errors.push("day: must be today or later");
      if (current.exact_time !== undefined) out.exact_time = null;
      if (current.day_part !== undefined) out.day_part = null;
      if (current.tolerance_min !== undefined) out.tolerance_min = null;
    }
    if (errors.length) return { ok: false, errors };
  } else if (
    out.time_open === null || (current.time_open && ("window_start" in out || "exact_time" in out))
  ) {
    // A time they gave, or a range with both ends, replaces "anything works".
    out.time_open = null;
    out.time_given = null;
  } else if (day !== undefined) {
    return { ok: false, errors: ["day: only with time_open"] };
  }

  // A new exact time replaces a window, and a new window an exact time: "make it 9pm"
  // moves the booking, it doesn't have to fit inside the old "around 8".
  if (typeof out.exact_time === "string" && !("window_start" in out) && !("window_end" in out)) {
    if (current.window_start !== undefined) out.window_start = null;
    if (current.window_end !== undefined) out.window_end = null;
    if (current.tolerance_min !== undefined && !("tolerance_min" in out)) out.tolerance_min = null;
  } else if (typeof out.window_start === "string" && typeof out.window_end === "string") {
    if (current.exact_time !== undefined && !("exact_time" in out)) {
      out.exact_time = null;
      // The tolerance was room around that time, which the window replaces.
      if (current.tolerance_min !== undefined && !("tolerance_min" in out)) out.tolerance_min = null;
    }
  }
  // A new time without a part of day ("make it 3 pm", "between 2 and 3") replaces the
  // old "afternoon" with it.
  if (
    ("window_start" in out || "window_end" in out) && !("day_part" in out) && current.day_part !== undefined
  ) {
    out.day_part = null;
  }

  // A narrow window is usually one time, written wrong, but it can be what they asked for.
  // Nothing is rewritten: it's refused unless a reading of the chat finds it's their range.
  let narrow = false;
  if (("window_start" in out || "window_end" in out) && !ops.windowConfirmed && out.time_open !== true) {
    const start = (out.window_start ?? current.window_start) as string | null | undefined;
    const end = (out.window_end ?? current.window_end) as string | null | undefined;
    const span = start && end ? Date.parse(end) - Date.parse(start) : 0;
    if (span > 0 && span <= SHORT_WINDOW_MS) {
      narrow = true;
      errors.push(
        "window: under 5 minutes, and they didn't ask for that. For one time they gave, use exact_time alone",
      );
    }
  }

  const merged = { ...current, ...out } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === null) delete merged[k];
  const m = merged as Fields;
  // "table for 3" in service with party_size 3 reads as "table for 3 for 3" in the plan
  // and the caller's brief: the number has one home.
  if (
    ("service" in out || "party_size" in out) && m.service && m.party_size &&
    new RegExp(`(^|\\D)${m.party_size}(\\D|$)`).test(m.service)
  ) {
    errors.push(
      "service: the party size goes in party_size only; service is what's booked, or null for a table",
    );
  }
  // A row saved before these rules may already be incoherent; an edit that doesn't touch the
  // time isn't refused for it (the plan is, in proposePlan).
  if (TIME_KEYS.some((k) => k in out)) errors.push(...incoherentTime(m));
  return errors.length
    ? { ok: false, errors, narrow: narrow && errors.length === 1 }
    : { ok: true, patch: out };
}

const TIME_KEYS = ["window_start", "window_end", "day_part", "exact_time", "time_open", "tolerance_min"];

export const CONFLICT_OPEN_TOLERANCE =
  "time_open and tolerance_min contradict each other: a tolerance is room around a time they chose, " +
  "time_open leaves the choice to the business. Store the one their messages say, not both";

// Combinations of time fields that can't all be true, whatever words they came from. Structure
// only: which reading is right is Luna's call, and code never picks one for her.
export function incoherentTime(f: Fields): string[] {
  const errors: string[] = [];
  if (f.time_open && f.tolerance_min) errors.push(CONFLICT_OPEN_TOLERANCE);
  else if (f.tolerance_min && !f.exact_time) {
    errors.push("tolerance_min: room either way of exact_time, so only with exact_time");
  }
  if (f.time_open && f.exact_time) errors.push("exact_time: not with time_open");
  if (f.time_open && f.day_part) {
    errors.push("day_part: not with time_open; a part of day has its own window");
  }
  if (f.time_open && !(f.window_start && f.window_end)) {
    errors.push("time_open: needs the day, through window_start and window_end");
  }
  if (f.day_part && !(f.window_start && f.window_end)) {
    errors.push("day_part: only with window_start and window_end spanning that part of day");
  }
  if (f.window_start && f.window_end && Date.parse(f.window_start) >= Date.parse(f.window_end)) {
    errors.push("window_start: must be before window_end");
  }
  if (f.exact_time && f.window_start && f.window_end) {
    const t = Date.parse(f.exact_time);
    if (t < Date.parse(f.window_start) || t > Date.parse(f.window_end)) {
      errors.push("exact_time: must be inside the window");
    }
  }
  return errors;
}

// The date in India of an ISO time, as YYYY-MM-DD.
function istDate(iso: string | null): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}

export function currentQuestions(f: Fields): string[] {
  if (Array.isArray(f.questions)) return f.questions;
  return f.question ? [f.question] : [];
}

// Numbers refer to the list as it stands; rewords and removals apply before adds.
function applyQuestionOps(list: string[], ops: QuestionOps): string[] | string {
  const out = [...list];
  for (const n of ops.reword ?? []) {
    if (!Number.isInteger(n.number) || n.number < 1 || n.number > out.length) {
      return `reword_questions: there is no question ${n.number}`;
    }
    const err = text(n.text, 200);
    if (err) return `reword_questions: ${err}`;
    out[n.number - 1] = n.text.trim();
  }
  const drop = new Set<number>();
  for (const n of ops.remove ?? []) {
    if (!Number.isInteger(n) || n < 1 || n > out.length) return `remove_questions: there is no question ${n}`;
    drop.add(n - 1);
  }
  const kept = out.filter((_, i) => !drop.has(i));
  for (const q of ops.add ?? []) {
    const err = text(q, 200);
    if (err) return `add_questions: ${err}`;
    // The same question added twice is one question: a plan never lists it twice.
    if (!kept.some((k) => same(k, q))) kept.push(q.trim());
  }
  if (kept.length > MAX_QUESTIONS) return `questions: at most ${MAX_QUESTIONS} per call`;
  return kept;
}

// The same text, whatever its spacing or case. Identity, not meaning: a reworded question is
// Luna's to see in the list it gets back.
function same(a: string, b: string): boolean {
  const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return norm(a) === norm(b);
}

function checkValue(key: keyof Fields, v: unknown, now: Date): string | null {
  switch (key) {
    case "window_start":
    case "window_end":
    case "exact_time": {
      if (typeof v !== "string" || !ISO.test(v) || Number.isNaN(Date.parse(v))) {
        return "ISO 8601 with an offset, e.g. 2026-10-24T19:30:00+05:30";
      }
      // A window may start a little in the past ("now till 9"), but must end in the future.
      if (key !== "window_start" && Date.parse(v) <= now.getTime()) return "must be in the future";
      return null;
    }
    case "party_size":
      return int(v, 1, 30);
    case "tolerance_min":
      return int(v, 0, 120);
    case "max_price_rs":
      return int(v, 0, 1_000_000);
    case "time_open":
      return v === true ? null : "true, or null to clear";
    case "time_given":
      return "set by code";
    case "may_book":
    case "visit":
    case "share_name":
    case "share_phone":
      return typeof v === "boolean" ? null : "true or false";
    case "service":
      return text(v, 100);
    case "service_address":
      return text(v, 500);
    case "service_details":
      return text(v, 1000);
    case "customer_name":
      return text(v, 60);
    case "day_part":
      return text(v, 30);
    case "question":
    case "questions":
      return "set through the question edits";
    case "also_ask":
      return text(v, 150);
    case "place_query":
      return text(v, 100);
  }
}

function int(v: unknown, min: number, max: number): string | null {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max
    ? null
    : `a whole number from ${min} to ${max}`;
}

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max
    ? null
    : `1-${max} characters`;
}

export type Has = {
  business: boolean;
  booking: boolean;
  // The profile has a name the plan can book under.
  profileName?: boolean;
  // The call will book (book_on_first_call), so it needs a name.
  mayBook?: boolean;
};

// What the request still needs before a plan can be proposed. "business" and "booking"
// are request columns (business_id, booking_id), the rest are fields. Not an order to
// ask in: Luna asks for what matters next, in its own words, and only what it can't infer.
export function missing(task: Task, f: Fields, has: Has): string[] {
  const out: string[] = [];
  const when = (f.window_start && f.window_end) || f.exact_time;
  switch (task) {
    case "booking":
      if (!f.party_size && !f.service) out.push("what to book (party_size or service)");
      if (!when) out.push("when (exact_time, or window_start and window_end)");
      if (has.mayBook !== false && !f.customer_name && !has.profileName) out.push("the name to book under");
      if (f.visit && !f.service_address) out.push("where they want the visit (service_address)");
      if (f.visit && !f.service_details) out.push("what the job is (service_details)");
      if (!has.business) out.push("which business");
      break;
    case "question":
      if (!currentQuestions(f).length) out.push("what to ask");
      if (f.share_name && !f.customer_name && !has.profileName) out.push("the name to give them");
      if (!has.business) out.push("which business");
      break;
    case "reschedule":
      if (!has.booking) out.push("which booking");
      if (!when) out.push("the new time");
      break;
    case "cancel":
      if (!has.booking) out.push("which booking");
      break;
  }
  return out;
}

// Where a request in the collecting states belongs. confirming means nothing is missing:
// Luna may propose the plan when the conversation is ready for it.
export function collectingState(
  task: Task,
  f: Fields,
  has: Has,
): Extract<State, "collecting" | "choosing_place" | "confirming"> {
  const m = missing(task, f, has);
  if (m.length === 0) return "confirming";
  if (m.length === 1 && m[0] === "which business") return "choosing_place";
  return "collecting";
}
