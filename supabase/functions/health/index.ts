// Daily from GitHub Actions (.github/workflows/daily.yml): keeps the free project awake,
// sends any alerts still new, and answers with the numbers the job checks. The job fails,
// and GitHub emails Ihaz, when an alert couldn't reach WhatsApp, a call is stuck, or the
// follow-through job has stopped running. It also says which version is running here:
// the schema's newest migration and DESK_GIT_SHA (set at deploy, README).
// verify_jwt is on, so only callers holding the service role key get here.
import { pushAlerts } from "../_shared/alerts.ts";
import { DbAdminStore } from "../_shared/chat/admin.ts";
import { createDelivery } from "../_shared/messaging.ts";
import { DbStore, serviceClient } from "../_shared/store.ts";

// reconcile runs every 5 minutes; this is several missed runs.
const JOB_STALE_MS = 30 * 60_000;

const db = serviceClient();
const admin = new DbAdminStore();
const waStore = new DbStore();
const adminWaIds = (Deno.env.get("DESK_ADMIN_WA_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

Deno.serve(async () => {
  const alerts = await pushAlerts({
    store: admin,
    admins: () => admin.users(adminWaIds),
    send: createDelivery(waStore),
  });
  const s = await admin.status();
  const { data: job } = await db.from("job_runs").select("last_ok_at").eq("name", "reconcile").maybeSingle();
  const { data: schema } = await db.rpc("schema_version");
  const { count: owed } = await db.from("deliveries").select("id", { count: "exact", head: true })
    .eq("status", "pending").lt("next_attempt_at", new Date(Date.now() - JOB_STALE_MS).toISOString());
  const jobOk = !!job && Date.now() - Date.parse(job.last_ok_at) < JOB_STALE_MS;
  return Response.json({
    ok: alerts.undelivered === 0 && jobOk && !owed,
    version: { git_sha: Deno.env.get("DESK_GIT_SHA") ?? null, schema },
    reconcile_last_ok: job?.last_ok_at ?? null,
    overdue_deliveries: owed ?? 0,
    undelivered_alerts: alerts.undelivered,
    open_alerts: s.open_alerts,
    kill_switch: s.kill_switch,
    credit_rs: Number(s.credit_rs),
    calls_today: s.calls_today,
  });
});
