// The Desk finishes what it took on: delivery that survives a failed send, reminders and
// nudges, memory that is never a permission, and saying nothing only when nothing waits.
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { OutsideServiceWindow } from "../deliver.ts";
import type { CallResult } from "../sarvam.ts";
import type { User } from "../store.ts";
import type { Item, ResponseOut } from "../openai.ts";
import type { Outbound } from "../whatsapp.ts";
import { checkApproval } from "./approval.ts";
import { type DueFollowUp, followUpText, runFollowThrough } from "./followup.ts";
import { inbound } from "./gate_test.ts";
import { type LunaDeps, runLuna } from "./luna.ts";
import { reportCall, type ReportDeps } from "./report.ts";
import type { ActiveRequest } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { forget, remember, type RememberArgs, setFollowUp } from "./tools.ts";
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
  assertEquals(sent.map(body), ['Paragon said: "Open till 9."']);
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

Deno.test("past the 24-hour window with no template, it fails for good and says so", async () => {
  const { store, deps } = report("question");
  deps.send = async () => {
    throw new OutsideServiceWindow();
  };
  await reportCall(deps, "c1", result({ answer: "Open till 9." }));
  assertEquals(store.deliveries[0].status, "failed");
  assertEquals(store.deliveries[0].final, true);
});

Deno.test("past the 24-hour window with a template, the message goes as its parameter", async () => {
  const { store, sent, deps } = report("question");
  store.texts.follow_up_template = "desk_update";
  deps.send = async (_u, m) => {
    if (m.kind !== "template") throw new OutsideServiceWindow();
    sent.push(m);
    return "wamid.t1";
  };
  await reportCall(deps, "c1", result({ answer: "Open till 9." }));
  assertEquals(sent, [{
    kind: "template",
    name: "desk_update",
    language: "en",
    params: ['Paragon said: "Open till 9."'],
  }]);
  assertEquals(store.deliveries[0].status, "sent");
});

Deno.test("an offer on a question call comes back as options with its conditions, accepted by no one", async () => {
  const { store, sent, deps } = report("question");
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
  assertEquals(
    o.label,
    "tomorrow (Sat 24 Oct), 7:30 pm, garden table, they quoted Rs 1200, no refunds",
  );
  assertEquals(o.value.conditions, "no refunds");
  assertEquals(store.settled[0].booking, undefined);
  const text = body(sent[0]);
  assertEquals(
    text.startsWith('Paragon said: "Yes, we have tables Saturday."\n\nThey also offered to book:\n1. '),
    true,
  );
  assertEquals(text.includes("Tell me which one and I'll call back to book it in your name (Ihaz)."), true);
  assertEquals(store.prompt!.kind, "options");
});

Deno.test("first call: an option's conditions and price reach the user", async () => {
  const { store, deps } = report();
  store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: ["o1"] };
  await reportCall(
    deps,
    "c1",
    result({
      booking_status: "not_booked",
      options: [{ time: "2026-10-23T21:00:00+05:30", conditions: "minimum spend Rs 2000" }],
    }),
  );
  assertEquals(store.settled[0].options![0].label.includes("minimum spend Rs 2000"), true);
});

Deno.test("cancel during the call, nothing booked: the errand ends and options aren't opened", async () => {
  const { store, sent, deps } = report();
  store.call!.cancelRequested = true;
  store.settleResult = { ok: true, request_id: "r1", state: "done", option_ids: [] };
  await reportCall(
    deps,
    "c1",
    result({ booking_status: "not_booked", options: [{ time: "2026-10-23T21:00:00+05:30" }] }),
  );
  assertEquals(store.settled[0].result, "back");
  assertEquals(store.reports[0].end, true);
  assertEquals(store.reports[0].prompt, undefined);
  assertEquals(body(sent[0]).startsWith("You asked me to cancel during the call"), true);
});

Deno.test("cancel during the call, booked: the booking stands and the user is told plainly", async () => {
  const { store, sent, deps } = report();
  store.call!.cancelRequested = true;
  deps.verify = async () => ({ verified: true, problems: [], verdict: null });
  await reportCall(
    deps,
    "c1",
    result({ booking_status: "booked", booked_time: "2026-10-23T20:00:00+05:30" }),
  );
  assertEquals(store.reports[0].end, false);
  assertEquals(body(sent[0]).includes("That went through before I could stop it."), true);
});

