// After a call (sarvam-webhook hand-off): read what the voice agent reported, verify it,
// settle the request (settle_call), and store the facts the user is owed. Code decides what
// the call established and records all of it; a model writes the message from those facts
// (tell.ts), so nothing here composes words for the user, and a fact can't be dropped by a
// branch that forgot it. Nothing is "booked" unless the agent reported booking_status booked,
// and anything the outputs don't make clear is recorded as not known.
//
// The outputs read here are the caller contract (eng plan 3.4, final_agent_variables),
// or the Genie brief's, read the same way by outputs.ts:
//   booking_status    first: booked | advance_required | not_booked
//                     booking: booked | advance_required | option_gone | not_available
//   booked_time       ISO 8601, the time they booked
//   booking_reference text, if they gave one
//   no_match_reason   no_slot | several_options | advance | price | new_condition | unclear
//   options           first call, up to 3: {time, party_size?, label?, advance_required?}
//   alternatives      booking call, the same shape as options
//   advance_amount    rupees, when they want an advance, with advance_redeemable,
//                     advance_refund, advance_hold, payment_mode, payment_address,
//                     payee_name and payment_deadline
//   answer            question calls: what the business said
//   payment_status    payment_confirm: received | not_seen | wrong_amount | disputed | unclear
//   cancel_status     cancel: cancelled | charge_pending | not_cancelled | unclear
//   original_booking_status  reschedule: kept | moved | cancelled | unclear
//   opt_out_requested yes | no
// Text from the call is the business's words: quoted, length-capped, never instructions.
//
// The result and the facts are stored together (settle_and_report), then written and sent
// through deliveries, so a failed write or send is retried by the recovery pass and a
// redelivered result sends nothing twice (followup.ts).
import type { CallResult } from "../sarvam.ts";
import { drainDeliveries } from "./followup.ts";
import { hasResult, type Outputs, readOutputs } from "./outputs.ts";
import { fmtDate, fmtDayFull, fmtFull, fmtTime, fmtWhen, type Place, placeName } from "./readback.ts";
import { currentQuestions } from "./slots.ts";
import type { ActiveRequest, CallForReport, CallSettlement } from "./store.ts";
import { type Facts, type NextStep, type TellDeps, writeOwed } from "./tell.ts";
import { cleanField } from "./tools.ts";
import {
  approvedTime,
  type BookedWhen,
  type CheckClaim,
  instant,
  readBookedWhen,
  type Verification,
  type Verify,
} from "./verify.ts";

export type ReportDeps = TellDeps & {
  // Booking verification (verify.ts). Without it no booking is reported as verified.
  verify?: Verify;
  // The same check for cancels and confirm calls; without it neither is reported as done.
  checkClaim?: CheckClaim;
};

type Option = { label: string; value: Record<string, unknown>; advance_required: boolean };

// Everything the business said about an advance. Nothing here was agreed.
export type AdvanceTerms = {
  amount_rs: number | null;
  // Is it adjusted against the bill, and is it refunded, in their words.
  redeemable: string | null;
  refund: string | null;
  // Whether they're keeping the slot until the customer decides.
  holding: "yes" | "no" | null;
  mode: string | null;
  address: string | null;
  payee: string | null;
  deadline: string | null;
  time: string | null;
};

// What the outputs establish, and nothing more.
export type Outcome =
  // captured: booked_time as the caller reported it; only verifying decides what stands.
  | { kind: "booked"; captured: string | null; reference: string | null }
  | { kind: "needs_advance"; terms: AdvanceTerms }
  | { kind: "options"; options: Option[]; reason: string | null }
  | { kind: "not_available"; reason: string | null }
  // offer: a question call where the business offered to book. Brought back for the user
  // to pick, with its conditions: not accepted, not refused, not a final price.
  | { kind: "answered"; answer: string; offer: Option[] }
  | { kind: "unclear" };

// deno-lint-ignore no-explicit-any
type Json = any;

