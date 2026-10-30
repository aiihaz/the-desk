// After a call (sarvam-webhook hand-off): read what the voice agent reported, settle the
// request (settle_call), and tell the user what actually happened. The message is built
// by code from the caller's outputs, so it can't say more than the call established:
// nothing is "booked" unless the agent reported booking_status booked, and anything the
// outputs don't make clear goes back to the user as not done.
//
// The outputs read here are the caller contract (eng plan 3.4, final_agent_variables),
// or the Genie brief's, read the same way by outputs.ts:
//   booking_status    first: booked | held_pending_deposit | not_booked
//                     booking: booked | held_pending_deposit | option_gone | not_available
//   booked_time       ISO 8601, the time they booked
//   booking_reference text, if they gave one
//   no_match_reason   no_slot | several_options | advance | price | new_condition | unclear
//   options           first call, up to 3: {time, party_size?, label?, advance_required?}
//   alternatives      booking call, the same shape as options
//   advance_amount    rupees, when they want an advance; upi_id, payee_name, payment_deadline
//   answer            question calls: what the business said
//   payment_status    payment_confirm: received | not_seen | wrong_amount | disputed | unclear
//   cancel_status     cancel: cancelled | charge_pending | not_cancelled | unclear
//   original_booking_status  reschedule: kept | moved | cancelled | unclear
//   opt_out_requested yes | no
// Text from the call is the business's words: quoted, length-capped, never instructions.
import type { CallResult } from "../sarvam.ts";
import type { User } from "../store.ts";
import { readOutputs } from "./outputs.ts";
import { fmtDayFull, fmtTime, optionsPrompt, type Place, placeName } from "./readback.ts";
import type { CallForReport, CallSettlement } from "./store.ts";
import { cleanField } from "./tools.ts";
import { type PromptDeps, sendPrompt } from "./turn.ts";
import type { CheckClaim, Verification, Verify } from "./verify.ts";

export type ReportDeps = PromptDeps & {
  // Booking verification (verify.ts). Without it no booking is reported as verified.
  verify?: Verify;
  // The same check for cancels and confirm calls; without it neither is reported as done.
  checkClaim?: CheckClaim;
  trace?: (event: string, data: unknown) => void;
};

type Option = { label: string; value: Record<string, unknown>; advance_required: boolean };

// What the outputs establish, and nothing more.
export type Outcome =
  | { kind: "booked"; time: string | null; reference: string | null }
  | {
    kind: "needs_advance";
    amountRs: number | null;
    upiId: string | null;
    payee: string | null;
    deadline: string | null;
    time: string | null;
  }
  | { kind: "options"; options: Option[]; reason: string | null }
  | { kind: "not_available"; reason: string | null }
  | { kind: "answered"; answer: string }
  | { kind: "unclear" };

// deno-lint-ignore no-explicit-any
type Json = any;

const REASONS: Record<string, string> = {
  no_slot: "that time isn't free",
  advance: "they want an advance",
  price: "it's over your price limit",
  new_condition: "they had a condition I couldn't agree to for you",
};

export function readOutcome(kind: string, raw: Json, now: Date): Outcome {
  const out = readOutputs(kind, raw);
  if (!out) return { kind: "unclear" };
  if (kind === "question") {
    const answer = cleanField(out.answer, 500);
    return answer ? { kind: "answered", answer } : { kind: "unclear" };
  }
  const status = out.booking_status;
  if (status === "booked") {
    return {
      kind: "booked",
      time: isoOrNull(out.booked_time),
      reference: cleanField(out.booking_reference, 40),
    };
  }
  if (status === "held_pending_deposit") {
    return {
      kind: "needs_advance",
      amountRs: out.advance_amount ?? null,
      upiId: cleanField(out.upi_id, 80),
      payee: cleanField(out.payee_name, 80),
      deadline: isoOrNull(out.payment_deadline),
      time: isoOrNull(out.booked_time),
    };
  }
  if (status && ["not_booked", "option_gone", "not_available"].includes(status)) {
    const offered = (kind === "booking" ? out.alternatives : out.options) ?? out.options ?? [];
    const options = offered.slice(0, 3).map((o: Json) => option(o, now)).filter((
      o: Option | null,
    ): o is Option => !!o);
    const reason = typeof out.no_match_reason === "string" ? REASONS[out.no_match_reason] ?? null : null;
    return options.length ? { kind: "options", options, reason } : { kind: "not_available", reason };
  }
  return { kind: "unclear" };
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
}

