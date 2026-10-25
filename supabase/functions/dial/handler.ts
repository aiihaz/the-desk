// Internal: chat-agent POSTs {"request_id", "kind", "variables", ...} to start a call.
// reserve_call() runs every check in eng plan 5.1 and inserts the call row; only then
// is Sarvam called. This is the only code path that starts a call (5.4).
import type { CallStore } from "../_shared/call_store.ts";
import { type CallKind, type Language, LANGUAGES, type StartCall } from "../_shared/sarvam.ts";

export type DialRequest = {
  request_id: string;
  kind: CallKind;
  option_id?: string | null;
  is_retry?: boolean;
  // Eng plan 3.4 inputs, built by code from the request's stored fields.
  variables: Record<string, unknown>;
  language?: Language;
};

export type Deps = {
  store: CallStore;
  start: (call: StartCall) => Promise<string>;
};

const KINDS = ["first", "booking", "question", "reschedule"];

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: DialRequest;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body?.request_id || !KINDS.includes(body.kind) || typeof body.variables !== "object") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.language && !LANGUAGES.includes(body.language)) {
    return Response.json({ error: "bad_language" }, { status: 400 });
  }

  const r = await deps.store.reserveCall(
    body.request_id,
    body.kind,
    body.option_id ?? null,
    body.is_retry ?? false,
  );
  if (!r.ok) return Response.json({ error: "refused", reason: r.reason }, { status: 409 });

  try {
    const target = await deps.store.dialTarget(r.call_id);
    const attemptId = await deps.start({
      callId: r.call_id,
      kind: body.kind,
      agentVersion: r.agent_version,
      callerNumber: target.callerNumber,
      businessPhone: target.businessPhone,
      variables: { ...body.variables, must_reask: r.must_reask },
      language: body.language,
    });
    await deps.store.markDialing(r.call_id, attemptId);
    return Response.json({ call_id: r.call_id, attempt_id: attemptId, flags: r.flags });
  } catch (e) {
    // The row stays, marked failed, so the attempt counts against the limits.
    await deps.store.markFailed(r.call_id, String(e)).catch((e2) => console.error("markFailed", e2));
    return Response.json({ error: "dial_failed", call_id: r.call_id, detail: String(e) }, { status: 502 });
  }
}
