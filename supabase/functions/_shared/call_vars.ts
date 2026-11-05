// The voice agent's input variables (eng plan 3.4), built by code from what the
// database holds for a reserved call: the request's fields (which reserve_call just
// checked against the consent), the business, the user and the picked option. Nothing a
// caller sends reaches the agent. Every variable for the call kind is present: an
// unknown value is null, and a missing required one stops the call before Sarvam.
//
// Names follow the Genie brief (section 4). The older names of eng plan 3.4 go along too,
// until the agent is built, so either contract works. Every call also gets the resolved
// errand: what's decided, what's flexible, what the caller may accept and what already
// happened, worked out here so the agent never has to.
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
  prev: { at: string; contactName: string | null; summary: string | null; alsoAnswered?: boolean } | null;
  // Reschedule, cancel: the Desk booking being changed. Payment confirm: the one paid for.
  booking: BookingInput | null;
  // Payment confirm: what the screenshot that passed the check showed.
  payment: { amountRs: number; ref: string; paidAt: string | null; payee: string | null } | null;
  // Cancel: the loss the user accepted by answering CANCEL to a read-back that named it.
  approvedLossRs: number;
  // The profile name, for a booking call that grew out of a question call.
  profileName?: string | null;
};

export type BookingInput = {
  time: string | null;
  // The day, when the call that made it gave no time.
  date?: string | null;
  reference: string | null;
  customerName: string | null;
  // An advance actually paid. Asked for and unpaid is nothing the customer can lose.
  depositRs: number | null;
  knownFeeRs: number | null;
};

const TZ = "Asia/Kolkata";