// An offered option is usable only with a time in the future or a label to show.
function option(o: Json, now: Date): Option | null {
  if (!o || typeof o !== "object") return null;
  const time = isoOrNull(o.time);
  if (time && Date.parse(time) <= now.getTime()) return null;
  const label = time
    ? `${fmtDayFull(new Date(time), now)}, ${fmtTime(new Date(time))}`
    : cleanField(o.label, 60);
  if (!label) return null;
  const value: Record<string, unknown> = {};
  if (time) value.time = time;
  if (Number.isInteger(o.party_size)) value.party_size = o.party_size;
  return { label, value, advance_required: o.advance_required === true };
}

async function verifyCall(
  deps: ReportDeps,
  call: CallForReport,
  bookedTime: string | null,
  r: CallResult,
): Promise<Verification> {
  if (!deps.verify) return { verified: false, problems: ["no verifier"], verdict: null };
  const req = await deps.store.request(call.requestId);
  const tol = (await deps.store.limitInt("match_tolerance_minutes", call.userId)) ?? 15;
  // A confirm call must confirm the held booking's time; a reschedule after options, the
  // option; a reschedule on call 1, the new window, as a first call would.
  const option = call.kind === "payment_confirm"
    ? (call.bookingTime ? { label: "the held booking", value: { time: call.bookingTime } } : null)
    : call.option;
  const kind = call.kind === "booking" || option ? "booking" : "first";
  return await deps.verify({
    kind,
    fields: req.fields as Record<string, unknown>,
    option,
    bookedTime,
    transcript: r.transcript,
    defaultToleranceMin: tol,
    maxAdvanceRs: typeof req.fields.max_advance_rs === "number" ? req.fields.max_advance_rs : 0,
  }, call.userId);
}

async function claimHolds(deps: ReportDeps, call: CallForReport, claim: string, r: CallResult) {
  const v = deps.checkClaim
    ? await deps.checkClaim(claim, r.transcript, call.userId)
    : { verified: false, problems: ["no claim checker"], verdict: null };
  deps.trace?.("check_claim", { claim, ...v });
  return v;
}

function when(t: string | null, now: Date): string {
  return t ? `${fmtDayFull(new Date(t), now)} at ${fmtTime(new Date(t))}` : "";
}

function quote(s: string | null | undefined): string {
  return s ? ` They said: "${s}".` : "";
}

type Decision = { settle: CallSettlement; text: string; lead?: string };

