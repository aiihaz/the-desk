// OpenAI Responses API, the minimum the chat agent needs: function tools, forced
// tool use, and passing a turn's items back in. Chat Completions doesn't allow
// tools with reasoning on gpt-6-luna, so this uses /v1/responses.

// deno-lint-ignore no-explicit-any
export type Item = Record<string, any>;

export type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
};

export type ResponseOut = {
  output: Item[];
  usage: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
};

export type CreateResponse = (req: {
  model: string;
  instructions: string;
  input: Item[];
  tools: FunctionTool[];
  reasoningEffort: string;
  maxOutputTokens: number;
}) => Promise<ResponseOut>;

// A hung request must not leave the user in silence: after timeoutMs the call fails and
// the chat agent sends its fallback message.
export function responsesClient(apiKey: string, timeoutMs = 30_000): CreateResponse {
  return async (req) => {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        instructions: req.instructions,
        input: req.input,
        tools: req.tools,
        tool_choice: "required",
        reasoning: { effort: req.reasoningEffort },
        max_output_tokens: req.maxOutputTokens,
        // Nothing kept at OpenAI; reasoning comes back encrypted so the next step can use it.
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(body?.error ?? body)}`);
    return body as ResponseOut;
  };
}
