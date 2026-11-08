// Model-only quality smoke. No database, carrier, real search, or messaging transport.
// deno run --allow-read --allow-write=/tmp --allow-env --allow-net=api.openai.com dev/conversation_eval.ts
// Key: OPENAI_API_KEY or ignored supabase/functions/.env. Output defaults to /tmp.
// These transcripts support human review; they are not production qualification.
import { callVariables } from "../supabase/functions/_shared/call_vars.ts";
import { createPlanChecker } from "../supabase/functions/_shared/chat/plan_writer.ts";
import { createIntentGrounding } from "../supabase/functions/_shared/chat/intent_grounding.ts";
import { FakeChatStore } from "../supabase/functions/_shared/chat/test_chat_store.ts";
import { runLuna, SYSTEM } from "../supabase/functions/_shared/chat/luna.ts";
import { type CreateResponse, responsesClient } from "../supabase/functions/_shared/openai.ts";
import type { PlaceHit } from "../supabase/functions/_shared/places.ts";
import type { ActiveRequest, ChatStore } from "../supabase/functions/_shared/chat/store.ts";
import type { Task } from "../supabase/functions/_shared/chat/states.ts";
import type { Outbound } from "../supabase/functions/_shared/whatsapp.ts";

type Case = {
  id: string;
  history: ["user" | "desk", string][];
  messages: string[];
  expected: string;
  booking?: boolean;
  // All messages arrive before one turn (a burst), instead of a turn each.
  burst?: boolean;
  noApproval?: boolean;
  noTime?: boolean;
  noSlotChanges?: boolean;
  // The case's own clock, when the fixture's isn't the point (around midnight).
  clock?: string;
  // Who the user is before the case: the fake's defaults are a known user named Ihaz.
  profile?: { name?: string | null; city?: string | null; addresses?: { label: string; address: string }[] };
  // The Desk has never written to them.
  firstContact?: boolean;
  // What must be true afterwards, read from state, not from wording.
  expect?: {
    plan?: boolean; // a plan was stored and sent (plan_sent), or none was
    fields?: Record<string, unknown>; // final request fields; null: must be absent
    business?: string; // fixture placeId the request is bound to
    queuedTask?: string; // a separate errand of this task waits
    queuedQuestions?: number; // and carries at least this many questions
    bookingUnchanged?: boolean; // the open booking kept its fields and business
    memories?: number; // memories kept
    replies?: number; // messages the Desk sent
    request?: boolean; // an errand was started, or none was
    profileName?: string | null; // the profile name afterwards
    addresses?: number; // saved addresses afterwards
    searches?: number; // Places searches run, at most
  };
};
// The caller's settled errand, as callVariables builds it for a first call.
function callerBrief(fields: Record<string, unknown>): Record<string, unknown> {
  const v = callVariables("first", {
    task: "booking",
    fields,
    businessName: "fixture",
    customerPhone: "+919812345678",
    option: null,
    prev: null,
    booking: null,
    payment: null,
    approvedLossRs: 0,
  }, false);
  return { when: v.resolved_when, decided: v.decided, flexible: v.flexible, may_accept: v.may_accept };
}
const raw = await Deno.readTextFile("fixtures/conversation/quality-smoke.json");
type FixturePlace = Omit<PlaceHit, "openingHours" | "closed"> & { found_by: string };
const fixture = JSON.parse(raw) as {
  version: number;
  clock: string;
  rubric: string[];
  // The fake search: a place is a hit when its found_by pattern matches the query. This stands in
  // for Google and never reaches the product.
  places: FixturePlace[];
  cases: Case[];
};
const hash = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((n) =>
    n.toString(16).padStart(2, "0")
  ).join("");
