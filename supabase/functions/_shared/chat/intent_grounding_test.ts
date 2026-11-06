import { deepStrictEqual as equal } from "node:assert/strict";
import { createIntentGrounding, type GroundingInput } from "./intent_grounding.ts";
import type { CreateResponse } from "../openai.ts";

const base: GroundingInput = {
  phase: "edit",
  task: "booking",
  current: { party_size: 2 },
  patch: { party_size: 4 },
  messages: [
    { from: "desk", text: "Two people at 8?", at: new Date("2026-11-04T10:00:00Z") },
    { from: "user", text: "actually four people", at: new Date("2026-11-04T10:00:01Z") },
  ],
  now: new Date("2026-11-04T10:00:02Z"),
  profile: { name: "Ihaz", phone: null },
};
const answer = (value: unknown): CreateResponse => async () => ({
  output: [{ type: "function_call", name: "intent_grounding", arguments: JSON.stringify(value) }],
  usage: { input_tokens: 0, output_tokens: 0 },
});
const yes = (message: number | null, source = "user", field = "party_size") => ({
  decision: "yes",
  clarification: "",
  issue: "",
  evidence: [{ field, message, source }],
});

Deno.test("grounding accepts a supported change with user evidence, not a Desk assertion", async () => {
  equal((await createIntentGrounding(answer(yes(2)), "test")(base)).ok, true);
  for (const message of [1, 0, 3, null, 1.5]) {
    const r = await createIntentGrounding(answer(yes(message)), "test")(base);
    equal(r.ok ? "ok" : r.reason, "grounding_unavailable");
    equal(!r.ok && r.detail?.startsWith("evidence for party_size"), true);
  }
});
Deno.test("every changed field requires evidence, including operational service context", async () => {
  const input = { ...base, patch: { party_size: 4, service_address: "12 Residency Road" } };
  equal((await createIntentGrounding(answer(yes(2)), "test")(input)).ok, false);
});
Deno.test("an added question cited as an item of the list is supported; one cited as another field is not", async () => {
  const input = {
    ...base,
    task: "question" as const,
    current: {},
    patch: { questions: ["Can you clean a wool blazer by Friday?"] },
    messages: [{
      from: "user" as const,
      text: "ask if they can clean a wool blazer by Friday",
      at: base.now,
    }],
  };
  equal((await createIntentGrounding(answer(yes(1, "user", "questions[0]")), "test")(input)).ok, true);
  equal((await createIntentGrounding(answer(yes(1, "user", "questions")), "test")(input)).ok, true);
  equal((await createIntentGrounding(answer(yes(1, "user", "questions_extra")), "test")(input)).ok, false);
});
Deno.test("profile can supply a name but never a time, spending allowance or different name", async () => {
  const nameInput = { ...base, patch: { customer_name: "Ihaz" } };
  equal(
    (await createIntentGrounding(answer(yes(null, "profile", "customer_name")), "test")(nameInput)).ok,
    true,
  );
  equal(
    (await createIntentGrounding(answer(yes(null, "profile", "customer_name")), "test")({
      ...nameInput,
      patch: { customer_name: "Asha" },
    })).ok,
    false,
  );
  equal((await createIntentGrounding(answer(yes(null, "profile")), "test")(base)).ok, false);
});
Deno.test("ambiguous intent returns a clarification and cannot become a successful edit", async () => {
  const result = await createIntentGrounding(
    answer({
      decision: "unclear",
      clarification: "Four people or 4 pm?",
      issue: "ambiguous correction",
      evidence: [],
    }),
    "test",
  )({ ...base, messages: [{ from: "user", text: "make it four", at: base.now }] });
  equal(result, { ok: false, reason: "intent_unclear", clarification: "Four people or 4 pm?" });
});
Deno.test("plan readiness can ask for missing pickup location without making every service require an address", async () => {
  const check = createIntentGrounding(
    answer({
      decision: "incomplete",
      clarification: "Where should they collect the blazers?",
      issue: "requested collection has no location",
      evidence: [],
    }),
    "test",
  );
  equal(await check({ ...base, phase: "plan", current: { service: "blazer collection" }, patch: {} }), {
    ok: false,
    reason: "brief_incomplete",
    clarification: "Where should they collect the blazers?",
  });
  equal(
    (await createIntentGrounding(
      answer({ decision: "yes", clarification: "", issue: "", evidence: [] }),
      "test",
    )({ ...base, phase: "plan", current: { service: "haircut" }, patch: {} })).ok,
    true,
  );
});
Deno.test("grounding sends actual chronological messages and existing context without planner reasoning", async () => {
  let request: Parameters<CreateResponse>[0] | undefined;
  const check = createIntentGrounding(async (r) => {
    request = r;
    return await answer(yes(2))(r);
  }, "test");
  await check(base);
  const data = JSON.parse(request!.input[0].content);
  equal(data.MESSAGES.map((m: { from: string }) => m.from), ["desk", "user"]);
  equal(data.CURRENT, { party_size: 2 });
  equal(data.PATCH, { party_size: 4 });
  equal(request!.tools.length, 1);
  equal(request!.deadlineAt! <= Date.now() + 40_000, true);
});
Deno.test("malformed or failed checker output fails closed; an unchanged edit needs no model", async () => {
  equal((await createIntentGrounding(answer({ decision: "yes", evidence: [] }), "test")(base)).ok, false);
  const down = createIntentGrounding(async () => {
    throw new Error("timeout");
  }, "test");
  equal(await down(base), {
    ok: false,
    reason: "grounding_unavailable",
    clarification: "",
    detail: "model call failed: timeout",
  });
  equal(await down({ ...base, patch: { party_size: 2 } }), { ok: true, evidence: [] });
});

