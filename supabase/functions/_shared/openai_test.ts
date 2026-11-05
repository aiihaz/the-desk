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
