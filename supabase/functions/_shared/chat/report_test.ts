import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { CallKind, CallResult } from "../sarvam.ts";
import type { Outbound } from "../whatsapp.ts";
import { readOutcome, reportCall, type ReportDeps } from "./report.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import type { BookingCheck, Verification } from "./verify.ts";

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
    send: async (_u, m) => {
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
  };
  return { store, sent, deps };
}

const result = (status: CallResult["status"], outputs: Record<string, unknown> | null): CallResult => ({
  attemptId: "a1",
  callId: "c1",
  status,
  durationS: 60,
  interactionId: null,
  failureReason: null,
  outputs,
  transcript: null,
  agentNumber: null,
});
const body = (m: Outbound) => (m as { body: string }).body;

const passes = (checks: BookingCheck[]) => async (c: BookingCheck): Promise<Verification> => {
  checks.push(c);
  return { verified: true, problems: [], verdict: null };
};

Deno.test("booked and verified: said as the business confirmed it on the call, and the errand is done", async () => {
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
    booking: { time: "2026-10-23T20:00:00+05:30", reference: "T12", verified: true, problems: [] },
    optOut: false,
  });
  assertEquals(checks[0].kind, "first");
  assertEquals(checks[0].bookedTime, "2026-10-23T20:00:00+05:30");
  assertEquals(checks[0].defaultToleranceMin, 15);
  assertEquals(
    body(sent[0]),
    "Paragon confirmed it on the call, tonight (Fri 23 Oct) at 8:00 pm, in your name. Reference: T12.",
  );
});

Deno.test("booked but not verified: probably booked, check with them, and flagged with the problems", async () => {
  const { store, sent, deps } = setup();
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
  assertEquals(store.settled[0].booking, {
    time: "2026-10-23T20:00:00+05:30",
    reference: null,
    verified: false,
    problems: ["transcript: unclear (no read-back)"],
  });
  assertEquals(
    body(sent[0]),
    "Paragon said it's booked, tonight (Fri 23 Oct) at 8:00 pm, but I couldn't confirm that from the call, " +
      "so please check with them yourself: +919800000901.",
  );
});

Deno.test("booked with no verifier wired: never reported as confirmed", async () => {
  const { store, sent, deps } = setup();
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(store.settled[0].booking?.verified, false);
  assertEquals(body(sent[0]).includes("please check with them yourself"), true);
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
  for (const s of ["no_answer", "busy", "failed"] as const) {
    const { store, sent, deps } = setup();
    await reportCall(deps, "c1", result(s, null));
    assertEquals(store.settled[0].result, "back", s);
    assertEquals(body(sent[0]).includes("nothing is done yet"), true, s);
  }
});

Deno.test("anything the outputs don't make clear is never reported as booked", async () => {
  for (
    const out of [null, {}, { booking_status: "maybe" }, { outcome: "voicemail" }, {
      booking_status: "BOOKED",
    }]
  ) {
    const { store, sent, deps } = setup();
    await reportCall(deps, "c1", result("completed", out));
    assertEquals(store.settled[0].result, "back", JSON.stringify(out));
    assertEquals(/booked|confirmed/.test(body(sent[0]).replace("treating anything as done", "")), false);
  }
});

Deno.test("an advance: nothing agreed or paid, said plainly", async () => {
  const { store, sent, deps } = setup();
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "held_pending_deposit", advance_amount: 500 }),
  );
  assertEquals(store.settled[0].result, "back");
  assertEquals(
    body(sent[0]),
    "Paragon will only hold it with an advance of Rs 500. I didn't agree to it or pay anything, so nothing is " +
      "booked. Do you want to try another time or place?",
  );
});

Deno.test("other times offered: they become options, sent as text to pick from in words", async () => {
  const { store, sent, deps } = setup();
  store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1", "o2"] };
  store.options = [{ id: "o1", label: "tonight (Fri 23 Oct), 8:30 pm", detail: null }, {
    id: "o2",
    label: "tonight (Fri 23 Oct), 9:15 pm",
    detail: null,
  }];
  await reportCall(
    deps,
    "c1",
    result("completed", {
      booking_status: "not_booked",
      no_match_reason: "no_slot",
      options: [{ time: "2026-10-23T20:30:00+05:30", party_size: 4 }, { time: "2026-10-23T21:15:00+05:30" }],
    }),
  );
  assertEquals(store.settled[0].result, "options");
  assertEquals(store.settled[0].options!.map((o) => o.label), [
    "tonight (Fri 23 Oct), 8:30 pm",
    "tonight (Fri 23 Oct), 9:15 pm",
  ]);
  assertEquals(sent[0].kind, "text");
  assertEquals(
    body(sent[0]).startsWith("Paragon can't do what you asked (that time isn't free). They offered:\n1. "),
    true,
  );
  assertEquals(store.prompt!.kind, "options");
});

