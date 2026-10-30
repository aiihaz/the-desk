// Daily from GitHub Actions (.github/workflows/daily.yml): keeps the free project awake,
// sends any alerts still new, and answers with the numbers the job checks. The job fails,
// and GitHub emails Ihaz, when an alert couldn't reach WhatsApp or a call is stuck.
// verify_jwt is on, so only callers holding the service role key get here.
import { pushAlerts } from "../_shared/alerts.ts";
import { DbAdminStore } from "../_shared/chat/admin.ts";
import { deliver } from "../_shared/deliver.ts";
import { DbStore } from "../_shared/store.ts";
import { send as waSend, waConfigFromEnv } from "../_shared/whatsapp.ts";

const admin = new DbAdminStore();
const waStore = new DbStore();
const wa = waConfigFromEnv();
const adminWaIds = (Deno.env.get("DESK_ADMIN_WA_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

Deno.serve(async () => {
  const alerts = await pushAlerts({
    store: admin,
    admins: () => admin.users(adminWaIds),
    send: (user, msg) => deliver(waStore, (to, m) => waSend(wa, to, m), user, msg),
  });
  const s = await admin.status();
  return Response.json({
    ok: alerts.undelivered === 0,
    undelivered_alerts: alerts.undelivered,
    open_alerts: s.open_alerts,
    kill_switch: s.kill_switch,
    credit_rs: Number(s.credit_rs),
    calls_today: s.calls_today,
  });
});