function advanceTerms(out: Outputs): AdvanceTerms {
  const hold = out.advance_hold?.trim().toLowerCase();
  return {
    amount_rs: out.advance_amount ?? null,
    redeemable: cleanField(out.advance_redeemable, 200),
    refund: cleanField(out.advance_refund, 200),
    holding: hold === "yes" || hold === "no" ? hold : null,
    mode: cleanField(out.payment_mode, 40),
    address: cleanField(out.payment_address, 120),
    payee: cleanField(out.payee_name, 80),
    deadline: instant(out.payment_deadline),
    time: instant(out.booked_time),
  };
}

export function readOutcome(kind: string, raw: Json, now: Date): Outcome {
  const out = readOutputs(kind, raw);
  if (!out) return { kind: "unclear" };
  if (kind === "question") {
    const answer = cleanField(out.answer, 500);
    const offer = usable(out.options ?? [], now);
    return answer || offer.length ? { kind: "answered", answer: answer ?? "", offer } : { kind: "unclear" };
  }
  const status = out.booking_status;
  if (status === "booked") {
    return {
      kind: "booked",
      captured: out.booked_time ?? null,
      reference: cleanField(out.booking_reference, 40),
    };
  }
  if (status === "advance_required") return { kind: "needs_advance", terms: advanceTerms(out) };
  if (status && ["not_booked", "option_gone", "not_available"].includes(status)) {
    const offered = (kind === "booking" ? out.alternatives : out.options) ?? out.options ?? [];
    const options = usable(offered, now);
    const reason = typeof out.no_match_reason === "string" ? out.no_match_reason : null;
    if (options.length) return { kind: "options", options, reason };
    return reason === "advance"
      ? { kind: "needs_advance", terms: advanceTerms(out) }
      : { kind: "not_available", reason };
  }
  return { kind: "unclear" };
}

function usable(offered: Json[], now: Date): Option[] {
  return offered.slice(0, 3).map((o: Json) => option(o, now)).filter((
    o: Option | null,
  ): o is Option => !!o);
}

// An offered option is usable only with a time in the future or a label to show. Its
// price and conditions stay in the label, so what the user picks says them; a price is
// what they quoted, never a final one.
function option(o: Json, now: Date): Option | null {
  if (!o || typeof o !== "object") return null;
  const time = instant(o.time);
  if (time && Date.parse(time) <= now.getTime()) return null;
  const words = cleanField(o.label, 60);
  const when = time ? `${fmtDayFull(new Date(time), now)}, ${fmtTime(new Date(time))}` : words;
  if (!when) return null;
  const price = typeof o.price_rs === "number" && o.price_rs > 0 ? o.price_rs : null;
  const conditions = cleanField(o.conditions, 120);
  const label = [when, price ? `Rs ${price}` : null, conditions].filter(Boolean).join(", ");
  const value: Record<string, unknown> = {};
  if (time) value.time = time;
  if (time && words) value.note = words;
  if (Number.isInteger(o.party_size)) value.party_size = o.party_size;
  if (price) value.price_rs = price;
  if (conditions) value.conditions = conditions;
  return { label, value, advance_required: o.advance_required === true };
}

// What a verified or unverified booking is stored as.
type Booked = {
  v: Verification;
  time: string | null;
  date: string | null;
  when: BookedWhen;
  approved: string | null;
};

function bookingRow(b: Booked, reference: string | null): NonNullable<CallSettlement["booking"]> {
  return {
    time: b.time,
    reference,
    verified: b.v.verified,
    problems: b.v.problems,
    conditions: b.v.conditions ?? [],
    decision_open: !!b.v.decisionOpen,
    ...(b.date ? { date: b.date } : {}),
    ...(b.when.captured ? { captured: b.when.captured } : {}),
    ...(b.approved ? { approved: b.approved } : {}),
  };
}