Deno.test("retrieved preferences can ground a proposed detail but invented memory IDs cannot", async () => {
  const memory = {
    id: "stored-pref",
    kind: "preference" as const,
    scope: "booking",
    text: "Prefers a window seat",
    source: "said" as const,
  };
  const input = { ...base, patch: { service_details: "Window seat if available" }, memories: [memory] };
  const verdict = {
    decision: "yes",
    clarification: "",
    issue: "",
    evidence: [{ field: "service_details", source: "memory", memory_id: memory.id, message: null }],
  };
  equal((await createIntentGrounding(answer(verdict), "test")(input)).ok, true);
  equal((await createIntentGrounding(answer(verdict), "test")({ ...input, memories: [] })).ok, false);
  equal(
    (await createIntentGrounding(
      answer({ ...verdict, evidence: [{ ...verdict.evidence[0], memory_id: "invented" }] }),
      "test",
    )(input)).ok,
    false,
  );
});
Deno.test("a real memory cannot substitute for payment, privacy or tolerance authority", async () => {
  const memories = [{
    id: "known",
    kind: "preference" as const,
    scope: "all",
    text: "General preference",
    source: "said" as const,
  }];
  for (
    const [field, value] of [["max_price_rs", 500], ["share_phone", true], ["share_name", true], [
      "tolerance_min",
      30,
    ], ["may_book", true]] as const
  ) {
    const verdict = {
      decision: "yes",
      clarification: "",
      issue: "",
      evidence: [{ field, source: "memory", memory_id: "known", message: null }],
    };
    equal(
      (await createIntentGrounding(answer(verdict), "test")({ ...base, patch: { [field]: value }, memories }))
        .ok,
      false,
    );
  }
});

Deno.test("null over a field never set is no change: nothing to ground, no model asked", async () => {
  let asked = 0;
  const create: CreateResponse = async () => {
    asked++;
    return { output: [], usage: { input_tokens: 0, output_tokens: 0 } };
  };
  const input = { ...base, current: { party_size: 4 }, patch: { party_size: 4, service: null } };
  equal(await createIntentGrounding(create, "test")(input), { ok: true, evidence: [] });
  equal(asked, 0);
});

Deno.test("the checker reads the user's local day: NOW and message times are India time", async () => {
  let content = "";
  const create: CreateResponse = async (req) => {
    content = String((req.input[0] as { content: string }).content);
    return answer(yes(2))(req);
  };
  // 00:05 on Sat 7 Nov in India is still 6 Nov in UTC.
  const late = new Date("2026-11-06T18:35:00Z");
  await createIntentGrounding(create, "test")({ ...base, now: late });
  const data = JSON.parse(content);
  equal(data.NOW, "2026-11-07T00:05+05:30 (Sat 7 Nov 2026, 12:05 am, Asia/Kolkata)");
  equal(data.MESSAGES[1].at, "2026-11-04T15:30+05:30");
});

Deno.test("an unusable verdict is read once more; a usable one is final", async () => {
  const replies = [{ decision: "yes", evidence: [] }, yes(2)];
  let asked = 0;
  const create: CreateResponse = async (req) => {
    asked++;
    return answer(replies.shift())(req);
  };
  equal((await createIntentGrounding(create, "test")(base)).ok, true);
  equal(asked, 2);
  let unclear = 0;
  const refuses: CreateResponse = async (req) => {
    unclear++;
    return answer({ decision: "unclear", clarification: "Four or two?", issue: "", evidence: [] })(req);
  };
  equal((await createIntentGrounding(refuses, "test")(base)).ok, false);
  equal(unclear, 1);
});

Deno.test("a saved address can come from the profile; an address they never saved can't", async () => {
  const addresses = [{ label: "home", address: "Flat 302, Prestige Lakeside, HSR Layout" }];
  const fromProfile = (value: string) => ({
    ...base,
    patch: { service_address: value },
    profile: { ...base.profile, addresses },
  });
  const verdict = yes(null, "profile", "service_address");
  equal((await createIntentGrounding(answer(verdict), "test")(fromProfile(addresses[0].address))).ok, true);
  equal((await createIntentGrounding(answer(verdict), "test")(fromProfile("12 MG Road"))).ok, false);
});
