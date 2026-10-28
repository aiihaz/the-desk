// Slot values Luna proposes through set_slots, and what each task needs before a plan.
// Code checks every value (E4 design 2, L2 tool table); the database stores only
// what passes. Times are ISO 8601 with an offset. Understanding what the user meant
// (a time or a party size, a reworded question) is Luna's job; the plan shows the
// result back to them before anything happens, so a misreading is caught there.
import type { State, Task } from "./states.ts";

export type Fields = {
  window_start?: string;
  window_end?: string;
  exact_time?: string;
  tolerance_min?: number;
  party_size?: number;
  service?: string;
  customer_name?: string;
  max_price_rs?: number;
  // Set by code from limits when the plan is built, so the consent hash covers them.
  max_advance_rs?: number;
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
};

// Keys Luna may set for each task. max_advance_rs and may_book are code-only; questions
// change through questionOps.
const ALLOWED: Record<Task, (keyof Fields)[]> = {
  booking: [
    "window_start",
    "window_end",
    "exact_time",
    "tolerance_min",
    "party_size",
    "service",
    "customer_name",
    "max_price_rs",
    "also_ask",
    "place_query",
  ],
  question: ["place_query"],
  reschedule: ["window_start", "window_end", "exact_time", "tolerance_min"],
  cancel: [],
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_QUESTIONS = 4;

export type SlotCheck =
  | { ok: true; patch: Partial<Record<keyof Fields, unknown>> }
  | { ok: false; errors: string[] };

// Edits to the question list: add new ones, reword one (1-based), remove some.
export type QuestionOps = {
  add?: string[];
  reword?: { number: number; text: string }[];
  remove?: number[];
};

// Checks a proposed patch on its own and merged with the current fields.
// A null value clears that slot. Errors are short and go back to Luna as the tool result.
export function checkSlots(
  task: Task,
  current: Fields,
  patch: Record<string, unknown>,
  now: Date,
  ops: QuestionOps = {},
): SlotCheck {
  const errors: string[] = [];
  const allowed = ALLOWED[task];
  const out: Record<string, unknown> = {};

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

  const merged = { ...current, ...out } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (v === null) delete merged[k];
  const m = merged as Fields;
  if (m.window_start && m.window_end && Date.parse(m.window_start) >= Date.parse(m.window_end)) {
    errors.push("window_start: must be before window_end");
  }
  if (m.exact_time && m.window_start && m.window_end) {
    const t = Date.parse(m.exact_time);
    if (t < Date.parse(m.window_start) || t > Date.parse(m.window_end)) {
      errors.push("exact_time: must be inside the window");
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, patch: out };
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
    kept.push(q.trim());
  }
  if (kept.length > MAX_QUESTIONS) return `questions: at most ${MAX_QUESTIONS} per call`;
  return kept;
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
    case "max_advance_rs":
      return int(v, 0, 1_000_000);
    case "may_book":
      return typeof v === "boolean" ? null : "true or false";
    case "service":
      return text(v, 100);
    case "customer_name":
      return text(v, 60);
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
      if (!has.business) out.push("which business");
      break;
    case "question":
      if (!currentQuestions(f).length) out.push("what to ask");
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
