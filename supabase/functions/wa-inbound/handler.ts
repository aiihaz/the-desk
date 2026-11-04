// Meta webhook: verify, store (deduped), hand off, return 200 fast (eng plan 3.1).
import type { Store, User } from "../_shared/store.ts";
import { type Inbound, parseWebhook, sha256Hex, verifySignature } from "../_shared/whatsapp.ts";

export type Deps = {
  store: Store;
  appSecret: string;
  verifyToken: string;
  // Runs after the response is sent (EdgeRuntime.waitUntil in production).
  background: (p: Promise<unknown>) => void;
  handOff: (user: User, msg: Inbound) => Promise<void>;
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "GET") return verifySubscription(new URL(req.url), deps.verifyToken);
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256"), deps.appSecret))) {
    return new Response("bad signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Event deduplication is for storage, never proof of completed ingestion.
  // Message IDs dedupe writes; a partial failure must resume on redelivery.
  await deps.store.saveEvent(await sha256Hex(raw), payload);

  await ingestPayload(payload, deps);
  await deps.store.completeEvent?.(await sha256Hex(raw));
  return new Response("ok");
}

// Only callers that have verified the signature, or internal recovery of an already
// verified stored event, enter here. Message IDs and inbox state make replay safe.
export async function ingestPayload(
  payload: unknown,
  deps: Pick<Deps, "store" | "background" | "handOff">,
): Promise<void> {
  for (const msg of parseWebhook(payload).messages) {
    const user = await deps.store.upsertUser(msg.waId, msg.name);
    const isNew = await deps.store.saveInbound(user.id, msg);
    if ((isNew || await deps.store.inboundPending?.(msg.messageId)) && !user.blocked) {
      deps.background(
        deps.handOff(user, msg).catch((e) => console.error("handoff failed", msg.messageId, e)),
      );
    }
  }
}

// Meta's one-time webhook check: GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
function verifySubscription(url: URL, verifyToken: string): Response {
  const p = url.searchParams;
  if (p.get("hub.mode") === "subscribe" && verifyToken && p.get("hub.verify_token") === verifyToken) {
    return new Response(p.get("hub.challenge") ?? "");
  }
  return new Response("forbidden", { status: 403 });
}
