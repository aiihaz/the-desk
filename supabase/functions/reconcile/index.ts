// pg_cron, every 15 minutes (0009_jobs.sql): calls with no result are looked up in
// Sarvam Analytics (_shared/reconcile.ts), due confirm-call redials are placed, then new
// alerts go to the admins.
// verify_jwt is on, so only callers holding the service role key get here.
import { DbAdminStore } from "../_shared/chat/admin.ts";
import { pushAlerts } from "../_shared/alerts.ts";
import { DbCallStore } from "../_shared/call_store.ts";
import { reportCall, type ReportDeps } from "../_shared/chat/report.ts";
import { DbChatStore } from "../_shared/chat/store.ts";
import { claimChecker, verifier } from "../_shared/chat/verify.ts";
import { deliver } from "../_shared/deliver.ts";
import { responsesClient } from "../_shared/openai.ts";
import { reconcile } from "../_shared/reconcile.ts";
import { dial } from "../_shared/dial.ts";
import { getTranscript, listAttempts, sarvamConfigFromEnv, startCall } from "../_shared/sarvam.ts";
import { DbStore, serviceClient } from "../_shared/store.ts";
import { send as waSend, waConfigFromEnv } from "../_shared/whatsapp.ts";

const db = serviceClient();
const calls = new DbCallStore(db);
const chat = new DbChatStore();
const admin = new DbAdminStore();
const waStore = new DbStore();
const wa = waConfigFromEnv();
const cfg = sarvamConfigFromEnv();
const adminWaIds = (Deno.env.get("DESK_ADMIN_WA_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const openai = responsesClient(Deno.env.get("OPENAI_API_KEY") ?? "");
const send: ReportDeps["send"] = (user, msg) => deliver(waStore, (to, m) => waSend(wa, to, m), user, msg);
const report: ReportDeps = {
  store: chat,
  send,
  verify: verifier(chat, openai),
  checkClaim: claimChecker(chat, openai),
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const summary = await reconcile({
    openCalls: (before) => calls.openCalls(before),
    // Global values: these limits are about the Desk, not a user.
    limitInt: async (key) => {
      const { data, error } = await db.rpc("limit_int", { p_key: key });
      if (error) throw error;
      return data;
    },
    listAttempts: (from, to) => listAttempts(cfg, from, to),
    transcript: (id) => getTranscript(cfg, id),
    finish: async (result, raw) => {
      await calls.saveEvent(result.attemptId, raw);
      const callId = await calls.finishCall(result);
      if (callId) await reportCall(report, callId, result);
    },
    timeoutCall: (callId) => calls.timeoutCall(callId),
    reportLost: (callId) =>
      reportCall(report, callId, {
        attemptId: "",
        callId,
        status: "failed",
        durationS: null,
        interactionId: null,
        failureReason: "no_result",
        outputs: null,
        transcript: null,
        agentNumber: null,
      }),
    now: () => new Date(),
  });
  // Confirm calls whose one redial is due ("we'll check later", eng plan 2.2 step 4).
  const { data: due, error } = await db.rpc("take_due_calls");
  if (error) throw error;
  const redials = [];
  for (const requestId of (due ?? []) as string[]) {
    const res = await dial(
      { store: calls, start: (c) => startCall(cfg, c) },
      { requestId, kind: "payment_confirm", optionId: null, isRetry: true },
    );
    redials.push({ requestId, ok: res.ok });
    if (!res.ok) {
      await chat.callNotStarted(requestId);
      await db.rpc("raise_alert", {
        p_kind: "redial_failed",
        p_request_id: requestId,
        p_call_id: null,
        p_detail: res.error === "refused" ? { reason: res.reason } : { detail: res.detail },
      });
    }
  }
  const alerts = await pushAlerts({ store: admin, admins: () => admin.users(adminWaIds), send });
  return Response.json({ ...summary, redials, alerts });
});