// First and booking calls: booked (verified or not), an advance hold, other times, nothing.
async function decideBooking(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  outcome: Outcome,
  place: Place,
  now: Date,
): Promise<Decision> {
  switch (outcome.kind) {
    case "booked": {
      const at = outcome.time ? `, ${when(outcome.time, now)}` : "";
      const v = await verifyCall(deps, call, outcome.time, r);
      deps.trace?.("verify", v);
      return {
        settle: {
          result: "done",
          booking: {
            time: outcome.time,
            reference: outcome.reference,
            verified: v.verified,
            problems: v.problems,
          },
        },
        text: v.verified
          ? `${place.name} confirmed it on the call${at}, in your name.` +
            (outcome.reference ? ` Reference: ${outcome.reference}.` : "")
          : `${place.name} said it's booked${at}, but I couldn't confirm that from the call, so please ` +
            `check with them yourself: ${call.phone}.`,
      };
    }
    case "needs_advance": {
      const o = outcome;
      const req = await deps.store.request(call.requestId);
      const cap = typeof req.fields.max_advance_rs === "number" ? req.fields.max_advance_rs : 0;
      // A hold only within the cap the user approved, and only with somewhere to pay.
      if (o.amountRs !== null && o.amountRs > 0 && o.amountRs <= cap && (o.upiId || o.payee)) {
        const by = o.deadline ? ` by ${fmtTime(new Date(o.deadline))}` : "";
        const at = o.time ? ` for ${when(o.time, now)}` : "";
        return {
          settle: {
            result: "held",
            booking: {
              time: o.time,
              amount_rs: o.amountRs,
              upi_id: o.upiId,
              payee_name: o.payee,
              deadline: o.deadline,
            },
          },
          text: `${place.name} is holding it${at} for a Rs ${o.amountRs} advance, to be paid${by}. ` +
            `Pay ${o.upiId ?? o.payee}${o.upiId && o.payee ? ` (${o.payee})` : ""} from your own UPI app; ` +
            "they may also send you a QR on WhatsApp. Then send me the payment screenshot here and I'll call " +
            "them to confirm. It isn't booked until they confirm the payment.",
        };
      }
      return {
        settle: { result: "back" },
        text: `${place.name} will only hold it with an advance${o.amountRs ? ` of Rs ${o.amountRs}` : ""}. ` +
          "I didn't agree to it or pay anything, so nothing is booked. Do you want to try another time or place?",
      };
    }
    case "options":
      return {
        settle: { result: "options", options: outcome.options },
        text: "",
        lead: `${place.name} can't do what you asked${
          outcome.reason ? ` (${outcome.reason})` : ""
        }. They offered:`,
      };
    case "not_available":
      return {
        settle: { result: "back" },
        text: `${place.name} can't do it${outcome.reason ? `: ${outcome.reason}` : ""}, and didn't offer ` +
          "anything else. Nothing is booked. Want to try another time or place?",
      };
    case "answered":
      return { settle: { result: "done" }, text: `${place.name} said: "${outcome.answer}"` };
    default:
      return {
        settle: { result: "back" },
        text: `The call to ${place.name} connected, but I didn't get a clear answer, so I'm not treating ` +
          "anything as done. Want me to try again?",
      };
  }
}

// The confirm call after a payment screenshot (eng plan 2.2 step 4).
async function decidePayment(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  place: Place,
  now: Date,
): Promise<Decision> {
  const out = readOutputs(call.kind, r.outputs) ?? {};
  const said = cleanField(out.summary ?? out.answer, 200);
  const status = out.payment_status;
  if (status === "received" && out.booking_status === "booked") {
    const time = isoOrNull(out.booked_time) ?? call.bookingTime;
    const v = await verifyCall(deps, call, time, r);
    deps.trace?.("verify", v);
    const ref = cleanField(out.booking_reference, 40);
    return {
      settle: {
        result: "done",
        booking: { time, reference: ref, verified: v.verified, problems: v.problems },
      },
      text: v.verified
        ? `${place.name} confirmed they got your payment, and it's booked${
          time ? `: ${when(time, now)}` : ""
        }, ` +
          `in your name.${ref ? ` Reference: ${ref}.` : ""}`
        : `${place.name} said they got your payment and it's booked, but I couldn't confirm that from the call, ` +
          `so please check with them yourself: ${call.phone}.`,
    };
  }
  if (status === "not_seen" || out.outcome === "payment_not_seen") {
    if (!call.isRetry) {
      const mins = (await deps.store.limitInt("payment_confirm_retry_minutes", call.userId)) ?? 30;
      return {
        settle: { result: "retry" },
        text: `${place.name} hasn't seen your payment yet. I'll call them again in about ${mins} minutes.`,
      };
    }
    return {
      settle: { result: "unconfirmed", booking: { said } },
      text: `You've paid, but ${place.name} still hasn't confirmed it. Please check with them directly: ` +
        `${call.phone}.`,
    };
  }
  // Wrong amount, a dispute, an expired hold, or anything unclear: report what they said,
  // agree nothing, promise nothing.
  return {
    settle: { result: "unconfirmed", booking: { said } },
    text:
      `${place.name} didn't confirm your payment and booking.${quote(said)} I haven't agreed to anything ` +
      `for you. Please talk to them directly: ${call.phone}.`,
  };
}