async function verifyCall(
  deps: ReportDeps,
  call: CallForReport,
  captured: string | null,
  r: CallResult,
  now: Date,
): Promise<Booked> {
  const req = await deps.store.request(call.requestId);
  const tol = (await deps.store.limitInt("match_tolerance_minutes", call.userId)) ?? 15;
  // A confirm call must confirm the held booking's time; a reschedule after options, the
  // option; a reschedule on call 1, the new window, as a first call would.
  const option = call.kind === "payment_confirm"
    ? (call.bookingTime ? { label: "the booking", value: { time: call.bookingTime } } : null)
    : call.option;
  const kind = call.kind === "booking" || option ? "booking" : "first";
  const fields = req.fields as Record<string, unknown>;
  const approved = approvedTime({ kind, option, fields });
  const heard = readBookedWhen(captured);
  const v = deps.verify
    ? await deps.verify({
      kind,
      fields,
      option,
      bookedTime: heard.time,
      bookedDate: heard.date,
      transcript: r.transcript,
      defaultToleranceMin: tol,
      advancePaidRs: call.kind === "payment_confirm" ? call.advanceRs ?? 0 : 0,
      today: fmtFull(now),
    }, call.userId)
    : { verified: false, problems: ["no verifier"], verdict: null };
  deps.trace?.("verify", v);
  return {
    v,
    time: v.badYear ? null : v.heard?.time ?? heard.time,
    date: v.badYear ? null : v.heard?.date ?? heard.date,
    when: heard,
    approved,
  };
}

async function claimHolds(deps: ReportDeps, call: CallForReport, claim: string, r: CallResult) {
  const v = deps.checkClaim
    ? await deps.checkClaim(claim, r.transcript, call.userId)
    : { verified: false, problems: ["no claim checker"], verdict: null };
  deps.trace?.("check_claim", { claim, ...v });
  return v;
}

function when(t: string, now: Date): string {
  return `${fmtDayFull(new Date(t), now)} at ${fmtTime(new Date(t))}`;
}

// What the call means for the user, as facts. values go into the message exactly.
type Told = {
  status: string;
  detail?: Record<string, unknown>;
  values?: Record<string, string | null | undefined>;
  next?: NextStep | null;
};

type Decision = { settle: CallSettlement; told: Told };

function conditionFacts(v: Verification) {
  return (v.conditions ?? []).map((c) => ({
    their_words: c.words,
    what: c.what,
    required: c.required,
    already_approved: c.covered,
  }));
}

// The facts of a booking the business says it made, however that verified.
function bookedFacts(
  b: Booked,
  reference: string | null,
  verified: string,
  unverified: string,
  call: CallForReport,
  now: Date,
): Told {
  const at = b.time ? when(b.time, now) : b.date ? `${fmtDate(b.date, now)}, no time confirmed` : null;
  const conditions = conditionFacts(b.v);
  const detail: Record<string, unknown> = {
    ...(conditions.length ? { conditions } : {}),
    ...(b.v.badYear
      ? { year_doesnt_match: { caller_noted: b.when.captured, they_asked_for: b.approved } }
      : {}),
    ...(!b.v.verified && b.when.captured && !b.time && !b.date ? { caller_noted: b.when.captured } : {}),
  };
  if (b.v.verified) {
    return { status: verified, detail, values: { when: at, reference } };
  }
  if (b.v.decisionOpen) {
    return {
      status: `${unverified}_but_requires_something_not_approved`,
      detail,
      values: { when: at, reference },
      next: "decide_on_condition",
    };
  }
  return {
    status: `${unverified}_not_verified`,
    detail: { ...detail, why_not_verified: b.v.problems },
    values: { when: at, reference, phone: call.phone },
    next: "check_with_business_themselves",
  };
}

const offered = (options: Option[], extra: Record<string, unknown> = {}): Told => ({
  status: "options_offered",
  detail: {
    ...extra,
    options: options.map((o, i) => ({
      value: `option_${i + 1}`,
      // Only ever what they said: an option with no mention of one says nothing either way.
      ...(o.advance_required ? { advance_required: true } : {}),
      ...(typeof o.value.note === "string" ? { note: o.value.note } : {}),
    })),
  },
  values: Object.fromEntries(options.map((o, i) => [`option_${i + 1}`, o.label])),
  next: "pick_an_option",
});

// A shape, not a word: an address like name@bank can be checked against a UPI screenshot.
const UPI = /^[^@\s]+@[^@\s]+$/;

