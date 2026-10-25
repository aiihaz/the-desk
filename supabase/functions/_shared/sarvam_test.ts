import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.8";
import { buildOutbound, parseWebhook, type SarvamConfig, startCall, verifyWebhookToken } from "./sarvam.ts";

const fixture = (name: string) =>
  JSON.parse(Deno.readTextFileSync(new URL(`../../../fixtures/sarvam/${name}.json`, import.meta.url)));

const cfg: SarvamConfig = {
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
  variables: { party_size: 4, call_kind: "booking" },
};

Deno.test("buildOutbound: version, numbers, variables, webhook", () => {
  const p = buildOutbound(cfg, { ...call, language: "Hindi" });
  assertEquals(p.app_config.app_id, "desk-caller");
  assertEquals(p.app_config.app_version, 3);
  assertEquals(p.app_config.connection_config, {
    connection_id: "conn",
    agent_phone_number: "+918041234567",
  });
  assertEquals(p.app_config.app_overrides, { initial_language_name: "Hindi" });
  assertEquals(p.user_config, { user_phone_number: "+919876543210" });
  assertEquals(p.webhook_config.metadata, { call_id: "c-1" });
  assertEquals(new URL(p.webhook_config.url).searchParams.get("token"), "t0ken");
});

Deno.test("buildOutbound: stored fields cannot override call_kind", () => {
  assertEquals(buildOutbound(cfg, call).app_config.agent_variables, { party_size: 4, call_kind: "first" });
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
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("startCall: a 422 throws with Sarvam's detail", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: [{ msg: "bad app_id" }] }, { status: 422 });
  try {
    await assertRejects(() => startCall(cfg, call), Error, "bad app_id");
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
