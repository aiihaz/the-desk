// Local bench boundaries. Configuration presence is not a successful provider check.
import { CallRejected } from "../supabase/functions/_shared/sarvam.ts";

export function assertTestTarget(actual: string, configured?: string) {
  if (!configured || !/^\+[1-9]\d{7,14}$/.test(configured) || actual !== configured) {
    throw new CallRejected("This bench may call only its configured test number.");
  }
}

export function benchReadiness(env: (key: string) => string | undefined) {
  const required = [
    "SARVAM_API_KEY",
    "SARVAM_ORG_ID",
    "SARVAM_WORKSPACE_ID",
    "SARVAM_APP_ID",
    "SARVAM_CONNECTION_ID",
    "SARVAM_WEBHOOK_TOKEN",
    "SARVAM_WEBHOOK_URL",
    "DEV_TEST_PHONE",
  ];
  const missing = required.filter((k) => !env(k));
  const agentReady = !!(env("DESK_OPENAI_API_KEY") || env("OPENAI_API_KEY"));
  let publicWebhook = false;
  try {
    const u = new URL(env("SARVAM_WEBHOOK_URL") ?? "");
    publicWebhook = u.protocol === "https:" && !/^(localhost|127\.|\[::1\])/.test(u.hostname);
  } catch { /* Missing or invalid URL. */ }
  const phone = env("DEV_TEST_PHONE");
  return {
    agentReady,
    mode: env("DEV_REAL_CALLS") === "1" ? "live" : "simulation",
    phoneReady: agentReady && missing.length === 0 && publicWebhook && /^\+[1-9]\d{7,14}$/.test(phone ?? ""),
    missing,
    publicWebhook,
    testPhone: phone ? `•••• ${phone.slice(-4)}` : null,
    note:
      "Call limits, stored approval, calling hours and the caller contract are checked again when dialing.",
  };
}

export function sameOrigin(req: Request) {
  const url = new URL(req.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  if (req.method === "POST" && !req.headers.get("content-type")?.startsWith("application/json")) return false;
  return true;
}