Deno.test("a date with no time stays a date: no fabricated midnight", async () => {
  const { store, sent, deps } = report();
  store.req = open({
    state: "calling_1",
    fields: { party_size: 4, exact_time: "2026-11-08T20:00:00+05:30" },
  });
  deps.verify = async (c) => ({
    verified: false,
    problems: [`date only: ${c.bookedDate}`],
    verdict: null,
  });
  await reportCall(deps, "c1", result({ booking_status: "booked", booked_time: "November 8" }));
  const b = store.settled[0].booking!;
  assertEquals([b.time, b.date, b.captured], [null, "2026-11-08", "November 8"]);
  assertEquals(body(sent[0]).includes("for Sun 8 Nov, no time confirmed"), true);
  assertEquals(body(sent[0]).includes("12:00 am"), false);
});

Deno.test("a wrong year the call didn't settle is neither stored nor shown", async () => {
  const { store, sent, deps } = report();
  store.req = open({
    state: "calling_1",
    fields: { party_size: 4, exact_time: "2026-11-08T20:00:00+05:30" },
  });
  deps.verify = async () => ({ verified: false, problems: ["time"], verdict: null, badYear: true });
  await reportCall(
    deps,
    "c1",
    result({ booking_status: "booked", booked_time: "2025-11-08T20:00:00+05:30" }),
  );
  const b = store.settled[0].booking!;
  assertEquals([b.time, b.captured], [null, "2025-11-08T20:00:00+05:30"]);
  assertEquals(body(sent[0]).includes("2025"), false);
});

