// After a call (sarvam-webhook hand-off): read what the voice agent reported, settle the
// request (settle_call), and tell the user what actually happened. The message is built
// by code from the caller's outputs, so it can't say more than the call established:
// nothing is "booked" unless the agent reported booking_status booked, and anything the
// outputs don't make clear goes back to the user as not done.
//
// The outputs read here are the caller contract (eng plan 3.4, final_agent_variables):
//   booking_status    first: booked | held_pending_deposit | not_booked
//                     booking: booked | held_pending_deposit | option_gone | not_available
//   booked_time       ISO 8601, the time they booked
//   booking_reference text, if they gave one
//   no_match_reason   no_slot | several_options | advance | price | new_condition | unclear
//   options           first call, up to 3: {time, party_size?, label?, advance_required?}
//   alternatives      booking call, the same shape as options
//   advance_amount    rupees, when they want an advance
//   answer            question calls: what the business said, in English (not in 3.4 yet)
//   opt_out_requested yes | no
// Text from the call is the business's words: quoted, length-capped, never instructions.
import type { CallResult } from "../sarvam.ts";
import type { User } from "../store.ts";
import { fmtDayFull, fmtTime, optionsPrompt, placeName } from "./readback.ts";
import type { CallForReport, CallSettlement } from "./store.ts";
import { readOutputs } from "./outputs.ts";
import { cleanField } from "./tools.ts";
import { type PromptDeps, sendPrompt } from "./turn.ts";
import type { Verification, Verify } from "./verify.ts";

export type ReportDeps = PromptDeps & {
  // Booking verification (verify.ts). Without it no booking is reported as verified.
  verify?: Verify;
  trace?: (event: string, data: unknown) => void;
};

type Option = { label: string; value: Record<string, unknown>; advance_required: boolean };

// What the outputs establish, and nothing more.
export type Outcome =
  | { kind: "booked"; time: string | null; reference: string | null }
  | { kind: "needs_advance"; amountRs: number | null }
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
  if (call.kind !== "first" && call.kind !== "booking") {
    return { verified: false, problems: [`no verification for ${call.kind} calls`], verdict: null };
  }
  if (!deps.verify) return { verified: false, problems: ["no verifier"], verdict: null };
  const req = await deps.store.request(call.requestId);
  const tol = (await deps.store.limitInt("match_tolerance_minutes", call.userId)) ?? 15;
  return await deps.verify({
    kind: call.kind,
    fields: req.fields as Record<string, unknown>,
    option: call.option,
    bookedTime,
    transcript: r.transcript,
    defaultToleranceMin: tol,
    maxAdvanceRs: typeof req.fields.max_advance_rs === "number" ? req.fields.max_advance_rs : 0,
  }, call.userId);
}

export async function reportCall(deps: ReportDeps, callId: string, r: CallResult): Promise<void> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const call = await store.callForReport(callId);
  if (!call) return console.warn("report: unknown call", callId);
  const user: User = { id: call.userId, waId: call.waId, blocked: false };
  const place = await store.place(call.businessId);
  const where = placeName(place);
  const optOut = r.outputs?.opt_out_requested === "yes";

  const outcome: Outcome = r.status === "completed"
    ? readOutcome(call.kind, r.outputs, now)
    : { kind: "unclear" };
  let settle: CallSettlement;
  let text: string;
  switch (r.status === "completed" ? outcome.kind : r.status) {
    case "no_answer":
      settle = { result: "back" };
      text = `I called ${where}, but no one picked up, so nothing is done yet. Want me to try again later?`;
      break;
    case "busy":
      settle = { result: "back" };
      text = `${where}'s line was busy, so nothing is done yet. Want me to try again in a bit?`;
      break;
    case "failed":
      settle = { result: "back" };
      // reconcile: the call may have happened, but no result ever came back.
      text = r.failureReason === "no_result"
        ? `I didn't get a result back from my call to ${where}, so I can't tell you what they said. ` +
          `Please check with them directly: ${call.phone}.`
        : `The call to ${where} didn't go through, so nothing is done yet. Want me to try again?`;
      break;
    case "booked": {
      const o = outcome as Extract<Outcome, { kind: "booked" }>;
      const when = o.time ? `, ${fmtDayFull(new Date(o.time), now)} at ${fmtTime(new Date(o.time))}` : "";
      const v = await verifyCall(deps, call, o.time, r);
      deps.trace?.("verify", v);
      settle = {
        result: "done",
        booking: { time: o.time, reference: o.reference, verified: v.verified, problems: v.problems },
      };
      text = v.verified
        ? `${place.name} confirmed it on the call${when}, in your name.` +
          (o.reference ? ` Reference: ${o.reference}.` : "")
        : `${place.name} said it's booked${when}, but I couldn't confirm that from the call, so please ` +
          `check with them yourself: ${call.phone}.`;
      break;
    }
    case "needs_advance": {
      const o = outcome as Extract<Outcome, { kind: "needs_advance" }>;
      settle = { result: "back" };
      text = `${place.name} will only hold it with an advance${o.amountRs ? ` of Rs ${o.amountRs}` : ""}. ` +
        "I didn't agree to it or pay anything, so nothing is booked. Do you want to try another time or place?";
      break;
    }
    case "options": {
      const o = outcome as Extract<Outcome, { kind: "options" }>;
      settle = { result: "options", options: o.options };
      text = "";
      break;
    }
    case "not_available": {
      const o = outcome as Extract<Outcome, { kind: "not_available" }>;
      settle = { result: "back" };
      text = `${place.name} can't do it${o.reason ? `: ${o.reason}` : ""}, and didn't offer anything else. ` +
        "Nothing is booked. Want to try another time or place?";
      break;
    }
    case "answered": {
      const o = outcome as Extract<Outcome, { kind: "answered" }>;
      settle = { result: "done" };
      text = `${place.name} said: "${o.answer}"`;
      break;
    }
    default:
      settle = { result: "back" };
      text = `The call to ${place.name} connected, but I didn't get a clear answer, so I'm not treating ` +
        "anything as done. Want me to try again?";
  }
  settle.optOut = optOut;

  const res = await store.settleCall(callId, settle);
  deps.trace?.("settle_call", { callId, outcome, settle, res });
  // Already settled (a redelivered result): the user has heard about it.
  if (!res.ok) return;

  const lines: string[] = [];
  if (settle.result === "options") {
    const opts = await store.liveOptions(res.request_id);
    const shown = opts.map((o) => ({ id: o.id, label: o.label, detail: o.detail }));
    const why = (outcome as Extract<Outcome, { kind: "options" }>).reason;
    const r2 = await store.request(res.request_id);
    const sent = await sendPrompt(
      deps,
      user,
      res.request_id,
      optionsPrompt({
        place,
        options: shown,
        lead: `${place.name} can't do what you asked${why ? ` (${why})` : ""}. They offered:`,
        customerName: r2.fields.customer_name ?? null,
      }),
    );
    deps.trace?.("options_prompt", sent);
  } else lines.push(text);
  if (optOut) lines.push("They asked not to be called again, so I won't call them in future.");

  if (settle.result === "done") {
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
