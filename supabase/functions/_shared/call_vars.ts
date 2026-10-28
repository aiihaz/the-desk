// The voice agent's input variables (eng plan 3.4), built by code from what the
// database holds for a reserved call: the request's fields (which reserve_call just
// checked against the consent), the business, the user and the picked option. Nothing a
// caller sends reaches the agent. Every variable for the call kind is present: an
// unknown value is null, and a missing required one stops the call before Sarvam.
import type { CallKind } from "./sarvam.ts";

export type CallInputs = {
  task: string;
  // requests.fields as stored (chat/slots.ts Fields).
  fields: Record<string, unknown>;
  businessName: string;
  customerPhone: string | null;
  // Booking calls: the option the user picked (consent #2).
  option: { label: string; value: Record<string, unknown> } | null;
  // Booking calls: the last completed first call on this request.
  prev: { at: string; contactName: string | null; summary: string | null } | null;
};

export class MissingCallInput extends Error {
  constructor(kind: CallKind, missing: string[]) {
    super(`${kind} call is missing ${missing.join(", ")}`);
  }
}

type Vars = Record<string, string | number | boolean | null>;

export function callVariables(kind: CallKind, x: CallInputs, mustReask: boolean): Vars {
  const f = x.fields;
  const str = (k: string) => (typeof f[k] === "string" ? f[k] as string : null);
  const num = (k: string) => (typeof f[k] === "number" ? f[k] as number : null);
  const mayBook = f.may_book === true;
  const missing: string[] = [];
  let v: Vars;

  switch (kind) {
    case "first": {
      v = {
        window_start: str("window_start"),
        window_end: str("window_end"),
        exact_time: str("exact_time"),
        tolerance_min: num("tolerance_min"),
        party_size: num("party_size"),
        service: str("service"),
        max_price: num("max_price_rs"),
        may_book: mayBook,
        max_advance_rs: num("max_advance_rs") ?? 0,
        customer_name: str("customer_name"),
        // The number is given only when booking on this call (3.4: otherwise never).
        customer_phone: mayBook ? x.customerPhone : null,
        also_ask: str("also_ask"),
      };
      if (x.task !== "booking") missing.push(`a booking request (this is ${x.task})`);
      if (v.party_size === null && v.service === null) missing.push("party_size or service");
      if (v.exact_time === null && (v.window_start === null || v.window_end === null)) missing.push("time");
      // A call that only asks gives no name or number (3.4), so it needs neither.
      if (mayBook && v.customer_name === null) missing.push("customer_name");
      if (typeof f.may_book !== "boolean") missing.push("may_book");
      if (mayBook && v.customer_phone === null) missing.push("customer_phone");
      break;
    }
    case "question": {
      // The question plan promises no booking and no name or number. Several questions
      // go as one numbered string; the agent's input is a single text variable.
      const qs = Array.isArray(f.questions) ? f.questions.filter((q) => typeof q === "string") : [];
      v = {
        question: qs.length > 1 ? qs.map((q, i) => `${i + 1}) ${q}`).join(" ") : qs[0] ?? str("question"),
      };
      if (x.task !== "question") missing.push(`a question request (this is ${x.task})`);
      if (v.question === null) missing.push("question");
      break;
    }
    case "booking": {
      const o = x.option;
      v = {
        option_label: o?.label ?? null,
        option_time: typeof o?.value.time === "string" ? o.value.time : null,
        party_size: num("party_size"),
        service: str("service"),
        max_advance_rs: num("max_advance_rs") ?? 0,
        customer_name: str("customer_name"),
        customer_phone: x.customerPhone,
        prev_call_time: x.prev?.at ?? null,
        prev_contact_name: x.prev?.contactName ?? null,
        prev_summary: x.prev?.summary ?? null,
      };
      if (!o) missing.push("option");
      if (v.customer_name === null) missing.push("customer_name");
      if (v.customer_phone === null) missing.push("customer_phone");
      if (!x.prev) missing.push("a completed first call");
      break;
    }
    case "reschedule":
      // Reschedules need Desk bookings (E6); until then there is nothing to build from.
      missing.push("reschedule support");
      v = {};
      break;
  }
  if (missing.length) throw new MissingCallInput(kind, missing);
  return { ...v, business_name: x.businessName, must_reask: mustReask };
}
