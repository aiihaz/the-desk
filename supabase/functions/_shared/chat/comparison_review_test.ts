import { deepStrictEqual as eq } from "node:assert/strict";
import { resolveNamedBusiness } from "./business_identity.ts";
import { comparisonQuestions } from "./comparison.ts";
import { callAfterConsent } from "./calls.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { fakeWriter } from "./test_writer.ts";
import { findBusiness } from "./find.ts";
import type { PlaceHit } from "../places.ts";

const user = { id: "u1", waId: "919800000001", blocked: false };
const consent = {
  ok: true as const,
  consent_id: "k",
  kind: "ask" as const,
  request_id: "r1",
  option_id: null,
};
const hit: PlaceHit = {
  placeId: "hsr",
  name: "Toni & Guy Essensuals",
  area: "HSR Layout",
  city: "Bengaluru",
  address: "HSR Layout",
  phone: "+919800000001",
  closed: false,
  openingHours: null,
};
function store() {
  const s = new FakeChatStore();
  s.req = {
    id: "r1",
    task: "question",
    state: "calling_1",
    version: 1,
    fields: { questions: ["price?"] },
    businessId: null,
    bookingId: null,
    createdAt: new Date(),
    pausedAt: null,
    comparison: true,
    recipientIds: ["b1", "b2", "b3"],
  };
  return s;
}
Deno.test("identity resolver weighs listing location, accepts returned listing ID only", async () => {
  let input = "";
  const resolved = await resolveNamedBusiness(
    async (r) => {
      input = JSON.stringify(r.input);
      return {
        output: [{
          type: "function_call",
          name: "decide_business",
          arguments: JSON.stringify({ place_id: "hsr", reason: "matching branch and city" }),
        }],
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
    "test",
    "TONI&GUY HSR",
    "HSR",
    "Bengaluru",
    [hit],
  );
  eq(resolved, hit);
  eq(input.includes("HSR Layout"), true);
  const bad = await resolveNamedBusiness(
    async () => ({
      output: [{ type: "function_call", name: "decide_business", arguments: '{"place_id":"invented"}' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    "test",
    "TONI&GUY",
    "HSR",
    "Bengaluru",
    [hit],
  );
  eq(bad, null);
});
Deno.test("unresolved named branch stops substitution rather than silently filling it with another business", async () => {
  const s = store();
  s.req!.state = "collecting";
  const result = await findBusiness(
    {
      store: s,
      send: async () => "x",
      searchPlaces: async () => [hit],
      resolveNamed: async () => null,
    },
    user,
    { query: "salon", area: "HSR", city: "Bengaluru", byKind: false, recipients: ["Unclear chain branch"] },
  );
  eq(result.ok, false);
  eq(s.recipientsSet, []);
});
Deno.test("question fields are plain language, never raw object JSON or identity", () => {
  const q = comparisonQuestions({
    service: "blow dry",
    exact_time: "18:00",
    party_size: 2,
    service_details: { secret: "hidden" },
    phone: "private",
  }).join(". ");
  eq(q.includes("Service: blow dry"), true);
  eq(q.includes("Requested time: 18:00"), true);
  eq(q.includes("{"), false);
  eq(q.includes("private"), false);
  eq(q.includes("hidden"), false);
});
Deno.test("mid-batch inbound durably closes as interrupted and does not dial later businesses", async () => {
  const s = store();
  const ids: string[] = [];
  const result = await callAfterConsent(
    {
      store: s,
      send: async () => "x",
      create: fakeWriter,
      dial: async (a) => {
        ids.push(a.businessId!);
        return ids.length === 1
          ? { ok: true, call_id: "c1", attempt_id: "a1", flags: [] }
          : { ok: false, error: "refused", reason: "new_inbound" };
      },
    },
    user,
    consent,
  );
  eq(result.started, true);
  eq(ids, ["b1", "b2"]);
  eq(s.dispatchFinishes, [{ requestId: "r1", interrupted: true }]);
});
Deno.test("actual turn invalidation during batch uses durable interruption cleanup", async () => {
  const s = store();
  let n = 0;
  await callAfterConsent(
    {
      store: s,
      send: async () => "x",
      create: fakeWriter,
      dial: async () => {
        if (n++) throw new Error("turn superseded");
        return { ok: true, call_id: "c", attempt_id: "a", flags: [] };
      },
    },
    user,
    consent,
  );
  eq(n, 2);
  eq(s.dispatchFinishes, [{ requestId: "r1", interrupted: true }]);
});
Deno.test("missing business row cannot shift another listing onto its ID", async () => {
  const s = store();
  s.recipientPlaces = async () => [{ businessId: "b3", name: "THIRD", address: null, city: null }];
  await callAfterConsent(
    {
      store: s,
      send: async () => "x",
      create: fakeWriter,
      dial: async (a) => ({ ok: true, call_id: a.businessId!, attempt_id: "a", flags: [] }),
    },
    user,
    consent,
  );
  const f = s.owedFacts.at(-1)!.facts.happened;
  eq(f.calling, [
    "a selected business whose listing is unavailable",
    "a selected business whose listing is unavailable",
    "THIRD",
  ]);
});

Deno.test("cancel and reschedule never enter comparison dial, even for a legacy comparison row", async () => {
  for (const task of ["cancel", "reschedule"] as const) {
    const s = store();
    s.req!.task = task;
    const args: unknown[] = [];
    await callAfterConsent(
      {
        store: s,
        send: async () => "x",
        create: fakeWriter,
        dial: async (a) => {
          args.push(a);
          return { ok: true, call_id: "c", attempt_id: "a", flags: [] };
        },
      },
      user,
      consent,
    );
    eq(args, [{ requestId: "r1", kind: task, optionId: null, isRetry: false }]);
    eq(s.dispatchFinishes, []);
  }
});
Deno.test("a named business resolved to a listing with no number is reported as that, not as unclear", async () => {
  const s = store();
  s.req!.state = "collecting";
  const noPhone: PlaceHit = { ...hit, placeId: "named-no-phone", name: "Named Salon", phone: null };
  const result = await findBusiness(
    {
      store: s,
      send: async () => "x",
      searchPlaces: async ({ text }) => text.startsWith("Named Salon") ? [noPhone] : [hit],
      // The resolver sees every listing, callable or not.
      resolveNamed: async (_named, _area, _city, hits) =>
        hits.find((h) => h.placeId === "named-no-phone") ?? null,
    },
    user,
    { query: "salon", area: "HSR", city: "Bengaluru", byKind: false, recipients: ["Named Salon"] },
  );
  eq(result.ok, true);
  // deno-lint-ignore no-explicit-any
  eq((result as any).unusable_named, ["Named Salon (no phone number on its listing)"]);
  eq(s.recipientsSet.length, 1);
});
