// TypeSafe System One (Jev) over HTTP. The jev and typesafe_sdk packages are Python only,
// so this reads the API from typesafe_sdk 0.7.5 (E4 design 3). Jev writes no text: it
// answers typed questions about a state with probabilities. The chat agent uses it as
// the router (L1) and for half of the output check (L3).

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type Answer = ChoiceAnswer | NoulAnswer;

export type AskJev = (req: {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, Question>;
  timeoutMs: number;
}) => Promise<Record<string, Answer>>;

// Throws on a timeout, an HTTP error, or a missing answer; callers decide what failing safe means.
export function jevClient(apiKey: string): AskJev {
  return async ({ model, state, questions, timeoutMs }) => {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`jev ${res.status}: ${JSON.stringify(body?.error ?? body)}`);
    const answers = body?.answers ?? {};
    for (const [name, q] of Object.entries(questions)) {
      if (answers[name]?.type !== q.type) throw new Error(`jev: no ${q.type} answer for ${name}`);
    }
    return answers;
  };
}
