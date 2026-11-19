import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { User } from "../store.ts";
import type { CallResult } from "../sarvam.ts";
import type { Outbound } from "../whatsapp.ts";
import type { PlaceHit } from "../places.ts";
import { callAfterConsent, type CallDeps } from "./calls.ts";
import { findBusiness, type FindDeps } from "./find.ts";
import { reportCall, type ReportDeps } from "./report.ts";
import { proposePlan } from "./turn.ts";
import { comparisonReadback } from "./readback.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { fakeWriter } from "./test_writer.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const now = new Date("2026-11-19T12:00:00+05:30");

const hit = (placeId: string, name: string, rating: number | null): PlaceHit => ({
  placeId,
  name,
  address: `${name} street`,
  area: "HSR Layout",
  city: "Bengaluru",
  phone: "+919800000001",
  openingHours: null,
  closed: false,
  rating,
});

const comparisonReq = (store: FakeChatStore, recipientIds: string[] | null = null) => {
  store.req = {
    id: "r1",
    task: "question",
    state: "collecting",
    version: 1,
    fields: { questions: ["do you do blow dry"] },
    businessId: null,
    bookingId: null,
    createdAt: now,
    pausedAt: null,
    comparison: true,
    recipientIds,
  };
  return store.req;
};

// Selection: with the switch on, find_business itself picks the highest-rated five and
// the user is never asked to choose.
Deno.test("comparison find: the Desk picks the highest-rated five and stores them", async () => {
  const store = new FakeChatStore();
  comparisonReq(store);
  let ratingAsked = false;
  const deps: FindDeps = {
    store,
    send: async () => "wamid.x",
    searchPlaces: async ({ withRating }) => {
      ratingAsked = !!withRating;
      return [
        hit("p1", "Low Rated", 4.1),
        hit("p2", "Top Rated", 4.9),
        hit("p3", "Unrated", null),
        hit("p4", "Mid Rated", 4.6),
        hit("p5", "Second", 4.8),
      ];
    },
  };
  const r = await findBusiness(deps, user, { query: "salon", area: "HSR", city: "Bengaluru", byKind: false });
  assertEquals(ratingAsked, true);
  const savedOrder = store.saved.map((id) => `b:${id}`); // savePlace order == search order
  const pickedIds = store.recipientsSet[0].ids;
  assertEquals(pickedIds, [savedOrder[1], savedOrder[4], savedOrder[3], savedOrder[0], savedOrder[2]]);
  assertEquals((r.picked as { name: string }[]).map((p) => p.name), [
    "Top Rated",
    "Second",
    "Mid Rated",
    "Low Rated",
    "Unrated",
  ]);
  assertEquals(store.req!.recipientIds, pickedIds);
});

// Selection, named first: businesses the user named are resolved and called in their
// order; the highest-rated results only fill what the named list can't supply; a named
// business that can't be called is dropped and said so. Cap holds at five.
Deno.test("comparison find: named businesses first, rated fill, unusable named dropped", async () => {
  const store = new FakeChatStore();
  comparisonReq(store);
  const deps: FindDeps = {
    store,
    send: async () => "wamid.x",
    searchPlaces: async ({ text }) => {
      if (text.startsWith("Salon Zulu")) return [hit("z1", "Salon Zulu HSR", 4.2)];
      if (text.startsWith("Ghost Salon")) return [];
      if (text.startsWith("Salon Alpha")) return [hit("a1", "Salon Alpha", 4.3)];
      return [
        hit("p1", "Low Rated", 4.1),
        hit("p2", "Top Rated", 4.9),
        hit("p3", "Unrated", null),
        hit("p4", "Mid Rated", 4.6),
        hit("p5", "Second", 4.8),
      ];
    },
  };
  const r = await findBusiness(deps, user, {
    query: "salon",
    area: "HSR",
    city: "Bengaluru",
    byKind: false,
    recipients: ["Salon Zulu", "Ghost Salon", "Salon Alpha"],
  });
  assertEquals((r.picked as { name: string }[]).map((p) => p.name), [
    "Salon Zulu HSR",
    "Salon Alpha",
    "Top Rated",
    "Second",
    "Mid Rated",
  ]);
  assertEquals(store.recipientsSet[0].ids, ["b:z1", "b:a1", "b:p2", "b:p5", "b:p4"]);
  assertEquals(r.unusable_named, ["Ghost Salon"]);
  assertEquals(r.named_first, 2);
});

