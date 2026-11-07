// The Desk finishes what it took on: delivery that survives a failed send, reminders and
// nudges, memory that is never a permission, and saying nothing only when nothing waits.
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { OutsideServiceWindow } from "../deliver.ts";
import type { CallResult } from "../sarvam.ts";
import type { User } from "../store.ts";
import type { Item, ResponseOut } from "../openai.ts";
import type { Outbound } from "../whatsapp.ts";
import { CHECK } from "./approval.ts";
import { type DueFollowUp, followUpFacts, runFollowThrough } from "./followup.ts";
import { inbound } from "./gate_test.ts";
import { type LunaDeps, runLuna } from "./luna.ts";
import { reportCall, type ReportDeps } from "./report.ts";
import type { ActiveRequest } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { fakeWriter, say } from "./test_writer.ts";
import {
  acceptCondition,
  findBooking,
  forget,
  remember,
  type RememberArgs,
  setFollowUp,
  setSlots,
} from "./tools.ts";
import { handleTurn, type TurnDeps } from "./turn.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const now = new Date("2026-10-23T12:00:00+05:30");
const body = (m: Outbound) => (m as { body: string }).body;

const open = (over: Partial<ActiveRequest> = {}): ActiveRequest => ({
  id: "r1",
  task: "booking",
  state: "collecting",
  version: 1,
  fields: { party_size: 4 },
  businessId: "b1",
  bookingId: null,
  createdAt: now,
  pausedAt: null,
  ...over,
});

