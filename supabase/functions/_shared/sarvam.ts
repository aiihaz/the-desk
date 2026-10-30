// Sarvam Voice Agents: Instant Outbound calls and the result webhook (eng plan 3.1, 3.4).
// Pure functions except startCall(); the edge functions wire them to the database.
// API: https://docs.sarvam.ai/voice-agents/api/instant-outbound/create

export type CallKind = "first" | "booking" | "question" | "reschedule" | "payment_confirm" | "cancel";

// Values Sarvam accepts for app_overrides.initial_language_name.
export const LANGUAGES = [
  "Assamese",
  "Bengali",
  "English",
  "Gujarati",
  "Hindi",
  "Kannada",
  "Malayalam",
  "Marathi",
  "Odia",
  "Punjabi",
  "Sanskrit",
  "Tamil",
  "Telugu",
] as const;
export type Language = typeof LANGUAGES[number];

export type SarvamConfig = {
  apiKey: string;
  orgId: string;
  workspaceId: string;
  appId: string;
  // Telephony connection the caller numbers belong to (dashboard → Connections).
  connectionId: string;
  // Public URL of the sarvam-webhook function, without the token.
  webhookUrl: string;
  webhookToken: string;
  baseUrl: string;
};

export function sarvamConfigFromEnv(): SarvamConfig {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  return {
    apiKey: Deno.env.get("SARVAM_API_KEY") ?? "",
    orgId: Deno.env.get("SARVAM_ORG_ID") ?? "",
    workspaceId: Deno.env.get("SARVAM_WORKSPACE_ID") ?? "",
    appId: Deno.env.get("SARVAM_APP_ID") ?? "",
    connectionId: Deno.env.get("SARVAM_CONNECTION_ID") ?? "",
    webhookUrl: Deno.env.get("SARVAM_WEBHOOK_URL") ?? `${supabaseUrl}/functions/v1/sarvam-webhook`,
    webhookToken: Deno.env.get("SARVAM_WEBHOOK_TOKEN") ?? "",
    baseUrl: Deno.env.get("SARVAM_BASE_URL") ?? "https://apps.sarvam.ai/api",
  };
}

export type StartCall = {
  callId: string;
  kind: CallKind;
  // calls.agent_version: the committed Sarvam version number, as text.
  agentVersion: string;
  callerNumber: string;
  businessPhone: string;
  // Eng plan 3.4 inputs for this call kind, built by code from stored fields.
  variables: Record<string, unknown>;
  language?: Language;
};

// deno-lint-ignore no-explicit-any
type Json = any;

export function buildOutbound(cfg: SarvamConfig, call: StartCall): Json {
  const version = Number(call.agentVersion);
  check(
    Number.isInteger(version) && version > 0,
    `agent version must be a positive integer: ${call.agentVersion}`,
  );
  check(E164.test(call.callerNumber), `caller number not E.164: ${call.callerNumber}`);
  check(E164.test(call.businessPhone), `business phone not E.164: ${call.businessPhone}`);
  check(!!cfg.webhookToken, "SARVAM_WEBHOOK_TOKEN is not set");
  const url = new URL(cfg.webhookUrl);
  url.searchParams.set("token", cfg.webhookToken);
  return {
    app_config: {
      app_id: cfg.appId,
      app_version: version,
      connection_config: { connection_id: cfg.connectionId, agent_phone_number: call.callerNumber },
      // call_kind last, so stored fields can never override it.
      agent_variables: { ...call.variables, call_kind: call.kind },
      ...(call.language ? { app_overrides: { initial_language_name: call.language } } : {}),
    },
    user_config: { user_phone_number: call.businessPhone },
    // Echoed back in the webhook; the call id is how results find their row.
    webhook_config: { url: url.toString(), metadata: { call_id: call.callId } },
  };
}

