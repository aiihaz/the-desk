// The voice agent's outputs (final_agent_variables), read the same way whichever contract
// the agent was built with: eng plan 3.4 (booking_status, advance_amount) or the Genie
// brief section 6 (outcome, advance_amount_rs, options with details). Sarvam may hand
// variables back as strings, so "500", "yes" and JSON-encoded lists are read as what they
// mean. Anything that doesn't parse is left out: unknown is empty, never a guess.

// deno-lint-ignore no-explicit-any
type Json = any;

export type Outputs = {
  // first: booked | advance_required | not_booked
  // booking: booked | advance_required | option_gone | not_available
  booking_status?: string;
  // The Genie outcome when it has no booking_status equivalent (moved, kept, cancelled,
  // payment_not_seen, hold_expired, wrong_number, ...).
  outcome?: string;
  booked_time?: string;
  booking_reference?: string;
  no_match_reason?: string;
  options?: Json[];
  alternatives?: Json[];
  advance_amount?: number;
  // Is it adjusted against the bill, and is it refunded if they don't come, in their words.
  advance_redeemable?: string;
  advance_refund?: string;
  // yes | no: are they keeping the slot until the customer decides.
  advance_hold?: string;
  // upi | bank_transfer | qr | link | cash | other, and where to pay.
  payment_mode?: string;
  payment_address?: string;
  payee_name?: string;
  payment_deadline?: string;
  payment_status?: string;
  callback_time?: string;
  cancel_status?: string;
  cancel_charge_rs?: number;
  refund_stated?: string;
  original_booking_status?: string;
  answer?: string;
  // The answer to also_ask on a booking call.
  also_answer?: string;
  contact_name?: string;
  summary?: string;
  // What the caller left unresolved or heard contradicted, in its words.
  uncertainties?: string;
  unintended_commitment?: string;
  opt_out_requested?: "yes" | "no";
};

// Genie outcome → eng plan booking_status, by call kind. Outcomes that say nothing about a
// booking (voicemail, a phone menu, a dropped line) map to nothing, which reads as unclear.
const OUTCOME: Record<string, Record<string, string>> = {
  booked: { first: "booked", booking: "booked" },
  advance_required: { first: "advance_required", booking: "advance_required" },
  // What the outcome was called before an advance stopped being agreed on the call.
  held_pending_deposit: { first: "advance_required", booking: "advance_required" },
  options_found: { first: "not_booked", booking: "option_gone" },
  unavailable: { first: "not_booked", booking: "not_available" },
  refused: { first: "not_booked", booking: "not_available" },
  needs_customer_decision: { first: "not_booked", booking: "not_available" },
};

// Whether the caller reported any result at all. An agent with no structured outputs
// (only a free-text call_summary) leaves this false: Desk can't know what the call did.
export function hasResult(o: Outputs | null): boolean {
  return !!o && !!(o.booking_status || o.outcome || o.answer || o.also_answer || o.payment_status ||
    o.cancel_status || o.original_booking_status);
}

export function readOutputs(kind: string, raw: unknown): Outputs | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, Json>;
  const o: Outputs = {};

  const status = text(r.booking_status);
  const outcome = text(r.outcome);
  if (status) o.booking_status = status === "held_pending_deposit" ? "advance_required" : status;
  else if (outcome && OUTCOME[outcome]?.[kind]) o.booking_status = OUTCOME[outcome][kind];
  if (outcome) o.outcome = outcome;
  // A shop that wants the customer to decide (a card, a fee) is a new condition.
  const reason = text(r.no_match_reason) ?? (outcome === "needs_customer_decision" ? "new_condition" : null);
  if (reason) o.no_match_reason = reason;

  for (
    const k of [
      "booked_time",
      "booking_reference",
      "advance_redeemable",
      "advance_refund",
      "advance_hold",
      "payment_mode",
      "payment_address",
      "payee_name",
      "payment_deadline",
      "payment_status",
      "callback_time",
      "cancel_status",
      "refund_stated",
      "original_booking_status",
      "answer",
      "also_answer",
      "contact_name",
      "summary",
      "uncertainties",
    ] as const
  ) {
    const v = text(r[k]);
    if (v) o[k] = v;
  }
  if (!o.payment_address) {
    const a = text(r.upi_id);
    if (a) o.payment_address = a;
  }
  if (!o.summary) {
    const s = text(r.call_summary);
    if (s) o.summary = s;
  }
  if (!o.answer) {
    const a = text(r.answer_summary);
    if (a) o.answer = a;
  }

  // On a call that isn't a question call, an answer can only be to the extra question.
  if (!o.also_answer && kind !== "question" && o.answer) o.also_answer = o.answer;

  const options = list(r.options);
  const alternatives = list(r.alternatives);
  if (options) o.options = options.map(option);
  if (alternatives) o.alternatives = alternatives.map(option);
  // Genie puts call-2 alternatives in options.
  if (kind === "booking" && !o.alternatives && o.options) o.alternatives = o.options;

  const advance = num(r.advance_amount) ?? num(r.advance_amount_rs) ?? num(r.deposit_amount);
  if (advance !== null) o.advance_amount = advance;
  const charge = num(r.cancel_charge_rs);
  if (charge !== null) o.cancel_charge_rs = charge;

  if (yes(r.possible_unintended_commitment)) {
    o.unintended_commitment = text(r.unintended_commitment_details) ?? "yes";
  }
  o.opt_out_requested = yes(r.opt_out_requested) ? "yes" : "no";
  return o;
}

// Genie options carry details, price_rs and conditions; the chat side wants a label, and
// any condition means the option needs the user's decision.
function option(x: Json): Json {
  if (!x || typeof x !== "object") return x;
  const out = { ...x };
  if (!text(out.label) && text(out.details)) out.label = text(out.details);
  const size = num(out.party_size);
  if (size !== null) out.party_size = size;
  if (out.advance_required === "yes" || out.advance_required === "true") out.advance_required = true;
  return out;
}

// A value with no letter or digit in any script ("-", "n/a" isn't one) says nothing.
function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return /[\p{L}\p{N}]/u.test(t) && t.toLowerCase() !== "null" && t.toLowerCase() !== "none" ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v.replace(/[₹,\s]|^rs\.?/gi, ""));
  return Number.isFinite(n) ? n : null;
}

function yes(v: unknown): boolean {
  return v === true || (typeof v === "string" && ["yes", "true"].includes(v.trim().toLowerCase()));
}

function list(v: unknown): Json[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string" || !v.trim().startsWith("[")) return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
