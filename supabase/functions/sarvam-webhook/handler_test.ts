import { assertEquals } from "jsr:@std/assert@1.0.8";
import { handle } from "./handler.ts";
import { FakeCallStore } from "../_shared/test_call_store.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`../../../fixtures/sarvam/${name}.json`, import.meta.url));

function setup() {
  const store = new FakeCallStore();
  for (
    const [id, providerCallId] of [
      ["11111111-1111-4111-8111-111111111111", "44b4f89d-252b-4585-ad2e-0ed5842cc6c5"],
      ["22222222-2222-4222-8222-222222222222", "df5b6536-5130-4a43-bc5d-6771d1f93355"],
      ["33333333-3333-4333-8333-333333333333", "951e49d8-d9a5-45a9-aed4-c42366d29129"],
    ]
  ) store.calls.set(id, { id, status: "dialing", providerCallId, outcome: null });
  const handed: string[] = [];
  const pending: Promise<unknown>[] = [];
  const deps = {
    store,
    webhookToken: "t0ken",
    background: (p: Promise<unknown>) => void pending.push(p),
    handOff: async (callId: string) => void handed.push(callId),
  };
  return { store, handed, pending, deps };
}

const post = (body: string, token = "t0ken") =>
  new Request(`http://x/sarvam-webhook?token=${token}`, { method: "POST", body });

Deno.test("wrong or missing token → 401, nothing stored", async () => {
  const { deps, store } = setup();
  assertEquals((await handle(post(fixture("connected"), "nope"), deps)).status, 401);
  assertEquals(
    (await handle(new Request("http://x/", { method: "POST", body: fixture("connected") }), deps)).status,
    401,
  );
  assertEquals(store.events.size, 0);
});

Deno.test("connected result closes the call and hands off once", async () => {
  const { deps, store, handed, pending } = setup();
  assertEquals((await handle(post(fixture("connected")), deps)).status, 200);
  await Promise.all(pending);
  assertEquals(store.calls.get("11111111-1111-4111-8111-111111111111")!.status, "completed");
  assertEquals(handed, ["11111111-1111-4111-8111-111111111111"]);

  // Redelivery: acknowledged, no second hand-off.
  assertEquals((await handle(post(fixture("connected")), deps)).status, 200);
  assertEquals(handed.length, 1);
});

Deno.test("no answer is stored as no_answer", async () => {
  const { deps, store } = setup();
  await handle(post(fixture("no_answer")), deps);
  assertEquals(store.calls.get("22222222-2222-4222-8222-222222222222")!.status, "no_answer");
});

Deno.test("no call_id in metadata → matched by attempt id", async () => {
  const { deps, store, handed } = setup();
  await handle(post(fixture("failed")), deps);
  const c = store.calls.get("33333333-3333-4333-8333-333333333333")!;
  assertEquals([c.status, c.outcome], ["failed", "exotel: Phone number is registered under TRAI NDNC"]);
  assertEquals(handed, ["33333333-3333-4333-8333-333333333333"]);
});

Deno.test("call the Desk did not start → stored, 200, no hand-off", async () => {
  const { deps, store, handed } = setup();
  store.calls.clear();
  assertEquals((await handle(post(fixture("connected")), deps)).status, 200);
  assertEquals(store.events.size, 1);
  assertEquals(handed, []);
});

Deno.test("bad json and unknown payloads → 400", async () => {
  const { deps } = setup();
  assertEquals((await handle(post("{"), deps)).status, 400);
  assertEquals((await handle(post(`{"hello":1}`), deps)).status, 400);
  assertEquals((await handle(new Request("http://x/?token=t0ken"), deps)).status, 405);
});