// They want an advance. Nothing is agreed: the terms go to the user, who decides and pays
// them directly, and the request waits with them.
function advanceDecision(t: AdvanceTerms, now: Date): Decision {
  const unknown = [
    t.amount_rs === null ? "the amount" : null,
    t.address || t.payee ? null : "where to pay",
    t.redeemable ? null : "whether it's adjusted against the bill",
    t.refund ? null : "whether it's refunded",
    t.deadline ? null : "by when",
  ].filter(Boolean);
  return {
    settle: {
      result: "advance",
      booking: {
        time: t.time,
        amount_rs: t.amount_rs,
        upi_id: t.address && UPI.test(t.address) ? t.address : null,
        payee_name: t.payee,
        deadline: t.deadline,
        terms: t,
      },
    },
    told: {
      status: "business_wants_advance_nothing_agreed",
      detail: {
        to_go_ahead:
          "they pay the business themselves and send the screenshot here; the desk then calls to say it's done",
        ...(t.redeemable ? { adjusted_against_bill_their_words: t.redeemable } : {}),
        ...(t.refund ? { refund_their_words: t.refund } : {}),
        keeping_the_slot_meanwhile: t.holding ?? "they didn't say",
        ...(t.mode ? { payment_mode: t.mode } : {}),
        ...(unknown.length ? { not_known: unknown } : {}),
      },
      values: {
        advance: t.amount_rs === null ? null : `Rs ${t.amount_rs}`,
        pay_to: t.address,
        payee: t.payee,
        deadline: t.deadline ? fmtFull(new Date(t.deadline)) : null,
        slot: t.time ? when(t.time, now) : null,
      },
      next: "decide_on_advance",
    },
  };
}

// First and booking calls: booked (verified or not), an advance, other times, nothing.
async function decideBooking(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  outcome: Outcome,
  now: Date,
): Promise<Decision> {
  switch (outcome.kind) {
    case "booked": {
      const b = await verifyCall(deps, call, outcome.captured, r, now);
      return {
        settle: { result: "done", booking: bookingRow(b, outcome.reference) },
        told: bookedFacts(b, outcome.reference, "booked_and_verified", "business_said_booked", call, now),
      };
    }
    case "needs_advance":
      return advanceDecision(outcome.terms, now);
    case "options":
      return {
        settle: { result: "options", options: outcome.options },
        told: offered(outcome.options, { why_not_what_they_asked: outcome.reason }),
      };
    case "not_available":
      return {
        settle: { result: "back" },
        told: {
          status: "not_available_nothing_offered_nothing_booked",
          detail: { why: outcome.reason },
          next: "offer_to_try_again",
        },
      };
    case "answered": {
      const said = outcome.answer ? { they_said: outcome.answer } : {};
      if (outcome.offer.length) {
        return {
          settle: { result: "options", options: outcome.offer },
          told: offered(outcome.offer, { ...said, they_offered_to_book: true }),
        };
      }
      return { settle: { result: "done" }, told: { status: "question_answered", detail: said } };
    }
    default:
      return {
        settle: { result: "back" },
        told: { status: "connected_no_clear_answer_nothing_done", next: "offer_to_try_again" },
      };
  }
}