Deno.test("comparison find: four named plus rated stays under the cap", async () => {
  const store = new FakeChatStore();
  comparisonReq(store);
  const deps: FindDeps = {
    store,
    send: async () => "wamid.x",
    searchPlaces: async ({ text }) => {
      for (const n of ["One", "Two", "Three", "Four"]) {
        if (text.startsWith(`Salon ${n}`)) return [hit(`n-${n}`, `Salon ${n}`, 4.0)];
      }
      return [hit("p1", "Rated A", 4.9), hit("p2", "Rated B", 4.8)];
    },
  };
  const r = await findBusiness(deps, user, {
    query: "salon",
    area: "HSR",
    city: "Bengaluru",
    byKind: false,
    recipients: ["Salon One", "Salon Two", "Salon Three", "Salon Four"],
  });
  assertEquals((r.picked as { name: string }[]).map((p) => p.name), [
    "Salon One",
    "Salon Two",
    "Salon Three",
    "Salon Four",
    "Rated A",
  ]);
  assertEquals(store.recipientsSet[0].ids.length, 5);
});

// Selection off: no pick, no recipients, no rating asked for.
Deno.test("comparison off: find_business is unchanged", async () => {
  const store = new FakeChatStore();
  store.req = null;
  let ratingAsked = false;
  const deps: FindDeps = {
    store,
    send: async () => "wamid.x",
    searchPlaces: async ({ withRating }) => {
      ratingAsked = !!withRating;
      return [hit("p1", "A Salon", 4.9)];
    },
  };
  const r = await findBusiness(deps, user, { query: "salon", area: null, city: "Bengaluru", byKind: false });
  assertEquals(ratingAsked, false);
  assertEquals(store.recipientsSet.length, 0);
  assertEquals((r.matches as unknown[]).length, 1);
  assertEquals("picked" in r, false);
});

// The batch dial: one go-ahead starts a question call per picked business; a refusal
// skips that business and the message says who is and isn't being called.
Deno.test("comparison dial: one call per business, refusals named, nothing booked", async () => {
  const store = new FakeChatStore();
  comparisonReq(store, ["b1", "b2", "b3"]);
  const dialled: { kind: string; businessId?: string }[] = [];
  const deps: CallDeps = {
    store,
    send: async () => "wamid.x",
    create: fakeWriter,
    dial: async (a) => {
      dialled.push(a);
      if (a.businessId === "b2") return { ok: false, error: "refused", reason: "business_closed" };
      return { ok: true, call_id: `c-${a.businessId}`, attempt_id: `a-${a.businessId}`, flags: [] };
    },
  };
  const consent = {
    ok: true as const,
    consent_id: "k1",
    kind: "ask" as const,
    request_id: "r1",
    option_id: null,
  };
  const r = await callAfterConsent(deps, user, consent);
  assertEquals(r.started, true);
  assertEquals(dialled, [
    { requestId: "r1", kind: "question", optionId: null, isRetry: false, businessId: "b1" },
    { requestId: "r1", kind: "question", optionId: null, isRetry: false, businessId: "b2" },
    { requestId: "r1", kind: "question", optionId: null, isRetry: false, businessId: "b3" },
  ]);
  const facts = store.owedFacts.at(-1)!.facts as unknown as {
    event: string;
    happened: { calling: string[]; not_called: { place: string; why: string }[] };
  };
  assertEquals(facts.event, "comparison_calls");
  assertEquals(facts.happened.calling, ["Salon One in HSR Layout", "Salon Three in HSR Layout"]);
  assertEquals(facts.happened.not_called, [{
    place: "Salon Two in HSR Layout",
    why: "the business is closed right now; they can try when it's open",
  }]);
});

