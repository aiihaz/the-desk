// Code settles, a model writes. What the guards around that writing hold to.
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { CreateResponse } from "../openai.ts";
import type { Outbound } from "../whatsapp.ts";
import { drainDeliveries, tell } from "./followup.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { say } from "./test_writer.ts";
import { checkReply, type Facts, FAITHFUL, fill, plain, type TellDeps, WRITE, writeOwed } from "./tell.ts";

const now = new Date("2026-10-23T12:00:00+05:30");
const user = { id: "u1", waId: "919812345678", blocked: false };
const facts: Facts = {
  event: "call_result",
  place: "Paragon",
  happened: { status: "business_wants_advance_nothing_agreed" },
  values: { advance: "Rs 500", pay_to: "paragon@okhdfc" },
  next_step: "decide_on_advance",
};

// drafts: what the writer says, in turn. checks: what the reader says, in turn.
function setup(drafts: string[], checks: unknown[] = [{ faithful: true, problems: [] }]) {
  const store = new FakeChatStore();
  const sent: Outbound[] = [];
  const asked: string[] = [];
  const create: CreateResponse = async (req) => {
    // As the real API does: a tool call in the input must have its output.
    for (const c of req.input.filter((i) => i.type === "function_call")) {
      if (!req.input.some((i) => i.type === "function_call_output" && i.call_id === c.call_id)) {
        throw new Error(`No tool output found for function call ${c.call_id}`);
      }
    }
    if (req.instructions === FAITHFUL) {
      asked.push(String(req.input[0].content));
      return say("verdict", checks.length > 1 ? checks.shift() : checks[0]);
    }
    return say("message", { text: drafts.length > 1 ? drafts.shift() : drafts[0] });
  };
  const deps: TellDeps = {
    store,
    create,
    send: async (_u, m) => (sent.push(m), "wamid.1"),
    now: () => now,
  };
  return { store, sent, asked, deps };
}
const GOOD = "They want {{advance}} to {{pay_to}}. Do you want it?";
const body = (m: Outbound) => (m as { body: string }).body;

Deno.test("values go in exactly as stored, whatever the language around them", async () => {
  const { sent, deps } = setup(["उन्हें {{advance}} चाहिए, {{pay_to}} पर। क्या करना है?"]);
  await tell(deps, user, null, "k1", facts);
  assertEquals(body(sent[0]), "उन्हें Rs 500 चाहिए, paragon@okhdfc पर। क्या करना है?");
});

Deno.test("fill: a missing value or a made-up one is refused", () => {
  assertEquals(fill("Pay {{advance}}", facts.values), { problem: "these values are missing: {{pay_to}}" });
  assertEquals(fill("{{advance}} {{pay_to}} {{upi}}", facts.values), {
    problem: "there is no value {{upi}}",
  });
  assertEquals(fill("{{ advance }} {{pay_to}}", facts.values), { text: "Rs 500 paragon@okhdfc" });
});

Deno.test("a draft that drops a value is sent back, and the rewrite goes out", async () => {
  const { sent, deps } = setup(["They want an advance.", GOOD]);
  await tell(deps, user, null, "k1", facts);
  assertEquals(body(sent[0]), "They want Rs 500 to paragon@okhdfc. Do you want it?");
});

Deno.test("the reader sees the finished message against the facts, and can send it back", async () => {
  const { sent, asked, deps } = setup(
    ["Booked! {{advance}} {{pay_to}}", GOOD],
    [{ faithful: false, problems: ["it says booked"] }, { faithful: true, problems: [] }],
  );
  await tell(deps, user, null, "k1", facts);
  assertEquals(asked[0].includes("Booked! Rs 500 paragon@okhdfc"), true);
  assertEquals(asked[0].includes("business_wants_advance_nothing_agreed"), true);
  assertEquals(sent.length, 1);
  assertEquals(body(sent[0]).startsWith("They want"), true);
});

Deno.test("nothing faithful in three drafts: nothing goes out, and it stays owed", async () => {
  const { store, sent, deps } = setup([GOOD], [{ faithful: false, problems: ["no"] }]);
  await tell(deps, user, null, "k1", facts);
  assertEquals(sent, []);
  assertEquals(store.unwritten, ["no"]);
  assertEquals(store.deliveries[0].message, undefined);
});

Deno.test("an unreadable verdict from the reader isn't a pass", async () => {
  const { sent, deps } = setup([GOOD], [{}]);
  await tell(deps, user, null, "k1", facts);
  assertEquals(sent, []);
});

Deno.test("a model that can't be reached: no message at all, no code-written stand-in", async () => {
  const { store, sent, deps } = setup([GOOD]);
  deps.create = () => Promise.reject(new Error("openai 503"));
  await tell(deps, user, null, "k1", facts);
  assertEquals(sent, []);
  assertEquals(store.unwritten, ["openai 503"]);
});

