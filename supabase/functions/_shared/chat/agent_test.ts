import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { DialArgs, DialResult } from "../dial.ts";
import type { User } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import { type AgentDeps, handleInbound } from "./agent.ts";
import { callAfterConsent } from "./calls.ts";
import { runCommand } from "./commands.ts";
import { inbound } from "./gate_test.ts";
import { FakeChatStore } from "./test_chat_store.ts";
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
  return { store, sent, dialed, deps: { ...deps, dial } };
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

Deno.test("a refused call ends the request and tells the user why, in plain words", async () => {
  const { store, sent, deps } = consentSetup({ ok: false, error: "refused", reason: "business_closed" });
  assertEquals(await callAfterConsent(deps, user, consent), { started: false });
  assertEquals(store.notStarted, ["r1"]);
  assertEquals(sent, [{ kind: "text", body: "[call_not_started]" }]);

  const ours = consentSetup({ ok: false, error: "refused", reason: "agent_not_gated" });
  ours.store.template = async () => "I couldn't start the call. {reason}";
  await callAfterConsent(ours.deps, user, consent);
  assertEquals(ours.sent, [{
    kind: "text",
    body: "I couldn't start the call. Calls aren't working on my side right now; please try again later.",
  }]);
});
