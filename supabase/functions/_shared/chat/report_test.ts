import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { CallKind, CallResult } from "../sarvam.ts";
import type { Outbound } from "../whatsapp.ts";
import { readOutcome, reportCall, type ReportDeps } from "./report.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { fakeWriter, say } from "./test_writer.ts";
import type { BookingCheck, Condition, Verification } from "./verify.ts";

const now = new Date("2026-10-23T12:00:00+05:30");

function setup(kind: CallKind = "first") {
  const store = new FakeChatStore();
  store.call = {
    callId: "c1",
    requestId: "r1",
    userId: "u1",
    waId: "919812345678",
    kind,
    task: kind === "question" ? "question" : "booking",
    businessId: "b1",
    phone: "+919800000901",
    option: null,
    isRetry: false,
    bookingTime: null,
  };
  store.req = {
    id: "r1",
    task: "booking",
    state: "calling_1",
    version: 3,
    fields: { party_size: 4, customer_name: "Ihaz" },
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  const sent: Outbound[] = [];
  const deps: ReportDeps = {
    store,
    create: fakeWriter,
    send: async (_u, m) => {
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
  };
  return { store, sent, deps };
}

const result = (
  status: CallResult["status"],
  outputs: Record<string, unknown> | null,
  failureReason: string | null = null,
): CallResult => ({
  attemptId: "a1",
  callId: "c1",
  status,
  durationS: 60,
  interactionId: null,
  failureReason,
  outputs,
  transcript: null,
  agentNumber: null,
});
const body = (m: Outbound) => (m as { body: string }).body;
const facts = (store: FakeChatStore) => store.reports[0].facts;
const status = (store: FakeChatStore) => facts(store).happened.status;

const passes = (checks: BookingCheck[]) => async (c: BookingCheck): Promise<Verification> => {
  checks.push(c);
  return { verified: true, problems: [], verdict: null };
};

const ok = async (): Promise<Verification> => ({ verified: true, problems: [], verdict: null });

Deno.test("booked and verified: the facts say so, and the errand is done", async () => {
  const { store, sent, deps } = setup();
  const checks: BookingCheck[] = [];
  deps.verify = passes(checks);
  await reportCall(
    deps,
    "c1",
    result("completed", {
      booking_status: "booked",
      booked_time: "2026-10-23T20:00:00+05:30",
      booking_reference: "T12",
    }),
  );
  assertEquals(store.settled[0], {
    result: "done",
    booking: {
      time: "2026-10-23T20:00:00+05:30",
      reference: "T12",
      verified: true,
      problems: [],
      conditions: [],
      decision_open: false,
      captured: "2026-10-23T20:00:00+05:30",
    },
    optOut: false,
  });
  assertEquals(checks[0].kind, "first");
  assertEquals(checks[0].bookedTime, "2026-10-23T20:00:00+05:30");
  assertEquals(checks[0].defaultToleranceMin, 15);
  assertEquals(status(store), "booked_and_verified");
  assertEquals(facts(store).values, { when: "tonight (Fri 23 Oct) at 8:00 pm", reference: "T12" });
  assertEquals(body(sent[0]), "booked_and_verified. tonight (Fri 23 Oct) at 8:00 pm T12");
});

Deno.test("booked but not verified: not called done, and they're told to check, with the number", async () => {
  const { store, deps } = setup();
  deps.verify = async () => ({
    verified: false,
    problems: ["transcript: unclear (no read-back)"],
    verdict: null,
  });
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "booked", booked_time: "2026-10-23T20:00:00+05:30" }),
  );
  assertEquals(store.settled[0].booking?.verified, false);
  assertEquals(status(store), "business_said_booked_not_verified");
  assertEquals(facts(store).happened.why_not_verified, ["transcript: unclear (no read-back)"]);
  assertEquals(facts(store).values.phone, "+919800000901");
  assertEquals(facts(store).next_step, "check_with_business_themselves");
});

Deno.test("booked with no verifier wired: never reported as confirmed", async () => {
  const { store, deps } = setup();
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(store.settled[0].booking?.verified, false);
  assertEquals(status(store), "business_said_booked_not_verified");
});

const valet: Condition = {
  words: "valet is Rs 100 if you want it",
  what: "valet",
  required: false,
  covered: false,
};
const cover: Condition = {
  words: "there's a Rs 500 cover per head",
  what: "cover charge",
  required: true,
  covered: false,
};

Deno.test("an optional mention doesn't downgrade a booking, and still reaches the user", async () => {
  const { store, deps } = setup();
  deps.verify = async () => ({ verified: true, problems: [], verdict: null, conditions: [valet] });
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(store.settled[0].booking?.verified, true);
  assertEquals(status(store), "booked_and_verified");
  assertEquals(facts(store).happened.conditions, [{
    their_words: valet.words,
    what: "valet",
    required: false,
    already_approved: false,
  }]);
  assertEquals(facts(store).next_step, null);
});