// The confirm call after a payment screenshot (eng plan 2.2 step 4). What the business said
// about the money is their claim: a payment they haven't seen isn't a payment that failed.
async function decidePayment(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  now: Date,
): Promise<Decision> {
  const out = readOutputs(call.kind, r.outputs) ?? {};
  const said = cleanField(out.summary ?? out.answer, 200);
  const status = out.payment_status;
  const paid = call.advanceRs ? { paid: `Rs ${call.advanceRs}` } : {};
  if (status === "received" && out.booking_status === "booked") {
    const b = await verifyCall(deps, call, out.booked_time ?? call.bookingTime, r, now);
    const ref = cleanField(out.booking_reference, 40);
    const told = bookedFacts(
      b,
      ref,
      "business_confirmed_payment_and_booking",
      "business_said_paid_and_booked",
      call,
      now,
    );
    return {
      settle: { result: "done", booking: bookingRow(b, ref) },
      told: { ...told, values: { ...told.values, ...paid } },
    };
  }
  if (status === "not_seen" || out.outcome === "payment_not_seen") {
    if (!call.isRetry) {
      const mins = (await deps.store.limitInt("payment_confirm_retry_minutes", call.userId)) ?? 30;
      return {
        settle: { result: "retry" },
        told: {
          status: "business_says_payment_not_seen_desk_will_call_them_again",
          detail: { desk_calling_them_again_in_minutes: mins, they_said: said },
        },
      };
    }
    return {
      settle: { result: "unconfirmed", booking: { said } },
      told: {
        status: "business_says_payment_still_not_seen",
        detail: { they_said: said, the_user_reports_having_paid: true },
        values: { phone: call.phone, ...paid },
        next: "check_with_business_themselves",
      },
    };
  }
  // Wrong amount, a dispute, an expired hold, or anything unclear: report what they said,
  // agree nothing, promise nothing.
  return {
    settle: { result: "unconfirmed", booking: { said } },
    told: {
      status: "business_did_not_confirm_payment_or_booking",
      detail: { they_said: said, payment_status: status ?? "unclear", nothing_agreed: true },
      values: { phone: call.phone, ...paid },
      next: "check_with_business_themselves",
    },
  };
}

// Cancelling a Desk booking (E4 design 2.9). A refund is reported only as their words.
async function decideCancel(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  now: Date,
): Promise<Decision> {
  const out = readOutputs(call.kind, r.outputs) ?? {};
  const status = out.cancel_status ?? (out.outcome === "cancelled" ? "cancelled" : undefined);
  const booking = call.bookingTime ? when(call.bookingTime, now) : null;
  const values = { booking };
  const said = cleanField(out.summary, 200);
  const refund = cleanField(out.refund_stated, 200);
  if (status === "cancelled") {
    const claim = `The business cancelled the customer's booking${booking ? ` for ${booking}` : ""}.`;
    const v = await claimHolds(deps, call, claim, r);
    const conditions = conditionFacts(v);
    if (v.verified) {
      return {
        settle: { result: "cancelled" },
        told: {
          status: "cancelled_and_verified",
          detail: {
            ...(refund ? { refund_their_words: refund } : {}),
            ...(conditions.length ? { conditions } : {}),
          },
          values,
        },
      };
    }
    return {
      settle: { result: "unconfirmed", booking: { problems: v.problems } },
      told: {
        status: "caller_says_cancelled_not_verified_booking_may_still_stand",
        detail: { why_not_verified: v.problems, ...(conditions.length ? { conditions } : {}) },
        values: { ...values, phone: call.phone },
        next: "check_with_business_themselves",
      },
    };
  }
  if (status === "charge_pending") {
    const fee = out.cancel_charge_rs ?? null;
    return {
      settle: { result: "back", booking: { fee_rs: fee, charge_stated: true } },
      told: {
        status: "business_says_cancelling_costs_money_not_agreed_booking_stands",
        detail: { they_said: said },
        values: { ...values, charge: fee ? `Rs ${fee}` : null },
        next: "say_if_still_cancelling_despite_charge",
      },
    };
  }
  if (status === "not_cancelled") {
    return {
      settle: { result: "back" },
      told: { status: "business_did_not_cancel_booking_stands", detail: { they_said: said }, values },
    };
  }
  return {
    settle: { result: "unconfirmed", booking: { said } },
    told: {
      status: "asked_to_cancel_outcome_unclear_booking_may_still_stand",
      detail: { they_said: said },
      values: { ...values, phone: call.phone },
      next: "check_with_business_themselves",
    },
  };
}

