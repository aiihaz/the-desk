// verify_jwt is off: the landing page is a static site with no Supabase key. The service
// role key salts the IP hash, so the stored hash can't be matched to an IP without it.
import { serviceClient } from "../_shared/store.ts";
import { handle, type JoinResult } from "./handler.ts";

const db = serviceClient();
const salt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

async function hashIp(ip: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function join(phone: string, handle: string, ipHash: string | null): Promise<JoinResult> {
  const { data, error } = await db.rpc("join_waitlist", {
    p_phone: phone,
    p_handle: handle,
    p_ip_hash: ipHash,
  });
  if (error) throw error;
  return data as JoinResult;
}

Deno.serve((req) => handle(req, { join, hashIp }));
