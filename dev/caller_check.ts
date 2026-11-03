// Is a caller agent wired to what Desk reads? Give it the agent's output variable names
// (one per line, or a JSON list), or a saved Sarvam result with final_agent_variables.
// Names only: says what's missing. A result: also shows what Desk would tell the user.
// Changes nothing and calls nothing.
//
//   deno task caller-check outputs.txt
import contract from "../agent/contract.json" with { type: "json" };
import { hasResult, readOutputs } from "../supabase/functions/_shared/chat/outputs.ts";
import { readOutcome } from "../supabase/functions/_shared/chat/report.ts";

const path = Deno.args[0];
if (!path) {
  console.error("usage: deno task caller-check <names or result file> [call kind, default first]");
  Deno.exit(2);
}
const kind = Deno.args[1] ?? "first";
const text = await Deno.readTextFile(path);

// deno-lint-ignore no-explicit-any
let parsed: any = null;
try {
  parsed = JSON.parse(text);
} catch {
  // A plain list of names.
}
const vars = parsed?.final_agent_variables ?? parsed?.outputs ??
  (parsed && !Array.isArray(parsed) ? parsed : null);
const names: string[] = vars
  ? Object.keys(vars)
  : Array.isArray(parsed)
  ? parsed.map(String)
  : text.split(/\s+/).filter(Boolean);

const missing = contract.required.filter((o) => !names.includes(o.name));
console.log(`${contract.required.length - missing.length} of ${contract.required.length} outputs present`);
for (const m of missing) console.log(`  missing: ${m.name} (${m.calls})`);
for (const m of contract.optional.filter((o) => !names.includes(o.name))) {
  console.log(`  optional, not there: ${m.name} (read when present)`);
}
if (vars) {
  const out = readOutputs(kind, vars);
  console.log(`\nAs a ${kind} call:`, hasResult(out) ? "Desk can read a result" : "NO RESULT Desk can read");
  console.log(JSON.stringify(readOutcome(kind, vars, new Date()), null, 2));
}
if (missing.length) Deno.exit(1);