Deno.test("a required condition nobody approved goes to the user as their decision, in their words", async () => {
  const { store, deps } = setup();
  deps.verify = async () => ({
    verified: false,
    problems: ["condition: cover charge"],
    verdict: null,
    conditions: [cover],
    decisionOpen: true,
  });
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(store.settled[0].booking?.decision_open, true);
  assertEquals(store.settled[0].booking?.conditions, [cover]);
  assertEquals(status(store), "business_said_booked_but_requires_something_not_approved");
  assertEquals(facts(store).next_step, "decide_on_condition");
});

Deno.test("the wrong year: stored with no date, the captured words kept, nothing confirmed", async () => {
  const { store, deps } = setup();
  store.req!.fields = { ...store.req!.fields, exact_time: "2026-11-08T20:00:00+05:30" };
  deps.verify = async () => ({
    verified: false,
    problems: ["booked 2025-11-08, off"],
    verdict: null,
    badYear: true,
  });
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "booked", booked_time: "2025-11-08T20:00:00+05:30" }),
  );
  const b = store.settled[0].booking!;
  assertEquals([b.time, b.date, b.verified, b.captured], [
    null,
    undefined,
    false,
    "2025-11-08T20:00:00+05:30",
  ]);
  assertEquals(facts(store).happened.year_doesnt_match, {
    caller_noted: "2025-11-08T20:00:00+05:30",
    they_asked_for: "2026-11-08T20:00:00+05:30",
  });
});

Deno.test("a booked time the caller couldn't give is taken from the call itself", async () => {
  const { store, deps } = setup();
  deps.verify = async () => ({
    verified: true,
    problems: [],
    verdict: null,
    heard: { time: "2026-11-08T20:00:00+05:30", date: null },
  });
  await reportCall(deps, "c1", result("completed", { booking_status: "booked", booked_time: "8 Nov at 8" }));
  assertEquals(store.settled[0].booking?.time, "2026-11-08T20:00:00+05:30");
  assertEquals(store.settled[0].booking?.captured, "8 Nov at 8");
});

Deno.test("a dash for a reference is no reference", async () => {
  const { store, deps } = setup();
  deps.verify = ok;
  await reportCall(deps, "c1", result("completed", { booking_status: "booked", booking_reference: "-" }));
  assertEquals(store.settled[0].booking?.reference, null);
  assertEquals("reference" in facts(store).values, false);
});

Deno.test("call 2: the check gets the picked option", async () => {
  const { store, deps } = setup("booking");
  store.call!.option = { label: "8:30 pm", value: { time: "2026-10-23T20:30:00+05:30" } };
  const checks: BookingCheck[] = [];
  deps.verify = passes(checks);
  await reportCall(
    deps,
    "c1",
    result("completed", { outcome: "booked", booked_time: "2026-10-23T20:30:00+05:30" }),
  );
  assertEquals(checks[0].kind, "booking");
  assertEquals(checks[0].option, store.call!.option);
  assertEquals(store.settled[0].booking?.verified, true);
});

Deno.test("the Genie contract: outcome options_found on call 1 becomes options", () => {
  const o = readOutcome("first", {
    outcome: "options_found",
    no_match_reason: "several_options",
    options: JSON.stringify([{ time: "2026-10-24T20:30:00+05:30", details: "table for 4" }]),
  }, now);
  assertEquals(o.kind, "options");
});

Deno.test("no answer, busy, failed: nothing is done, and the approval is spent", async () => {
  const want = {
    no_answer: "no_one_picked_up_nothing_done",
    busy: "line_busy_nothing_done",
    failed: "call_did_not_go_through_nothing_done",
  };
  for (const s of ["no_answer", "busy", "failed"] as const) {
    const { store, deps } = setup();
    await reportCall(deps, "c1", result(s, null));
    assertEquals(store.settled[0].result, "back", s);
    assertEquals(status(store), want[s]);
    assertEquals(facts(store).next_step, "offer_to_try_again");
  }
});

Deno.test("a lost result: what they said can't be told, and they're pointed at the business", async () => {
  const { store, deps } = setup();
  await reportCall(deps, "c1", result("failed", null, "no_result"));
  assertEquals(status(store), "no_result_came_back_cannot_say_what_they_said");
  assertEquals(facts(store).values.phone, "+919800000901");
});

Deno.test("anything the outputs don't make clear is never reported as booked", async () => {
  for (
    const out of [null, {}, { booking_status: "maybe" }, { outcome: "voicemail" }, {
      booking_status: "BOOKED",
    }]
  ) {
    const { store, deps } = setup();
    await reportCall(deps, "c1", result("completed", out));
    assertEquals(store.settled[0].result, "back", JSON.stringify(out));
    assertEquals(/^booked|business_said/.test(String(status(store))), false);
  }
});

