import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { AskJev, ChoiceAnswer } from "../jev.ts";
import { checkOutput, decide, mayClaim, route } from "./router.ts";

const th = { offscope: 0.85, injection: 0.8 };
const intent = (choice: string, p: number): ChoiceAnswer => ({
  type: "choice",
  choice,
  confidence: p,
  probabilities: { [choice]: p },
});
const noul = (p: number) => ({ type: "noul" as const, noul: p });
const state = { task_card: "TASK\nnone active", messages: [] };

Deno.test("only a clear off-scope or injection redirects; low confidence never blocks", () => {
  assertEquals(decide(intent("off_scope", 0.95), noul(0.01), th), { mode: "redirect", why: "off_scope" });
  assertEquals(decide(intent("off_scope", 0.6), noul(0.01), th), { mode: "task", why: null });
  assertEquals(decide(intent("new_booking", 0.9), noul(0.9), th), { mode: "redirect", why: "injection" });
  assertEquals(decide(intent("unclear", 0.4), noul(0.1), th), { mode: "task", why: null });
});

Deno.test("recommendations redirect while rec is off for v1", () => {
  assertEquals(decide(intent("recommendation", 0.5), noul(0), th), {
    mode: "redirect",
    why: "recommendation",
  });
});

Deno.test("a router timeout or error means task mode", async () => {
  const ask: AskJev = () => Promise.reject(new Error("timed out"));
  const r = await route(ask, "jev-1", state, th, 1500);
  assertEquals([r.mode, r.intent, r.error], ["task", null, "timed out"]);
});

Deno.test("claims are allowed only while a call is under way or done", async () => {
  const ask: AskJev = async () => ({
    claims_action: noul(0.9),
    off_task_content: noul(0.05),
    promises_follow_up: noul(0),
  });
  const o = { claims: 0.5, offtask: 0.3, promise: 0.6 };
  const before = await checkOutput(ask, "jev-1", state, mayClaim("awaiting_yes", false), "Booked!", o, 1500);
  const during = await checkOutput(ask, "jev-1", state, mayClaim("calling_1", false), "Calling.", o, 1500);
  const report = await checkOutput(ask, "jev-1", state, mayClaim(null, true), "It's booked.", o, 1500);
  assertEquals(report.ran && report.failed, []);
  assertEquals(before.ran && before.failed, ["claims_action"]);
  assertEquals(during.ran && during.failed, []);
});

Deno.test("off-task content fails in any state; a Jev error is reported, not thrown", async () => {
  const ask: AskJev = async () => ({
    claims_action: noul(0),
    off_task_content: noul(0.4),
    promises_follow_up: noul(0),
  });
  const o = { claims: 0.5, offtask: 0.3, promise: 0.6 };
  const r = await checkOutput(ask, "jev-1", state, false, "Paris. Want a table?", o, 1500);
  assertEquals(r.ran && r.failed, ["off_task_content"]);
  const down = await checkOutput(
    () => Promise.reject(new Error("503")),
    "jev-1",
    state,
    false,
    "Hi",
    o,
    1500,
  );
  assertEquals(down, { ran: false, error: "503" });
});
