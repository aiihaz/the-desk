import type { Store, User } from "./store.ts";
import { needsTemplate, type Outbound } from "./whatsapp.ts";

export class OutsideServiceWindow extends Error {
  constructor() {
    super("last user message is over 24 hours old; send a template");
  }
}

export type Sender = (to: string, msg: Outbound) => Promise<string>;

// One path for outgoing messages: channel-specific window check, send, log.
// Linq has no Meta service-window restriction; createDelivery selects the policy.
export async function deliver(
  store: Store,
  sender: Sender,
  user: User,
  msg: Outbound,
  now = new Date(),
  serviceWindow = true,
): Promise<string> {
  if (msg.kind === "template") throw new Error("paid template messages are disabled");
  if (serviceWindow && needsTemplate(await store.lastInboundAt(user.id), now)) {
    throw new OutsideServiceWindow();
  }
  const id = await sender(user.waId, msg);
  await store.saveOutbound(user.id, id, msg);
  return id;
}
