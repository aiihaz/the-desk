import { responsesClient } from "./openai.ts";
import { serviceClient } from "./store.ts";
import type { CreateResponse } from "./openai.ts";

// Persist bounded operational measurements, never prompts, screenshots, or model output.
export function observedResponsesClient(apiKey: string): CreateResponse {
  const create = responsesClient(apiKey);
  return async (req) => {
    const started = performance.now();
    const result = await create(req);
    try {
      const { error } = await serviceClient().from("model_usage").insert({
        model: req.model,
        purpose: req.tools.map((t) => t.name).join(",").slice(0, 100),
        input_tokens: result.usage?.input_tokens ?? 0,
        output_tokens: result.usage?.output_tokens ?? 0,
        latency_ms: Math.round(performance.now() - started),
      });
      if (error) console.warn("model usage persistence failed");
    } catch {
      console.warn("model usage persistence failed");
    }
    return result;
  };
}
