import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { approvePlan } from "./approval.ts";
import type { User } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import { inbound } from "./gate_test.ts";
import type { ActiveRequest } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { handleTurn, istDayStart, proposePlan, type TurnDeps } from "./turn.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const now = new Date("2026-10-23T12:00:00+05:30");

function setup() {
  const store = new FakeChatStore();
  const sent: Outbound[] = [];
  const calls: string[] = [];
  const deps: TurnDeps = {
    store,
    send: async (_u, m) => {
      sent.push(m);
      store.lastOut = `wamid.out${sent.length}`;
      return store.lastOut;
    },
    isAdmin: () => false,
    luna: async (_u, text) => void calls.push(`luna:${text}`),
    onCommand: async (_u, r) => void calls.push(`command:${r.command}`),
    onPayment: async (_u, r) => void calls.push(`payment:${r.kind}`),
    now: () => now,
  };
  return { store, sent, calls, deps };
}

const tonight: ActiveRequest = {
  id: "r1",
  task: "booking",
  state: "confirming",
  version: 3,
  fields: {
    party_size: 4,
    customer_name: "Ihaz",
    window_start: "2026-10-23T19:30:00+05:30",
    window_end: "2026-10-23T21:00:00+05:30",
  },
  businessId: "b1",
  bookingId: null,
  createdAt: now,
  pausedAt: null,
};

Deno.test("IST day start", () => {
  assertEquals(istDayStart(new Date("2026-10-23T20:00:00Z")).toISOString(), "2026-10-23T18:30:00.000Z");
  assertEquals(istDayStart(new Date("2026-10-23T18:00:00Z")).toISOString(), "2026-10-22T18:30:00.000Z");
});

Deno.test("a plan: code fields are written first, then the plan is sent as text and bound", async () => {
  const { store, sent, deps } = setup();
  store.req = { ...tonight };
  const res = await proposePlan(deps, user, "r1");
  assertEquals(store.slotWrites, [{ may_book: true }]);
  assertEquals(res.ok, true);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].kind, "text");
  assertEquals(store.prompt!.waMessageId, "wamid.out1");
  assertEquals(store.prompt!.text, (sent[0] as { body: string }).body);
});

Deno.test("a plan with nothing to change writes no slots (no needless version bump)", async () => {
  const { store, deps } = setup();
  store.req = { ...tonight, fields: { ...tonight.fields, may_book: true } };
  await proposePlan(deps, user, "r1");
  assertEquals(store.slotWrites, []);
});

Deno.test("no plan while something is missing, or while paused", async () => {
  const { store, sent, deps } = setup();
  store.req = { ...tonight, businessId: null, state: "choosing_place" };
  assertEquals(await proposePlan(deps, user, "r1"), {
    ok: false,
    reason: "not ready",
    missing: ["which business"],
  });
  store.req = { ...tonight, pausedAt: now };
  assertEquals(await proposePlan(deps, user, "r1"), { ok: false, reason: "paused" });
  assertEquals(sent, []);
});

Deno.test("no plan for a number already recorded as reaching someone else (R3)", async () => {
  const { store, sent, deps } = setup();
  store.req = { ...tonight };
  store.wrongNumbers.add("b1");
  const res = await proposePlan(deps, user, "r1");
  assertEquals(res.ok, false);
  assertEquals(
    (res as { reason: string }).reason.startsWith("this place's number reached someone else"),
    true,
  );
  assertEquals(sent, []);
});

Deno.test("the profile name is what the plan books under when they gave no other", async () => {
  const { store, deps } = setup();
  const { customer_name: _, ...f } = tonight.fields;
  store.req = { ...tonight, fields: f };
  await proposePlan(deps, user, "r1");
  assertEquals(store.slotWrites[0].customer_name, "Ihaz");
});

Deno.test("a typed yes or an old button goes to Luna, never straight to consent", async () => {
  const { store, calls, deps } = setup();
  store.req = { ...tonight, state: "awaiting_yes" };
  await handleTurn(user, inbound({ text: "yes" }), deps);
  await handleTurn(user, inbound({ type: "interactive", replyId: "yes:p1", text: "YES" }), deps);
  assertEquals(calls, ["luna:yes", "luna:[tapped: YES]"]);
  assertEquals(store.consents, []);
});

Deno.test("free text goes to Luna; STOP goes to commands", async () => {
  const { calls, deps } = setup();
  await handleTurn(user, inbound({ text: "table for 4 at Paragon tonight" }), deps);
  await handleTurn(user, inbound({ text: "STOP" }), deps);
  assertEquals(calls, ["luna:table for 4 at Paragon tonight", "command:stop"]);
});