// Advances --------------------------------------------------------------------------------

const terms = {
  booking_status: "advance_required",
  advance_amount: 500,
  advance_redeemable: "adjusted in the final bill",
  advance_refund: "not refundable after 6 pm",
  advance_hold: "yes",
  payment_mode: "upi",
  payment_address: "paragon@okhdfc",
  payee_name: "Paragon Restaurant",
  payment_deadline: "2026-10-23T19:30:00+05:30",
  booked_time: "2026-10-23T20:15:00+05:30",
};

Deno.test("an advance: every term is kept and told, nothing is agreed, and the errand waits", async () => {
  const { store, deps } = setup();
  deps.checkClaim = ok;
  await reportCall(deps, "c1", result("completed", terms));
  const b = store.settled[0];
  assertEquals(b.result, "advance");
  assertEquals(b.booking?.amount_rs, 500);
  assertEquals(b.booking?.upi_id, "paragon@okhdfc");
  assertEquals(b.booking?.payee_name, "Paragon Restaurant");
  assertEquals((b.booking?.terms as Record<string, unknown>).redeemable, "adjusted in the final bill");
  assertEquals(status(store), "business_wants_advance_nothing_agreed");
  assertEquals(facts(store).values, {
    advance: "Rs 500",
    pay_to: "paragon@okhdfc",
    payee: "Paragon Restaurant",
    deadline: "Fri 23 Oct 2026, 7:30 pm",
    slot: "tonight (Fri 23 Oct) at 8:15 pm",
  });
  assertEquals(facts(store).happened.adjusted_against_bill_their_words, "adjusted in the final bill");
  assertEquals(facts(store).happened.refund_their_words, "not refundable after 6 pm");
  assertEquals(facts(store).happened.keeping_the_slot_meanwhile, "yes");
  assertEquals(facts(store).next_step, "decide_on_advance");
  assertEquals(String(facts(store).happened.to_go_ahead).includes("send the screenshot here"), true);
});

Deno.test("an advance of any size comes back the same way: no cap, nothing lost", async () => {
  const { store, deps } = setup();
  await reportCall(deps, "c1", result("completed", { ...terms, advance_amount: 20000 }));
  assertEquals(store.settled[0].result, "advance");
  assertEquals(facts(store).values.advance, "Rs 20000");
});

Deno.test("what the business didn't say is told as not known", async () => {
  const { store, deps } = setup();
  await reportCall(deps, "c1", result("completed", { booking_status: "advance_required" }));
  assertEquals(store.settled[0].result, "advance");
  assertEquals(facts(store).happened.not_known, [
    "the amount",
    "where to pay",
    "whether it's adjusted against the bill",
    "whether it's refunded",
    "by when",
  ]);
  assertEquals(facts(store).happened.keeping_the_slot_meanwhile, "they didn't say");
});

Deno.test("not booked because of an advance is an advance, with or without the status", async () => {
  const { store, deps } = setup();
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "not_booked", no_match_reason: "advance", advance_amount: 300 }),
  );
  assertEquals(store.settled[0].result, "advance");
});

Deno.test("the older outcome name still reads as an advance", () => {
  assertEquals(readOutcome("first", { outcome: "held_pending_deposit" }, now).kind, "needs_advance");
  assertEquals(readOutcome("first", { booking_status: "held_pending_deposit" }, now).kind, "needs_advance");
});

Deno.test("an address that isn't a UPI ID isn't held against the screenshot as one", async () => {
  const { store, deps } = setup();
  deps.checkClaim = ok;
  await reportCall(deps, "c1", result("completed", { ...terms, payment_address: "9812345678" }));
  assertEquals(store.settled[0].booking?.upi_id, null);
  assertEquals(facts(store).values.pay_to, "9812345678");
});

Deno.test("cancelled during the call: the terms are told, the errand ends, nothing waits", async () => {
  const { store, deps } = setup();
  store.call!.cancelRequested = true;
  await reportCall(deps, "c1", result("completed", terms));
  assertEquals(store.settled[0].result, "back");
  assertEquals(store.reports[0].end, true);
  assertEquals(facts(store).happened.errand_dropped_nothing_booked, true);
  assertEquals(facts(store).values.advance, "Rs 500");
  assertEquals(facts(store).next_step, null);
});

// Options, questions ------------------------------------------------------------------------