// "Sat, 24 Oct 2026, 8:15 pm": always with the year, so a follow-up call can't carry a
// wrong one past the business unnoticed.
function fullTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fullDay(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

// "Sat, 24 Oct 2026, 8:15 pm, table for 4, name Ihaz, ref T12": what the agent reads out
// to identify a booking.
function describeBooking(b: BookingInput, f: Record<string, unknown>): string {
  const when = b.time
    ? fullTime(b.time)
    : b.date
    ? `${fullDay(`${b.date}T12:00:00+05:30`)}, time not confirmed`
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

function requestWhat(f: Record<string, unknown>): string | null {
  return typeof f.party_size === "number" && typeof f.service === "string"
    ? `${f.service} for ${f.party_size}`
    : typeof f.party_size === "number"
    ? `table for ${f.party_size}`
    : typeof f.service === "string"
    ? f.service
    : null;
}

// "Saturday, 8 November 2026, 7:30 pm to 8:30 pm IST": no relative words, no arithmetic
// left for the agent.
function resolvedWhen(f: Record<string, unknown>, o: CallInputs["option"]): string | null {
  const t = typeof o?.value.time === "string"
    ? o.value.time
    : typeof f.exact_time === "string"
    ? f.exact_time
    : null;
  if (t) return `${fullDay(t)}, ${clock(t)} IST`;
  if (typeof f.window_start === "string" && typeof f.window_end === "string") {
    return `${fullDay(f.window_start)}, ${clock(f.window_start)} to ${clock(f.window_end)} IST`;
  }
  return null;
}

// Never agreed on a call. The customer decides, with everything the business said.
// The user asked for their number not to be given (share_phone false on a booking).
const NO_PHONE = "Don't give their phone number: they asked not to share it. If the business needs it to " +
  "book, don't book: find out why, and say you'll check and get back to them.";

const ADVANCE = "No advance: if they want one, don't agree. Take down the amount, whether it's adjusted " +
  "against the bill, whether it's refunded, how and where to pay, by when, whether they'll keep the " +
  "slot meanwhile and until when, then say you'll check and get back to them.";

// The errand as settled before the call. Every line comes from what the user approved.
function resolvedErrand(kind: CallKind, x: CallInputs, v: Vars, now: Date): Vars {
  const f = x.fields;
  const o = x.option;
  const when = resolvedWhen(f, o);
  const what = requestWhat(f);
  const picked = !!o;
  const mayBook = picked || (kind !== "question" && v.may_book === true);
  const conditions = typeof o?.value.conditions === "string" ? o.value.conditions : null;

  const baseDecision = kind === "question"
    ? `Only asking: ${v.question_text}`
    : kind === "cancel"
    ? `Cancel this booking: ${v.existing_booking}`
    : kind === "payment_confirm"
    ? `Confirm the payment for: ${v.held_booking}`
    : [
      what,
      kind === "reschedule" ? `move from: ${v.existing_booking}` : null,
      picked ? `the option picked: ${o.label}` : when,
      typeof v.customer_name === "string" ? `under the name ${v.customer_name}` : null,
      typeof v.also_ask === "string" ? `also ask: ${v.also_ask}` : null,
    ].filter(Boolean).join("; ");

  // These fields are included in the approved proposal. Keep them in the existing
  // decided variable so the deployed caller receives them without a new SDK contract.
  const serviceContext = ["first", "question", "booking", "reschedule"].includes(kind)
    ? [
      typeof f.service_address === "string" ? `service location: ${f.service_address}` : null,
      typeof f.service_details === "string" ? `service requirements: ${f.service_details}` : null,
    ].filter(Boolean)
    : [];
  const decided = [baseDecision, ...serviceContext].filter(Boolean).join("; ");

  const flexible = picked || !when || kind === "question" || kind === "cancel" || kind === "payment_confirm"
    ? "Nothing."
    : typeof f.exact_time === "string"
    ? (f.tolerance_min
      ? `Up to ${f.tolerance_min} minutes either way of the time.`
      : "Nothing: that exact time.")
    : "Any time inside the window.";

  const accept = kind === "question"
    ? "Take the answer down. If they offer to book or hold, thank them, get the times, price and conditions, and say you'll check and get back to them. Accept nothing."
    : kind === "cancel"
    ? (x.approvedLossRs
      ? `A loss of up to Rs ${x.approvedLossRs}. Anything more: don't cancel, come back.`
      : "No charge. If there is one: don't cancel, come back.")
    : kind === "payment_confirm"
    ? "Tell them the advance is paid and ask them to confirm the booking. Only their word that it was received. Agree nothing new."
    : mayBook
    ? [
      `Book only what is decided above${
        typeof f.max_price_rs === "number" ? `, up to Rs ${f.max_price_rs}` : ""
      }.`,
      conditions ? `Already accepted: ${conditions}.` : null,
      f.share_phone === false ? NO_PHONE : null,
      ADVANCE,
      "Anything else: don't accept, come back with it.",
    ].filter(Boolean).join(" ")
    : `Nothing yet: ask what's possible and come back. ${ADVANCE}`;

  const prev = typeof v.prev_summary === "string"
    ? `Called earlier${
      typeof v.prev_contact_name === "string" ? `, spoke to ${v.prev_contact_name}` : ""
    }: ${v.prev_summary}`
    : x.prev
    ? "Called earlier about this."
    : "Nothing yet: this is the first call.";

  return {
    call_date: fullDay(now.toISOString()),
    timezone: TZ,
    resolved_when: when,
    request_summary: kind === "question" ? null : [what, when].filter(Boolean).join(", ") || null,
    decided,
    flexible,
    may_accept: accept,
    already_happened: prev,
  };
}

const KIND: Record<CallKind, string> = {
  first: "First call about this errand.",
  booking: "Calling back to book the option they picked.",
  question: "Calling only to ask.",
  reschedule: "Calling to move an existing booking.",
  cancel: "Calling to cancel an existing booking.",
  payment_confirm: "Calling back to say the advance is paid and confirm the booking.",
};

// The live caller reads its errand from task_context, user_name and user_phone (Desk
// Caller v2-3). task_context is the resolved errand above, in one block, plus what only
// this kind of call needs. Only what the plan said is shared goes in: no name or number
// on a call that only asks.
function agentInputs(kind: CallKind, v: Vars, now: Date): Vars {
  const line = (label: string, value: unknown) =>
    value === null || value === undefined || value === "" ? null : `${label}: ${value}`;
  const task = [
    KIND[kind],
    line("What to ask", v.question_text),
    line("The booking", v.existing_booking ?? v.held_booking),
    line("Decided", v.decided),
    line("Flexible", v.flexible),
    line("You may agree to", v.may_accept),
    line("Already happened", v.already_happened),
    v.must_reask ? "It's been a while since the options: check it's still free before booking." : null,
    kind === "payment_confirm" && v.paid_amount_rs
      ? `The person you're calling for reports paying Rs ${v.paid_amount_rs}${
        v.payee ? ` to ${v.payee}` : ""
      }${v.payment_ref ? `, reference ending ${v.payment_ref}` : ""}. You may say this, as what they report.`
      : null,
    kind === "cancel" && typeof v.deposit_paid_rs === "number"
      ? `They paid a Rs ${v.deposit_paid_rs} advance for this booking.`
      : null,
  ].filter(Boolean).join("\n");
  const ist = new Intl.DateTimeFormat("en-IN", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(now);
  const part = (t: string) => ist.find((p) => p.type === t)?.value ?? "";
  return {
    task_context: task,
    user_name: typeof v.customer_name === "string" ? v.customer_name : "not given",
    user_phone: typeof v.customer_phone === "string" ? v.customer_phone : "not shared on this call",
    current_day: part("weekday"),
    current_date: `${part("day")} ${part("month")} ${part("year")}`,
    current_time: `${part("hour")}:${part("minute")} ${part("dayPeriod")}`.trim(),
  };
}

export function callVariables(kind: CallKind, x: CallInputs, mustReask: boolean, now = new Date()): Vars {
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
        max_price_rs: num("max_price_rs"),
        may_book: mayBook,
        // Name and number go only when booking on this call: the plan for a call that
        // only asks tells the user neither is shared.
        customer_name: mayBook ? str("customer_name") : null,
        customer_phone: mayBook && f.share_phone !== false ? x.customerPhone : null,
        also_ask: str("also_ask"),
      };
      if (x.task !== "booking") missing.push(`a booking request (this is ${x.task})`);
      if (v.party_size === null && v.service === null) missing.push("party_size or service");
      if (v.exact_time === null && (v.window_start === null || v.window_end === null)) missing.push("time");
      if (mayBook && v.customer_name === null) missing.push("customer_name");
      if (typeof f.may_book !== "boolean") missing.push("may_book");
      if (mayBook && f.share_phone !== false && v.customer_phone === null) missing.push("customer_phone");
      break;
    }
    case "question": {
      // No booking. Name and number go only if the plan said so, for an errand about
      // something of the user's own. Several questions go as one numbered string; the
      // agent's input is a single text variable.
      const qs = Array.isArray(f.questions) ? f.questions.filter((q) => typeof q === "string") : [];
      const question = qs.length > 1
        ? qs.map((q, i) => `${i + 1}) ${q}`).join(" ")
        : qs[0] ?? str("question");
      v = { question, question_text: question };
      if (f.share_name === true) v.customer_name = str("customer_name");
      if (f.share_phone === true) v.customer_phone = x.customerPhone;
      if (x.task !== "question") missing.push(`a question request (this is ${x.task})`);
      if (v.question === null) missing.push("question");
      if (f.share_name === true && v.customer_name === null) missing.push("customer_name");
      if (f.share_phone === true && v.customer_phone === null) missing.push("customer_phone");
      break;
    }
    case "booking": {
      const o = x.option;
      v = {
        option_label: o?.label ?? null,
        picked_option: o?.label ?? null,
        option_time: typeof o?.value.time === "string" ? o.value.time : null,
        approved_conditions: typeof o?.value.conditions === "string" ? o.value.conditions : null,
        party_size: num("party_size"),
        service: str("service"),
        // A question call that turned into an offer has no name stored yet.
        customer_name: str("customer_name") ?? x.profileName ?? null,
        customer_phone: f.share_phone === false ? null : x.customerPhone,
        // The plan promised to ask; a first call that got the answer already did.
        also_ask: x.prev?.alsoAnswered ? null : str("also_ask"),
        prev_call_time: x.prev?.at ?? null,
        prev_contact_name: x.prev?.contactName ?? null,
        prev_summary: x.prev?.summary ?? null,
      };
      if (!o) missing.push("option");
      if (v.customer_name === null) missing.push("customer_name");
      if (f.share_phone !== false && v.customer_phone === null) missing.push("customer_phone");
      if (!x.prev) missing.push("a completed earlier call");
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
        // Paying is what makes the booking, so this is the call that gives their details.
        customer_name: b?.customerName ?? str("customer_name") ?? x.profileName ?? null,
        customer_phone: f.share_phone === false ? null : x.customerPhone,
      };
      if (!b) missing.push("held_booking");
      if (!p) missing.push("payment");
      break;
    }
  }
  if (missing.length) throw new MissingCallInput(kind, missing);
  const all = {
    ...v,
    ...resolvedErrand(kind, x, v, now),
    business_name: x.businessName,
    must_reask: mustReask,
  };
  return { ...all, ...agentInputs(kind, all, now) };
}
