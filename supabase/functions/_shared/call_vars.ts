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
  // Booking calls: the last completed first call on this request. Reschedule and cancel:
  // the call that made the booking.
  prev: { at: string; contactName: string | null; summary: string | null } | null;
  // Reschedule, cancel: the Desk booking being changed. Payment confirm: the held one.
  booking: BookingInput | null;
  // Payment confirm: what the screenshot that passed the check showed.
  payment: { amountRs: number; ref: string; paidAt: string | null; payee: string | null } | null;
  // Cancel: the loss the user accepted by answering CANCEL to a read-back that named it.
  approvedLossRs: number;
};

export type BookingInput = {
  time: string | null;
  reference: string | null;
  customerName: string | null;
  depositRs: number | null;
  knownFeeRs: number | null;
};

// "Fri 24 Oct 2026, 20:15 IST, table for 4, name Ihaz, ref T12": what the agent reads
// out to identify a booking.
function describeBooking(b: BookingInput, f: Record<string, unknown>): string {
  const when = b.time
    ? new Date(b.time).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    })
    : "time not recorded";
  const what = typeof f.party_size === "number"
    ? `table for ${f.party_size}`
    : typeof f.service === "string"
    ? f.service
    : null;
  return [
    when,
    what,
    b.customerName ? `name ${b.customerName}` : null,
    b.reference ? `ref ${b.reference}` : null,
  ]
    .filter(Boolean).join(", ");
}

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
    case "reschedule": {
      // Ask to move the booking, never cancel it (E4 design 2.7). With an option (call 2
      // after options), move it to exactly that; otherwise to the new window.
      const b = x.booking;
      const o = x.option;
      v = {
        existing_booking: b ? describeBooking(b, f) : null,
        window_start: o ? null : str("window_start"),
        window_end: o ? null : str("window_end"),
        exact_time: o && typeof o.value.time === "string" ? o.value.time : o ? null : str("exact_time"),
        tolerance_min: o ? 0 : num("tolerance_min"),
        picked_option: o?.label ?? null,
        party_size: num("party_size"),
        service: str("service"),
        may_book: o ? true : mayBook,
        customer_name: b?.customerName ?? str("customer_name"),
        customer_phone: x.customerPhone,
        prev_call_time: x.prev?.at ?? null,
        prev_contact_name: x.prev?.contactName ?? null,
        prev_summary: x.prev?.summary ?? null,
      };
      if (x.task !== "reschedule") missing.push(`a reschedule request (this is ${x.task})`);
      if (!b) missing.push("existing_booking");
      if (!o && v.exact_time === null && (v.window_start === null || v.window_end === null)) {
        missing.push("new time");
      }
      break;
    }
    case "cancel": {
      const b = x.booking;
      v = {
        existing_booking: b ? describeBooking(b, f) : null,
        customer_name: b?.customerName ?? null,
        customer_phone: x.customerPhone,
        deposit_paid_rs: b?.depositRs ?? null,
        // A known loss the user accepted with CANCEL (2.9); otherwise accept none.
        approved_loss_rs: x.approvedLossRs,
        prev_call_time: x.prev?.at ?? null,
        prev_contact_name: x.prev?.contactName ?? null,
        prev_summary: x.prev?.summary ?? null,
      };
      if (x.task !== "cancel") missing.push(`a cancel request (this is ${x.task})`);
      if (!b) missing.push("existing_booking");
      break;
    }
    case "payment_confirm": {
      const b = x.booking;
      const p = x.payment;
      v = {
        held_booking: b ? describeBooking(b, f) : null,
        paid_amount_rs: p?.amountRs ?? null,
        payment_ref: p?.ref ?? null,
        paid_at: p?.paidAt ?? null,
        payee: p?.payee ?? null,
        customer_name: b?.customerName ?? str("customer_name"),
      };
      if (!b) missing.push("held_booking");
      if (!p) missing.push("payment");
      break;
    }
  }
  if (missing.length) throw new MissingCallInput(kind, missing);
  return { ...v, business_name: x.businessName, must_reask: mustReask };
}