Deno.test("other times offered: they become options, each value exact, the prompt the words sent", async () => {
  const { store, sent, deps } = setup();
  store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1", "o2"] };
  await reportCall(
    deps,
    "c1",
    result("completed", {
      booking_status: "not_booked",
      no_match_reason: "no_slot",
      options: [
        { time: "2026-10-23T20:30:00+05:30", party_size: 4, price_rs: 1200, conditions: "90 minutes only" },
        { time: "2026-10-23T21:15:00+05:30", advance_required: true },
      ],
    }),
  );
  assertEquals(store.settled[0].result, "options");
  assertEquals(store.settled[0].options!.map((o) => o.label), [
    "tonight (Fri 23 Oct), 8:30 pm, Rs 1200, 90 minutes only",
    "tonight (Fri 23 Oct), 9:15 pm",
  ]);
  assertEquals(facts(store).values.option_1, "tonight (Fri 23 Oct), 8:30 pm, Rs 1200, 90 minutes only");
  assertEquals(facts(store).happened.why_not_what_they_asked, "no_slot");
  assertEquals(facts(store).next_step, "pick_an_option");
  assertEquals(store.prompt!.kind, "options");
  assertEquals(store.prompt!.text, body(sent[0]));
});

Deno.test("a question answered: the business's words, cleaned", async () => {
  const { store, deps } = setup("question");
  await reportCall(deps, "c1", result("completed", { answer: "Yes, Rs 250,‮ ready Friday." }));
  assertEquals(store.settled[0].result, "done");
  assertEquals(status(store), "question_answered");
  assertEquals(facts(store).happened.they_said, "Yes, Rs 250, ready Friday.");
});

Deno.test("a question call that brings an offer: their answer and the offer both reach the user", async () => {
  const { store, deps } = setup("question");
  await reportCall(
    deps,
    "c1",
    result("completed", {
      answer: "Yes we have tables.",
      options: [{ time: "2026-10-23T20:30:00+05:30" }],
    }),
  );
  assertEquals(store.settled[0].result, "options");
  assertEquals(facts(store).happened.they_said, "Yes we have tables.");
  assertEquals(facts(store).happened.they_offered_to_book, true);
});

Deno.test("the extra question's answer comes back on any booking call", async () => {
  const { store, deps } = setup();
  store.req!.fields = { ...store.req!.fields, also_ask: "parking?" };
  deps.verify = ok;
  await reportCall(deps, "c1", result("completed", { booking_status: "booked", also_answer: "Yes, valet." }));
  assertEquals(facts(store).happened.also_asked, { question: "parking?", their_answer: "Yes, valet." });
});

Deno.test("the extra question unanswered on call 1 is said; on call 2 it isn't news", async () => {
  const first = setup();
  first.store.req!.fields = { ...first.store.req!.fields, also_ask: "parking?" };
  first.deps.verify = ok;
  await reportCall(first.deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(facts(first.store).happened.also_asked, {
    question: "parking?",
    their_answer: "no clear answer",
  });

  const second = setup("booking");
  second.store.req!.fields = { ...second.store.req!.fields, also_ask: "parking?" };
  second.deps.verify = ok;
  await reportCall(second.deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals("also_asked" in facts(second.store).happened, false);
});

Deno.test("an opt-out is recorded and told; a redelivered result says nothing twice", async () => {
  const { store, sent, deps } = setup();
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "not_booked", opt_out_requested: "yes" }),
  );
  assertEquals(store.settled[0].optOut, true);
  assertEquals(facts(store).happened.business_asked_not_to_be_called_again_so_it_wont_be, true);
  store.settleResult = { ok: false, reason: "not_calling" };
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(sent.length, 1);
});

Deno.test("when an errand ends, the one waiting behind it goes in the same message", async () => {
  const { store, sent, deps } = setup("question");
  store.activated = "r2";
  store.waiting = [{ ...store.req!, id: "r2", state: "queued" }];
  await reportCall(deps, "c1", result("completed", { answer: "Yes." }));
  assertEquals(sent.length, 1);
  assertEquals(store.deliveries[0].facts?.next_errand, { task: "booking", place: "Paragon" });
});

Deno.test("readOutcome: options in the past or without a time or label are dropped", () => {
  const o = readOutcome("first", {
    booking_status: "not_booked",
    options: [{ time: "2026-10-23T09:00:00+05:30" }, {}, { label: "Sat lunch" }],
  }, now);
  assertEquals(o.kind === "options" && o.options.map((x) => x.label), ["Sat lunch"]);
});

// Confirm calls, cancels and reschedules -----------------------------------------------------

Deno.test("confirm call: received and booked, verified against the booking's time and what was paid", async () => {
  const { store, deps } = setup("payment_confirm");
  store.call!.bookingTime = "2026-10-23T20:15:00+05:30";
  store.call!.advanceRs = 500;
  const checks: BookingCheck[] = [];
  deps.verify = passes(checks);
  await reportCall(deps, "c1", result("completed", { payment_status: "received", booking_status: "booked" }));
  assertEquals(checks[0].kind, "booking");
  assertEquals(checks[0].option?.value.time, "2026-10-23T20:15:00+05:30");
  assertEquals(checks[0].bookedTime, "2026-10-23T20:15:00+05:30");
  assertEquals(checks[0].advancePaidRs, 500);
  assertEquals(store.settled[0].result, "done");
  assertEquals(status(store), "business_confirmed_payment_and_booking");
  assertEquals(facts(store).values.paid, "Rs 500");
});