let key = Deno.env.get("OPENAI_API_KEY");
if (!key) {
  const env = await Deno.readTextFile("supabase/functions/.env");
  key = env.split("\n").find((l) => l.startsWith("OPENAI_API_KEY="))?.slice("OPENAI_API_KEY=".length).trim()
    .replace(/^['"]|['"]$/g, "");
}
if (!key) throw new Error("OPENAI_API_KEY is required; no credential is written to results");
const output = Deno.env.get("DESK_EVAL_OUTPUT") ?? `/tmp/desk-quality-${Date.now()}.json`;
const count = Number(Deno.env.get("DESK_EVAL_CASES") ?? "8");
if (!Number.isInteger(count) || count < 1 || count > fixture.cases.length) {
  throw new Error(`DESK_EVAL_CASES must be 1–${fixture.cases.length}`);
}
// Optional model judgment of each transcript against its expectation and the rubric.
// Recorded beside the state checks; it is not a human verdict.
const judging = Deno.env.get("DESK_EVAL_JUDGE") !== "off";
const create = responsesClient(key);
let modelCalls = 0;
const results: Record<string, unknown>[] = [];
const sourceFiles = [
  "supabase/functions/_shared/chat/luna.ts",
  "supabase/functions/_shared/chat/tools.ts",
  "supabase/functions/_shared/chat/turn.ts",
  "supabase/functions/_shared/chat/plan_writer.ts",
  "supabase/functions/_shared/chat/intent_grounding.ts",
  "supabase/functions/_shared/chat/slots.ts",
  "supabase/functions/_shared/chat/readback.ts",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(sourceFiles.map(async (p) => [p, await hash(await Deno.readTextFile(p))])),
);
const run = {
  fixture_version: fixture.version,
  fixture_sha256: await hash(raw),
  system_sha256: await hash(SYSTEM),
  source_sha256: sourceHashes,
  configuration: {
    model: Deno.env.get("DESK_EVAL_MODEL") ?? "gpt-6-luna",
    plan_writer: true,
    intent_grounding: true,
    jev: "off",
    judge: judging,
  },
  started_at: new Date().toISOString(),
  rubric: fixture.rubric,
  limitations: [
    "FakeChatStore is not PostgreSQL",
    "Search fixtures are deterministic, not provider search",
    "No approval or carrier execution is permitted",
    "Sequential turns do not qualify burst concurrency or adapters",
    "No automatic tone pass; human review required",
  ],
  results,
};
await Deno.writeTextFile(output, JSON.stringify(run, null, 2));
// Business IDs are UUIDs, as in production; choose_business refuses anything else.
const placeIds: Record<string, string> = {
  paragon: "b5000000-0000-4000-8000-000000000001",
  "snow-white": "b5000000-0000-4000-8000-000000000002",
};
const businessId = (placeId: string) => placeIds[placeId] ??= crypto.randomUUID();
// DESK_EVAL_ONLY=id,id runs just those cases.
const only = Deno.env.get("DESK_EVAL_ONLY")?.split(",").map((s) => s.trim());
for (
  const scenario of only ? fixture.cases.filter((c) => only.includes(c.id)) : fixture.cases.slice(0, count)
) {
  const now = new Date(scenario.clock ?? fixture.clock);
  const state = new FakeChatStore();
  state.promptAt = now;
  if (scenario.profile?.name !== undefined) state.profileName = scenario.profile.name;
  if (scenario.profile?.city !== undefined) state.city = scenario.profile.city;
  if (scenario.profile?.addresses) state.savedAddresses = structuredClone(scenario.profile.addresses);
  state.isFirstContact = scenario.firstContact === true;
  // As production (0007): a kind of place ("a plumber") can be searched for.
  state.limits.place_search_by_kind = true;
  const places = new Map<string, PlaceHit>();
  const request = (task: Task): ActiveRequest => ({
    id: "a4000000-0000-4000-8000-000000000001",
    task,
    state: "collecting" as const,
    version: 1,
    fields: {},
    businessId: null,
    bookingId: null,
    createdAt: now,
    pausedAt: null,
  });
  if (scenario.booking) {
    // An open plan for a table at Paragon, waiting for their answer.
    state.req = {
      ...request("booking"),
      state: "confirming",
      businessId: businessId("paragon"),
      fields: {
        party_size: 2,
        exact_time: "2026-11-05T20:00:00+05:30",
        customer_name: "Ihaz",
        may_book: true,
      },
    };
    const shown = scenario.history.findLast(([from]) => from === "desk")?.[1];
    if (shown) {
      state.req.state = "awaiting_yes";
      state.prompt = {
        id: "c5000000-0000-4000-8000-000000000001",
        kind: "ask",
        optionIds: [],
        confirmWord: "yes",
        waMessageId: `history-${scenario.history.length - 1}`,
        sentAt: new Date(now.getTime() - 1000),
        text: shown,
        message: { kind: "text", body: shown },
      };
    }
  }
  const store = Object.assign(state, {
    savePlace: async (p: PlaceHit) => {
      const id = businessId(p.placeId);
      places.set(id, p);
      state.saved.push(p.placeId);
      return id;
    },
    place: async (id: string) =>
      places.get(id) ?? { name: "Paragon", address: "Kannur Road, Kozhikode", city: "Kozhikode" },
    businessExists: async (id: string) => places.has(id) || id === businessId("paragon"),
    request: async (id: string) => {
      const found = [state.req, ...state.waiting].find((r) => r?.id === id);
      if (!found) throw new Error("unknown request");
      return found;
    },
    queueRequest: async (_u: string, task: Task) => {
      const queued = {
        ...request(task),
        id: "b4000000-0000-4000-8000-" + String(state.waiting.length + 1).padStart(12, "0"),
        state: "queued" as const,
      };
      state.waiting.push(queued);
      state.queuedTasks.push(task);
      return { ok: true as const, request_id: queued.id, state: queued.state };
    },
    updateSlots: async (id: string, patch: Record<string, unknown>) => {
      const r = [state.req, ...state.waiting].find((r) => r?.id === id);
      if (!r) throw new Error("unknown request");
      state.slotWrites.push(patch);
      r.fields = { ...r.fields, ...patch };
      r.version++;
      if (r === state.req) state.prompt = null;
      return { ok: true as const, changed: true, state: r.state, version: r.version };
    },
    advance: async (id: string, next: ActiveRequest["state"]) => {
      const r = [state.req, ...state.waiting].find((r) => r?.id === id);
      if (!r) throw new Error("unknown request");
      r.state = next;
      return { ok: true as const };
    },
    startRequest: async (_u: string, task: Task) => {
      state.req = request(task);
      return { ok: true as const, request_id: state.req.id, state: state.req.state };
    },
    // By request id, as the database does: a queued errand's business is its own.
    setBusiness: async (requestId: string, id: string) => {
      const r = [state.req, ...state.waiting].find((r) => r?.id === requestId);
      if (!r) throw new Error("unknown request");
      r.businessId = id;
      return { ok: true as const, changed: true, state: r.state, version: r.version };
    },
  }) as ChatStore;
  state.lines = scenario.history.map(([from, text], i) => ({
    from,
    text,
    at: new Date(now.getTime() - (scenario.history.length - i) * 1000),
    id: `history-${i}`,
  }));
  const before = state.req ? structuredClone(state.req) : null;
  const transcript: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  const calls: Record<string, unknown>[] = [];
  const failures: string[] = [];
  let approvalAttempts = 0;
  let sent = 0;
  const wrapped: CreateResponse = async (req) => {
    // Per case, so one runaway case can't starve the ones after it.
    modelCalls++;
    if (calls.length >= 48) throw new Error("evaluation model-call cap reached for this case");
    const started = performance.now();
    const actual = { ...req, model: Deno.env.get("DESK_EVAL_MODEL") ?? req.model };
    let response: Awaited<ReturnType<CreateResponse>>;
    try {
      response = await create(actual);
    } catch (error) {
      calls.push({
        model: actual.model,
        tool_names: actual.tools.map((t) => t.name),
        error: (error as Error).message,
        latency_ms: Math.round(performance.now() - started),
      });
      throw error;
    }
    calls.push({
      model: actual.model,
      reasoning: actual.reasoningEffort,
      input: actual.input,
      tool_names: actual.tools.map((t) => t.name),
      output: response.output.filter((o) => o.type !== "reasoning"),
      usage: response.usage,
      latency_ms: Math.round(performance.now() - started),
    });
    return response;
  };
  const started = performance.now();
  const turns = scenario.burst ? [scenario.messages] : scenario.messages.map((m) => [m]);
  for (const [index, texts] of turns.entries()) {
    const id = `input-${index}`;
    texts.forEach((text, i) => {
      state.lines.push({ from: "user", text, at: now, id: i === texts.length - 1 ? id : `${id}-${i}` });
      transcript.push({ from: "user", text });
    });
    try {
      await runLuna(
        {
          store,
          now: () => now,
          create: wrapped,
          checkPlan: createPlanChecker(wrapped, Deno.env.get("DESK_EVAL_MODEL") ?? "gpt-6-luna"),
          checkIntent: createIntentGrounding(wrapped, Deno.env.get("DESK_EVAL_MODEL") ?? "gpt-6-luna"),
          send: async (_u, message: Outbound) => {
            const id = `output-${++sent}`;
            state.lastOut = id;
            const text = message.kind === "text" ? message.body : JSON.stringify(message);
            transcript.push({ from: "desk", text, id });
            state.lines.push({ from: "desk", text, at: now, id });
            return id;
          },
          searchPlaces: async ({ text }) =>
            fixture.places.filter((p) => new RegExp(p.found_by, "i").test(text)).map((
              { found_by: _, ...p },
            ) => ({
              ...p,
              openingHours: null,
              closed: false,
            })),
          onApproved: async () => {
            approvalAttempts++;
            throw new Error("External action disabled in quality evaluation");
          },
          trace: (event, data) => {
            traces.push({ event, data });
          },
        },
        { id: "eval-user", waId: "919999999999", blocked: false, channel: "linq" },
        now,
        id,
      );
    } catch (error) {
      failures.push(`runtime: ${(error as Error).message}`);
    }
  }
  if (scenario.noApproval && (approvalAttempts || state.consents.length)) {
    failures.push("unexpected approval");
  }
  if (scenario.noTime && state.slotWrites.some((w) => w.exact_time || w.window_start || w.window_end)) {
    failures.push("invented clock time");
  }
  if (scenario.noSlotChanges && state.slotWrites.length) failures.push("ambiguous edit changed state");
  const fallbacks = traces.filter((t) => t.event === "fallback" || t.event === "luna_error");
  if (fallbacks.length) {
    failures.push(`fell back: ${JSON.stringify(fallbacks.map((t) => t.data)).slice(0, 300)}`);
  }
  const want = scenario.expect ?? {};
  const planSent = traces.some((t) => t.event === "plan_sent");
  if (want.plan === true && !(planSent && state.prompt)) failures.push("no plan was stored and sent");
  if (want.plan === false && planSent) failures.push("a plan was sent before it could be ready");
  const same = (a: unknown, b: unknown) =>
    typeof a === "string" && typeof b === "string" && !Number.isNaN(Date.parse(a)) && /T\d/.test(a)
      ? Date.parse(a) === Date.parse(b)
      : JSON.stringify(a) === JSON.stringify(b);
  for (const [k, v] of Object.entries(want.fields ?? {})) {
    const got = (state.req?.fields as Record<string, unknown> | undefined)?.[k];
    // null expects the field absent: a meaning that must not be stored.
    const ok = v === null ? got === undefined || got === null : same(got, v);
    if (!ok) failures.push(`field ${k}: ${JSON.stringify(got)}, expected ${JSON.stringify(v)}`);
  }
  if (want.business && state.req?.businessId !== businessId(want.business)) {
    failures.push(`business: not bound to ${want.business}`);
  }
  if (want.queuedTask) {
    const queued = state.waiting.find((r) => r.task === want.queuedTask);
    if (!queued) failures.push(`no separate ${want.queuedTask} errand`);
    else if ((queued.fields.questions?.length ?? 0) < (want.queuedQuestions ?? 0)) {
      failures.push(`${want.queuedTask} errand is missing its question`);
    }
  }
  if (
    want.bookingUnchanged && before &&
    (JSON.stringify(state.req?.fields) !== JSON.stringify(before.fields) ||
      state.req?.businessId !== before.businessId)
  ) failures.push("the open booking was changed");
  if (want.memories !== undefined && state.kept.length !== want.memories) {
    failures.push(`memories: ${state.kept.length}, expected ${want.memories}`);
  }
  if (want.replies !== undefined && sent !== want.replies) {
    failures.push(`replies: ${sent}, expected ${want.replies}`);
  }
  if (want.request === false && (state.req || state.waiting.length)) failures.push("an errand was started");
  if (want.request === true && !state.req) failures.push("no errand was started");
  if (want.profileName !== undefined && state.profileName !== want.profileName) {
    failures.push(
      `profile name: ${JSON.stringify(state.profileName)}, expected ${JSON.stringify(want.profileName)}`,
    );
  }
  const searches = traces.filter((t) =>
    t.event === "luna_tool" && (t.data as { tool?: string }).tool === "find_business"
  )
    .length;
  if (want.searches !== undefined && searches > want.searches) {
    failures.push(`searches: ${searches}, expected at most ${want.searches}`);
  }
  if (want.addresses !== undefined && state.savedAddresses.length !== want.addresses) {
    failures.push(`addresses: ${state.savedAddresses.length}, expected ${want.addresses}`);
  }
  let judgment: unknown = null;
  if (judging) {
    try {
      const res = await wrapped({
        model: Deno.env.get("DESK_EVAL_JUDGE_MODEL") ?? Deno.env.get("DESK_EVAL_MODEL") ?? "gpt-6-luna",
        reasoningEffort: "medium",
        maxOutputTokens: 1500,
        instructions:
          "You review one conversation between a user and Desk, an assistant that makes phone calls to businesses in India. Judge only from the transcript. For the EXPECTED behaviour and each RUBRIC item that applies, say whether the Desk's messages meet it, with a one-line reason quoting the Desk. Unnecessary questions, re-asking known facts, invented details and generic service openers are failures. Do not reward length or politeness alone.",
        tools: [{
          type: "function",
          strict: false,
          name: "judgment",
          description: "Per-criterion verdicts for this transcript.",
          parameters: {
            type: "object",
            properties: {
              verdicts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    criterion: { type: "string" },
                    pass: { type: "boolean" },
                    reason: { type: "string" },
                  },
                  required: ["criterion", "pass", "reason"],
                },
              },
              unnecessary_questions: { type: "integer" },
            },
            required: ["verdicts", "unnecessary_questions"],
          },
        }],
        input: [{
          role: "user",
          content: JSON.stringify({
            NOW: `${fixture.clock} (Asia/Kolkata); resolving "tomorrow" or a weekday to its date is expected`,
            DESK_RULES:
              "Every call needs the user's yes on a plan that states it, so a plan ending in a request to go ahead is required, not redundant. The plan may add details from search results (branch, area) and the user's profile name (bookings are made under it unless they say otherwise).",
            EXPECTED: scenario.expected,
            RUBRIC: fixture.rubric,
            EARLIER: scenario.history.map(([from, text]) => ({ from, text })),
            TRANSCRIPT: transcript,
          }),
        }],
      });
      const out = res.output.find((o) => o.type === "function_call" && o.name === "judgment");
      judgment = out && out.type === "function_call" ? JSON.parse(out.arguments) : { error: "no judgment" };
    } catch (error) {
      judgment = { error: (error as Error).message };
    }
  }
  const result = {
    id: scenario.id,
    expected: scenario.expected,
    human_quality_verdict: "unreviewed",
    failures,
    model_judgment: judgment,
    transcript,
    traces,
    model_calls: calls,
    elapsed_ms: Math.round(performance.now() - started),
    final_request: state.req,
    // What the caller would be told from the final fields, for review beside the plan.
    caller: planSent && state.req?.businessId
      ? callerBrief(state.req.fields as Record<string, unknown>)
      : null,
    memories: state.kept,
    queued_requests: state.waiting,
    slot_writes: state.slotWrites,
    approval_attempts: approvalAttempts,
  };
  results.push(result);
  await Deno.writeTextFile(output, JSON.stringify(run, null, 2));
  const misses = (judgment as { verdicts?: { pass: boolean; criterion: string }[] } | null)?.verdicts
    ?.filter((v) => !v.pass).map((v) => v.criterion);
  console.log(
    JSON.stringify({
      id: scenario.id,
      failures,
      judge_misses: misses ?? null,
      transcript,
      model_calls: calls.length,
    }),
  );
}
const totals = results.flatMap((r) => r.model_calls as Record<string, unknown>[]).reduce<
  { input_tokens: number; output_tokens: number }
>((sum, c) => {
  const usage = c.usage as { input_tokens?: number; output_tokens?: number };
  sum.input_tokens += usage?.input_tokens ?? 0;
  sum.output_tokens += usage?.output_tokens ?? 0;
  return sum;
}, { input_tokens: 0, output_tokens: 0 });
await Deno.writeTextFile(
  output,
  JSON.stringify(
    {
      ...run,
      finished_at: new Date().toISOString(),
      totals,
      model_calls: modelCalls,
      cost_usd: null,
      cost_note: "Token usage recorded; no unverified model pricing estimate",
    },
    null,
    2,
  ),
);
console.log(`Saved ${results.length} cases to ${output}; human conversation review remains required.`);