function report(kind: "first" | "question" = "first") {
  const store = new FakeChatStore();
  store.req = open({ state: "calling_1", task: kind === "question" ? "question" : "booking" });
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
  const sent: Outbound[] = [];
  let failing = 0;
  const deps: ReportDeps = {
    store,
    create: fakeWriter,
    send: async (_u, m) => {
      if (failing-- > 0) throw new Error("whatsapp down");
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
  };
  return { store, sent, deps, fail: (n: number) => (failing = n) };
}

const result = (outputs: Record<string, unknown>): CallResult => ({
  attemptId: "a1",
  callId: "c1",
  status: "completed",
  durationS: 60,
  interactionId: null,
  failureReason: null,
  outputs,
  transcript: null,
  agentNumber: null,
});

Deno.test("a failed send keeps the report: stored, retried, and sent once", async () => {
  const { store, sent, deps, fail } = report("question");
  fail(1);
  await reportCall(deps, "c1", result({ answer: "Open till 9." }));
  assertEquals(sent, []);
  assertEquals(store.deliveries.map((d) => d.status), ["pending"]);

  // The recovery pass.
  store.deliveries[0].attempts = 0;
  await runFollowThrough(deps);
  assertEquals(sent.map(body), ["question_answered."]);
  assertEquals(store.deliveries.map((d) => d.status), ["sent"]);

  await runFollowThrough(deps);
  assertEquals(sent.length, 1);
});

Deno.test("without a simulated clock, the database's clock decides what's due", async () => {
  const { store, deps } = report("question");
  deps.now = undefined;
  await reportCall(deps, "c1", result({ answer: "Open till 9." }));
  assertEquals(store.takenAt.length > 0 && store.takenAt.every((t) => t === undefined), true);
});

Deno.test("a redelivered result settles nothing and sends nothing", async () => {
  const { store, sent, deps } = report("question");
  store.settleResult = { ok: false, reason: "not_calling" };
  await reportCall(deps, "c1", result({ answer: "Open till 9." }));
  assertEquals(sent, []);
});

Deno.test("past the 24-hour window the update stays pending", async () => {
  const { store, deps } = report();
  deps.send = async () => {
    throw new OutsideServiceWindow();
  };
  await reportCall(deps, "c1", result({ booking_status: "not_booked" }));
  assertEquals(store.deliveries[0].status, "pending");
  assertEquals(store.deliveries[0].final, undefined);
});

Deno.test("a configured legacy template is never used outside the window", async () => {
  const { store, deps } = report();
  store.texts.follow_up_template = "desk_update";
  const kinds: string[] = [];
  deps.send = async (_u, m) => {
    kinds.push(m.kind);
    throw new OutsideServiceWindow();
  };
  await reportCall(deps, "c1", result({ booking_status: "not_booked" }));
  assertEquals(kinds, ["text"]);
  assertEquals(store.deliveries[0].status, "pending");
});

Deno.test("an offer on a question call comes back as options with its conditions, accepted by no one", async () => {
  const { store, deps } = report("question");
  store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1"] };
  await reportCall(
    deps,
    "c1",
    result({
      outcome: "question_answered",
      answer: "Yes, we have tables Saturday.",
      options: [{
        time: "2026-10-24T19:30:00+05:30",
        details: "garden table",
        price_rs: 1200,
        conditions: "no refunds",
      }],
    }),
  );
  assertEquals(store.settled[0].result, "options");
  const o = store.settled[0].options![0];
  assertEquals(o.label, "tomorrow (Sat 24 Oct), 7:30 pm, Rs 1200, no refunds");
  assertEquals(o.value.conditions, "no refunds");
  assertEquals(o.value.note, "garden table");
  assertEquals(store.settled[0].booking, undefined);
  assertEquals(store.reports[0].facts.happened.they_said, "Yes, we have tables Saturday.");
  assertEquals(store.prompt!.kind, "options");
});

Deno.test("a date with no time stays a date: no fabricated midnight", async () => {
  const { store, deps } = report();
  store.req = open({
    state: "calling_1",
    fields: { party_size: 4, exact_time: "2026-11-08T20:00:00+05:30" },
  });
  deps.verify = async (c) => ({
    verified: false,
    problems: [`date only: ${c.bookedDate}`],
    verdict: null,
  });
  await reportCall(deps, "c1", result({ booking_status: "booked", booked_time: "2026-11-08" }));
  const b = store.settled[0].booking!;
  assertEquals([b.time, b.date, b.captured], [null, "2026-11-08", "2026-11-08"]);
  assertEquals(store.reports[0].facts.values.when, "Sun 8 Nov, no time confirmed");
});

const withAlso = (kind: "first" = "first") => {
  const t = report(kind);
  t.store.req = open({
    state: "calling_1",
    fields: { party_size: 2, also_ask: "whether they have parking" },
  });
  t.store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1"] };
  t.deps.verify = async () => ({ verified: true, problems: [], verdict: null });
  return t;
};

const also = (t: { store: FakeChatStore }) => t.store.reports[0].facts.happened.also_asked;

Deno.test("the extra question's answer is in the report, whatever happened to the booking", async () => {
  const want = { question: "whether they have parking", their_answer: "Yes, parking is available." };
  const answer = { also_answer: "Yes, parking is available." };
  const booked = withAlso();
  await reportCall(
    booked.deps,
    "c1",
    result({ ...answer, booking_status: "booked", booked_time: "2026-10-24T11:00:00+05:30" }),
  );
  assertEquals(also(booked), want);

  const none = withAlso();
  await reportCall(none.deps, "c1", result({ ...answer, booking_status: "not_booked" }));
  assertEquals(also(none), want);

  const options = withAlso();
  await reportCall(
    options.deps,
    "c1",
    result({
      ...answer,
      booking_status: "not_booked",
      options: [{ time: "2026-10-24T13:00:00+05:30" }],
    }),
  );
  assertEquals(also(options), want);
});

Deno.test("an answer in the older answer field counts, and a missing one is said", async () => {
  const old = withAlso();
  await reportCall(old.deps, "c1", result({ booking_status: "not_booked", answer: "Yes." }));
  assertEquals((also(old) as { their_answer: string }).their_answer, "Yes.");

  const none = withAlso();
  await reportCall(none.deps, "c1", result({ booking_status: "not_booked" }));
  assertEquals((also(none) as { their_answer: string }).their_answer, "no clear answer");
});

Deno.test("no connection, no claim about the extra question", async () => {
  const t = withAlso();
  await reportCall(t.deps, "c1", { ...result({}), status: "no_answer" });
  assertEquals(also(t), undefined);
});

Deno.test("cancel during a call nobody answered: no offer to try again on a closed errand", async () => {
  const { store, deps } = report();
  store.call!.cancelRequested = true;
  await reportCall(deps, "c1", { ...result({}), status: "no_answer" });
  assertEquals(store.reports[0].end, true);
  assertEquals(store.reports[0].facts.next_step, null);
});

const due = (over: Partial<DueFollowUp>): DueFollowUp => ({
  requestId: "r1",
  userId: "u1",
  reason: "reminder",
  task: "booking",
  state: "confirming",
  stamp: 1,
  fields: { party_size: 4 },
  waitingFor: null,
  endReason: null,
  place: "Paragon",
  amountRs: null,
  deadline: null,
  ...over,
});

Deno.test("follow-ups carry what's waiting and the next step, and claim nothing more", () => {
  const reminder = followUpFacts(due({ waitingFor: "Asha to confirm the time" }));
  assertEquals(reminder.happened, {
    status: "reminder_they_asked_for",
    waiting_for: "Asha to confirm the time",
  });
  assertEquals(reminder.next_step, null);
  assertEquals(
    followUpFacts(due({ reason: "nudge", state: "awaiting_yes" })).next_step,
    "answer_the_open_plan",
  );
  assertEquals(
    followUpFacts(due({ reason: "expired", endReason: "window_passed" })).happened.status,
    "closed_because_the_time_passed",
  );
  const pay = followUpFacts(due({
    reason: "payment",
    state: "awaiting_payment",
    amountRs: 300,
    deadline: new Date("2026-10-23T18:00:00+05:30"),
    terms: { refund: "no refunds" },
  }));
  assertEquals(pay.values, { advance: "Rs 300", deadline: "Fri 23 Oct 2026, 6:00 pm" });
  assertEquals(pay.next_step, "send_payment_screenshot");
});

Deno.test("a passed deadline is the user's to decide, and never says the business dropped it", () => {
  const f = followUpFacts(due({
    reason: "deadline",
    state: "awaiting_payment",
    amountRs: 300,
    deadline: new Date("2026-10-23T18:00:00+05:30"),
  }));
  assertEquals(f.happened.status, "payment_deadline_passed_nothing_paid");
  assertEquals(f.happened.note, "the errand stays open; nothing says the business has dropped it");
  assertEquals(f.next_step, "check_with_business_or_drop");
});

Deno.test("due follow-ups are queued, then go out through the same tracked path", async () => {
  const { store, deps } = report();
  store.due = [due({ reason: "nudge", state: "awaiting_yes" })];
  const res = await runFollowThrough(deps);
  assertEquals(res.queued, 1);
  assertEquals(store.queuedFollowUps[0].reason, "nudge");
});

Deno.test("set_follow_up: stored on the errand; a past time is refused", async () => {
  const { store, deps } = report();
  store.req = open();
  const bad = await setFollowUp(deps, user, {
    waitingFor: "Asha",
    remindAt: "2026-10-22T10:00:00+05:30",
    errand: null,
  });
  assertEquals(bad.ok, false);
  const ok = await setFollowUp(deps, user, {
    waitingFor: "Asha to confirm",
    remindAt: "2026-10-24T10:00:00+05:30",
    errand: null,
  });
  assertEquals(ok.ok, true);
  assertEquals(store.followUps, [{ waitingFor: "Asha to confirm", remindAt: "2026-10-24T10:00:00+05:30" }]);
});

const NARROW = { window_start: "2026-10-24T20:00:00+05:30", window_end: "2026-10-24T20:05:00+05:30" };

Deno.test("a narrow window stands only if a second reading finds they asked for that range", async () => {
  for (const [verdict, ok] of [["yes", true], ["no", false], ["unclear", false]] as const) {
    const { store, deps } = report();
    store.req = open();
    store.lines = [{ from: "user", text: "kal aath se sawa aath ke beech", at: now }];
    const seen: string[] = [];
    deps.create = async (req) => {
      seen.push(String(req.input[0].content));
      return say("verdict", { decision: verdict, message: verdict === "yes" ? 1 : null, why: "" });
    };
    assertEquals((await setSlots(deps, user, NARROW)).ok, ok, verdict);
    assertEquals(seen[0].includes("kal aath se sawa aath"), true);
    if (ok) assertEquals(store.slotWrites.at(-1), NARROW);
  }
});

Deno.test("a window of a normal size needs no reading", async () => {
  const { store, deps } = report();
  store.req = open();
  deps.create = () => Promise.reject(new Error("no reading needed"));
  const wide = { window_start: "2026-10-24T19:30:00+05:30", window_end: "2026-10-24T20:30:00+05:30" };
  assertEquals((await setSlots(deps, user, wide)).ok, true);
});

const said = (text: string): RememberArgs => ({
  text,
  kind: "fact",
  scope: null,
  learned: false,
  evidence: null,
});

Deno.test("remember keeps a fact; forget drops it; a repeat isn't kept twice", async () => {
  const { store, deps } = report();
  const created = await remember(deps, user, said("vegetarian"));
  assertEquals(created.ok, true);
  assertEquals(created.outcome, "created");
  assertEquals(created.text, "vegetarian");
  assertEquals(typeof created.say, "string");
  const repeated = await remember(deps, user, said("Vegetarian"));
  assertEquals(repeated.ok, true);
  assertEquals(repeated.already_known, true);
  assertEquals(repeated.outcome, "unchanged");
  assertEquals(repeated.text, "vegetarian");
  assertEquals(store.kept.map((m) => [m.text, m.source, m.scope]), [["vegetarian", "said", "all"]]);
  assertEquals((await forget(deps, user, "the vegetarian thing")).ok, false);
  assertEquals(await forget(deps, user, `m-${store.kept[0].id.slice(0, 8)}`), {
    ok: true,
    forgot: "vegetarian",
  });
  assertEquals(store.kept, []);
});

Deno.test("a learned preference keeps what they said, and a scope", async () => {
  const { store, deps } = report();
  const learned = {
    text: "prefers the Indiranagar branch",
    kind: "preference" as const,
    scope: "place:Toni&Guy",
    learned: true,
  };
  assertEquals((await remember(deps, user, { ...learned, evidence: null })).ok, false);
  const ok = await remember(deps, user, { ...learned, evidence: "ഇന്ദിരാനഗർ ബ്രാഞ്ച് മതി" });
  assertEquals(ok.ok, true);
  assertEquals("say" in ok, true);
  assertEquals(store.kept[0].source, "learned");
  assertEquals(store.kept[0].scope, "place:Toni&Guy");
  assertEquals((await remember(deps, user, { ...said("x"), scope: "everything" })).ok, false);
});

const call = (name: string, args: unknown, id = name): Item => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: `call_${id}`,
});

