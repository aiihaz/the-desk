import { authorizeInternal } from "../_shared/internal_auth.ts";
import { createAgentRuntime } from "../_shared/agent_runtime.ts";
import { runFollowThrough } from "../_shared/chat/followup.ts";
import { observedResponsesClient as responsesClient } from "../_shared/model_client.ts";
import { serviceClient } from "../_shared/store.ts";
import { send, waConfigFromEnv } from "../_shared/whatsapp.ts";

// A lightweight minute tick; provider analytics stays on the five-minute reconcile job.
Deno.serve(async (req) => {
  const denied = authorizeInternal(req, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  if (denied) return denied;
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const runtime = createAgentRuntime();
  const result = await runFollowThrough({
    store: runtime.chat,
    send: runtime.send,
    create: responsesClient(Deno.env.get("OPENAI_API_KEY") ?? ""),
  });
  const db = serviceClient();
  const { data: notices, error } = await db.rpc("erase_requested_users");
  if (error) throw error;
  for (const notice of notices ?? []) {
    // Do not recreate the deleted profile or log its confirmation in application storage.
    if (Date.now() - Date.parse(notice.last_inbound_at) >= 24 * 3_600_000) continue;
    try {
      await send(waConfigFromEnv(), notice.wa_id, {
        kind: "text",
        body:
          "Your data has been deleted from the Desk. This does not cancel any booking you made; contact the business for that.",
      });
    } catch {
      console.error("could not deliver deletion confirmation");
    }
  }
  const job = await db.rpc("job_ran", { p_name: "follow-through", p_detail: result });
  if (job.error) throw job.error;
  return Response.json(result);
});
