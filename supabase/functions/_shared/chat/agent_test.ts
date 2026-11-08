import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { DialArgs, DialResult } from "../dial.ts";
import type { User } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import { type AgentDeps, handleInbound } from "./agent.ts";
import { callAfterConsent } from "./calls.ts";
import { runCommand } from "./commands.ts";
import { inbound } from "./gate_test.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { fakeWriter } from "./test_writer.ts";
import { proposePlan } from "./turn.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const now = new Date("2026-10-23T12:00:00+05:30");

function setup() {
  const store = new FakeChatStore();
  const sent: Outbound[] = [];
  const calls: string[] = [];
  const slept: number[] = [];
  const deps: AgentDeps = {
    store,
    send: async (_u, m) => {
      sent.push(m);
      store.lastOut = `wamid.out${sent.length}`;
      return store.lastOut;
    },
    isAdmin: () => false,
    luna: async (_u, text) => void calls.push(`luna:${text}`),
    onCommand: (u, r) => runCommand(deps, u, r),
    onPayment: async () => {},
    now: () => now,
    sleep: async (ms) => void slept.push(ms),
  };
  store.limits.turn_debounce_ms = 1500;
  return { store, sent, calls, slept, deps };
}

Deno.test("a message waits out the debounce, claims the turn, and releases it", async () => {
  const { store, calls, slept, deps } = setup();
  store.claims = [{ status: "claimed", batch: ["table for 4 at Paragon"] }];
  await handleInbound(user, inbound({ text: "table for 4 at Paragon", messageId: "m1" }), deps);
  assertEquals(slept, [1500]);
  assertEquals(store.turnLog, ["claim:m1:claimed", "release:m1"]);
  assertEquals(calls, ["luna:table for 4 at Paragon"]);
});

Deno.test("a burst: earlier messages leave it to the newest, which answers once (P6)", async () => {
  const { store, calls, deps } = setup();
  store.claims = [
    { status: "newer" },
    { status: "newer" },
    {
      status: "claimed",
      batch: [
        "ask Test Laundry in Indiranagar",
        "if they can dry clean my blazer",
        "and have it ready by Friday",
      ],
    },
  ];
  await handleInbound(user, inbound({ text: "ask Test Laundry in Indiranagar", messageId: "m1" }), deps);
  await handleInbound(user, inbound({ text: "if they can dry clean my blazer", messageId: "m2" }), deps);
  await handleInbound(user, inbound({ text: "and have it ready by Friday", messageId: "m3" }), deps);
  assertEquals(calls, ["luna:and have it ready by Friday"]);
  assertEquals(store.turnLog, ["claim:m1:newer", "claim:m2:newer", "claim:m3:claimed", "release:m3"]);
});

Deno.test("busy: waits for the turn before it, then runs", async () => {
  const { store, calls, slept, deps } = setup();
  store.claims = [{ status: "busy" }, { status: "busy" }, { status: "claimed", batch: ["hi"] }];
  await handleInbound(user, inbound({ text: "hi", messageId: "m1" }), deps);
  assertEquals(slept, [1500, 400, 400]);
  assertEquals(calls, ["luna:hi"]);
});

