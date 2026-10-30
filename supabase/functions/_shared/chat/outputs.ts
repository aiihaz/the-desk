// The voice agent's outputs (final_agent_variables), read the same way whichever contract
// the agent was built with: eng plan 3.4 (booking_status, advance_amount) or the Genie
// brief section 6 (outcome, advance_amount_rs, options with details). Sarvam may hand
// variables back as strings, so "500", "yes" and JSON-encoded lists are read as what they
// mean. Anything that doesn't parse is left out: unknown is empty, never a guess.

// deno-lint-ignore no-explicit-any
type Json = any;

export type Outputs = {
  // first: booked | held_pending_deposit | not_booked
  // booking: booked | held_pending_deposit | option_gone | not_available
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
  upi_id?: string;
  payee_name?: string;
  payment_deadline?: string;
  payment_status?: string;
  callback_time?: string;
  cancel_status?: string;
  cancel_charge_rs?: number;
  refund_stated?: string;
  original_booking_status?: string;
  answer?: string;
  contact_name?: string;
  summary?: string;
  unintended_commitment?: string;
  opt_out_requested?: "yes" | "no";
};

// Genie outcome → eng plan booking_status, by call kind. Outcomes that say nothing about a
// booking (voicemail, a phone menu, a dropped line) map to nothing, which reads as unclear.
const OUTCOME: Record<string, Record<string, string>> = {
  booked: { first: "booked", booking: "booked" },
  held_pending_deposit: { first: "held_pending_deposit", booking: "held_pending_deposit" },
  options_found: { first: "not_booked", booking: "option_gone" },
  unavailable: { first: "not_booked", booking: "not_available" },
  refused: { first: "not_booked", booking: "not_available" },
  needs_customer_decision: { first: "not_booked", booking: "not_available" },
};

export function readOutputs(kind: string, raw: unknown): Outputs | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, Json>;
  const o: Outputs = {};

  const status = text(r.booking_status);
  const outcome = text(r.outcome);
  if (status) o.booking_status = status;
  else if (outcome && OUTCOME[outcome]?.[kind]) o.booking_status = OUTCOME[outcome][kind];
  if (outcome) o.outcome = outcome;
  // A shop that wants the customer to decide (a card, a fee) is a new condition.
  const reason = text(r.no_match_reason) ?? (outcome === "needs_customer_decision" ? "new_condition" : null);
  if (reason) o.no_match_reason = reason;

  for (
    const k of [
      "booked_time",
      "booking_reference",
      "upi_id",
      "payee_name",
      "payment_deadline",
      "payment_status",
      "callback_time",
      "cancel_status",
      "refund_stated",
      "original_booking_status",
      "answer",
      "contact_name",
      "summary",
    ] as const
  ) {
    const v = text(r[k]);
    if (v) o[k] = v;
  }
  if (!o.answer) {
    const a = text(r.answer_summary);
    if (a) o.answer = a;
  }

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

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.toLowerCase() !== "null" && t.toLowerCase() !== "none" ? t : null;
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
