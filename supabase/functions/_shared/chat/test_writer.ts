// A stand-in for the model that writes messages (tell.ts): it puts every value in and names
// the status, so a test reads what the facts reached the user as. The checker passes it.
import type { CreateResponse, ResponseOut } from "../openai.ts";
import { FAITHFUL, WRITE } from "./tell.ts";

export const say = (name: string, args: unknown): ResponseOut => ({
  output: [{ type: "function_call", name, call_id: crypto.randomUUID(), arguments: JSON.stringify(args) }],
  usage: { input_tokens: 0, output_tokens: 0 },
});

export const fakeWriter: CreateResponse = async (req) => {
  if (req.instructions === FAITHFUL) return say("verdict", { faithful: true, problems: [] });
  if (req.instructions !== WRITE) throw new Error("fakeWriter: not a write");
  const content = req.input[0].content as string;
  const facts = JSON.parse(content.slice(content.indexOf("FACTS:\n") + 7));
  const values = Object.keys(facts.values).map((k) => `{{${k}}}`).join(" ");
  return say("message", { text: `${facts.happened.status}. ${values}`.trim() });
};