Deno.test("confirm call: 'not seen' is the business's claim, with one redial, then their number", async () => {
  const first = setup("payment_confirm");
  first.store.limits.payment_confirm_retry_minutes = 30;
  await reportCall(first.deps, "c1", result("completed", { payment_status: "not_seen" }));
  assertEquals(first.store.settled[0].result, "retry");
  assertEquals(first.store.settled[0].booking?.retry_at, "2026-10-23T07:00:00.000Z");
  assertEquals(status(first.store), "business_says_payment_not_seen_desk_will_call_them_again");
  assertEquals(facts(first.store).values.calling_them_again, "today (Fri 23 Oct) at 12:30 pm");

  const second = setup("payment_confirm");
  second.store.call!.isRetry = true;
  await reportCall(second.deps, "c1", result("completed", { outcome: "payment_not_seen" }));
  assertEquals(second.store.settled[0].result, "unconfirmed");
  assertEquals(status(second.store), "business_says_payment_still_not_seen");
  assertEquals(facts(second.store).values.phone, "+919800000901");
});

Deno.test("confirm call: wrong amount: what they said is kept, and nothing is agreed", async () => {
  const { store, deps } = setup("payment_confirm");
  await reportCall(
    deps,
    "c1",
    result("completed", { payment_status: "wrong_amount", summary: "We got Rs 50, not Rs 500." }),
  );
  assertEquals(store.settled[0].result, "unconfirmed");
  assertEquals(facts(store).happened.they_said, "We got Rs 50, not Rs 500.");
  assertEquals(facts(store).happened.nothing_agreed, true);
});

Deno.test("cancel: cancelled only when the business's words confirm it; a refund only as their words", async () => {
  const { store, deps } = setup("cancel");
  store.call!.bookingTime = "2026-10-23T20:15:00+05:30";
  deps.checkClaim = ok;
  await reportCall(
    deps,
    "c1",
    result("completed", { cancel_status: "cancelled", refund_stated: "advance back to UPI in 2 days" }),
  );
  assertEquals(store.settled[0].result, "cancelled");
  assertEquals(facts(store).values.booking, "tonight (Fri 23 Oct) at 8:15 pm");
  assertEquals(facts(store).happened.refund_their_words, "advance back to UPI in 2 days");

  const unsure = setup("cancel");
  await reportCall(unsure.deps, "c1", result("completed", { cancel_status: "cancelled" }));
  assertEquals(unsure.store.settled[0].result, "unconfirmed");
  assertEquals(status(unsure.store), "caller_says_cancelled_not_verified_booking_may_still_stand");
});

Deno.test("cancel: a charge is kept for the next plan, even with no amount, and the booking stands", async () => {
  const { store, deps } = setup("cancel");
  await reportCall(
    deps,
    "c1",
    result("completed", { cancel_status: "charge_pending", cancel_charge_rs: "200" }),
  );
  assertEquals(store.settled[0], {
    result: "back",
    booking: { fee_rs: 200, charge_stated: true },
    optOut: false,
  });
  assertEquals(facts(store).values.charge, "Rs 200");

  const vague = setup("cancel");
  await reportCall(vague.deps, "c1", result("completed", { cancel_status: "charge_pending" }));
  assertEquals(vague.store.settled[0].booking, { fee_rs: null, charge_stated: true });
  assertEquals("charge" in facts(vague.store).values, false);
});

Deno.test("reschedule: moved (verified), kept with other times, or unclear", async () => {
  const moved = setup("reschedule");
  moved.deps.verify = passes([]);
  await reportCall(
    moved.deps,
    "c1",
    result("completed", { original_booking_status: "moved", booked_time: "2026-10-23T21:00:00+05:30" }),
  );
  assertEquals(moved.store.settled[0].result, "done");
  assertEquals(status(moved.store), "moved_and_verified");
  assertEquals(facts(moved.store).values.when, "tonight (Fri 23 Oct) at 9:00 pm");

  const kept = setup("reschedule");
  kept.store.call!.bookingTime = "2026-10-23T20:00:00+05:30";
  kept.store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1"] };
  await reportCall(
    kept.deps,
    "c1",
    result("completed", { outcome: "kept", options: [{ time: "2026-10-23T21:45:00+05:30" }] }),
  );
  assertEquals(kept.store.settled[0].result, "options");
  assertEquals(facts(kept.store).happened.their_booking_stands, true);
  assertEquals(facts(kept.store).values.original, "tonight (Fri 23 Oct) at 8:00 pm");

  const unclear = setup("reschedule");
  await reportCall(unclear.deps, "c1", result("completed", { outcome: "uncertain" }));
  assertEquals(unclear.store.settled[0].result, "unconfirmed");
  assertEquals(status(unclear.store), "asked_to_move_outcome_unclear_original_booking_may_still_stand");
});