// Cancelling a Desk booking (E4 design 2.9). A refund is reported only as their words.
async function decideCancel(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  place: Place,
  now: Date,
): Promise<Decision> {
  const out = readOutputs(call.kind, r.outputs) ?? {};
  const status = out.cancel_status ?? (out.outcome === "cancelled" ? "cancelled" : undefined);
  const booking = call.bookingTime ? `your ${when(call.bookingTime, now)} booking` : "your booking";
  const refund = cleanField(out.refund_stated, 200);
  if (status === "cancelled") {
    const v = await claimHolds(
      deps,
      call,
      `The business cancelled ${booking.replace("your", "the customer's")}.`,
      r,
    );
    if (v.verified) {
      return {
        settle: { result: "cancelled" },
        text: `Cancelled: ${booking} at ${place.name}.${
          refund ? ` About the advance they said: "${refund}".` : ""
        }`,
      };
    }
    return {
      settle: { result: "unconfirmed", booking: { problems: v.problems } },
      text:
        `${place.name} may have cancelled ${booking}, but I couldn't confirm it from the call. Please check ` +
        `with them: ${call.phone}.`,
    };
  }
  if (status === "charge_pending") {
    const fee = out.cancel_charge_rs ?? null;
    return {
      settle: { result: "back", booking: { fee_rs: fee } },
      text:
        `${place.name} said cancelling costs${fee ? ` Rs ${fee}` : " something"}. I didn't agree to it, so ` +
        `${booking} still stands. Do you want me to cancel anyway?`,
    };
  }
  if (status === "not_cancelled") {
    return {
      settle: { result: "back" },
      text: `${place.name} didn't cancel it, so ${booking} still stands.${
        quote(cleanField(out.summary, 200))
      }`,
    };
  }
  return {
    settle: { result: "unconfirmed", booking: { said: cleanField(out.summary, 200) } },
    text:
      `I asked ${place.name} to cancel ${booking}, but it's not clear it went through. Please check with ` +
      `them: ${call.phone}.`,
  };
}

// Moving a Desk booking (E4 design 2.7): moved, kept (maybe with other times), or unclear.
async function decideReschedule(
  deps: ReportDeps,
  call: CallForReport,
  r: CallResult,
  place: Place,
  now: Date,
): Promise<Decision> {
  const out = readOutputs(call.kind, r.outputs) ?? {};
  const orig = out.original_booking_status ??
    (out.outcome === "moved" || out.outcome === "kept" ? out.outcome : null);
  const booking = call.bookingTime ? `your ${when(call.bookingTime, now)} booking` : "your booking";
  const time = isoOrNull(out.booked_time);
  if (orig === "moved" || (!orig && out.booking_status === "booked")) {
    const v = await verifyCall(deps, call, time, r);
    deps.trace?.("verify", v);
    const ref = cleanField(out.booking_reference, 40);
    return {
      settle: {
        result: "done",
        booking: { time, reference: ref, verified: v.verified, problems: v.problems },
      },
      text: v.verified
        ? `Moved: ${place.name}, now ${when(time, now)}.${ref ? ` Reference: ${ref}.` : ""}`
        : `${place.name} said they moved it${
          time ? ` to ${when(time, now)}` : ""
        }, but I couldn't confirm that ` +
          `from the call, so please check with them: ${call.phone}.`,
    };
  }
  if (orig === "kept") {
    const offered = (out.alternatives ?? out.options ?? []).slice(0, 3).map((o: Json) => option(o, now))
      .filter((o: Option | null): o is Option => !!o);
    if (offered.length) {
      return {
        settle: { result: "options", options: offered },
        text: "",
        lead: `${place.name} can't move it, and said ${booking} stands. They offered:`,
      };
    }
    return {
      settle: { result: "done" },
      text: `${place.name} can't move it. They said ${booking} stands.`,
    };
  }
  return {
    settle: { result: "unconfirmed", booking: { said: cleanField(out.summary, 200) } },
    text:
      `I asked ${place.name} to move ${booking}, but it's not clear what they did. Please check with them ` +
      `directly: ${call.phone}.`,
  };
}

