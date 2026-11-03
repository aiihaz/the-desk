// One transport selection for replies, reports, reconciliation and admin alerts.
import { deliver } from "./deliver.ts";
import { linqConfigFromEnv, send as linqSend } from "./linq.ts";
import type { Store, User } from "./store.ts";
import { type Outbound, send as waSend, waConfigFromEnv } from "./whatsapp.ts";

export function createDelivery(store: Store) {
  const channel = Deno.env.get("DESK_CHANNEL") ?? "whatsapp";
  if (channel !== "whatsapp" && channel !== "linq") throw new Error("invalid DESK_CHANNEL");
  const sender = channel === "linq"
    ? (to: string, msg: Outbound) => linqSend(linqConfigFromEnv(), to, msg)
    : (to: string, msg: Outbound) => waSend(waConfigFromEnv(), to, msg);
  return (user: User, msg: Outbound) => deliver(store, sender, user, msg, new Date(), channel === "whatsapp");
}