Deno.test("a move that didn't verify: the original is said to stand until it does", async () => {
  const { store, deps } = setup("reschedule");
  store.call!.bookingTime = "2026-10-23T20:00:00+05:30";
  deps.verify = async () => ({ verified: false, problems: ["transcript: unclear"], verdict: null });
  await reportCall(
    deps,
    "c1",
    result("completed", { original_booking_status: "moved", booked_time: "2026-10-23T21:00:00+05:30" }),
  );
  assertEquals(status(store), "business_said_moved_not_verified");
  assertEquals(facts(store).happened.original_booking_stands_until_confirmed, true);
  assertEquals(facts(store).values.original, "tonight (Fri 23 Oct) at 8:00 pm");
});

// Cancelling during a call ---------------------------------------------------------------------

Deno.test("cancelled during the call, booked anyway: it stands, and they're asked", async () => {
  const { store, deps } = setup();
  store.call!.cancelRequested = true;
  deps.verify = ok;
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(store.settled[0].result, "done");
  assertEquals(store.reports[0].end, false);
  assertEquals(facts(store).happened.it_had_already_happened, true);
  assertEquals(facts(store).next_step, "say_if_still_cancelling");
});

Deno.test("cancelled during the call, options found: they're told but not opened", async () => {
  const { store, deps } = setup();
  store.call!.cancelRequested = true;
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "not_booked", options: [{ time: "2026-10-23T21:45:00+05:30" }] }),
  );
  assertEquals(store.settled[0].result, "back");
  assertEquals(store.reports[0].end, true);
  assertEquals(facts(store).next_step, null);
  assertEquals(facts(store).happened.nothing_is_open_to_pick_or_pay, true);
  assertEquals(facts(store).values.option_1, "tonight (Fri 23 Oct), 9:45 pm");
});

Deno.test("cancelled during a question call: the answer still reaches them, and the errand closes", async () => {
  const { store, deps } = setup("question");
  store.call!.cancelRequested = true;
  await reportCall(deps, "c1", result("completed", { answer: "Open till 11." }));
  assertEquals(store.reports[0].end, true);
  assertEquals(facts(store).happened.they_said, "Open till 11.");
});

// The errand from the extraction ticket, as Sarvam would hand it back: strings, and a list
// as a JSON string. A fixture: it proves Desk reads the contract, not that a caller fills it.
const TERRACE = "Yes, we do have outdoor seating on our terrace area.";

Deno.test("the contract, as Sarvam returns it, reaches the user with nothing hand-filled", async () => {
  const { store, deps } = setup();
  store.req = {
    ...store.req!,
    fields: {
      party_size: 2,
      customer_name: "Ihaz",
      exact_time: "2026-11-07T19:30:00+05:30",
      also_ask: "do you have outdoor seating?",
    },
  };
  const checks: BookingCheck[] = [];
  deps.verify = passes(checks);
  await reportCall(
    deps,
    "c1",
    result("completed", {
      outcome: "booked",
      booked_time: "2026-11-07T19:30:00+05:30",
      booking_reference: "",
      options: "[]",
      also_answer: TERRACE,
      advance_amount_rs: "",
      opt_out_requested: "no",
      summary: "Booked for Ihaz, two people, Saturday 7 November at 7:30 pm.",
    }),
  );
  assertEquals(checks[0].bookedTime, "2026-11-07T19:30:00+05:30");
  assertEquals(store.settled[0].result, "done");
  assertEquals(status(store), "booked_and_verified");
  assertEquals((facts(store).happened.also_asked as { their_answer: string }).their_answer, TERRACE);
  assertEquals(store.alerts, []);
  assertEquals(store.brokenCalls, []);
  assertEquals(store.outputsSeen.includes("also_answer"), true);
});

Deno.test("a caller with only call_summary: not 'nothing is done', and flagged", async () => {
  const { store, deps } = setup();
  deps.verify = passes([]);
  await reportCall(
    deps,
    "c1",
    result("completed", {
      call_summary: "The agent successfully booked a table for two people for Ihaz at Paragon.",
    }),
  );
  assertEquals(store.settled[0].result, "back");
  assertEquals(status(store), "connected_result_missing_may_or_may_not_have_gone_through");
  assertEquals(
    facts(store).happened.callers_own_note_unconfirmed,
    "The agent successfully booked a table for two people for Ihaz at Paragon.",
  );
  assertEquals(facts(store).values.phone, "+919800000901");
  assertEquals(store.alerts, [{
    kind: "caller_contract_missing",
    detail: { kind: "first", outputs: ["call_summary"] },
  }]);
  assertEquals(store.brokenCalls, ["c1"]);
});

