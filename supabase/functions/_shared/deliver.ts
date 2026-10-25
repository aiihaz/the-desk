import type { Store, User } from "./store.ts";
import { needsTemplate, type Outbound } from "./whatsapp.ts";

export class OutsideServiceWindow extends Error {
  constructor() {
    super("last user message is over 24 hours old; send a template");
  }
}

export type Sender = (to: string, msg: Outbound) => Promise<string>;

// The one path for every outgoing WhatsApp message: window check, send, log.
export async function deliver(
  store: Store,
  sender: Sender,
  user: User,
  msg: Outbound,
  now = new Date(),
): Promise<string> {
  if (msg.kind !== "template" && needsTemplate(await store.lastInboundAt(user.id), now)) {
    throw new OutsideServiceWindow();
  }
  const id = await sender(user.waId, msg);
  await store.saveOutbound(user.id, id, msg);
  return id;
}
