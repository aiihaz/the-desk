// Slot values Luna proposes through set_slots, and what each task still needs.
// Code checks every value (E4 design 2, L2 tool table); the database stores only
// what passes. Times are ISO 8601 with an offset.
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
  // Set by code from limits when the read-back is built, so the consent hash covers them.
  max_advance_rs?: number;
  may_book?: boolean;
  question?: string;
  // Booking: one extra thing to ask on the call ("do they have parking?"). In the read-back.
  also_ask?: string;
  // What the user called the place, for find_business.
  place_query?: string;
};

// Keys Luna may set for each task. max_advance_rs and may_book are code-only.
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
  question: ["question", "place_query"],
  reschedule: ["window_start", "window_end", "exact_time", "tolerance_min"],
  cancel: [],
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export type SlotCheck =
  | { ok: true; patch: Partial<Record<keyof Fields, unknown>> }
  | { ok: false; errors: string[] };

// Checks a proposed patch on its own and merged with the current fields.
// A null value clears that slot. Errors are short and go back to Luna as the tool result.
export function checkSlots(
  task: Task,
  current: Fields,
  patch: Record<string, unknown>,
  now: Date,
): SlotCheck {
  const errors: string[] = [];
  const allowed = ALLOWED[task];
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key as keyof Fields)) {
      errors.push(`${key}: not a ${task} slot`);
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
    // Room for two or three questions to one place ("walk-ins? and insurance?").
    case "question":
      return text(v, 300);
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

// "make it 7", "yes but make it five", "6 instead": an edit with a number and no unit.
// It could be a time or a number of people, in any task, so code makes Luna ask (P9).
// A bare "4" answering "how many?" is not an edit, and "7 pm" or "7 people" has a unit.
const NUM = "(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const BARE_EDIT = new RegExp(
  `^(?:(?:yes|ok|okay|sure|haan)\\s+)?(?:but\\s+|actually\\s+|no\\s+)?` +
    `(?:(?:make|change|move|shift|switch)\\s+(?:it\\s+)?(?:to\\s+)?${NUM}(?:\\s+instead)?|${NUM}\\s+instead)$`,
);

export function bareNumberEdit(text: string): boolean {
  return BARE_EDIT.test(text.toLowerCase().replace(/[.!,?]+/g, " ").replace(/\s+/g, " ").trim());
}

// Numbers and days in what the user asked ("under 300", "ready by Friday"). A rewording
// of the question or also_ask must keep them (P10).
const LIMIT =
  /\d[\d,]*(?:[.:]\d+)?|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:today|tomorrow|tonight|weekend)\b/gi;

function limits(s: string): string[] {
  return [...new Set((s.match(LIMIT) ?? []).map((m) => m.toLowerCase().replace(/,/g, "")))];
}

const COMMON = new Set([
  "the",
  "and",
  "you",
  "your",
  "for",
  "are",
  "can",
  "what",
  "does",
  "have",
  "with",
  "they",
  "them",
  "this",
  "that",
  "there",
  "how",
  "much",
  "any",
  "will",
  "ask",
  "yes",
  "not",
]);

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !COMMON.has(w));
}

// The new question keeps under half of the old one's words: it replaces the question
// instead of rewording or adding to it. Long words match on their first five letters.
function replaces(old: string, next: string): boolean {
  const before = [...new Set(words(old))];
  if (!before.length) return false;
  const after = words(next);
  const kept = before.filter((w) =>
    after.some((x) => x === w || (w.length >= 5 && x.slice(0, 5) === w.slice(0, 5)))
  );
  return kept.length / before.length < 0.5;
}

// A set_slots patch that rewrites question or also_ask must keep what the user asked
// for. drop lists what the user asked to remove: a limit ("300") or "question" for a
// question they want replaced. Returns the problem for Luna, or null.
export function rewordingProblem(
  current: Fields,
  patch: Record<string, unknown>,
  drop: string[],
): string | null {
  const dropped = new Set(drop.flatMap(limits));
  for (const key of ["question", "also_ask"] as const) {
    const old = current[key];
    const next = patch[key];
    if (typeof old !== "string" || typeof next !== "string" || old === next) continue;
    const keep = new Set(limits(next));
    const lost = limits(old).filter((t) => !keep.has(t) && !dropped.has(t));
    if (lost.length) {
      const list = lost.map((t) => `"${t}"`).join(", ");
      return `${key}: the new text drops ${list} from "${old}". Keep every limit the user gave; ` +
        `only if they asked to remove it, call again with drop: [${list}]`;
    }
    if (key === "question" && !drop.includes("question") && replaces(old, next)) {
      return `question: this replaces "${old}" instead of adding to it. If they want both asked, put ` +
        `both in question; only if they want just the new one, call again with drop: ["question"]`;
    }
  }
  return null;
}

// What the request still needs before a read-back. "business" and "booking" are
// request columns (business_id, booking_id), the rest are fields.
export function missing(task: Task, f: Fields, has: { business: boolean; booking: boolean }): string[] {
  const out: string[] = [];
  const when = (f.window_start && f.window_end) || f.exact_time;
  switch (task) {
    case "booking":
      if (!f.party_size && !f.service) out.push("party_size or service");
      if (!when) out.push("time (window_start and window_end, or exact_time)");
      if (!f.customer_name) out.push("customer_name");
      if (!has.business) out.push("business");
      break;
    case "question":
      if (!f.question) out.push("question");
      if (!has.business) out.push("business");
      break;
    case "reschedule":
      if (!has.booking) out.push("booking");
      if (!when) out.push("new time (window_start and window_end, or exact_time)");
      break;
    case "cancel":
      if (!has.booking) out.push("booking");
      break;
  }
  return out;
}

// Where a request in the collecting states belongs: details first, then the place,
// then a read-back. Reschedule and cancel take the business from the booking.
export function collectingState(
  task: Task,
  f: Fields,
  has: { business: boolean; booking: boolean },
): Extract<State, "collecting" | "choosing_place" | "confirming"> {
  const m = missing(task, f, has);
  if (m.length === 0) return "confirming";
  if (m.length === 1 && m[0] === "business") return "choosing_place";
  return "collecting";
}