Deno.test("confirm call: the time the business asked for is the redial, not the default (S8)", async () => {
  const { store, deps } = setup("payment_confirm");
  store.limits.payment_confirm_retry_minutes = 30;
  const asked: string[] = [];
  deps.create = async (req) => {
    if (req.tools?.[0]?.name !== "when") return fakeWriter(req);
    asked.push(req.input[0].content as string);
    return say("when", { at: "2026-10-23T12:40:00+05:30" });
  };
  await reportCall(
    deps,
    "c1",
    result("completed", { payment_status: "not_seen", callback_time: "40 minutes" }),
  );
  assertEquals(asked.length, 1);
  assertEquals(store.settled[0].booking?.retry_at, "2026-10-23T07:10:00.000Z");
  assertEquals(facts(store).values.calling_them_again, "today (Fri 23 Oct) at 12:40 pm");
  assertEquals(facts(store).happened.they_asked_to_be_called_back_their_words, "40 minutes");

  // Further off than the screenshot's approval stretches: no redial, their number instead.
  const late = setup("payment_confirm");
  await reportCall(
    late.deps,
    "c1",
    result("completed", { payment_status: "not_seen", callback_time: "2026-10-24T12:00:00+05:30" }),
  );
  assertEquals(late.store.settled[0].result, "unconfirmed");
  assertEquals(facts(late.store).happened.they_want_a_call_later_than_the_desk_can_wait, true);
  assertEquals(facts(late.store).next_step, "check_with_business_themselves");
});

Deno.test("other times with an advance: every term stays with the options (S3)", async () => {
  const { store, deps } = setup();
  deps.checkClaim = ok;
  await reportCall(
    deps,
    "c1",
    result("completed", {
      outcome: "needs_customer_decision",
      options: JSON.stringify([{
        time: "2026-10-23T21:00:00+05:30",
        details: "9 pm",
        advance_required: true,
      }]),
      advance_amount_rs: "500",
      advance_redeemable: "adjusted in the final bill",
      advance_refund: "not refunded if you don't come",
      advance_hold: "yes",
      payment_mode: "upi",
      payment_address: "paragon@okhdfc",
      payee_name: "Paragon Restaurant",
      payment_deadline: "2026-10-23T12:30:00+05:30",
    }),
  );
  assertEquals(store.settled[0].result, "options");
  const f = facts(store);
  assertEquals(f.next_step, "pick_an_option");
  const advance = f.happened.advance_they_want as Record<string, unknown>;
  assertEquals(advance.adjusted_against_bill_their_words, "adjusted in the final bill");
  assertEquals(advance.refund_their_words, "not refunded if you don't come");
  assertEquals(advance.keeping_the_slot_meanwhile, "yes");
  assertEquals(f.values.advance, "Rs 500");
  assertEquals(f.values.pay_to, "paragon@okhdfc");
  assertEquals(f.values.payee, "Paragon Restaurant");
  assertEquals(f.values.deadline, "Fri 23 Oct 2026, 12:30 pm");
});

Deno.test("an address the call doesn't show confirmed whole is never a place to pay (R6)", async () => {
  const { store, deps } = setup();
  const claims: string[] = [];
  deps.checkClaim = async (claim) => {
    claims.push(claim);
    return { verified: false, problems: ["never read back to them whole"], verdict: null };
  };
  await reportCall(deps, "c1", result("completed", terms));
  assertEquals(claims.length, 1);
  assertEquals(claims[0].includes('"paragon@okhdfc"'), true);
  assertEquals(store.settled[0].result, "advance");
  assertEquals(store.settled[0].booking?.upi_id, null);
  assertEquals(facts(store).values.pay_to, undefined);
  assertEquals(facts(store).values.advance, "Rs 500");
  const unknown = facts(store).happened.not_known as string[];
  assertEquals(
    unknown.includes(
      "where exactly to pay: the address wasn't read back to the business in full and confirmed",
    ),
    true,
  );
});

Deno.test("an incomplete payment handle is never a place to pay (S8)", async () => {
  const { store, deps } = setup();
  await reportCall(
    deps,
    "c1",
    result("completed", {
      outcome: "advance_required",
      advance_amount_rs: 500,
      payment_mode: "upi",
      payment_address: "okhdfc",
      payee_name: "paragon kozhikode",
    }),
  );
  assertEquals(store.settled[0].booking?.upi_id, null);
  assertEquals(facts(store).values.pay_to, undefined);
  const unknown = facts(store).happened.not_known as string[];
  assertEquals(unknown.includes("where exactly to pay: what was noted on the call is incomplete"), true);
});