// Moving a Desk booking (E4 design 2.7): moved, kept (maybe with other times), or unclear.
// Until the move verifies, the original booking is what's known to stand.
async function decideReschedule(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  now: Date,
): Promise<Decision> {
  const out = readOutputs(call.kind, r.outputs) ?? {};
  const orig = out.original_booking_status ??
    (out.outcome === "moved" || out.outcome === "kept" ? out.outcome : null);
  const original = call.bookingTime ? when(call.bookingTime, now) : null;
  const said = cleanField(out.summary, 200);
  if (orig === "moved" || (!orig && out.booking_status === "booked")) {
    const b = await verifyCall(deps, call, out.booked_time ?? null, r, now);
    const ref = cleanField(out.booking_reference, 40);
    const told = bookedFacts(b, ref, "moved_and_verified", "business_said_moved", call, now);
    return {
      settle: { result: "done", booking: bookingRow(b, ref) },
      told: {
        ...told,
        detail: {
          ...told.detail,
          ...(b.v.verified ? {} : { original_booking_stands_until_confirmed: true }),
        },
        values: { ...told.values, original },
      },
    };
  }
  if (orig === "kept") {
    const options = usable(out.alternatives ?? out.options ?? [], now);
    if (options.length) {
      return {
        settle: { result: "options", options },
        told: {
          ...offered(options, { could_not_move_it: true, their_booking_stands: true }),
          values: { ...offered(options).values, original },
        },
      };
    }
    return {
      settle: { result: "done" },
      told: {
        status: "could_not_move_it_booking_stands",
        detail: { they_said: said },
        values: { original },
      },
    };
  }
  return {
    settle: { result: "unconfirmed", booking: { said } },
    told: {
      status: "asked_to_move_outcome_unclear_original_booking_may_still_stand",
      detail: { they_said: said },
      values: { original, phone: call.phone },
      next: "check_with_business_themselves",
    },
  };
}

// The user said cancel while the call ran. Nothing booked or agreed: the errand ends, and
// what the call found is still told, as a record. Booked: it stands until they say
// otherwise, because only they can decide to undo what the business already agreed.
function afterCancel(d: Decision): { decision: Decision; end: boolean } {
  const { result } = d.settle;
  const told = (extra: Record<string, unknown>, next: NextStep | null = null): Told => ({
    ...d.told,
    detail: { ...d.told.detail, they_asked_to_cancel_during_the_call: true, ...extra },
    next,
  });
  if (result === "options" || result === "back" || result === "advance") {
    return {
      decision: {
        settle: { result: "back", optOut: d.settle.optOut },
        told: told({ errand_dropped_nothing_booked: true, nothing_is_open_to_pick_or_pay: true }),
      },
      end: true,
    };
  }
  if (result === "done" && !d.settle.booking) {
    return { decision: { ...d, told: told({ errand_closed: true }) }, end: true };
  }
  return {
    decision: {
      ...d,
      told: told(
        { it_had_already_happened: true },
        result === "done" ? "say_if_still_cancelling" : d.told.next,
      ),
    },
    end: false,
  };
}

function errandFacts(req: ActiveRequest, call: CallForReport, now: Date): Record<string, unknown> {
  const f = req.fields;
  const qs = currentQuestions(f);
  return {
    task: call.task,
    call: call.kind,
    what: f.party_size ? `table for ${f.party_size}` : f.service,
    when: fmtWhen(f, now) || null,
    ...(qs.length ? { questions: qs } : {}),
    ...(call.option ? { picked: call.option.label } : {}),
  };
}

// The extra question: the plan promised to ask, so the facts say what came back, or that
// nothing did. A booking call asks only if the first call didn't get an answer, so only
// its answer is news.
function alsoAsked(req: ActiveRequest, call: CallForReport, r: CallResult): Record<string, unknown> | null {
  if (r.status !== "completed" || (call.kind !== "first" && call.kind !== "booking")) return null;
  const ask = req.fields.also_ask;
  if (!ask) return null;
  const answer = cleanField(readOutputs(call.kind, r.outputs)?.also_answer, 300);
  if (!answer && call.kind !== "first") return null;
  return { also_asked: { question: ask, their_answer: answer ?? "no clear answer" } };
}

