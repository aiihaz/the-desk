// Internal: POST {"request_id", "kind", "option_id"?, "is_retry"?, "language"?} to start a call.
// _shared/dial.ts does the work: reserve_call() first, then Sarvam, with variables built
// from the request's stored, consented fields. A body that carries its own variables is
// refused, so no caller can tell the voice agent anything the user didn't approve.
import type { CallStore } from "../_shared/call_store.ts";
import { dial } from "../_shared/dial.ts";
import { type CallKind, type Language, LANGUAGES, type StartCall } from "../_shared/sarvam.ts";

export type DialRequest = {
  request_id: string;
  kind: CallKind;
  option_id?: string | null;
  is_retry?: boolean;
  language?: Language;
};

export type Deps = {
  store: CallStore;
  start: (call: StartCall) => Promise<string>;
};

const KINDS = ["first", "booking", "question", "reschedule", "payment_confirm", "cancel"];

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: DialRequest & { variables?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body?.request_id || !KINDS.includes(body.kind)) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.variables !== undefined) {
    return Response.json({ error: "variables_not_accepted" }, { status: 400 });
  }
  if (body.language && !LANGUAGES.includes(body.language)) {
    return Response.json({ error: "bad_language" }, { status: 400 });
  }

  const res = await dial(deps, {
    requestId: body.request_id,
    kind: body.kind,
    optionId: body.option_id ?? null,
    isRetry: body.is_retry ?? false,
    language: body.language,
  });
  if (res.ok) return Response.json({ call_id: res.call_id, attempt_id: res.attempt_id, flags: res.flags });
  if (res.error === "refused") {
    return Response.json({ error: "refused", reason: res.reason }, { status: 409 });
  }
  return Response.json({ error: "dial_failed", call_id: res.call_id, detail: res.detail }, { status: 502 });
}
