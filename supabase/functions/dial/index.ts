import { authorizeInternal } from "../_shared/internal_auth.ts";

// Requests and consent now enter through the chat agent, never this legacy endpoint.
Deno.serve((req) =>
  authorizeInternal(req, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "") ??
    Response.json({ error: "endpoint_retired", use: "chat agent" }, { status: 410 })
);
