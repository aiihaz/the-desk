// Alerts go to the admins on WhatsApp (eng plan 8): reconcile pushes new ones every 15
// minutes, health once a day. An alert is marked notified once any admin got it. When
// none can be reached (no user row yet, or outside the 24-hour window), they stay new,
// and health reports them as undelivered so the GitHub job fails: the backup channel.
import { type AdminStore, alertLine, type AlertRow } from "./chat/admin.ts";
import type { User } from "./store.ts";
import type { Outbound } from "./whatsapp.ts";

export type AlertDeps = {
  store: Pick<AdminStore, "newAlerts" | "markNotified">;
  // The admins' user rows (wa_ids from DESK_ADMIN_WA_IDS that have messaged the Desk).
  admins: () => Promise<User[]>;
  send: (user: User, msg: Outbound) => Promise<string>;
};

export async function pushAlerts(deps: AlertDeps): Promise<{ sent: number; undelivered: number }> {
  const rows: AlertRow[] = await deps.store.newAlerts();
  if (!rows.length) return { sent: 0, undelivered: 0 };
  const body = `Desk alert${rows.length > 1 ? "s" : ""} (review to see all, resolve <id> when handled):\n` +
    rows.map(alertLine).join("\n");
  let delivered = false;
  for (const admin of await deps.admins()) {
    try {
      await deps.send(admin, { kind: "text", body: body.slice(0, 4000) });
      delivered = true;
    } catch (e) {
      console.warn("alert not delivered to", admin.waId, String((e as Error)?.message ?? e));
    }
  }
  if (!delivered) return { sent: 0, undelivered: rows.length };
  await deps.store.markNotified(rows.map((r) => r.id));
  return { sent: rows.length, undelivered: 0 };
}