Deno.test("reschedule: an original the business cancelled is told as cancelled, not maybe (S6)", async () => {
  const { store, deps } = setup("reschedule");
  store.call!.task = "reschedule";
  store.call!.bookingTime = "2026-11-06T21:00:00+05:30";
  const claims: string[] = [];
  deps.checkClaim = async (claim) => {
    claims.push(claim);
    return { verified: true, problems: [], verdict: null };
  };
  await reportCall(
    deps,
    "c1",
    result("completed", {
      outcome: "unavailable",
      original_booking_status: "cancelled",
      summary: "They had already cancelled Friday by mistake and have nothing on Saturday.",
    }),
  );
  assertEquals(claims.length, 1);
  assertEquals(store.settled[0].result, "cancelled");
  assertEquals(status(store), "business_says_original_booking_already_cancelled_nothing_new_booked");
  assertEquals(facts(store).next_step, "offer_to_book_again");
  assertEquals(facts(store).happened.new_time_booked, false);
  assertEquals(
    String(facts(store).happened.cancelled_by).startsWith("the business, on their own"),
    true,
  );
  assertEquals(store.alerts.some((a) => a.kind === "business_cancelled_booking"), true);

  const unsure = setup("reschedule");
  unsure.store.call!.task = "reschedule";
  await reportCall(unsure.deps, "c1", result("completed", { original_booking_status: "cancelled" }));
  assertEquals(unsure.store.settled[0].result, "unconfirmed");
  assertEquals(
    status(unsure.store),
    "caller_says_business_cancelled_original_not_verified_nothing_new_booked",
  );
});

Deno.test("a wrong number is not an answer from the business, and isn't offered again (S9)", async () => {
  for (const kind of ["first", "question", "payment_confirm"] as const) {
    const { store, deps } = setup(kind);
    await reportCall(deps, "c1", result("completed", { outcome: "wrong_number", summary: "Not Paragon." }));
    assertEquals(store.settled[0].result, "back");
    assertEquals(store.settled[0].booking?.wrong_number, true);
    assertEquals(status(store), "the_number_reached_someone_else_this_business_was_not_reached_nothing_done");
    assertEquals(facts(store).next_step, "find_the_right_number_or_place");
    assertEquals(facts(store).values.number_called, "+919800000901");
  }
});

Deno.test("voicemail or a phone menu: nothing was said, so nothing is unclear", async () => {
  const { store, deps } = setup("payment_confirm");
  await reportCall(deps, "c1", result("completed", { outcome: "voicemail" }));
  assertEquals(store.settled[0].result, "back");
  assertEquals(status(store), "reached_voicemail_nothing_said_nothing_done");
  assertEquals(facts(store).happened.payment_still_unconfirmed, true);
});

Deno.test("the call itself goes with the facts: transcript by who spoke, and the caller's notes", async () => {
  const { store, deps } = setup();
  const r = result("completed", {
    outcome: "unavailable",
    uncertainties: "They said 8 was free, then that it was taken.",
    options: [],
    advance_amount_rs: null,
  });
  r.transcript = [
    { role: "agent", en_text: "Hi, is this Paragon?" },
    { role: "user", en_text: "Yes. 8 is free... sorry, no, 8 is taken." },
  ];
  await reportCall(deps, "c1", r);
  const f = facts(store);
  assertEquals(f.call?.transcript, [
    "caller: Hi, is this Paragon?",
    "business: Yes. 8 is free... sorry, no, 8 is taken.",
  ]);
  assertEquals(f.call?.caller_noted.outcome, "unavailable");
  assertEquals(f.call?.caller_noted.options, "[]");
  assertEquals("advance_amount_rs" in (f.call?.caller_noted ?? {}), false);
  assertEquals(f.happened.caller_noted_as_unresolved, "They said 8 was free, then that it was taken.");

  // A call that never connected has nothing to show.
  const none = setup();
  await reportCall(none.deps, "c1", result("no_answer", null));
  assertEquals(facts(none.store).call, undefined);
});

Deno.test("a very long call keeps its opening and its end, and says the middle is left out (R10)", async () => {
  const { store, deps } = setup();
  const r = result("completed", { outcome: "unavailable", options: [] });
  r.transcript = [
    { role: "user", en_text: "Refundable only if cancelled before Thursday noon. Pay by UPI tonight." },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "agent", en_text: `filler ${i} ${"x".repeat(900)}` })),
    { role: "user", en_text: "So nothing is free at 8, sorry." },
  ];
  await reportCall(deps, "c1", r);
  const t = facts(store).call!.transcript;
  assertEquals(t[0], "business: Refundable only if cancelled before Thursday noon. Pay by UPI tonight.");
  assertEquals(t[t.length - 1], "business: So nothing is free at 8, sorry.");
  assertEquals(t.some((l) => /^\(\d+ lines from the middle of the call left out\)$/.test(l)), true);
  assertEquals(t.join("").length <= 32_100, true);

  // A call of ordinary length goes whole.
  const short = setup();
  const s = result("completed", { outcome: "unavailable", options: [] });
  s.transcript = Array.from(
    { length: 12 },
    (_, i) => ({ role: "user", en_text: `line ${i} ${"y".repeat(900)}` }),
  );
  await reportCall(short.deps, "c1", s);
  assertEquals(facts(short.store).call!.transcript.length, 12);
});
