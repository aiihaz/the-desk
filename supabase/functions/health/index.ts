import { authorizeInternal } from "../_shared/internal_auth.ts";
// Daily from GitHub Actions (.github/workflows/daily.yml): keeps the free project awake,
// sends any alerts still new, and answers with the numbers the job checks. The job fails,
// and GitHub emails Ihaz, when an alert couldn't reach WhatsApp, a call is stuck, or the
// follow-through job has stopped running. It also says which version is running here:
// the schema's newest migration and DESK_GIT_SHA (set at deploy, README).
// verify_jwt is on, so only callers holding the service role key get here.
import { pushAlerts } from "../_shared/alerts.ts";
import { DbAdminStore } from "../_shared/chat/admin.ts";
import { deliver } from "../_shared/deliver.ts";
import { DbStore, serviceClient } from "../_shared/store.ts";
import { send as waSend, waConfigFromEnv } from "../_shared/whatsapp.ts";

// reconcile runs every 5 minutes; this is several missed runs.
const JOB_STALE_MS = 30 * 60_000;

const db = serviceClient();
const admin = new DbAdminStore();
const waStore = new DbStore();
const wa = waConfigFromEnv();
const adminWaIds = (Deno.env.get("DESK_ADMIN_WA_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

Deno.serve(async (req) => {
  const denied = authorizeInternal(req, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  if (denied) return denied;
  const alerts = await pushAlerts({
    store: admin,
    admins: () => admin.users(adminWaIds),
    send: (user, msg) => deliver(waStore, (to, m) => waSend(wa, to, m), user, msg),
  });
  const s = await admin.status();
  const { data: job, error: jobError } = await db.from("job_runs").select("last_ok_at").eq(
    "name",
    "reconcile",
  ).maybeSingle();
  const { data: schema, error: schemaError } = await db.rpc("schema_version");
  const { count: owed, error: owedError } = await db.from("deliveries").select("id", {
    count: "exact",
    head: true,
  })
    .eq("status", "pending").lt("next_attempt_at", new Date(Date.now() - JOB_STALE_MS).toISOString());
  const { data: recovery, error: recoveryError } = await db.rpc("recovery_health");
  if (jobError || schemaError || owedError || recoveryError) {
    return Response.json({ ok: false, error: "health checks unavailable" }, { status: 503 });
  }
  const stuckInbox = recovery.oldest_unhandled_at &&
    Date.now() - Date.parse(recovery.oldest_unhandled_at) > 15 * 60_000;
  const stuckEvent = recovery.oldest_uningested_at &&
    Date.now() - Date.parse(recovery.oldest_uningested_at) > 15 * 60_000;
  const windowJobOk = recovery.follow_through_last_ok &&
    Date.now() - Date.parse(recovery.follow_through_last_ok) < 3 * 60_000;
  const recoveryOk = windowJobOk && !stuckEvent && !recovery.overdue_calls && !stuckInbox &&
    !recovery.unsettled_calls &&
    !recovery.unknown_submissions &&
    !recovery.failed_deliveries && !recovery.pending_erasure;
  const jobOk = !!job && Date.now() - Date.parse(job.last_ok_at) < JOB_STALE_MS;
  return Response.json({
    ok: alerts.undelivered === 0 && jobOk && !owed && recoveryOk,
    recovery,
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
