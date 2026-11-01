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
//
// The result and every message it owes the user are stored together (settle_and_report),
// then sent through deliveries, so a failed send is retried by the recovery pass and a
// redelivered result sends nothing twice (followup.ts).
import type { CallResult } from "../sarvam.ts";
import { drainDeliveries } from "./followup.ts";
import { hasResult, readOutputs } from "./outputs.ts";
import { fmtDate, fmtDayFull, fmtTime, optionsPrompt, type Place, placeName } from "./readback.ts";
import type { CallForReport, CallReport, CallSettlement } from "./store.ts";
import { cleanField } from "./tools.ts";
import type { PromptDeps } from "./turn.ts";
import {
  approvedTime,
  type BookedWhen,
  type CheckClaim,
  instant,
  readBookedWhen,
  type Verification,
  type Verify,
} from "./verify.ts";

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
  // captured: booked_time as the caller reported it; only verifying decides what stands.
  | { kind: "booked"; captured: string | null; reference: string | null }
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
  // offer: a question call where the business offered to book. Brought back for the user
  // to pick, with its conditions: not accepted, not refused, not a final price.
  | { kind: "answered"; answer: string; offer: Option[] }
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
  if (status === "held_pending_deposit") {
    return {
      kind: "needs_advance",
      amountRs: out.advance_amount ?? null,
      upiId: cleanField(out.upi_id, 80),
      payee: cleanField(out.payee_name, 80),
      deadline: instant(out.payment_deadline),
      time: instant(out.booked_time),
    };
  }
  if (status && ["not_booked", "option_gone", "not_available"].includes(status)) {
    const offered = (kind === "booking" ? out.alternatives : out.options) ?? out.options ?? [];
    const options = usable(offered, now);
    const reason = typeof out.no_match_reason === "string" ? REASONS[out.no_match_reason] ?? null : null;
    return options.length ? { kind: "options", options, reason } : { kind: "not_available", reason };
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
  const label = [
    when,
    // A label that only repeats the time adds nothing.
    time && words && !/\d\s*(:|am|pm)/i.test(words) ? words : null,
    price ? `they quoted Rs ${price}` : null,
    conditions,
  ].filter(Boolean).join(", ");
  const value: Record<string, unknown> = {};
  if (time) value.time = time;
  if (Number.isInteger(o.party_size)) value.party_size = o.party_size;
  if (price) value.price_rs = price;
  if (conditions) value.conditions = conditions;
  return { label, value, advance_required: o.advance_required === true };
}

// What a verified or unverified booking is stored as, and how the user hears its time.
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
    ...(b.date ? { date: b.date } : {}),
    ...(b.when.captured ? { captured: b.when.captured } : {}),
    ...(b.approved ? { approved: b.approved } : {}),
    ...(b.v.correction ? { correction: b.v.correction } : {}),
  };
}

// ", tonight (Fri 23 Oct) at 8:00 pm", ", for Sat 8 Nov, no time confirmed", or nothing.
function bookedAt(b: Booked, now: Date): string {
  if (b.time) return `, ${when(b.time, now)}`;
  return b.date ? `, for ${fmtDate(b.date, now)}, no time confirmed` : "";
}

