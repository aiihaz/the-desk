import { deepStrictEqual as equal, rejects } from "node:assert/strict";
import { responsesClient } from "./openai.ts";
const req = {
  model: "test",
  instructions: "",
  input: [],
  tools: [],
  reasoningEffort: "low",
  maxOutputTokens: 10,
};
Deno.test("incomplete model output is not executed as a completed decision", async () => {
  const create = responsesClient(
    "fake",
    1000,
    async () =>
      Response.json({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "function_call", name: "approve_plan", arguments: "{}" }],
      }),
  );
  await rejects(() => create(req), /incomplete: max_output_tokens/);
});
Deno.test("completed model responses retain output while malformed success fails explicitly", async () => {
  const body = { status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } };
  equal(await responsesClient("fake", 1000, async () => Response.json(body))(req), body);
  await rejects(() => responsesClient("fake", 1000, async () => Response.json({}))(req), /missing output/);
});
Deno.test("a 503 or 429 is tried again within the time; a 400 and a third failure are not", async () => {
  const body = { status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 1 } };
  const replies = (...statuses: number[]) => {
    let n = 0;
    const fetcher = async () => {
      const status = statuses[n++] ?? 200;
      return status === 200 ? Response.json(body) : Response.json({ error: "x" }, { status });
    };
    return { fetcher, calls: () => n };
  };
  const flaky = replies(503, 429);
  equal(await responsesClient("fake", 1000, flaky.fetcher, 1)(req), body);
  equal(flaky.calls(), 3);
  const bad = replies(400);
  await rejects(() => responsesClient("fake", 1000, bad.fetcher, 1)(req), /openai 400/);
  equal(bad.calls(), 1);
  const down = replies(503, 503, 503);
  await rejects(() => responsesClient("fake", 1000, down.fetcher, 1)(req), /openai 503/);
  equal(down.calls(), 3);
  const late = replies(503);
  await rejects(() => responsesClient("fake", 1000, late.fetcher, 5_000)(req), /openai 503/);
  equal(late.calls(), 1);
});