Deno.test("recovered after an outage: the message says it's late, in the model's own words", async () => {
  const { store, sent, deps } = setup([GOOD]);
  const inputs: string[] = [];
  const real = deps.create;
  deps.create = (req) => {
    inputs.push(String(req.input[0].content));
    return real(req);
  };
  store.createdAt = new Date(now.getTime() - 45 * 60_000);
  await tell(deps, user, null, "k1", facts);
  assertEquals(JSON.parse(inputs[0].slice(inputs[0].indexOf("FACTS:\n") + 7)).late_by_minutes, 45);
  assertEquals(sent.length, 1);
});

Deno.test("a message on time isn't called late", async () => {
  const { store, deps } = setup([GOOD]);
  const inputs: string[] = [];
  const real = deps.create;
  deps.create = (req) => {
    inputs.push(String(req.input[0].content));
    return real(req);
  };
  store.createdAt = new Date(now.getTime() - 60_000);
  await tell(deps, user, null, "k1", facts);
  assertEquals(inputs[0].includes("late_by_minutes"), false);
});

Deno.test("the writer gets the user's language and recent chat", async () => {
  const { store, deps } = setup([GOOD]);
  const inputs: string[] = [];
  const real = deps.create;
  deps.create = (req) => {
    inputs.push(String(req.input[0].content));
    return real(req);
  };
  store.lines = [{ from: "user", text: "kal 8 baje book kar do", at: now }];
  await tell(deps, user, null, "k1", facts);
  assertEquals(inputs[0].startsWith("LANGUAGE: en-IN"), true);
  assertEquals(inputs[0].includes("user: kal 8 baje book kar do"), true);
});

Deno.test("owed once: telling the same thing twice writes one message", async () => {
  const { store, deps } = setup([GOOD]);
  await tell(deps, user, null, "k1", facts);
  await tell(deps, user, null, "k1", facts);
  assertEquals(store.deliveries.length, 1);
});

Deno.test("writing and sending are separate: a written message waits for its send", async () => {
  const { store, sent, deps } = setup([GOOD]);
  await store.oweFacts("u1", null, "k1", "notice", facts);
  assertEquals((await writeOwed(deps)).written, 1);
  assertEquals(sent, []);
  await drainDeliveries(deps);
  assertEquals(sent.length, 1);
});

Deno.test("checkReply: what WhatsApp and the voice rules forbid, in any language", () => {
  assertEquals(checkReply("कल 8 बजे, 4 लोग।"), null);
  assertEquals(checkReply("1. 8:30 pm\n2. 9:15 pm"), null);
  assertEquals(checkReply("See https://paragon.in"), "no links");
  assertEquals(checkReply("**Booked**"), "no markdown, bullets or bold");
});

Deno.test("the check reads the call itself, not only what code made of it", async () => {
  const { sent, asked, deps } = setup(
    [GOOD, "They want {{advance}} to {{pay_to}}, adjusted in the bill. Do you want it?"],
    [{ faithful: false, problems: ["leaves out that it's adjusted in the bill"] }, {
      faithful: true,
      problems: [],
    }],
  );
  const withCall: Facts = {
    ...facts,
    call: {
      transcript: ["caller: Is there an advance?", "business: Rs 500, adjusted in the bill."],
      caller_noted: { advance_redeemable: "adjusted in the bill" },
    },
  };
  await tell(deps, user, null, "k1", withCall);
  assertEquals(asked[0].includes("business: Rs 500, adjusted in the bill."), true);
  assertEquals(body(sent[0]), "They want Rs 500 to paragon@okhdfc, adjusted in the bill. Do you want it?");
});

Deno.test("fill: a placeholder written wrongly never reaches them (R10)", () => {
  assertEquals(fill("{{advance}} {{pay_to}} {{pay to}}", facts.values), {
    problem: "a {{...}} is written wrongly: use {{key}} exactly",
  });
  assertEquals(fill("{{advance}} to {{pay_to}} }}", facts.values), {
    problem: "a {{...}} is written wrongly: use {{key}} exactly",
  });
});

Deno.test("fill: an address or number the writer typed itself never reaches them", () => {
  const typed =
    "a payment address, account or phone number is typed in: use its {{key}}, or say it isn't clear";
  assertEquals(fill("{{advance}} to paragon@okhdfc {{pay_to}}", facts.values), { problem: typed });
  assertEquals(fill("{{advance}} {{pay_to}}, or call +91 98000 00901", facts.values), { problem: typed });
  assertEquals(fill("{{advance}} {{pay_to}} to account 50100234567", facts.values), { problem: typed });
  // Dates, times, amounts and options aren't addresses.
  assertEquals(
    fill("{{advance}} {{pay_to}} by 23-10-2026, 7:30 pm. 1. 8:30 pm 2. 9:15 pm, Rs 1,50,000", facts.values),
    { text: "Rs 500 paragon@okhdfc by 23-10-2026, 7:30 pm. 1. 8:30 pm 2. 9:15 pm, Rs 1,50,000" },
  );
});