async function verifyCall(
  deps: ReportDeps,
  call: CallForReport,
  captured: string | null,
  r: CallResult,
): Promise<Booked> {
  const req = await deps.store.request(call.requestId);
  const tol = (await deps.store.limitInt("match_tolerance_minutes", call.userId)) ?? 15;
  // A confirm call must confirm the held booking's time; a reschedule after options, the
  // option; a reschedule on call 1, the new window, as a first call would.
  const option = call.kind === "payment_confirm"
    ? (call.bookingTime ? { label: "the held booking", value: { time: call.bookingTime } } : null)
    : call.option;
  const kind = call.kind === "booking" || option ? "booking" : "first";
  const fields = req.fields as Record<string, unknown>;
  const approved = approvedTime({ kind, option, fields });
  const heard = readBookedWhen(captured, approved);
  const v = deps.verify
    ? await deps.verify({
      kind,
      fields,
      option,
      bookedTime: heard.time,
      bookedDate: heard.date,
      transcript: r.transcript,
      defaultToleranceMin: tol,
      maxAdvanceRs: typeof req.fields.max_advance_rs === "number" ? req.fields.max_advance_rs : 0,
    }, call.userId)
    : { verified: false, problems: ["no verifier"], verdict: null };
  deps.trace?.("verify", v);
  return {
    v,
    time: v.correction?.to ?? (v.badYear ? null : heard.time),
    date: v.badYear ? null : heard.date,
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

function when(t: string | null, now: Date): string {
  return t ? `${fmtDayFull(new Date(t), now)} at ${fmtTime(new Date(t))}` : "";
}

function quote(s: string | null | undefined): string {
  return s ? ` They said: "${s}".` : "";
}

// said: what the business answered, kept apart so a cancel during the call can't lose it.
type Decision = { settle: CallSettlement; text: string; lead?: string; said?: string };

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
      const b = await verifyCall(deps, call, outcome.captured, r);
      const at = bookedAt(b, now);
      return {
        settle: { result: "done", booking: bookingRow(b, outcome.reference) },
        text: b.v.verified
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
    case "answered": {
      const said = outcome.answer ? `${place.name} said: "${outcome.answer}"` : "";
      if (outcome.offer.length) {
        return {
          settle: { result: "options", options: outcome.offer },
          text: "",
          lead: [said, `${said ? "They also" : `${place.name}`} offered to book:`].filter(Boolean).join(
            "\n\n",
          ),
          said,
        };
      }
      return { settle: { result: "done" }, text: said };
    }
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
    const b = await verifyCall(deps, call, out.booked_time ?? call.bookingTime, r);
    const ref = cleanField(out.booking_reference, 40);
    return {
      settle: { result: "done", booking: bookingRow(b, ref) },
      text: b.v.verified
        ? `${place.name} confirmed they got your payment, and it's booked${
          b.time ? `: ${when(b.time, now)}` : ""
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
  if (orig === "moved" || (!orig && out.booking_status === "booked")) {
    const b = await verifyCall(deps, call, out.booked_time ?? null, r);
    const ref = cleanField(out.booking_reference, 40);
    return {
      settle: { result: "done", booking: bookingRow(b, ref) },
      text: b.v.verified
        ? `Moved: ${place.name}, now ${when(b.time, now)}.${ref ? ` Reference: ${ref}.` : ""}`
        : `${place.name} said they moved it${
          b.time ? ` to ${when(b.time, now)}` : ""
        }, but I couldn't confirm that ` +
          `from the call, so please check with them: ${call.phone}.`,
    };
  }
  if (orig === "kept") {
    const offered = usable(out.alternatives ?? out.options ?? [], now);
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

// The user said cancel while the call ran. Nothing booked: the errand ends, and options
// are mentioned but not opened for a pick. Booked: it stands until they say otherwise,
// because only they can decide to undo what the business already agreed.
function afterCancel(d: Decision, place: Place): boolean {
  const { result } = d.settle;
  if (result === "options" || result === "back") {
    // The errand is over, so a closing "Want me to try again?" no longer applies.
    const record = d.text.replace(/\s*[^.!?"]*\?$/, "");
    const said = result === "options"
      ? `${d.said ? ` ${d.said}` : ""} They had other options, but I've dropped them too.`
      : record
      ? ` For the record: ${record}`
      : "";
    d.settle = { result: "back", booking: d.settle.booking, optOut: d.settle.optOut };
    d.text =
      `You asked me to cancel during the call, so I've dropped this errand. Nothing was booked.${said}`;
    d.lead = undefined;
    return true;
  }
  if (result === "done" && d.settle.booking) {
    d.text += `\n\nThat went through before I could stop it. If you still want it cancelled, say so and ` +
      `I'll call ${place.name} back.`;
  } else if (result === "held") {
    d.text += `\n\nThat happened before I could stop it. If you'd rather drop it, tell me and don't pay.`;
  } else if (result === "done") {
    // Answered, nothing booked: what the call got still reaches them, and the errand
    // closes as the cancel they asked for.
    d.text += `\n\nYou asked me to cancel during the call. It had already got this far, so I've closed ` +
      "the errand and nothing more will happen.";
    return true;
  } else if (result === "unconfirmed" || result === "cancelled") {
    d.text += `\n\nYou asked me to cancel during the call, but it was already under way.`;
  }
  return false;
}

// The extra question on a booking call. The plan promised to ask, so the report says what
// came back, or that nothing did. A booking call asks only if the first call didn't get
// an answer, so only its answer is news.
async function alsoLine(deps: ReportDeps, call: CallForReport, r: CallResult): Promise<string | null> {
  if (r.status !== "completed" || (call.kind !== "first" && call.kind !== "booking")) return null;
  const ask = (await deps.store.request(call.requestId)).fields.also_ask;
  if (!ask) return null;
  const answer = cleanField(readOutputs(call.kind, r.outputs)?.also_answer, 300);
  if (answer) return `You also asked: "${ask}". They said: "${answer}"`;
  return call.kind === "first" ? `You also asked: "${ask}". I didn't get a clear answer to that.` : null;
}

export async function reportCall(deps: ReportDeps, callId: string, r: CallResult): Promise<void> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const call = await store.callForReport(callId);
  if (!call) return console.warn("report: unknown call", callId);
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
  const end = !!call.cancelRequested && call.kind !== "payment_confirm" && afterCancel(d, place);
  // The call connected and the caller reported no result: an agent without the output
  // contract (agent/contract.json). It may well have booked, so "nothing is done, try
  // again?" could book twice. Say what isn't known, quote its note as its note, flag it,
  // and block the version for real businesses (0013).
  const blind = r.status === "completed" && !hasResult(readOutputs(call.kind, r.outputs));
  if (blind && d.settle.result === "back") {
    const note = cleanField(readOutputs(call.kind, r.outputs)?.summary, 240);
    d.text = `The call to ${place.name} connected, but its result didn't come back properly, so it may or ` +
      `may not have gone through. Please check with them before we try again: ${call.phone}.` +
      (note ? ` My caller's note, which I can't confirm: "${note}"` : "");
  }
  const also = await alsoLine(deps, call, r);
  if (also && d.settle.result === "options") d.lead = `${also}\n\n${d.lead ?? `${place.name} offered:`}`;
  else if (also) d.text = `${d.text}\n\n${also}`;
  const settle = d.settle;
  settle.optOut = optOut;

  const report: CallReport = { parts: [], end };
  const lines: string[] = [];
  if (settle.result === "options") {
    const shown = settle.options!.map((o, i) => ({
      id: String(i),
      label: o.label,
      detail: o.advance_required ? "advance" : null,
    }));
    const req = await store.request(call.requestId);
    const p = optionsPrompt({
      place,
      options: shown,
      lead: d.lead ?? `${place.name} offered:`,
      customerName: req.fields.customer_name ?? (await store.user(call.userId)).name,
    });
    report.prompt = { id: crypto.randomUUID(), text: p.text, message: p.message };
  } else lines.push(d.text);
  if (optOut) lines.push("They asked not to be called again, so I won't call them in future.");
  if (lines.length) report.parts.push({ key: "result", message: { kind: "text", body: lines.join("\n\n") } });

  if (end || ["done", "unconfirmed", "cancelled"].includes(settle.result)) {
    const n = await store.queued(call.userId);
    if (n) {
      const at = n.businessId ? ` for ${(await store.place(n.businessId)).name}` : "";
      report.next = {
        request_id: n.id,
        message: {
          kind: "text",
          body: `Next I have your ${
            n.task === "question" ? "question" : "booking"
          }${at}. Shall I carry on with it?`,
        },
      };
    }
  }

  const res = await store.settleCall(callId, settle, report);
  deps.trace?.("settle_call", { callId, settle, res });
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
  await drainDeliveries(deps, callId);
}