function luna(steps: Item[][]) {
  const store = new FakeChatStore();
  const sent: Outbound[] = [];
  const inputs: Item[][] = [];
  const deps: LunaDeps = {
    store,
    send: async (_u, m) => {
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
    create: async (req): Promise<ResponseOut> => {
      inputs.push(structuredClone(req.input));
      return { output: steps.shift() ?? [], usage: { input_tokens: 0, output_tokens: 0 } };
    },
    searchPlaces: async () => [],
    onApproved: async () => ({ started: true }),
  };
  return { store, sent, inputs, deps };
}

const noul = (n: number) => ({ type: "noul" as const, noul: n });

// The router reads their message as this; the output check scores a reply with promise.
function jevReads(t: { store: FakeChatStore; deps: LunaDeps }, intent: string, promise = () => 0) {
  t.store.texts.jev_model = "jev-test";
  t.store.texts.jev_mode = "shadow";
  t.deps.jev = async (q) =>
    (q.questions.intent
      ? {
        intent: { type: "choice", choice: intent, confidence: 0.9, probabilities: { [intent]: 0.9 } },
        injection: noul(0),
      }
      : { claims_action: noul(0), off_task_content: noul(0), promises_follow_up: noul(promise()) }) as never;
}

Deno.test("nothing needs saying: stay_quiet sends nothing and no fallback", async () => {
  const t = luna([[call("stay_quiet", { why: "just thanks" })]]);
  jevReads(t, "closing");
  t.store.lines = [{ from: "desk", text: "All done.", at: now }, { from: "user", text: "shukriya", at: now }];
  await runLuna(t.deps, user, now);
  assertEquals(t.sent, []);
  assertEquals(t.store.routes[0].l3Result, "pass");
});

const refused = async (setupFn: (s: FakeChatStore) => void) => {
  const t = luna([[call("stay_quiet", {})], [call("reply", { text: "Sure, here you go." })]]);
  setupFn(t.store);
  await runLuna(t.deps, user, now);
  return t;
};

// Whether a message needs an answer is Luna's reading (a question in any language is the
// conversation eval's to check, question-in-malayalam). Code's rule is the same whatever the
// router reads, and with no router at all: an outage or shadow setting changes nothing.
Deno.test("the router's reading never decides silence: with nothing owed, stay_quiet stands however it reads", async () => {
  for (const reads of ["status", "greeting", null]) {
    const t = luna([[call("stay_quiet", { why: "nothing needed" })]]);
    if (reads) jevReads(t, reads);
    t.store.lines = [{ from: "desk", text: "All done.", at: now }, { from: "user", text: "നന്ദി", at: now }];
    await runLuna(t.deps, user, now);
    assertEquals(t.sent, [], `router read ${reads}`);
  }
});

Deno.test("stay_quiet is refused while a plan is open", async () => {
  const { sent, inputs } = await refused((s) => {
    s.req = open({ state: "awaiting_yes" });
    s.prompt = {
      id: "p1",
      kind: "ask",
      optionIds: [],
      confirmWord: "yes",
      waMessageId: "wamid.plan",
      sentAt: now,
      text: "Plan",
      message: { kind: "text", body: "Plan" },
    };
    s.lines = [{ from: "user", text: "ok thanks", at: now }];
  });
  assertEquals(sent.length, 1);
  assertEquals(JSON.parse(inputs[1].at(-1)!.output).reason.startsWith("a plan is open"), true);
});

Deno.test("stay_quiet is refused on the first word after an update that asked something (R3)", async () => {
  const before = new Date(now.getTime() - 60_000);
  const { sent, inputs } = await refused((s) => {
    s.asked = before;
    s.lines = [
      {
        from: "desk",
        text: "That number reached someone else. Shall I look for another branch?",
        at: before,
      },
      { from: "user", text: "Okay", at: now },
    ];
  });
  assertEquals(sent.length, 1);
  assertEquals(
    JSON.parse(inputs[1].at(-1)!.output).reason.startsWith("the Desk's last update asked them something"),
    true,
  );

  // Once they've already answered it, a later "ok" can go unanswered.
  const t = luna([[call("stay_quiet", { why: "just ok" })]]);
  jevReads(t, "closing");
  t.store.asked = before;
  t.store.lines = [
    { from: "user", text: "Yes, look", at: new Date(before.getTime() + 1000) },
    { from: "desk", text: "Found two.", at: new Date(before.getTime() + 2000) },
    { from: "user", text: "ok", at: now },
  ];
  await runLuna(t.deps, user, now);
  assertEquals(t.sent, []);
});

Deno.test("a reply WhatsApp wouldn't take stays owed instead of killing the turn", async () => {
  const { store, deps } = luna([[call("reply", { text: "Which day?" })]]);
  deps.send = async () => {
    throw new Error("whatsapp down");
  };
  await runLuna(deps, user, now, "wamid.in1");
  assertEquals(store.owed, [{ key: "wamid.in1", message: { kind: "text", body: "Which day?" } }]);
});

Deno.test("a long useful reply is not rejected for its length", async () => {
  const text = "They close at 9, and your table is the 8:30. ".repeat(12).trim();
  const { sent, deps } = luna([[call("reply", { text })]]);
  await runLuna(deps, user, now);
  assertEquals(sent, [{ kind: "text", body: text }]);
});

for (const jevMode of ["shadow", "gate"]) {
  Deno.test(`a promised reminder has to exist, however it's worded (jev ${jevMode})`, async () => {
    const t = luna([
      [call("reply", { text: "Theek hai, kal yaad dila dungi." }, "a")],
      [
        call("set_follow_up", { waiting_for: "their call", remind_at: "2026-10-24T10:00:00+05:30" }),
        call("reply", { text: "Kal 10 baje yaad dila dungi." }, "b"),
      ],
    ]);
    jevReads(t, "later", () => 0.9);
    t.store.texts.jev_mode = jevMode;
    t.store.req = open();
    await runLuna(t.deps, user, now);
    assertEquals(JSON.parse(t.inputs[1].at(-1)!.output).reason.startsWith("you promised a reminder"), true);
    assertEquals(t.store.followUps.length, 1);
    assertEquals(t.sent, [{ kind: "text", body: "Kal 10 baje yaad dila dungi." }]);
  });
}

Deno.test("a promise of a reminder that's already set goes out as written", async () => {
  const t = luna([[call("reply", { text: "Kal 10 baje yaad dila dungi." })]]);
  jevReads(t, "later", () => 0.9);
  t.store.req = open({ remindAt: new Date("2026-10-24T04:30:00Z") });
  await runLuna(t.deps, user, now);
  assertEquals(t.inputs.length, 1);
  assertEquals(t.sent, [{ kind: "text", body: "Kal 10 baje yaad dila dungi." }]);
});

Deno.test("one message is one errand of a kind, unless they asked for two", async () => {
  const t = luna([
    [
      call("start_new_request", { task: "booking" }, "a"),
      call("start_new_request", { task: "booking", mode: "after" }, "b"),
    ],
    [call("reply", { text: "Which place?" })],
  ]);
  const started: string[] = [];
  const start = ((_u: string, task: string) => {
    started.push(task);
    return Promise.resolve({
      ok: true,
      request_id: "r1000000-0000",
      state: "collecting",
      replaced_request_id: null,
    });
  }) as never;
  t.store.startRequest = start;
  await runLuna(t.deps, user, now);
  assertEquals(started, ["booking"]);
  assertEquals(t.store.queuedTasks, []);

  const two = luna([
    [
      call("start_new_request", { task: "booking" }, "a"),
      call("start_new_request", { task: "booking", mode: "after", separate: true }, "b"),
    ],
    [call("reply", { text: "Which places?" })],
  ]);
  two.store.startRequest = start;
  await runLuna(two.deps, user, now);
  assertEquals(two.store.queuedTasks, ["booking"]);
});

const upcoming = (over: Record<string, unknown>) => ({
  id: "aaaaaaaa-0000",
  status: "booked",
  time: new Date("2026-10-24T20:00:00+05:30"),
  place: "Paragon",
  what: "table for 4",
  reference: null,
  ...over,
});

Deno.test("find_booking shows every booking with what's known, each kept together, and binds by ref", async () => {
  const { store, deps } = report();
  store.req = open({ task: "reschedule" });
  store.bookings = [
    upcoming({}),
    upcoming({ id: "bbbbbbbb-0000", status: "probably_booked", time: new Date("2026-10-25T20:00:00+05:30") }),
    upcoming({ id: "cccccccc-0000", status: "advance_due" }),
  ];
  const r = await findBooking(deps, user, null) as unknown as { bookings: Record<string, string>[] };
  assertEquals(r.bookings.map((b) => [b.ref, b.when, b.known]), [
    ["aaaaaaaa", "Sat 24 Oct 2026, 8:00 pm", "booked"],
    ["bbbbbbbb", "Sun 25 Oct 2026, 8:00 pm", "not confirmed by the business"],
    ["cccccccc", "Sat 24 Oct 2026, 8:00 pm", "advance not paid; nothing agreed"],
  ]);
  assertEquals(store.bookingSet, []);
  assertEquals((await findBooking(deps, user, "bbbbbbbb")).ok, true);
  assertEquals(store.bookingSet, ["bbbbbbbb-0000"]);
  assertEquals((await findBooking(deps, user, "nope")).ok, false);
});

Deno.test("one booking binds at once; no words are matched to get there", async () => {
  const { store, deps } = report();
  store.req = open({ task: "cancel" });
  store.bookings = [upcoming({})];
  assertEquals((await findBooking(deps, user, null)).ok, true);
  assertEquals(store.bookingSet, ["aaaaaaaa-0000"]);
});

const decision = {
  bookingId: "dddddddd-0000",
  place: "Paragon",
  time: null,
  conditions: [{ words: "Rs 500 cover per head", what: "cover charge" }],
};

Deno.test("accepting a condition needs a second reading, and keeps their message", async () => {
  const { store, deps } = report();
  store.decisions = [decision];
  store.lines = [{ from: "user", text: "ok fine, theek hai", at: now }];
  deps.create = async () => say("verdict", { decision: "yes", message: 1, why: "accepted" });
  assertEquals((await acceptCondition(deps, user, "dddddddd")).ok, true);
  assertEquals(store.accepted[0].bookingId, "dddddddd-0000");
  assertEquals(store.accepted[0].basis.evidence, "ok fine, theek hai");

  const no = report();
  no.store.decisions = [decision];
  no.deps.create = async () => say("verdict", { decision: "no", message: null, why: "still deciding" });
  assertEquals((await acceptCondition(no.deps, user, "dddddddd")).ok, false);
  assertEquals(no.store.accepted, []);
});

Deno.test("cancel during a live call: told how it ends, the flag is set", async () => {
  const { store, sent, deps } = luna([
    [call("cancel_request", {})],
    [call("reply", { text: "The call is already under way, so I can't stop it." })],
  ]);
  store.req = open({ state: "calling_1" });
  store.cancelResult = { ok: false, reason: "in_flight" };
  await runLuna(deps, user, now);
  assertEquals(store.cancelledAfterCall, ["r1"]);
  assertEquals(sent.length, 1);
});

function reactionDeps(store: FakeChatStore, seen: string[]): TurnDeps {
  return {
    store,
    send: async () => "x",
    isAdmin: () => false,
    luna: async (_u, text) => void seen.push(text),
    onCommand: async () => {},
    onPayment: async () => {},
    now: () => now,
  };
}

Deno.test("a 👍 reaches Luna whatever it's on, as what it points at; a removed one reaches nothing", async () => {
  const store = new FakeChatStore();
  store.req = open({ state: "awaiting_yes" });
  store.prompt = {
    id: "p1",
    kind: "ask",
    optionIds: [],
    confirmWord: "yes",
    waMessageId: "wamid.plan",
    sentAt: now,
    text: "Plan",
    message: { kind: "text", body: "Plan" },
  };
  const seen: string[] = [];
  const deps = reactionDeps(store, seen);
  // Routing is not approval: approval reads only reactions on the plan (approval_test).
  await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "wamid.other" }), deps);
  await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "wamid.plan" }), deps);
  await handleTurn(user, inbound({ type: "reaction", text: "", quotedId: "wamid.plan" }), deps);
  assertEquals(seen, ["[reacted 👍]", "[reacted 👍]"]);
  assertEquals(store.consents, []);
});