function notConnected(r: CallResult, call: CallForReport): Decision {
  const unpaid = call.kind === "payment_confirm" ? { payment_still_unconfirmed: true } : {};
  switch (r.status) {
    case "no_answer":
      return {
        settle: { result: "back" },
        told: { status: "no_one_picked_up_nothing_done", detail: unpaid, next: "offer_to_try_again" },
      };
    case "busy":
      return {
        settle: { result: "back" },
        told: { status: "line_busy_nothing_done", detail: unpaid, next: "offer_to_try_again" },
      };
    default:
      // reconcile: the call may have happened, but no result ever came back.
      return r.failureReason === "no_result"
        ? {
          settle: { result: "back" },
          told: {
            status: "no_result_came_back_cannot_say_what_they_said",
            detail: unpaid,
            values: { phone: call.phone },
            next: "check_with_business_themselves",
          },
        }
        : {
          settle: { result: "back" },
          told: {
            status: "call_did_not_go_through_nothing_done",
            detail: unpaid,
            next: "offer_to_try_again",
          },
        };
  }
}

export async function reportCall(deps: ReportDeps, callId: string, r: CallResult): Promise<void> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const call = await store.callForReport(callId);
  if (!call) return console.warn("report: unknown call", callId);
  const place: Place = await store.place(call.businessId);
  const req = await store.request(call.requestId);
  const outputs = readOutputs(call.kind, r.outputs);
  const optOut = outputs?.opt_out_requested === "yes";

  let d: Decision;
  if (r.status !== "completed") d = notConnected(r, call);
  else if (call.kind === "payment_confirm") d = await decidePayment(deps, call, r, now);
  else if (call.kind === "cancel") d = await decideCancel(deps, call, r, now);
  else if (call.kind === "reschedule") d = await decideReschedule(deps, call, r, now);
  else d = await decideBooking(deps, call, r, readOutcome(call.kind, r.outputs, now), now);

  let end = false;
  if (call.cancelRequested && call.kind !== "payment_confirm") ({ decision: d, end } = afterCancel(d));

  // The call connected and the caller reported no result: an agent without the output
  // contract (agent/contract.json). It may well have booked, so "nothing is done, try
  // again?" could book twice. Record what isn't known, its note as its note, flag it,
  // and block the version for real businesses (0013).
  const blind = r.status === "completed" && !hasResult(outputs);
  if (blind && d.settle.result === "back") {
    d.told = {
      status: "connected_result_missing_may_or_may_not_have_gone_through",
      detail: { ...d.told.detail, callers_own_note_unconfirmed: cleanField(outputs?.summary, 240) },
      values: { phone: call.phone },
      next: "check_with_business_themselves",
    };
  }

  const settle = d.settle;
  settle.optOut = optOut;
  const values = Object.fromEntries(
    Object.entries(d.told.values ?? {}).filter((e): e is [string, string] => !!e[1]),
  );
  const facts: Facts = {
    event: "call_result",
    place: placeName(place),
    errand: errandFacts(req, call, now),
    happened: {
      status: d.told.status,
      ...d.told.detail,
      ...alsoAsked(req, call, r),
      ...(optOut ? { business_asked_not_to_be_called_again_so_it_wont_be: true } : {}),
    },
    values,
    next_step: d.told.next ?? null,
  };

  let next = null;
  if (end || ["done", "unconfirmed", "cancelled"].includes(settle.result)) {
    const n = await store.queued(call.userId);
    if (n) {
      next = {
        request_id: n.id,
        facts: { task: n.task, place: n.businessId ? (await store.place(n.businessId)).name : null },
      };
    }
  }

  const res = await store.settleCall(callId, settle, { facts, next, end });
  deps.trace?.("settle_call", { callId, settle, facts, res });
  // Already settled (a redelivered result): the user has heard, or the recovery pass will
  // finish telling them.
  if (!res.ok) return;
  if (r.status === "completed" && r.outputs) await store.recordCallerOutputs(callId, Object.keys(r.outputs));
  if (blind) {
    await store.callerContractBroken(callId);
    await store.raiseAlert("caller_contract_missing", call.requestId, callId, {
      kind: call.kind,
      outputs: Object.keys(r.outputs ?? {}),
    });
  }
  await writeOwed(deps, callId);
  await drainDeliveries(deps, callId);
}
