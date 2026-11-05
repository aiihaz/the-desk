import { deepStrictEqual as equal } from "node:assert/strict";
import { observeResponses } from "./model_client.ts";
const request = {
  model: "test",
  instructions: "",
  input: [],
  tools: [],
  reasoningEffort: "low",
  maxOutputTokens: 20,
};
Deno.test("hosted telemetry does not delay a completed model response and has lifecycle ownership", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let background: Promise<unknown> | undefined;
  const response = { output: [], usage: { input_tokens: 2, output_tokens: 3 } };
  const client = observeResponses(async () => response, () => pending, (work) => {
    background = work;
  });
  equal(await client(request), response);
  equal(!!background, true);
  finish();
  await background;
});
Deno.test("telemetry failure does not turn a valid response into a conversational failure", async () => {
  const response = { output: [], usage: { input_tokens: 2, output_tokens: 3 } };
  const client = observeResponses(async () => response, async () => {
    throw new Error("storage unavailable");
  });
  equal(await client(request), response);
});