Deno.test("with no plan open, a casual 👍 sends nothing and approves nothing", async () => {
  const t = luna([[call("stay_quiet", { why: "a thumbs-up on the report" })]]);
  t.store.lines = [
    {
      from: "desk",
      text: "Booked: Paragon, 8 pm tonight, table for 4.",
      at: new Date(now.getTime() - 60_000),
    },
    { from: "user", text: "[reacted 👍]", at: now },
  ];
  await runLuna(t.deps, user, now);
  assertEquals(t.sent, []);
  assertEquals(t.store.consents, []);
});

Deno.test("the approval check counts casual agreement and a reaction on the plan by meaning, not a list", () => {
  assertEquals(CHECK.includes("Short and casual agreement counts"), true);
  assertEquals(CHECK.includes("an emoji reaction on the plan itself"), true);
  // The serialised form of a reaction stays documented; no approval phrases are listed.
  assertEquals(CHECK.includes("[reacted 👍]"), true);
  assertEquals(/"ok( thanks)?"|haan kar do|sounds good/.test(CHECK), false);
});

Deno.test("a first message to the Desk is always answered: a stored fact refuses silence, not a reading", async () => {
  const t = luna([[call("stay_quiet", { why: "just hi" })], [call("reply", { text: "Hi, I'm Desk." })]]);
  jevReads(t, "greeting");
  t.store.isFirstContact = true;
  t.store.lines = [{ from: "user", text: "hi", at: now }];
  await runLuna(t.deps, user, now);
  assertEquals(t.sent.length, 1);
  assertEquals(
    JSON.parse(t.inputs[1].at(-1)!.output).reason,
    "this is their first message to the Desk; answer it",
  );
});

