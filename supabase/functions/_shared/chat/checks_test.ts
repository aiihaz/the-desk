// Diagnostics (0027) record what checks decided, without conversation text in the
// production tier, and never change what the user gets or block a reply.
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { Item, ResponseOut } from "../openai.ts";
import type { User } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import { CheckLog, code, errorKind, replyRule } from "./checks.ts";
import { type LunaDeps, runLuna } from "./luna.ts";
import { createPlanChecker } from "./plan_writer.ts";
import { FakeChatStore } from "./test_chat_store.ts";

const user: User = { id: "u1", waId: "919812345678", blocked: false };
const now = new Date("2026-11-07T12:00:00+05:30");

Deno.test("reasons are codes: text can't ride in on one, and errors keep only their kind", () => {
  assertEquals(code("They said Indiranagar, 8 pm!"), "they_said_indiranagar_8_pm");
  assertEquals(code(""), "unknown");
  assertEquals(
    errorKind(new Error("openai response incomplete: max_output_tokens")),
    "incomplete:max_output_tokens",
  );
  assertEquals(errorKind(new Error('openai 400: {"message":"your text here"}')), "http_4xx");
  assertEquals(
    errorKind(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
    "timeout",
  );
  assertEquals(errorKind(new Error("something with the user's words")), "other");
  assertEquals(replyRule("too long for one message"), "too_long");
  assertEquals(replyRule("no markdown, bullets or bold"), "markdown");
});

Deno.test("a full buffer is counted, not silently cut; the summary comes last", () => {
  const log = new CheckLog();
  for (let i = 0; i < 53; i++) log.record({ check: "reply_code", outcome: "reject", reason: "link" });
  log.summary = { check: "luna_turn", outcome: "pass", reason: "first try" };
  const out = log.drain();
  assertEquals(out.length, 52);
  assertEquals(out.at(-2), { check: "luna_turn", outcome: "pass", reason: "first_try" });
  assertEquals(out.at(-1), { check: "diag_dropped", outcome: "error", reason: "dropped:3" });
});

Deno.test("checker words are capped before they leave, and a failed write never throws", async () => {
  const log = new CheckLog();
  log.record({ check: "plan_check", outcome: "reject", detail: Array(12).fill("x".repeat(400)) });
  const store = new FakeChatStore();
  store.checksFail = true;
  await log.flush(store, "u1", "wamid.in"); // must not throw
  const again = new CheckLog();
  again.record({ check: "plan_check", outcome: "reject", detail: Array(12).fill("x".repeat(400)) });
  store.checksFail = false;
  await again.flush(store, "u1", "wamid.in");
  const [e] = store.checks[0].events;
  assertEquals(e.detail?.length, 10);
  assertEquals(e.detail?.[0].length, 300);
  assertEquals(store.checks[0].version, "unknown");
  assertEquals(store.checks[0].waMessageId, "wamid.in");
});

const call = (name: string, args: unknown, id = name): Item => ({
  type: "function_call",
  name,
  arguments: JSON.stringify(args),
  call_id: `call_${id}`,
});
const out = (items: Item[]): ResponseOut => ({ output: items, usage: { input_tokens: 0, output_tokens: 0 } });

Deno.test("the plan check records its verdict; what it decides is unchanged", async () => {
  const check = createPlanChecker(
    async () => out([call("plan_verdict", { faithful: false, problems: ["drops the table size"] })]),
    "m",
  );
  const log = new CheckLog();
  const input = {
    task: "booking",
    fields: {},
    reference: "r",
    chat: [],
    language: "en-IN",
    now: "",
    timezone: "",
  };
  const v = await check(
    input,
    "I'll call Paragon at 8 pm tonight. Go ahead?",
    log,
    "00000000-0000-4000-8000-000000000001",
    1,
  );
  assertEquals(v, { ok: false, problems: ["drops the table size"] });
  assertEquals(log.drain().map((e) => [e.check, e.attempt, e.outcome, e.reason, e.detail]), [
    ["plan_check", 1, "reject", "unfaithful", ["drops the table size"]],
  ]);
  // Without a log it decides the same.
  assertEquals(await check(input, "I'll call Paragon at 8 pm tonight. Go ahead?"), v);
});

function luna(steps: Item[][]) {
  const store = new FakeChatStore();
  const sent: Outbound[] = [];
  const deps: LunaDeps = {
    store,
    send: async (_u, m) => {
      sent.push(m);
      return `wamid.out${sent.length}`;
    },
    now: () => now,
    create: async (): Promise<ResponseOut> => out(steps.shift() ?? []),
    searchPlaces: async () => [],
    onApproved: async () => ({ started: true }),
  };
  return { store, sent, deps };
}

Deno.test("a turn records its rejections and one summary, linked to the message it answered", async () => {
  const t = luna([
    [call("reply", { text: "see https://example.com" })],
    [call("reply", { text: "Sure, what time?" })],
  ]);
  await runLuna(t.deps, user, now, "wamid.in1");
  assertEquals(t.sent.length, 1);
  const [batch] = t.store.checks;
  assertEquals(batch.waMessageId, "wamid.in1");
  assertEquals(batch.events.map((e) => [e.check, e.outcome, e.reason]), [
    ["reply_code", "reject", "link"],
    ["luna_turn", "pass", "retry_pass"],
  ]);
});

Deno.test("a fallback says why it happened", async () => {
  const bad = [call("reply", { text: "**bold**" })];
  const t = luna([bad, bad, bad]);
  await runLuna(t.deps, user, now, "wamid.in2");
  assertEquals(t.store.checks[0].events.at(-1)?.reason, "rejected_thrice");
  assertEquals(t.store.checks[0].events.at(-1)?.outcome, "fallback");

  const down = luna([]);
  down.deps.create = async () => {
    throw new Error("openai response incomplete: max_output_tokens");
  };
  await runLuna(down.deps, user, now, "wamid.in3");
  assertEquals(down.store.checks[0].events.at(-1)?.reason, "model_error:incomplete:max_output_tokens");
});

Deno.test("diagnostics that can't be written cost the user nothing", async () => {
  const t = luna([[call("reply", { text: "Sure, what time?" })]]);
  t.store.checksFail = true;
  await runLuna(t.deps, user, now, "wamid.in4");
  assertEquals(t.sent, [{ kind: "text", body: "Sure, what time?" }]);
});