Deno.test("an edit then YES in one burst: the YES is not consent (P6)", async () => {
  const { store, calls, deps } = setup();
  store.req = {
    id: "r1",
    task: "booking",
    state: "confirming",
    version: 1,
    fields: { party_size: 4, customer_name: "Ihaz", exact_time: "2026-10-23T18:00:00+05:30" },
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  await proposePlan(deps, user, "r1");
  store.req = { ...store.req!, state: "awaiting_yes" };
  store.claims = [{ status: "claimed", batch: ["make it 7 pm", "yes"] }];
  await handleInbound(user, inbound({ text: "yes", messageId: "m2" }), deps);
  assertEquals(store.consents, []);
  assertEquals(calls, ["luna:yes"]);
});

Deno.test("STOP acts at once, mid-turn, with no wait (P1)", async () => {
  const { store, sent, slept, deps } = setup();
  await handleInbound(user, inbound({ text: "stop", messageId: "m9" }), deps);
  assertEquals(slept, []);
  assertEquals(store.turnLog, ["handled:m9"]);
  assertEquals(store.stoppedAt !== null, true);
  assertEquals(sent, [{ kind: "text", body: "[stopped]" }]);
});

Deno.test("after STOP a YES does nothing; START turns the Desk back on (P1)", async () => {
  const { store, sent, calls, deps } = setup();
  store.req = {
    id: "r1",
    task: "question",
    state: "confirming",
    version: 1,
    fields: { questions: ["Do you dry clean blazers?"] },
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  await proposePlan(deps, user, "r1");
  await handleInbound(user, inbound({ text: "stop", messageId: "m1" }), deps);
  await handleInbound(user, inbound({ text: "yes", messageId: "m2" }), deps);
  assertEquals(store.consents, []);
  assertEquals(calls, []);
  await handleInbound(user, inbound({ text: "START", messageId: "m3" }), deps);
  assertEquals(store.stoppedAt, null);
  assertEquals(sent.slice(1).map((m) => m.kind === "text" && m.body), [
    "[stopped]",
    "[stopped_reminder]",
    "[started]",
  ]);
});

Deno.test("START when not stopped goes through the normal turn", async () => {
  const { store, calls, deps } = setup();
  store.claims = [{ status: "claimed", batch: ["start"] }];
  await handleInbound(user, inbound({ text: "start", messageId: "m1" }), deps);
  assertEquals(calls, ["luna:start"]);
});

Deno.test("delete my data: stops, records the request, says so", async () => {
  const { store, sent, deps } = setup();
  await handleInbound(user, inbound({ text: "Delete my data", messageId: "m1" }), deps);
  assertEquals([store.deletionRequested, store.stoppedAt !== null], [true, true]);
  assertEquals(sent, [{ kind: "text", body: "[delete_requested]" }]);
});

Deno.test("paused: a yes goes to Luna, which has no approve_plan while paused (P3)", async () => {
  const { store, calls, deps } = setup();
  store.req = {
    id: "r1",
    task: "booking",
    state: "confirming",
    version: 1,
    fields: {},
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: now,
  };
  store.claims = [{ status: "claimed", batch: ["yes"] }];
  await handleInbound(user, inbound({ text: "yes", messageId: "m1" }), deps);
  assertEquals(store.consents, []);
  assertEquals(calls, ["luna:yes"]);
});

function consentSetup(res: DialResult) {
  const { store, sent, deps } = setup();
  store.req = {
    id: "r1",
    task: "question",
    state: "calling_1",
    version: 2,
    fields: { questions: ["Do you dry clean blazers?"] },
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  const dialed: DialArgs[] = [];
  const dial = async (a: DialArgs) => {
    dialed.push(a);
    return res;
  };
  return { store, sent, dialed, deps: { ...deps, dial, create: fakeWriter } };
}

const consent = {
  ok: true as const,
  consent_id: "k1",
  kind: "ask" as const,
  request_id: "r1",
  option_id: null,
};

Deno.test("a consent starts the call its request allows; the kind comes from the request", async () => {
  const { store, sent, dialed, deps } = consentSetup({
    ok: true,
    call_id: "c1",
    attempt_id: "a1",
    flags: [],
  });
  assertEquals(await callAfterConsent(deps, user, consent), { started: true });
  assertEquals(dialed, [{ requestId: "r1", kind: "question", optionId: null, isRetry: false }]);
  assertEquals([store.notStarted, sent], [[], []]);
});

Deno.test("a refused call ends the request and owes the user why", async () => {
  const { store, sent, deps } = consentSetup({ ok: false, error: "refused", reason: "business_closed" });
  assertEquals(await callAfterConsent(deps, user, consent), { started: false });
  assertEquals(store.notStarted, ["r1"]);
  assertEquals(
    store.owedFacts[0].facts.happened.why,
    "the business is closed right now; they can try when it's open",
  );
  assertEquals(sent.length, 1);

  // Every path says who stopped it and that nothing reached the business.
  assertEquals(store.owedFacts[0].facts.happened.stopped_by, "the Desk's own checks, before dialling");
  assertEquals(store.owedFacts[0].facts.happened.reached_business, "no: no call was placed");

  // A check with no reason a user can act on: still the Desk's checks, and no made-up reason.
  const ours = consentSetup({ ok: false, error: "refused", reason: "agent_not_gated" });
  await callAfterConsent(ours.deps, user, consent);
  assertEquals(ours.store.owedFacts[0].facts.happened, {
    status: "the_call_did_not_start_nothing_done",
    stopped_by: "the Desk's own checks, before dialling",
    reached_business: "no: no call was placed",
    why: "a check on the Desk's side; the Desk doesn't have a reason it can give them",
  });
});

Deno.test("a call the phone provider rejects says so, and that nothing reached the business", async () => {
  const t = consentSetup({
    ok: false,
    error: "dial_failed",
    call_id: "c1",
    detail: "sarvam outbound response 422",
  });
  assertEquals(await callAfterConsent(t.deps, user, consent), { started: false });
  assertEquals(t.store.notStarted, ["r1"]);
  const happened = t.store.owedFacts[0].facts.happened;
  assertEquals(
    happened.stopped_by,
    "the phone provider, which rejected the Desk's request to place the call",
  );
  assertEquals(happened.reached_business, "no: no call was placed");
  // The provider's own error text stays in the call row, never in what the user is told.
  assertEquals(JSON.stringify(happened).includes("422"), false);
});

Deno.test("a submission that may have reached the provider is never told as not started", async () => {
  const t = consentSetup({ ok: false, error: "submission_unknown", call_id: "c1", detail: "x" });
  await callAfterConsent(t.deps, user, consent);
  // Unknown outcome: the request isn't ended, and nothing claims the call didn't happen.
  assertEquals(t.store.notStarted, []);
  assertEquals(t.store.owedFacts[0].facts.happened.reached_business, "unknown");
  assertEquals(t.store.owedFacts[0].facts.next_step, "check_with_business_themselves");
});

Deno.test("a refused dial for the caller contract raises an alert and tells the user it's on our side", async () => {
  const { store, sent, deps } = setup();
  store.req = {
    id: "r1",
    task: "booking",
    state: "calling_1",
    version: 1,
    fields: {},
    businessId: "b1",
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  const res = await callAfterConsent(
    {
      ...deps,
      create: fakeWriter,
      dial: async () => ({ ok: false, error: "refused", reason: "caller_contract_mismatch" }),
    },
    user,
    { ok: true, consent_id: "k1", kind: "ask", request_id: "r1", option_id: null },
  );
  assertEquals(res, { started: false });
  assertEquals(store.alerts.map((a) => a.kind), ["caller_contract_mismatch"]);
  assertEquals(sent.length, 1);
});

function withTyping(deps: AgentDeps, log: string[]) {
  deps.typing = (_u, m) => {
    log.push(`typing:${m.messageId}`);
    return { stop: async () => void log.push(`typing-stop:${m.messageId}`) };
  };
}

Deno.test("typing shows for the claimed turn and stops before the turn is released", async () => {
  const { store, deps } = setup();
  withTyping(deps, store.turnLog);
  deps.luna = async () => void store.turnLog.push("luna");
  store.claims = [{ status: "claimed", batch: ["hi"] }];
  await handleInbound(user, inbound({ text: "hi", messageId: "m1" }), deps);
  assertEquals(store.turnLog, ["claim:m1:claimed", "typing:m1", "luna", "typing-stop:m1", "release:m1"]);
});

Deno.test("a replaced turn stops typing before it gives the turn up", async () => {
  const { store, deps } = setup();
  const log: string[] = [];
  withTyping(deps, log);
  const bound = Object.assign(new FakeChatStore(), {
    renewTurn: async () => {},
    assertTurn: async () => {},
    completeTurn: async () => void log.push("complete"),
    abandonTurn: async () => void log.push("abandon"),
  });
  Object.assign(store, { forTurn: () => bound });
  store.claims = [{ status: "claimed", token: "generation", batch: ["hi"] }];
  deps.luna = async () => {
    throw new Error("turn superseded");
  };
  await handleInbound(user, inbound({ text: "hi", messageId: "m1" }), deps);
  assertEquals(log, ["typing:m1", "typing-stop:m1", "abandon"]);
  log.length = 0;
  store.claims = [{ status: "claimed", token: "generation", batch: ["hi"] }];
  deps.luna = async () => {};
  await handleInbound(user, inbound({ text: "hi", messageId: "m2" }), deps);
  assertEquals(log, ["typing:m2", "typing-stop:m2", "complete"]);
});

Deno.test("no typing for STOP, or for a message a newer one answers", async () => {
  const { store, deps } = setup();
  const log: string[] = [];
  withTyping(deps, log);
  await handleInbound(user, inbound({ text: "stop", messageId: "m1" }), deps);
  store.claims = [{ status: "newer" }];
  await handleInbound(user, inbound({ text: "dinner", messageId: "m2" }), deps);
  assertEquals(log, []);
});