Deno.test("a question answered: the business's words, quoted and cleaned", async () => {
  const { store, sent, deps } = setup("question");
  await reportCall(deps, "c1", result("completed", { answer: "Yes, Rs 250,‮ ready Friday." }));
  assertEquals(store.settled[0].result, "done");
  assertEquals(body(sent[0]), 'Paragon said: "Yes, Rs 250, ready Friday."');
});

Deno.test("an opt-out is recorded and the user told; a redelivered result says nothing twice", async () => {
  const { store, sent, deps } = setup();
  await reportCall(
    deps,
    "c1",
    result("completed", { booking_status: "not_booked", opt_out_requested: "yes" }),
  );
  assertEquals(store.settled[0].optOut, true);
  assertEquals(
    body(sent[0]).endsWith("They asked not to be called again, so I won't call them in future."),
    true,
  );
  store.settleResult = { ok: false, reason: "not_calling" };
  await reportCall(deps, "c1", result("completed", { booking_status: "booked" }));
  assertEquals(sent.length, 1);
});

Deno.test("when an errand ends, the one waiting behind it is brought up", async () => {
  const { store, sent, deps } = setup("question");
  store.activated = "r2";
  await reportCall(deps, "c1", result("completed", { answer: "Yes." }));
  assertEquals(
    body(sent[0]).endsWith("Next I have your booking for Paragon. Shall I carry on with it?"),
    true,
  );
});

Deno.test("readOutcome: options in the past or without a time or label are dropped", () => {
  const o = readOutcome("first", {
    booking_status: "not_booked",
    options: [{ time: "2026-10-23T09:00:00+05:30" }, {}, { label: "Sat lunch" }],
  }, now);
  assertEquals(o.kind === "options" && o.options.map((x) => x.label), ["Sat lunch"]);
});

// Advances, confirm calls, cancels and reschedules (0011) -------------------------------

const ok = async (): Promise<Verification> => ({ verified: true, problems: [], verdict: null });

Deno.test("an advance within the approved cap, with UPI details: held, and the user told how to pay", async () => {
  const { store, sent, deps } = setup();
  store.req!.fields = { ...store.req!.fields, max_advance_rs: 500 };
  await reportCall(
    deps,
    "c1",
    result("completed", {
      booking_status: "held_pending_deposit",
      advance_amount: 300,
      upi_id: "paragon@okhdfc",
      payee_name: "Paragon Restaurant",
      payment_deadline: "2026-10-23T19:30:00+05:30",
      booked_time: "2026-10-23T20:15:00+05:30",
    }),
  );
  assertEquals(store.settled[0].result, "held");
  assertEquals(store.settled[0].booking?.amount_rs, 300);
  assertEquals(store.settled[0].booking?.upi_id, "paragon@okhdfc");
  const text = body(sent[0]);
  assertEquals(text.includes("Rs 300 advance, to be paid by 7:30 pm"), true);
  assertEquals(text.includes("Pay paragon@okhdfc (Paragon Restaurant)"), true);
  assertEquals(text.includes("send me the payment screenshot"), true);
});

Deno.test("an advance over the cap, or with nowhere to pay, is not held", async () => {
  for (const out of [{ advance_amount: 800, upi_id: "p@ok" }, { advance_amount: 300 }]) {
    const { store, deps } = setup();
    store.req!.fields = { ...store.req!.fields, max_advance_rs: 500 };
    await reportCall(deps, "c1", result("completed", { booking_status: "held_pending_deposit", ...out }));
    assertEquals(store.settled[0].result, "back", JSON.stringify(out));
  }
});

