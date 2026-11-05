import { type CreateResponse, responsesClient } from "./openai.ts";
import { serviceClient } from "./store.ts";

type Measurement = {
  model: string;
  purpose: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
};
type Background = (work: Promise<unknown>) => void;

// Explicit lifecycle ownership keeps telemetry off the hosted response path without
// leaving an untracked promise that an edge isolate may discard on response completion.
export function observeResponses(
  create: CreateResponse,
  record: (measurement: Measurement) => Promise<void>,
  background?: Background,
): CreateResponse {
  return async (req) => {
    const started = performance.now();
    const result = await create(req);
    const work = Promise.resolve().then(() =>
      record({
        model: req.model,
        purpose: req.tools.map((t) => t.name).join(",").slice(0, 100),
        input_tokens: result.usage?.input_tokens ?? 0,
        output_tokens: result.usage?.output_tokens ?? 0,
        latency_ms: Math.round(performance.now() - started),
      })
    ).catch(() => {
      console.warn("model usage persistence failed");
    });
    if (background) background(work);
    else await work;
    return result;
  };
}

export function observedResponsesClient(apiKey: string): CreateResponse {
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: Background } }).EdgeRuntime;
  return observeResponses(responsesClient(apiKey), async (measurement) => {
    const { error } = await serviceClient().from("model_usage").insert(measurement);
    if (error) throw error;
  }, runtime ? (work) => runtime.waitUntil(work) : undefined);
}
