import { deepStrictEqual as equal } from "node:assert/strict";
import { FakeChatStore } from "./test_chat_store.ts";
import { setSlots } from "./tools.ts";
import type { GroundingInput } from "./intent_grounding.ts";
const now = new Date("2026-10-23T12:00:00+05:30");
const user = { id: "u1", waId: "919800000001", blocked: false };
Deno.test("semantic ambiguity leaves stored fields untouched and returns the useful clarification", async () => {
  const store = new FakeChatStore();
  store.req = {
    id: "r1",
    task: "booking",
    state: "collecting",
    version: 1,
    fields: { party_size: 2 },
    businessId: null,
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  store.lines = [{ from: "user", text: "make it 4", at: now }];
  let input: GroundingInput | undefined;
  const result = await setSlots(
    {
      store,
      send: async () => "out",
      now: () => now,
      checkIntent: async (value) => {
        input = value;
        return { ok: false, reason: "intent_unclear", clarification: "Four people or 4 pm?" };
      },
    },
    user,
    { exact_time: "2026-10-23T16:00:00+05:30" },
  );
  equal(result.ok, false);
  equal(store.slotWrites, []);
  equal(input?.messages[0].text, "make it 4");
  equal(input?.current.party_size, 2);
});