Deno.test("each check sees why earlier drafts were refused, so it can't flip on what it asked for", async () => {
  const { sent, asked, deps } = setup(
    ["{{advance}} {{pay_to}}, pay tonight.", "{{advance}} {{pay_to}}.", GOOD],
    [
      { faithful: false, problems: ["'pay tonight' isn't established"] },
      { faithful: false, problems: ["leaves out paying tonight"] },
      { faithful: true, problems: [] },
    ],
  );
  await tell(deps, user, null, "k1", facts);
  assertEquals(asked[0].includes("EARLIER CHECKS"), false);
  assertEquals(asked[1].includes("draft 1 refused: 'pay tonight' isn't established"), true);
  assertEquals(asked[2].includes("draft 2 refused: leaves out paying tonight"), true);
  assertEquals(sent.length, 1);
});

const withCall: Facts = {
  ...facts,
  call: { transcript: ["business: 500 advance, pay tonight"], caller_noted: { outcome: "advance_required" } },
};

Deno.test("plain: the record without the call, saying the rest couldn't be checked", () => {
  const p = plain(withCall);
  assertEquals(p.call, undefined);
  assertEquals(p.values, withCall.values);
  assertEquals(p.next_step, withCall.next_step);
  assertEquals(p.happened.status, "business_wants_advance_nothing_agreed");
  assertEquals(typeof p.happened.rest_of_the_call_could_not_be_checked, "string");

  // The business's number goes with it, so "ask the business" is something they can do.
  const numbered = plain({ ...withCall, call: { ...withCall.call!, number_called: "+919800000901" } });
  assertEquals(numbered.values, { ...withCall.values, phone: "+919800000901" });
  const already = plain({
    ...withCall,
    values: { ...withCall.values, phone: "+919800000901" },
    call: { ...withCall.call!, number_called: "+919800000901" },
  });
  assertEquals(already.values.phone, "+919800000901");
});

Deno.test("a call report whose drafts keep failing is written from the record alone, and goes", async () => {
  const { store, sent, deps } = setup([GOOD]);
  const seen: string[] = [];
  const create = deps.create;
  deps.create = async (req) => {
    if (req.instructions === WRITE) seen.push(String(req.input[0].content));
    return create(req);
  };
  await store.oweFacts("u1", "r1", "k1", "notice", withCall);
  // Two writes already failed: this is the third.
  store.deliveries[0].written = 2;
  await writeOwed(deps);
  await drainDeliveries(deps);
  assertEquals(seen[0].includes("rest_of_the_call_could_not_be_checked"), true);
  assertEquals(seen[0].includes("500 advance, pay tonight"), false);
  assertEquals(sent.length, 1);

  // Before that, the call goes with it.
  const early = setup([GOOD]);
  const seenEarly: string[] = [];
  const c2 = early.deps.create;
  early.deps.create = async (req) => {
    if (req.instructions === WRITE) seenEarly.push(String(req.input[0].content));
    return c2(req);
  };
  await early.store.oweFacts("u1", "r1", "k1", "notice", withCall);
  await writeOwed(early.deps);
  assertEquals(seenEarly[0].includes("500 advance, pay tonight"), true);
  assertEquals(seenEarly[0].includes("rest_of_the_call_could_not_be_checked"), false);
});

// Diagnostics (0027): each check attempt and which words went out are recorded per report,
// with the checker's words only as detail; a model that can't be reached is a kind, not text.
Deno.test("a report records each check and its source, without changing what goes out", async () => {
  const { store, sent, deps } = setup(
    ["Booked! {{advance}} {{pay_to}}", GOOD],
    [{ faithful: false, problems: ["it says booked"] }, { faithful: true, problems: [] }],
  );
  await tell(deps, user, null, "k1", facts);
  assertEquals(sent.length, 1);
  const events = store.checks.flatMap((c) => c.events);
  assertEquals(events.map((e) => [e.check, e.attempt, e.outcome, e.reason]), [
    ["report_check", 1, "reject", "unfaithful"],
    ["report_check", 2, "pass", undefined],
    ["report_source", undefined, "writer", "attempt_1"],
  ]);
  assertEquals(events[0].detail, ["it says booked"]);

  const down = setup([GOOD]);
  down.deps.create = () => Promise.reject(new Error("openai 503: the user's words"));
  await tell(down.deps, user, null, "k2", facts);
  const last = down.store.checks.flatMap((c) => c.events).at(-1);
  assertEquals([last?.check, last?.outcome, last?.reason], ["report_source", "error", "threw:http_5xx"]);
});