// Returns Sarvam's attempt_id (stored as calls.provider_call_id).
export async function startCall(cfg: SarvamConfig, call: StartCall): Promise<string> {
  const res = await fetch(
    `${cfg.baseUrl}/outbounds/v1/orgs/${cfg.orgId}/workspaces/${cfg.workspaceId}/outbounds`,
    {
      method: "POST",
      headers: { "X-API-Key": cfg.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(buildOutbound(cfg, call)),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.attempt_id) {
    throw new Error(`sarvam outbound failed ${res.status}: ${JSON.stringify(body?.detail ?? body)}`);
  }
  return body.attempt_id;
}

// Sarvam sends no signature, so the webhook URL carries a shared token.
export function verifyWebhookToken(url: URL, expected: string): boolean {
  const given = url.searchParams.get("token");
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// calls.status values the webhook can set.
export type FinalStatus = "completed" | "no_answer" | "busy" | "failed";

export type CallResult = {
  attemptId: string;
  // Our calls.id from webhook_config.metadata; null for calls the Desk did not start.
  callId: string | null;
  status: FinalStatus;
  durationS: number | null;
  interactionId: string | null;
  failureReason: string | null;
  // final_agent_variables: the eng plan 3.4 outputs.
  outputs: Record<string, unknown> | null;
  transcript: { role: string; en_text: string }[] | null;
  agentNumber: string | null;
};

const STATUS: Record<string, FinalStatus> = {
  connected: "completed",
  no_answer: "no_answer",
  busy: "busy",
  failed: "failed",
};

// null if the payload is not an Instant Outbound result.
export function parseWebhook(payload: Json): CallResult | null {
  if (typeof payload?.attempt_id !== "string" || !payload.attempt_id) return null;
  const status = STATUS[payload.status];
  if (!status) return null;
  const callId = payload.webhook_config?.metadata?.call_id;
  return {
    attemptId: payload.attempt_id,
    callId: typeof callId === "string" ? callId : null,
    status,
    durationS: typeof payload.duration === "number" ? Math.round(payload.duration) : null,
    interactionId: payload.interaction_id ?? null,
    failureReason: payload.failure_reason ?? null,
    outputs: payload.final_agent_variables ?? null,
    transcript: Array.isArray(payload.interaction_transcript) ? payload.interaction_transcript : null,
    agentNumber: payload.channel_info?.agent_phone_number ?? null,
  };
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

function check(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`sarvam: ${message}`);
}

// Analytics (reconcile): what Sarvam knows about attempts whose webhook never came.
// https://docs.sarvam.ai/voice-agents/api/analytics/attempts
export type Attempt = {
  attempt_id: string;
  interaction_id: string | null;
  connectivity_status: string;
  failure_reason: string | null;
  duration_in_seconds: number | null;
  agent_variables: Record<string, unknown> | null;
  bot_contact_identifier: string | null;
};

// Every attempt of the Desk's agent between from and to (both inclusive), all pages.
export async function listAttempts(cfg: SarvamConfig, from: Date, to: Date): Promise<Attempt[]> {
  const out: Attempt[] = [];
  const base = `${cfg.baseUrl}/analytics/v1/${cfg.orgId}/${cfg.workspaceId}/${cfg.appId}/attempts`;
  for (let offset = 0;; offset += 1000) {
    const q = new URLSearchParams({
      start_datetime: from.toISOString(),
      end_datetime: to.toISOString(),
      limit: "1000",
      offset: String(offset),
    });
    const res = await fetch(`${base}?${q}`, { headers: { "X-API-Key": cfg.apiKey } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`sarvam attempts failed ${res.status}: ${JSON.stringify(body?.detail ?? body)}`);
    }
    const items: Attempt[] = Array.isArray(body.items) ? body.items : [];
    out.push(...items);
    if (items.length < 1000 || !body.next_page_uri) return out;
  }
}

// The transcript in the webhook's shape. Analytics says "assistant" where the webhook
// says "agent", and gives the text as spoken (content), not an English rendering.
export async function getTranscript(
  cfg: SarvamConfig,
  interactionId: string,
): Promise<{ role: string; en_text: string }[]> {
  const res = await fetch(
    `${cfg.baseUrl}/analytics/v1/${cfg.orgId}/${cfg.workspaceId}/${cfg.appId}/transcripts/${
      encodeURIComponent(interactionId)
    }`,
    { headers: { "X-API-Key": cfg.apiKey } },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`sarvam transcript failed ${res.status}: ${JSON.stringify(body?.detail ?? body)}`);
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  return msgs.map((m: Json) => ({
    role: m.role === "assistant" ? "agent" : String(m.role ?? ""),
    en_text: String(m.content ?? ""),
  }));
}

// An attempt with a final status, as the webhook would have reported it; null while the
// attempt is still going (or its status is one we don't know).
export function attemptResult(
  a: Attempt,
  callId: string,
  transcript: CallResult["transcript"],
): CallResult | null {
  const status = STATUS[a.connectivity_status];
  if (!status) return null;
  return {
    attemptId: a.attempt_id,
    callId,
    status,
    durationS: typeof a.duration_in_seconds === "number" ? Math.round(a.duration_in_seconds) : null,
    interactionId: a.interaction_id ?? null,
    failureReason: a.failure_reason && a.failure_reason !== "NO_FAILURE_REASON" ? a.failure_reason : null,
    outputs: a.agent_variables ?? null,
    transcript,
    agentNumber: a.bot_contact_identifier ?? null,
  };
}
