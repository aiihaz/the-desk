import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { createPlanWriter, type PlanInput } from "./plan_writer.ts";
import type { ResponseOut } from "../openai.ts";
const input: PlanInput = {
  task: "booking",
  fields: { party_size: 4, exact_time: "2026-11-06T20:00:00+05:30" },
  reference: "Call Paragon Kannur Road and book for four tomorrow at 8pm. Ask approval.",
  chat: [{ from: "user", text: "book Paragon Kannur Road for four tomorrow 8pm" }],
  language: "en",
};
const answer = (name: string, value: unknown): ResponseOut => ({
  output: [{ type: "function_call", name, arguments: JSON.stringify(value) }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
Deno.test("natural proposal wording requires an independent affirmative semantic verdict", async () => {
  const calls: string[] = [];
  const text = "I'll call Paragon on Kannur Road for a table for four tomorrow at 8. Shall I?";
  const writer = createPlanWriter(async (req) => {
    calls.push(req.tools[0].name);
    return req.tools[0].name === "plan"
      ? answer("plan", { text })
      : answer("plan_verdict", { faithful: true, problems: [] });
  });
  equal(await writer(input), text);
  equal(calls, ["plan", "plan_verdict"]);
});
Deno.test("an unsupported booking claim is never returned when independent checks keep rejecting it", async () => {
  let drafts = 0;
  const writer = createPlanWriter(async (req) => {
    if (req.tools[0].name === "plan") {
      drafts++;
      return answer("plan", { text: "Booked for four, and paid an advance." });
    }
    return answer("plan_verdict", {
      faithful: false,
      problems: ["Nothing is booked; no payment was authorized"],
    });
  });
  equal(await writer(input), null);
  equal(drafts, 2);
});
Deno.test("a corrected draft is checked again rather than trusting the repair", async () => {
  let calls = 0;
  const outputs = [
    answer("plan", { text: "I'll book at 9. Shall I?" }),
    answer("plan_verdict", { faithful: false, problems: ["wrong time"] }),
    answer("plan", { text: "I'll book at 8. Shall I?" }),
    answer("plan_verdict", { faithful: true, problems: [] }),
  ];
  equal(await createPlanWriter(async () => outputs[calls++])(input), "I'll book at 8. Shall I?");
  equal(calls, 4);
});
Deno.test("an unavailable checker never silently releases an unchecked plan", async () => {
  const writer = createPlanWriter(async (req) => {
    if (req.tools[0].name === "plan") return answer("plan", { text: "I'll call them. Shall I?" });
    throw new Error("checker unavailable");
  });
  await rejects(() => writer(input), /checker unavailable/);
});
