import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.8";
import { type CallInputs, callVariables } from "./call_vars.ts";
import {
  buildOutbound,
  CALLER_INPUTS,
  CallRejected,
  parseWebhook,
  type SarvamConfig,
  startCall,
  TEST_CALL_RECIPIENT,
  verifyWebhookToken,
} from "./sarvam.ts";

const fixture = (name: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(`../../../fixtures/sarvam/${name}.json`, import.meta.url)));

const cfg: SarvamConfig = {
  callsPaused: false,
  apiKey: "key",
  orgId: "org",
  workspaceId: "ws",
  appId: "desk-caller",
  connectionId: "conn",
  webhookUrl: "https://example.supabase.co/functions/v1/sarvam-webhook",
  webhookToken: "t0ken",
  baseUrl: "https://apps.sarvam.ai/api",
};

const call = {
  callId: "c-1",
  kind: "first" as const,
  agentVersion: "3",
  callerNumber: "+918041234567",
  businessPhone: "+919876543210",
  // The declared inputs, plus internal values callVariables also returns.
  variables: {
    business_name: "Paragon",
    current_day: "Friday",
    current_date: "23 October 2026",
    current_time: "7:00 pm",
    task_context: "Calling to book.",
    user_name: "Ihaz",
    user_phone: "+919812345678",
    party_size: 4,
    decided: "table for 4",
    call_kind: "booking",
  } as Record<string, unknown>,
};
const declared = (v: Record<string, unknown>) => Object.fromEntries(CALLER_INPUTS.map((k) => [k, v[k]]));

Deno.test("buildOutbound: version, numbers, variables, webhook", () => {
  const p = buildOutbound(cfg, { ...call, language: "Hindi" });
  assertEquals(p.app_config.app_id, "desk-caller");
  assertEquals(p.app_config.app_version, 3);
  assertEquals(p.app_config.connection_config, {
    connection_id: "conn",
    agent_phone_number: "+918041234567",
  });
  assertEquals(p.app_config.app_overrides, { initial_language_name: "Hindi" });
  assertEquals(p.user_config, { user_phone_number: TEST_CALL_RECIPIENT });
  assertEquals(p.webhook_config.metadata, { call_id: "c-1" });
  assertEquals(new URL(p.webhook_config.url).searchParams.get("token"), "t0ken");
});

Deno.test("buildOutbound: only the caller's declared inputs go, and call_kind comes from the call", () => {
  // Sarvam refuses any variable the app doesn't declare (422, 8 Nov 2026).
  assertEquals(buildOutbound(cfg, call).app_config.agent_variables, {
    ...declared(call.variables),
    call_kind: "first",
  });
});

Deno.test("buildOutbound: a missing declared input is caught here, before Sarvam", () => {
  const { task_context: _, ...rest } = call.variables;
  assertThrows(
    () => buildOutbound(cfg, { ...call, variables: rest }),
    Error,
    "caller inputs missing: task_context",
  );
});

Deno.test("the caller's instructions read only declared inputs", () => {
  const text = Deno.readTextFileSync(new URL("../../../agent/instructions.md", import.meta.url));
  const used = [...new Set([...text.matchAll(/{{(\w+)}}/g)].map((m) => m[1]))].sort();
  assertEquals(used, [...CALLER_INPUTS].sort());
});

Deno.test("every call kind's variables build a request Sarvam's caller declares", () => {
  const base: CallInputs = {
    task: "booking",
    fields: {
      party_size: 2,
      customer_name: "Ihaz",
      exact_time: "2026-10-23T20:00:00+05:30",
      tolerance_min: 30,
      may_book: true,
    },
    businessName: "Paragon",
    customerPhone: "+919812345678",
    option: null,
    prev: null,
    booking: null,
    payment: null,
    approvedLossRs: 0,
  };
  const booking = {
    time: "2026-10-23T20:15:00+05:30",
    reference: null,
    customerName: "Ihaz",
    depositRs: 500,
    knownFeeRs: null,
  };
  const inputs: [Parameters<typeof callVariables>[0], CallInputs][] = [
    ["first", base],
    ["question", { ...base, task: "question", fields: { questions: ["Is there parking?"] } }],
    ["booking", {
      ...base,
      option: { label: "9:30 pm", value: { time: "2026-10-23T21:30:00+05:30" } },
      prev: { at: "2026-10-23T12:00:00+05:30", contactName: null, summary: null },
    }],
    ["reschedule", { ...base, task: "reschedule", booking }],
    ["cancel", { ...base, task: "cancel", booking }],
    ["payment_confirm", {
      ...base,
      booking,
      payment: { amountRs: 500, ref: "344321", paidAt: null, payee: "p@ok" },
    }],
  ];
  for (const [kind, x] of inputs) {
    const variables = callVariables(kind, x, false, new Date("2026-10-23T12:00:00+05:30"));
    const sent = buildOutbound(cfg, { ...call, kind, variables }).app_config.agent_variables;
    assertEquals(Object.keys(sent).sort(), [...CALLER_INPUTS, "call_kind"].sort(), kind);
  }
  // What the caller is told still carries the meaning: their time with room either way.
  const first = callVariables("first", base, false, new Date("2026-10-23T12:00:00+05:30"));
  assert(String(first.task_context).includes("Up to 30 minutes either way of the time."));
});