Deno.test("confirm call: received and booked, verified against the held booking's time", async () => {
  const { store, sent, deps } = setup("payment_confirm");
  store.call!.bookingTime = "2026-10-23T20:15:00+05:30";
  const checks: BookingCheck[] = [];
  deps.verify = passes(checks);
  await reportCall(deps, "c1", result("completed", { payment_status: "received", booking_status: "booked" }));
  assertEquals(checks[0].kind, "booking");
  assertEquals(checks[0].option?.value.time, "2026-10-23T20:15:00+05:30");
  assertEquals(checks[0].bookedTime, "2026-10-23T20:15:00+05:30");
  assertEquals(store.settled[0].result, "done");
  assertEquals(body(sent[0]).startsWith("Paragon confirmed they got your payment, and it's booked"), true);
});

Deno.test("confirm call: not seen → one redial; not seen again → unconfirmed, with their number", async () => {
  const first = setup("payment_confirm");
  first.store.limits.payment_confirm_retry_minutes = 30;
  await reportCall(first.deps, "c1", result("completed", { payment_status: "not_seen" }));
  assertEquals(first.store.settled[0].result, "retry");
  assertEquals(
    body(first.sent[0]),
    "Paragon hasn't seen your payment yet. I'll call them again in about 30 minutes.",
  );

  const second = setup("payment_confirm");
  second.store.call!.isRetry = true;
  await reportCall(second.deps, "c1", result("completed", { outcome: "payment_not_seen" }));
  assertEquals(second.store.settled[0].result, "unconfirmed");
  assertEquals(body(second.sent[0]).endsWith("+919800000901."), true);
});

Deno.test("confirm call: wrong amount or an expired hold: nothing agreed, no refund promised", async () => {
  const { store, sent, deps } = setup("payment_confirm");
  await reportCall(
    deps,
    "c1",
    result("completed", { payment_status: "wrong_amount", summary: "We got Rs 50, not Rs 500." }),
  );
  assertEquals(store.settled[0].result, "unconfirmed");
  const text = body(sent[0]);
  assertEquals(text.includes('They said: "We got Rs 50, not Rs 500."'), true);
  assertEquals(/refund/i.test(text), false);
});

Deno.test("cancel: cancelled only when the business's words confirm it; a refund only as their words", async () => {
  const { store, sent, deps } = setup("cancel");
  store.call!.bookingTime = "2026-10-23T20:15:00+05:30";
  deps.checkClaim = ok;
  await reportCall(
    deps,
    "c1",
    result("completed", { cancel_status: "cancelled", refund_stated: "advance back to UPI in 2 days" }),
  );
  assertEquals(store.settled[0].result, "cancelled");
  assertEquals(
    body(sent[0]),
    "Cancelled: your tonight (Fri 23 Oct) at 8:15 pm booking at Paragon. About the advance they said: " +
      '"advance back to UPI in 2 days".',
  );

  const unsure = setup("cancel");
  await reportCall(unsure.deps, "c1", result("completed", { cancel_status: "cancelled" }));
  assertEquals(unsure.store.settled[0].result, "unconfirmed");
});

Deno.test("cancel: a charge is kept for the next plan, and the booking still stands", async () => {
  const { store, sent, deps } = setup("cancel");
  await reportCall(
    deps,
    "c1",
    result("completed", { cancel_status: "charge_pending", cancel_charge_rs: "200" }),
  );
  assertEquals(store.settled[0], { result: "back", booking: { fee_rs: 200 }, optOut: false });
  assertEquals(body(sent[0]).includes("cancelling costs Rs 200. I didn't agree to it"), true);
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
  assertEquals(body(moved.sent[0]), "Moved: Paragon, now tonight (Fri 23 Oct) at 9:00 pm.");

  const kept = setup("reschedule");
  kept.store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1"] };
  kept.store.options = [{ id: "o1", label: "tonight (Fri 23 Oct), 9:45 pm", detail: null }];
  await reportCall(
    kept.deps,
    "c1",
    result("completed", { outcome: "kept", options: [{ time: "2026-10-23T21:45:00+05:30" }] }),
  );
  assertEquals(kept.store.settled[0].result, "options");
  assertEquals(
    kept.store.prompt!.text.startsWith("Paragon can't move it, and said your booking stands."),
    true,
  );

  const unclear = setup("reschedule");
  await reportCall(unclear.deps, "c1", result("completed", { outcome: "uncertain" }));
  assertEquals(unclear.store.settled[0].result, "unconfirmed");
  assertEquals(body(unclear.sent[0]).includes("it's not clear what they did"), true);
});
