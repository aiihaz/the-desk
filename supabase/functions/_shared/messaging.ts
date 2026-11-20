// One transport selection for replies, reports, reconciliation and admin alerts.
import { deliver } from "./deliver.ts";
import { linqConfigFromEnv } from "./linq.ts";
import { linqSender } from "./linq_contact_card.ts";
import type { MessagingChannel, Store, User } from "./store.ts";
import type { Sender } from "./deliver.ts";
import { type Outbound, send as waSend, waConfigFromEnv } from "./whatsapp.ts";

export const benchSender: Sender = () => Promise.resolve(`bench:${crypto.randomUUID()}`);

export function createDelivery(store: Store, senders?: Record<MessagingChannel, Sender>) {
  return async (user: User, msg: Outbound) => {
    // The persisted user wins over a caller's cached/stale channel. Call reports,
    // retries and alerts are delivered to the conversation that created the errand.
    const target = store.deliveryTarget ? await store.deliveryTarget(user.id) : user;
    if (target.blocked) throw new Error("recipient is blocked");
    const channel = target.channel ?? "whatsapp";
    // The bench user (0036): the message is written and stored like any other, and goes nowhere.
    if (channel === "bench") return deliver(store, benchSender, target, msg, new Date(), false);
    const sender = senders?.[channel] ??
      (channel === "linq"
        ? linqSender(store, target.id, linqConfigFromEnv())
        : (to: string, m: Outbound) => waSend(waConfigFromEnv(), to, m));
    return deliver(store, sender, target, msg, new Date(), channel === "whatsapp");
  };
}