Deno.test("every call kind ignores the Maps destination and any supplied destination override", () => {
  for (const kind of ["first", "booking", "question", "reschedule", "payment_confirm", "cancel"] as const) {
    const p = buildOutbound(cfg, {
      ...call,
      kind,
      businessPhone: "+14155551234",
      variables: { ...call.variables, user_phone_number: "+14155559999", business_phone: "+14155550000" },
    });
    assertEquals(p.user_config.user_phone_number, "+918848878757");
  }
});

Deno.test("buildOutbound: no language override unless asked", () => {
  assertEquals(buildOutbound(cfg, call).app_config.app_overrides, undefined);
});

Deno.test("buildOutbound: rejects bad version, numbers and a missing token", () => {
  assertThrows(() => buildOutbound(cfg, { ...call, agentVersion: "null" }));
  assertThrows(() => buildOutbound(cfg, { ...call, agentVersion: "1.5" }));
  assertThrows(() => buildOutbound(cfg, { ...call, businessPhone: "09876543210" }));
  assertThrows(() => buildOutbound(cfg, { ...call, callerNumber: "+91 80 4123" }));
  assertThrows(() => buildOutbound({ ...cfg, webhookToken: "" }, call));
});

Deno.test("startCall: posts to Instant Outbound with the API key", async () => {
  const real = globalThis.fetch;
  let seen: Request | undefined;
  globalThis.fetch = async (input, init) => {
    seen = new Request(input, init);
    return Response.json({ attempt_id: "a-1" });
  };
  try {
    assertEquals(await startCall(cfg, call), "a-1");
    assertEquals(seen!.url, "https://apps.sarvam.ai/api/outbounds/v1/orgs/org/workspaces/ws/outbounds");
    assertEquals(seen!.headers.get("x-api-key"), "key");
    assertEquals((await seen!.json()).user_config.user_phone_number, "+918848878757");
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("paused calling makes no HTTP request, including for retries and follow-ups", async () => {
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("must not reach network");
  };
  try {
    for (const kind of ["first", "booking", "question", "reschedule", "payment_confirm", "cancel"] as const) {
      await assertRejects(
        () => startCall({ ...cfg, callsPaused: true }, { ...call, kind }),
        Error,
        "calling is paused",
      );
    }
    assertEquals(requests, 0);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("startCall: a 422 is a definite rejection", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: [{ msg: "bad app_id" }] }, { status: 422 });
  try {
    // Sarvam's own words come with it, so the rejected field can be found.
    const e = await assertRejects(() => startCall(cfg, call), CallRejected);
    assertEquals(e.message, 'sarvam outbound response 422: {"detail":[{"msg":"bad app_id"}]}');
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("verifyWebhookToken", () => {
  assert(verifyWebhookToken(new URL("https://x/?token=t0ken"), "t0ken"));
  assert(!verifyWebhookToken(new URL("https://x/?token=t0kem"), "t0ken"));
  assert(!verifyWebhookToken(new URL("https://x/"), "t0ken"));
  assert(!verifyWebhookToken(new URL("https://x/?token="), ""));
});

Deno.test("parseWebhook: connected call carries outputs and transcript", () => {
  const r = parseWebhook(fixture("connected"))!;
  assertEquals(r.status, "completed");
  assertEquals(r.callId, "11111111-1111-4111-8111-111111111111");
  assertEquals(r.durationS, 118);
  assertEquals(r.outputs?.no_match_reason, "several_options");
  assertEquals(r.transcript?.length, 3);
});

Deno.test("parseWebhook: no answer and provider failure", () => {
  const n = parseWebhook(fixture("no_answer"))!;
  assertEquals([n.status, n.durationS, n.outputs], ["no_answer", null, null]);
  const f = parseWebhook(fixture("failed"))!;
  assertEquals([f.status, f.callId], ["failed", null]);
  assertEquals(f.failureReason, "exotel: Phone number is registered under TRAI NDNC");
});

Deno.test("parseWebhook: rejects other payloads", () => {
  assertEquals(parseWebhook({}), null);
  assertEquals(parseWebhook({ attempt_id: "a", status: "ringing" }), null);
  assertEquals(parseWebhook(null), null);
});
