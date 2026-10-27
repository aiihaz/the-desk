import { assertEquals } from "jsr:@std/assert@1.0.8";
import { handle } from "./handler.ts";
import { FakeCallStore } from "../_shared/test_call_store.ts";
import type { StartCall } from "../_shared/sarvam.ts";

function setup(start?: (c: StartCall) => Promise<string>) {
  const store = new FakeCallStore();
  const started: StartCall[] = [];
  const deps = {
    store,
    start: start ?? (async (c: StartCall) => {
      started.push(c);
      return "a-1";
    }),
  };
  return { store, started, deps };
}

const post = (body: unknown) => new Request("http://x/dial", { method: "POST", body: JSON.stringify(body) });

const ok = { request_id: "r-1", kind: "first" };

Deno.test("reserves, builds the variables from stored fields, dials, stores the attempt id", async () => {
  const { deps, store, started } = setup();
  const res = await handle(post({ ...ok, language: "Tamil" }), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { call_id: "c-1", attempt_id: "a-1", flags: [] });
  assertEquals(store.reserved, [{ requestId: "r-1", kind: "first", optionId: null, isRetry: false }]);
  assertEquals(started[0].businessPhone, "+919876543210");
  assertEquals(started[0].agentVersion, "3");
  assertEquals(started[0].language, "Tamil");
  assertEquals(started[0].variables, {
    window_start: null,
    window_end: null,
    exact_time: "2026-10-23T20:00:00+05:30",
    tolerance_min: null,
    party_size: 4,
    service: null,
    max_price: null,
    may_book: true,
    max_advance_rs: 0,
    customer_name: "Ihaz",
    customer_phone: "+919812345678",
    also_ask: null,
    business_name: "Paragon",
    must_reask: false,
  });
  assertEquals(store.calls.get("c-1"), {
    id: "c-1",
    status: "dialing",
    providerCallId: "a-1",
    outcome: null,
  });
});

Deno.test("variables in the body are refused: no caller tells the voice agent anything (P15)", async () => {
  const { deps, store, started } = setup();
  const res = await handle(
    post({ ...ok, variables: { party_size: 40, customer_phone: "+910000000000" } }),
    deps,
  );
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "variables_not_accepted" });
  assertEquals([store.reserved, started], [[], []]);
});

Deno.test("must_reask from reserve_call reaches the agent", async () => {
  const { deps, store, started } = setup();
  store.reservation = { ...store.reservation, must_reask: true } as typeof store.reservation;
  store.inputs = {
    ...store.inputs,
    option: { label: "9:30 pm", value: { time: "2026-10-23T21:30:00+05:30" } },
    prev: { at: "2026-10-23T18:00:00+05:30", contactName: "Ravi", summary: null },
  };
  await handle(post({ ...ok, kind: "booking", option_id: "o-1" }), deps);
  assertEquals(store.reserved[0].optionId, "o-1");
  assertEquals(started[0].variables.must_reask, true);
  assertEquals(started[0].variables.option_time, "2026-10-23T21:30:00+05:30");
  assertEquals(started[0].variables.prev_contact_name, "Ravi");
});

Deno.test("a required input missing: the call row fails, Sarvam is never called", async () => {
  const { deps, store, started } = setup();
  store.inputs = { ...store.inputs, fields: { party_size: 4, may_book: true } };
  const res = await handle(post(ok), deps);
  assertEquals(res.status, 502);
  assertEquals((await res.json()).detail, "Error: first call is missing time, customer_name");
  assertEquals(started, []);
  assertEquals(store.calls.get("c-1")!.status, "failed");
});

Deno.test("refused by check_dial → 409 with the reason, Sarvam never called", async () => {
  const { deps, store, started } = setup();
  store.reservation = { ok: false, reason: "kill_switch" };
  const res = await handle(post(ok), deps);
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { error: "refused", reason: "kill_switch" });
  assertEquals(started, []);
});

Deno.test("Sarvam error → call row marked failed, 502", async () => {
  const { deps, store } = setup(async () => {
    throw new Error("sarvam outbound failed 422");
  });
  const res = await handle(post(ok), deps);
  assertEquals(res.status, 502);
  assertEquals(store.calls.get("c-1")!.status, "failed");
});

Deno.test("bad input → 400 before any reservation", async () => {
  const { deps, store } = setup();
  assertEquals((await handle(post({ ...ok, kind: "chat" }), deps)).status, 400);
  assertEquals((await handle(post({ kind: "first" }), deps)).status, 400);
  assertEquals((await handle(post({ ...ok, language: "Klingon" }), deps)).status, 400);
  assertEquals(store.reserved, []);
});
