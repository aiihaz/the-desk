import { parseLinqWebhook, verifyLinqSignature } from "../_shared/linq.ts";
import type { Store, User } from "../_shared/store.ts";
import type { Inbound } from "../_shared/whatsapp.ts";

export type Deps = {
  store: Store;
  secret: string;
  background: (p: Promise<unknown>) => void;
  handOff: (user: User, msg: Inbound) => Promise<void>;
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await req.text();
  if (!await verifyLinqSignature(body, req.headers, deps.secret)) {
    return new Response("bad signature", { status: 401 });
  }
  let payload: unknown;
  let msg: Inbound | null;
  try {
    payload = JSON.parse(body);
    msg = parseLinqWebhook(payload);
  } catch {
    return new Response("invalid payload", { status: 400 });
  }
  if (!msg) return new Response("ok");
  // Do not drop a retry just because the event was saved before message persistence failed.
  // Message IDs are the processing dedupe key; saveInbound must succeed before acknowledgment.
  try {
    await deps.store.saveEvent(req.headers.get("webhook-id")!, payload);
    const user = await deps.store.upsertUser(msg.waId, msg.name);
    if (await deps.store.saveInbound(user.id, msg) && !user.blocked) {
      deps.background(
        deps.handOff(user, msg).catch((e) => console.error("linq handoff failed", msg!.messageId, e)),
      );
    }
  } catch {
    return new Response("storage unavailable", { status: 503 });
  }
  return new Response("ok");
}