// The 7 Nov shape: a returning user says hello after a finished errand, with no plan open and
// no question waiting. Code holds nothing owed, so it doesn't force a reply: answering is
// Luna's judgment, which the conversation eval checks (returning-hi-after-failed-call).
Deno.test("a returning user's hello has no code obligation: Luna's choice stands", async () => {
  const t = luna([[call("stay_quiet", { why: "test" })]]);
  const earlier = new Date(now.getTime() - 18 * 3_600_000);
  t.store.lines = [
    { from: "desk", text: "The call didn't start, so I haven't booked anything.", at: earlier },
    { from: "user", text: "Sure", at: new Date(earlier.getTime() + 1000) },
    { from: "user", text: "hi", at: now },
  ];
  await runLuna(t.deps, user, now);
  assertEquals(t.sent, []);
});

Deno.test("several quick messages answering an update's question are one answer: silence stays refused", async () => {
  const before = new Date(now.getTime() - 60_000);
  const { sent, inputs } = await refused((s) => {
    s.asked = before;
    s.lines = [
      {
        from: "desk",
        text: "That number reached someone else. Shall I look for another branch?",
        at: before,
      },
      { from: "user", text: "Okay", at: new Date(now.getTime() - 2000) },
      { from: "user", text: "sure", at: now },
    ];
  });
  assertEquals(sent.length, 1);
  assertEquals(
    JSON.parse(inputs[1].at(-1)!.output).reason.startsWith("the Desk's last update asked them something"),
    true,
  );
});
