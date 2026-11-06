// Their name and addresses are learned once (0026), and only what a reading of the chat
// finds they said. A one-off name or an address for one job stays on that errand.
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { User } from "../store.ts";
import type { CreateResponse } from "../openai.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { pauseActive, saveAddress, setName, type ToolDeps } from "./tools.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const now = new Date("2026-11-06T14:40:00+05:30");

// A reading that answers decision, pointing at the user's message number.
function deps(store: FakeChatStore, decision: "yes" | "no" | "unclear", message: number | null) {
  const asked: string[] = [];
  const create: CreateResponse = async (req) => {
    asked.push(String(req.input[0] && "content" in req.input[0] ? req.input[0].content : ""));
    return {
      output: [{
        type: "function_call",
        name: "verdict",
        arguments: JSON.stringify({ decision, message, why: "test" }),
      }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  const d: ToolDeps = { store, send: async () => "wamid.out", now: () => now, create };
  return { d, asked };
}

function chat(store: FakeChatStore, ...lines: [("user" | "desk"), string][]) {
  store.lines = lines.map(([from, text], i) => ({ from, text, at: new Date(now.getTime() - 60_000 + i) }));
}

Deno.test("their own name goes on the profile once, as they wrote it", async () => {
  const store = new FakeChatStore();
  store.profileName = null;
  chat(store, ["user", "i need a plumber"], ["desk", "What name should I give them?"], [
    "user",
    "book under my name ihaz",
  ]);
  const { d, asked } = deps(store, "yes", 3);
  const res = await setName(d, user, "Ihaz");
  assertEquals(res.ok, true);
  assertEquals(store.profileName, "Ihaz");
  assertEquals(asked[0].startsWith('NAME: "Ihaz"'), true);
});

Deno.test("a name for one booking, or one they never wrote, never touches the profile", async () => {
  const store = new FakeChatStore();
  chat(store, ["user", "book it under Priya this time"]);
  const notTheirs = await setName(deps(store, "no", null).d, user, "Priya");
  assertEquals(notTheirs.ok, false);
  assertEquals(store.profileName, "Ihaz");
  // The reading says yes but their message doesn't hold the name: the store refuses it.
  chat(store, ["user", "I'm Ihaz"]);
  const invented = await setName(deps(store, "yes", 1).d, user, "Zain");
  assertEquals(invented.ok, false);
  assertEquals(store.profileName, "Ihaz");
});

Deno.test("an address is kept under their label only after they agree to keep it", async () => {
  const store = new FakeChatStore();
  chat(
    store,
    ["user", "flat 302, Prestige Lakeside, HSR Layout"],
    ["desk", "Want me to keep that as your home address for next time?"],
    ["user", "yes save it as home"],
  );
  const declined = await saveAddress(
    deps(store, "no", null).d,
    user,
    { label: "home", address: "Flat 302, Prestige Lakeside, HSR Layout" },
    "wamid.3",
  );
  assertEquals(declined.ok, false);
  assertEquals(store.savedAddresses.length, 0);
  const { d, asked } = deps(store, "yes", 3);
  const kept = await saveAddress(d, user, {
    label: "home",
    address: "Flat 302, Prestige Lakeside, HSR Layout",
  }, "wamid.3");
  assertEquals(kept.ok, true);
  assertEquals(store.savedAddresses, [{ label: "home", address: "Flat 302, Prestige Lakeside, HSR Layout" }]);
  assertEquals(asked[0].startsWith("LABEL: home\nADDRESS: Flat 302"), true);
  // A second place is a second label, not a replacement.
  await saveAddress(d, user, { label: "work", address: "WeWork, Koramangala" }, "wamid.3");
  assertEquals(store.savedAddresses.map((a) => a.label), ["home", "work"]);
});

Deno.test("a missing address is refused, not read as a removal", async () => {
  const store = new FakeChatStore();
  store.savedAddresses = [{ label: "home", address: "HSR Layout" }];
  chat(store, ["user", "forget my home address"]);
  const { d, asked } = deps(store, "yes", 1);
  const res = await saveAddress(d, user, { label: "home", address: "" }, "wamid.1");
  assertEquals(res.ok, false);
  assertEquals(asked, []);
  assertEquals(store.savedAddresses.length, 1);
  assertEquals((await saveAddress(d, user, { label: "home", address: null }, "wamid.1")).ok, true);
  assertEquals(store.savedAddresses, []);
});

Deno.test("pausing a plan they've seen says the plan is on hold, not that nothing was proposed", async () => {
  const store = new FakeChatStore();
  store.req = {
    id: "r1",
    task: "booking",
    state: "awaiting_yes",
    version: 2,
    fields: {},
    businessId: null,
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  };
  const d: ToolDeps = { store, send: async () => "wamid.out", now: () => now };
  const res = await pauseActive(d, user);
  assertEquals(res.ok && String(res.paused).startsWith("the plan you sent them is on hold"), true);
});
