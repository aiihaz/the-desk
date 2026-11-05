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
  deadlineAt?: number;
}) => Promise<ResponseOut>;

// A hung request must not leave the user in silence: after timeoutMs the call fails and
// the chat agent sends its fallback message. Inside that time a request that hangs past
// attemptMs (answers take under 20s; a hang never answers), or gets a 429 or 5xx, is sent
// again, twice at most. Nothing is kept at OpenAI, so a second request changes nothing.
export function responsesClient(
  apiKey: string,
  timeoutMs = 45_000,
  fetcher: typeof fetch = fetch,
  retryDelayMs = 400,
  attemptMs = 20_000,
): CreateResponse {
  return async (req) => {
    const until = Math.min(Date.now() + timeoutMs, req.deadlineAt ?? Infinity);
    const send = () =>
      fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: AbortSignal.timeout(Math.max(1, Math.min(attemptMs, until - Date.now()))),
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
    let res: Response | undefined;
    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        const wait = retryDelayMs * attempt;
        if (Date.now() + wait >= until) break;
        await res?.body?.cancel();
        await new Promise((r) => setTimeout(r, wait));
      }
      try {
        res = await send();
      } catch (e) {
        // Only a hang of this attempt is retried; the last one's error is the call's.
        if ((e as Error)?.name !== "TimeoutError" || attempt === 2 || Date.now() + 1_000 >= until) throw e;
        res = undefined;
        continue;
      }
      if (res.status !== 429 && res.status < 500) break;
    }
    if (!res) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`openai ${res.status}: ${JSON.stringify(body?.error ?? body)}`);
    if (body.status && body.status !== "completed") {
      throw new Error(
        `openai response ${body.status}: ${body.incomplete_details?.reason ?? "not completed"}`,
      );
    }
    if (!Array.isArray(body.output)) throw new Error("openai response missing output");
    return body as ResponseOut;
  };
}
