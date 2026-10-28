import { assertEquals } from "jsr:@std/assert@1.0.8";
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
  assertEquals(store.slotWrites, [{ may_book: true, max_advance_rs: 500 }]);
  assertEquals(res.ok, true);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].kind, "text");
  assertEquals(store.prompt!.waMessageId, "wamid.out1");
  assertEquals(store.prompt!.text, (sent[0] as { body: string }).body);
});

Deno.test("a plan with nothing to change writes no slots (no needless version bump)", async () => {
  const { store, deps } = setup();
  store.req = { ...tonight, fields: { ...tonight.fields, may_book: true, max_advance_rs: 500 } };
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
