// Code settles, a model writes. What the guards around that writing hold to.
import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { CreateResponse } from "../openai.ts";
import type { Outbound } from "../whatsapp.ts";
import { drainDeliveries, tell } from "./followup.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { say } from "./test_writer.ts";
import { checkReply, type Facts, FAITHFUL, fill, type TellDeps, writeOwed } from "./tell.ts";

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
