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
    case "question":
      return text(v, 200);
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