Deno.test("daily cap: one message, then silence; STOP still works", async () => {
  const { store, sent, calls, deps } = setup();
  store.inbound = 61;
  await handleTurn(user, inbound({ text: "hi" }), deps);
  store.inbound = 62;
  await handleTurn(user, inbound({ text: "hello?" }), deps);
  await handleTurn(user, inbound({ text: "stop" }), deps);
  assertEquals(sent, [{ kind: "text", body: "[daily_cap]" }]);
  assertEquals(calls, ["command:stop"]);
});

Deno.test("reactions to conversational questions reach Luna even without an approval plan", async () => {
  const { store, calls, deps } = setup();
  store.lastOut = "clarification";
  await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "clarification" }), deps);
  assertEquals(calls, ["luna:[reacted 👍]"]);
  assertEquals(store.consents, []);
});

Deno.test("delayed reactions retain context instead of being limited to the latest outgoing message", async () => {
  const { store, calls, deps } = setup();
  store.lastOut = "newer-context";
  await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "earlier-question" }), deps);
  assertEquals(calls, ["luna:[reacted 👍]"]);
  assertEquals(store.consents, []);
});

Deno.test("a routed reaction to another message cannot approve the current plan", async () => {
  for (const quoted of ["An earlier plan for two people", "The Indiranagar branch?", undefined]) {
    const { store, deps } = setup();
    store.req = { ...tonight };
    await proposePlan(deps, user, "r1");
    const plan = store.prompt!;
    store.lines = [
      { id: plan.waMessageId!, from: "desk", text: plan.text, at: now },
      {
        from: "user",
        text: "[reacted 👍]",
        at: new Date(now.getTime() + 1000),
        ...(quoted ? { quoted } : {}),
      },
    ];
    let readings = 0;
    let started = 0;
    deps.luna = async () => {
      const result = await approvePlan(
        {
          store,
          create: async () => {
            readings++;
            throw new Error("non-plan reaction must not reach approval reading");
          },
          onApproved: async () => {
            started++;
            return { started: true };
          },
        },
        user,
        null,
        "reaction-in",
      );
      assertEquals(result.ok, false);
    };
    await handleTurn(user, inbound({ type: "reaction", text: "👍", quotedId: "other-message" }), deps);
    assertEquals([readings, started, store.consents.length], [0, 0, 0]);
  }
});

Deno.test("removed reactions remain silent without calling Luna", async () => {
  const { calls, deps } = setup();
  await handleTurn(user, inbound({ type: "reaction", text: null, quotedId: "clarification" }), deps);
  assertEquals(calls, []);
});

Deno.test("an exact time never receives an invented default booking tolerance", async () => {
  const { store, deps } = setup();
  store.req = {
    ...tonight,
    fields: { party_size: 2, customer_name: "Ihaz", exact_time: "2026-10-23T20:00:00+05:30" },
  };
  store.limits.match_tolerance_minutes = 15;
  await proposePlan(deps, user, "r1");
  assertEquals(store.req!.fields.tolerance_min, 0);
  assertEquals(store.prompt!.text.includes("either way"), false);
});

Deno.test("an incomplete grounded brief never opens or sends an approval plan", async () => {
  const { store, deps, sent } = setup();
  store.req = { ...tonight };
  const res = await proposePlan(
    {
      ...deps,
      checkIntent: async () => ({
        ok: false,
        reason: "brief_incomplete",
        clarification: "Where should they collect it?",
      }),
    },
    user,
    "r1",
  );
  assertEquals(res.ok, false);
  assertEquals(sent.length, 0);
  assertEquals(store.prompt, null);
  assertEquals(store.slotWrites, []);
});

Deno.test("checked wording is what they approve; a writer that fails or isn't faithful leaves the readback", async () => {
  const readback = setup();
  readback.store.req = { ...tonight };
  await proposePlan(readback.deps, user, "r1");
  const reference = readback.store.prompt!.text;

  const written = setup();
  written.store.req = { ...tonight };
  await proposePlan(
    { ...written.deps, renderPlan: async () => "Paragon, 4 people tonight? Shall I?" },
    user,
    "r1",
  );
  assertEquals(written.store.prompt!.text, "Paragon, 4 people tonight? Shall I?");

  for (
    const renderPlan of [async () => null, async () => {
      throw new Error("The operation was aborted due to timeout");
    }]
  ) {
    const t = setup();
    t.store.req = { ...tonight };
    const res = await proposePlan({ ...t.deps, renderPlan }, user, "r1");
    assertEquals(res.ok, true);
    assertEquals(t.store.prompt!.text, reference);
    assertEquals((t.sent[0] as { body: string }).body, reference);
  }
});

Deno.test("a turn lost while the plan is written sends nothing", async () => {
  const t = setup();
  t.store.req = { ...tonight };
  let thrown: unknown;
  try {
    await proposePlan(
      {
        ...t.deps,
        renderPlan: async () => {
          throw new Error("turn superseded");
        },
      },
      user,
      "r1",
    );
  } catch (e) {
    thrown = e;
  }
  assertEquals(String(thrown), "Error: turn superseded");
  assertEquals(t.sent.length, 0);
});