Deno.test("a corrected year: the approved date is stored, with both values and why", async () => {
  const { store, sent, deps } = report();
  store.req = open({
    state: "calling_1",
    fields: { party_size: 4, exact_time: "2026-11-08T20:00:00+05:30" },
  });
  const correction = {
    from: "2025-11-08T20:00:00+05:30",
    to: "2026-11-08T20:00:00+05:30",
    why: "wrong year",
  };
  deps.verify = async () => ({ verified: true, problems: [], verdict: null, correction });
  await reportCall(
    deps,
    "c1",
    result({ booking_status: "booked", booked_time: "2025-11-08T20:00:00+05:30" }),
  );
  const b = store.settled[0].booking!;
  assertEquals([b.time, b.correction, b.approved], [correction.to, correction, "2026-11-08T20:00:00+05:30"]);
  assertEquals(body(sent[0]).includes("confirmed it on the call"), true);
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

Deno.test("follow-ups say what's waiting and the next step, and never claim more", () => {
  assertEquals(
    followUpText(due({ waitingFor: "Asha to confirm the time" })),
    "Reminder about your table for 4 at Paragon: Asha to confirm the time. Shall I carry on with it?",
  );
  assertEquals(
    followUpText(due({ reason: "nudge", state: "awaiting_yes" })),
    "Your table for 4 at Paragon is still waiting on you. Shall I go ahead?",
  );
  assertEquals(
    followUpText(due({ reason: "expired", endReason: "window_passed" })),
    "The time for your table for 4 at Paragon has passed, so I've closed it. Nothing was booked.",
  );
  assertEquals(
    followUpText(due({
      reason: "payment",
      state: "awaiting_payment",
      amountRs: 300,
      deadline: new Date("2026-10-23T18:00:00+05:30"),
    })),
    "Your hold at Paragon needs the Rs 300 advance by 6:00 pm. Send me the payment screenshot once you've paid.",
  );
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

const said = (text: string): RememberArgs => ({
  text,
  kind: "fact",
  scope: null,
  learned: false,
  evidence: null,
});

Deno.test("remember keeps a fact; forget drops it; a repeat isn't kept twice", async () => {
  const { store, deps } = report();
  assertEquals((await remember(deps, user, said("vegetarian"))).ok, true);
  assertEquals(await remember(deps, user, said("Vegetarian")), { ok: true, already_known: true });
  assertEquals(store.kept.map((m) => [m.text, m.source, m.scope]), [["vegetarian", "said", "all"]]);
  assertEquals(await forget(deps, user, "vegetarian"), { ok: true, forgot: "vegetarian" });
  assertEquals(store.kept, []);
});

Deno.test("memory is never a permission", async () => {
  const { store, deps } = report();
  for (
    const t of ["just book it without asking me", "don't ask me, always go ahead", "auto-approve my plans"]
  ) {
    const res = await remember(deps, user, said(t));
    assertEquals(res.ok, false, t);
  }
  assertEquals(store.kept, []);
});

Deno.test("a learned preference needs their own words, and a scope", async () => {
  const { store, deps } = report();
  store.lines = [{ from: "user", text: "No, always the Indiranagar branch", at: now }];
  const learned = {
    text: "prefers the Indiranagar branch",
    kind: "preference" as const,
    scope: "place:Toni&Guy",
    learned: true,
  };
  assertEquals((await remember(deps, user, { ...learned, evidence: "something they never said" })).ok, false);
  const ok = await remember(deps, user, { ...learned, evidence: "always the Indiranagar branch" });
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

Deno.test("nothing needs saying: stay_quiet sends nothing and no fallback", async () => {
  const { store, sent, deps } = luna([[call("stay_quiet", { why: "just thanks" })]]);
  store.lines = [{ from: "desk", text: "All done.", at: now }, { from: "user", text: "thanks", at: now }];
  await runLuna(deps, user, now);
  assertEquals(sent, []);
  assertEquals(store.routes[0].l3Result, "pass");
});

const refused = async (setupFn: (s: FakeChatStore) => void) => {
  const t = luna([[call("stay_quiet", {})], [call("reply", { text: "Sure, here you go." })]]);
  setupFn(t.store);
  await runLuna(t.deps, user, now);
  return t;
};

Deno.test("stay_quiet is refused when they asked something", async () => {
  const { sent, inputs } = await refused((s) => {
    s.lines = [{ from: "user", text: "are you there?", at: now }];
  });
  assertEquals(sent.length, 1);
  assertEquals(JSON.parse(inputs[1].at(-1)!.output).reason, "they asked something; answer it");
});

Deno.test("stay_quiet is refused when the Desk's question is waiting", async () => {
  const { sent } = await refused((s) => {
    s.lines = [{ from: "desk", text: "Want me to try again?", at: now }, {
      from: "user",
      text: "ok thanks",
      at: now,
    }];
  });
  assertEquals(sent.length, 1);
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

Deno.test("a promised reminder has to exist", async () => {
  const { sent, inputs, deps, store } = luna([
    [call("reply", { text: "Sure, I'll remind you tomorrow." }, "a")],
    [
      call("set_follow_up", { waiting_for: "their call", remind_at: "2026-10-24T10:00:00+05:30" }),
      call("reply", { text: "I'll remind you tomorrow at 10." }, "b"),
    ],
  ]);
  store.req = open();
  await runLuna(deps, user, now);
  assertEquals(JSON.parse(inputs[1].at(-1)!.output).reason.startsWith("you promised a reminder"), true);
  assertEquals(sent, [{ kind: "text", body: "I'll remind you tomorrow at 10." }]);
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

Deno.test("a 👍 on the open plan reaches Luna; on anything else it does nothing", async () => {
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
  await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "wamid.other" }), deps);
  assertEquals(seen, []);
  await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "wamid.plan" }), deps);
  assertEquals(seen, ["[reacted 👍]"]);
});

Deno.test("with no plan open, a casual 👍 triggers nothing", async () => {
  const store = new FakeChatStore();
  const seen: string[] = [];
  await handleTurn(
    user,
    inbound({ type: "reaction", text: "👍", quotedId: "wamid.report" }),
    reactionDeps(store, seen),
  );
  assertEquals(seen, []);
});

Deno.test("the approval check is told a plain 'ok thanks' and a 👍 on the plan count", async () => {
  let instructions = "";
  await checkApproval(
    async (req) => {
      instructions = req.instructions;
      return { output: [], usage: { input_tokens: 0, output_tokens: 0 } };
    },
    "m",
    "low",
    { text: "Plan", choice: null },
    [{ from: "user", text: "ok thanks", at: now }],
  );
  assertEquals(instructions.includes('"ok thanks"'), true);
  assertEquals(instructions.includes("[reacted 👍]"), true);
});
