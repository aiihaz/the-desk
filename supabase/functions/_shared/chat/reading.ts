// A second, independent reading of what the user said. A separate model call sees only the
// question and the numbered messages, none of Luna's reasoning, and answers yes, no or
// unclear. A yes must point at the user's message that says so. That works in any language
// and survives paraphrase, because nothing is matched as words: code only checks that the
// number is a real message from the user, and what's kept as evidence is that message.
import type { CreateResponse, Item } from "../openai.ts";
import type { ChatLine, ChatStore } from "./store.ts";

export type Reading = {
  decision: "yes" | "no" | "unclear";
  // The user's message the yes rests on.
  line: ChatLine | null;
  why: string;
};

const TOOL = {
  type: "function" as const,
  strict: false as const,
  name: "verdict",
  description: "Your answer.",
  parameters: {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["yes", "no", "unclear"] },
      message: {
        type: ["integer", "null"],
        description: "the number of the user's message your yes rests on; null unless yes",
      },
      why: { type: "string", description: "one short sentence" },
    },
    required: ["decision", "message", "why"],
  },
};

// A message quoted in a reply or reaction. One that is the subject itself (a 👍 on the plan,
// which approval.ts has already matched to it) says so: the model then reads the reaction
// against all of it, not a fragment it has to guess the rest of.
const QUOTED_CHARS = 600;

function numbered(lines: ChatLine[], target?: string): string {
  return lines.map((l, i) => {
    const q = !l.quoted
      ? ""
      : l.quoted === target
      ? " (replying to the message above, exactly as written there)"
      : ` (replying to: "${
        l.quoted.length > QUOTED_CHARS ? `${l.quoted.slice(0, QUOTED_CHARS - 1)}…` : l.quoted
      }")`;
    return `${i + 1}. ${l.from}${q}: ${l.text}`;
  }).join("\n");
}

export async function readChat(
  create: CreateResponse,
  model: string,
  effort: string,
  instructions: string,
  subject: string,
  lines: ChatLine[],
  // The exact text the subject shows (a plan), so a reply to it is named as one.
  target?: string,
): Promise<Reading> {
  const input: Item[] = [{ role: "user", content: `${subject}\n\nMESSAGES:\n${numbered(lines, target)}` }];
  const res = await create({
    model,
    instructions,
    input,
    tools: [TOOL],
    reasoningEffort: effort,
    maxOutputTokens: 600,
  });
  const call = res.output.find((o) => o.type === "function_call" && o.name === "verdict");
  let v: { decision?: string; message?: unknown; why?: unknown } = {};
  try {
    v = JSON.parse(call?.arguments ?? "{}");
  } catch {
    // An unreadable answer says nothing.
  }
  const why = String(v.why ?? "");
  if (v.decision === "no") return { decision: "no", line: null, why };
  const line = Number.isInteger(v.message) ? lines[(v.message as number) - 1] : undefined;
  return v.decision === "yes" && line?.from === "user"
    ? { decision: "yes", line, why }
    : { decision: "unclear", line: null, why };
}

// The model and effort come from limits, so they change without a deploy.
export async function readingSettings(
  store: Pick<ChatStore, "limitText">,
  userId: string,
): Promise<{ model: string; effort: string }> {
  return {
    model: (await store.limitText("approval_model", userId)) ??
      (await store.limitText("luna_model", userId)) ?? "gpt-6-luna",
    effort: (await store.limitText("approval_reasoning_effort", userId)) ?? "low",
  };
}