// No call could start: the request ends and the user is told.
Deno.test("comparison dial: all refused ends the errand", async () => {
  const store = new FakeChatStore();
  comparisonReq(store, ["b1"]);
  let ended = "";
  store.callNotStarted = async (requestId: string) => {
    ended = requestId;
    return { ok: true as const };
  };
  const deps: CallDeps = {
    store,
    send: async () => "wamid.x",
    create: fakeWriter,
    dial: async () => ({ ok: false as const, error: "refused" as const, reason: "opted_out" }),
  };
  const consent = {
    ok: true as const,
    consent_id: "k1",
    kind: "ask" as const,
    request_id: "r1",
    option_id: null,
  };
  const r = await callAfterConsent(deps, user, consent);
  assertEquals(r.started, false);
  assertEquals(ended, "r1");
  assertEquals(
    (store.owedFacts.at(-1)!.facts as unknown as { happened: { reached_business: string } }).happened
      .reached_business,
    "no: no call was placed",
  );
});

// Reporting: no per-call message; when the last call settles the summary ranks answered
// first, in plan order.
Deno.test("comparison report: one ranked summary when the batch completes", async () => {
  const store = new FakeChatStore();
  comparisonReq(store, ["b1", "b2", "b3"]);
  store.req!.state = "calling_1";
  store.call = {
    callId: "c2",
    requestId: "r1",
    userId: "u1",
    waId: "919812345678",
    kind: "question",
    task: "question",
    businessId: "b2",
    phone: "+919800000901",
    option: null,
    isRetry: false,
    bookingTime: null,
  };
  store.batchCalls = [
    {
      id: "c1",
      businessId: "b1",
      placeName: "Salon One",
      placeArea: "HSR",
      status: "completed",
      outcome: "completed",
      outputs: { outcome: "answered", summary: "does blow dry, Rs 800" },
    },
    {
      id: "c2",
      businessId: "b2",
      placeName: "Salon Two",
      placeArea: "HSR",
      status: "completed",
      outcome: "completed",
      outputs: { outcome: "answered", summary: "no blow dry" },
    },
    {
      id: "c3",
      businessId: "b3",
      placeName: "Salon Three",
      placeArea: "HSR",
      status: "no_answer",
      outcome: "no_answer",
      outputs: null,
    },
  ];
  const sent: Outbound[] = [];
  const deps: ReportDeps = {
    store,
    create: fakeWriter,
    send: async (_u, m) => {
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
  };
  const result: CallResult = {
    attemptId: "a2",
    callId: "c2",
    status: "completed",
    durationS: 55,
    interactionId: null,
    failureReason: null,
    outputs: { outcome: "answered", summary: "no blow dry" },
    transcript: null,
    agentNumber: null,
  };
  await reportCall(deps, "c2", result);
  assertEquals(store.comparisonSettlements.length, 1);
  const facts = store.comparisonSettlements[0].facts as {
    event: string;
    happened: { results: { place: string; outcome: string }[] };
  };
  assertEquals(facts.event, "comparison_summary");
  assertEquals(facts.happened.results, [
    { place: "Salon One, HSR", outcome: "answered", detail: "does blow dry, Rs 800" },
    { place: "Salon Two, HSR", outcome: "answered", detail: "no blow dry" },
    { place: "Salon Three, HSR", outcome: "unreachable", detail: "no answer" },
  ]);
});

// The plan: no businesses picked yet means find_business first; with recipients the
// readback names every place and books nothing.
Deno.test("comparison plan: needs picked businesses, then names them all", async () => {
  const store = new FakeChatStore();
  comparisonReq(store);
  store.req!.state = "confirming";
  const deps = { store, send: async () => "wamid.x", now: () => now };
  const notReady = await proposePlan(deps as never, user, "r1");
  assertEquals(notReady.ok, false);

  store.req!.recipientIds = ["b1", "b2"];
  const p = comparisonReadback({
    places: store.recipientList,
    f: store.req!.fields,
    customerPhone: "+919812345678",
  });
  assertEquals(p.text.includes("Salon One in HSR Layout"), true);
  assertEquals(p.text.includes("Salon Two in HSR Layout"), true);
  assertEquals(p.text.includes("won't book anything"), true);
  assertEquals(p.text.includes("do you do blow dry"), true);
});