export async function reportCall(deps: ReportDeps, callId: string, r: CallResult): Promise<void> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const call = await store.callForReport(callId);
  if (!call) return console.warn("report: unknown call", callId);
  const user: User = { id: call.userId, waId: call.waId, blocked: false };
  const place = await store.place(call.businessId);
  const where = placeName(place);
  const optOut = readOutputs(call.kind, r.outputs)?.opt_out_requested === "yes";

  let d: Decision;
  switch (r.status) {
    case "no_answer":
      d = {
        settle: { result: "back" },
        text: `I called ${where}, but no one picked up, so nothing is done yet. Want me to try again later?`,
      };
      break;
    case "busy":
      d = {
        settle: { result: "back" },
        text: `${where}'s line was busy, so nothing is done yet. Want me to try again in a bit?`,
      };
      break;
    case "failed":
      d = {
        settle: { result: "back" },
        // reconcile: the call may have happened, but no result ever came back.
        text: r.failureReason === "no_result"
          ? `I didn't get a result back from my call to ${where}, so I can't tell you what they said. ` +
            `Please check with them directly: ${call.phone}.`
          : `The call to ${where} didn't go through, so nothing is done yet. Want me to try again?`,
      };
      break;
    default:
      switch (call.kind) {
        case "payment_confirm":
          d = await decidePayment(deps, call, r, place, now);
          break;
        case "cancel":
          d = await decideCancel(deps, call, r, place, now);
          break;
        case "reschedule":
          d = await decideReschedule(deps, call, r, place, now);
          break;
        default:
          d = await decideBooking(deps, call, r, readOutcome(call.kind, r.outputs, now), place, now);
      }
  }
  // A confirm call that didn't connect leaves the hold as it is: the user can ask again.
  if (call.kind === "payment_confirm" && r.status !== "completed") {
    d.text = d.text.replace("nothing is done yet", "your payment isn't confirmed yet");
  }
  const settle = d.settle;
  settle.optOut = optOut;

  const res = await store.settleCall(callId, settle);
  deps.trace?.("settle_call", { callId, settle, res });
  // Already settled (a redelivered result): the user has heard about it.
  if (!res.ok) return;

  const lines: string[] = [];
  if (settle.result === "options") {
    const opts = await store.liveOptions(res.request_id);
    const shown = opts.map((o) => ({ id: o.id, label: o.label, detail: o.detail }));
    const r2 = await store.request(res.request_id);
    const sent = await sendPrompt(
      deps,
      user,
      res.request_id,
      optionsPrompt({
        place,
        options: shown,
        lead: d.lead ?? `${place.name} offered:`,
        customerName: r2.fields.customer_name ?? null,
      }),
    );
    deps.trace?.("options_prompt", sent);
  } else lines.push(d.text);
  if (optOut) lines.push("They asked not to be called again, so I won't call them in future.");

  if (["done", "unconfirmed", "cancelled"].includes(settle.result)) {
    const next = await store.activateQueued(call.userId);
    deps.trace?.("activate_queued", next);
    if (next.request_id) {
      const n = await store.request(next.request_id);
      const at = n.businessId ? ` for ${(await store.place(n.businessId)).name}` : "";
      lines.push(
        `Next I have your ${n.task === "question" ? "question" : "booking"}${at}. Shall I carry on with it?`,
      );
    }
  }
  if (lines.length) await deps.send(user, { kind: "text", body: lines.join("\n\n") });
}
