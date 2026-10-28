import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { CallResult } from "../sarvam.ts";
import type { Outbound } from "../whatsapp.ts";
import { readOutcome, reportCall, type ReportDeps } from "./report.ts";
import { FakeChatStore } from "./test_chat_store.ts";

const now = new Date("2026-10-23T12:00:00+05:30");

function setup(kind: "first" | "booking" | "question" = "first") {
  const store = new FakeChatStore();
  store.call = {
    callId: "c1",
    requestId: "r1",
    userId: "u1",
    waId: "919812345678",
    kind,
    task: kind === "question" ? "question" : "booking",
    businessId: "b1",
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

Deno.test("booked: said as the business confirmed it on the call, and the errand is done", async () => {
  const { store, sent, deps } = setup();
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
    booking: { time: "2026-10-23T20:00:00+05:30", reference: "T12" },
    optOut: false,
  });
  assertEquals(
    body(sent[0]),
    "Paragon confirmed it on the call, tonight (Fri 23 Oct) at 8:00 pm, in your name. Reference: T12.",
  );
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
    const out of [null, {}, { booking_status: "maybe" }, { outcome: "booked" }, { booking_status: "BOOKED" }]
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
