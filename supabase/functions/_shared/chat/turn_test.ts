import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { User } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import { inbound } from "./gate_test.ts";
import type { ActiveRequest } from "./store.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { handleTurn, istDayStart, presentReadback, type TurnDeps } from "./turn.ts";

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
    onConsent: async (_u, c) => void calls.push(`consent:${c.consent_id}`),
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

Deno.test("read-back: code fields are written first, then the prompt is sent and bound", async () => {
  const { store, sent, deps } = setup();
  store.req = { ...tonight };
  const res = await presentReadback(deps, user, "r1");
  assertEquals(res.ok, true);
  assertEquals(store.slotWrites, [{ may_book: true, max_advance_rs: 500 }]);
  assertEquals(sent.length, 1);
  const msg = sent[0];
  assertEquals(msg.kind === "buttons" && msg.buttons[0].id, `yes:${store.prompt!.id}`);
  assertEquals(store.prompt!.waMessageId, "wamid.out1");
});

Deno.test("read-back with nothing to change writes no slots (no needless version bump)", async () => {
  const { store, deps } = setup();
  store.req = { ...tonight, fields: { ...tonight.fields, may_book: true, max_advance_rs: 500 } };
  await presentReadback(deps, user, "r1");
  assertEquals(store.slotWrites, []);
});

Deno.test("typed YES after the read-back stores consent and hands off to the call", async () => {
  const { store, calls, deps } = setup();
  store.req = { ...tonight };
  await presentReadback(deps, user, "r1");
  store.req = { ...store.req!, state: "awaiting_yes" };
  await handleTurn(user, inbound({ text: "haan", messageId: "wamid.in9" }), deps);
  assertEquals(store.consents, [{
    promptId: store.prompt!.id,
    optionId: null,
    word: "yes",
    wa: "wamid.in9",
  }]);
  assertEquals(calls, ["consent:k1"]);
});

Deno.test("a consent the database refuses: say so and re-send the current prompt", async () => {
  const { store, sent, calls, deps } = setup();
  store.req = { ...tonight };
  await presentReadback(deps, user, "r1");
  store.consentResult = { ok: false, reason: "prompt_closed" };
  await handleTurn(user, inbound({ type: "interactive", replyId: `yes:${store.prompt!.id}` }), deps);
  assertEquals(calls, []);
  assertEquals(sent.slice(1).map((m) => m.kind === "text" ? m.body : m.kind), [
    "[stale_approval]",
    "buttons",
  ]);
  assertEquals(store.prompt!.waMessageId, "wamid.out3", "the re-sent message is the one YES now binds to");
});

Deno.test("an old button with no prompt open: say so, nothing else", async () => {
  const { store, sent, deps } = setup();
  store.req = { ...tonight, state: "collecting" };
  await handleTurn(user, inbound({ type: "interactive", replyId: "yes:old" }), deps);
  assertEquals(sent, [{ kind: "text", body: "[stale_approval_none]" }]);
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
