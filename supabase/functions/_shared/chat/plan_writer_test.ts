import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { createPlanChecker, type PlanInput } from "./plan_writer.ts";
import type { ResponseOut } from "../openai.ts";
const input: PlanInput = {
  task: "booking",
  fields: { party_size: 4, exact_time: "2026-11-06T20:00:00+05:30" },
  reference: "I'll call Paragon in Kannur Road and book a table for 4 tomorrow at 8:00 pm.",
  chat: [{ from: "user", text: "book Paragon Kannur Road for four tomorrow 8pm" }],
  language: "en",
  now: "2026-11-05T21:20+05:30",
  timezone: "Asia/Kolkata",
};
const verdict = (value: unknown): ResponseOut => ({
  output: [{ type: "function_call", name: "plan_verdict", arguments: JSON.stringify(value) }],
  usage: { input_tokens: 1, output_tokens: 1 },
});
const text = "I'll call Paragon on Kannur Road for a table for four tomorrow at 8. Shall I?";

Deno.test("Luna's words pass only on an independent affirmative verdict, which sees them with the action", async () => {
  const seen: string[] = [];
  const check = createPlanChecker(async (req) => {
    seen.push(String((req.input[0] as { content: string }).content));
    return verdict({ faithful: true, problems: [] });
  });
  equal(await check(input, text), { ok: true });
  equal(seen[0].includes(`DRAFT: ${text}`) && seen[0].includes(input.reference), true);
});

Deno.test("words that claim more than the action come back with the problems", async () => {
  const check = createPlanChecker(async () =>
    verdict({ faithful: false, problems: ["Nothing is booked; no payment was authorized"] })
  );
  equal(await check(input, "Booked for four, and paid an advance."), {
    ok: false,
    problems: ["Nothing is booked; no payment was authorized"],
  });
});

Deno.test("an unreadable or unavailable check never passes the words", async () => {
  equal(await createPlanChecker(async () => verdict({}))(input, text), { ok: false, unusable: "no_verdict" });
  equal(
    await createPlanChecker(async () => {
      throw new Error("openai 503: down");
    })(input, text),
    { ok: false, unusable: "model_error:http_5xx" },
  );
  // Format problems are caught before any model call.
  equal(await createPlanChecker(async () => verdict({ faithful: true, problems: [] }))(input, "**Booked**"), {
    ok: false,
    problems: ["no markdown, bullets or bold"],
  });
});

Deno.test("a turn that was superseded during the check is not swallowed", async () => {
  await rejects(
    () =>
      createPlanChecker(async () => {
        throw new Error("turn superseded");
      })(input, text),
    /turn superseded/,
  );
});
