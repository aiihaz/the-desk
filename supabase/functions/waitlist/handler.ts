// Public: the landing page's invite form (web/main.js) POSTs {"handle", "phone", "hp"}.
// The Desk is on WhatsApp in India, so the phone must be an Indian mobile. "hp" is a field
// people never see; a bot that fills it is thanked and nothing is stored. join_waitlist() keeps
// one row per number and limits new numbers per IP and per hour (0023_waitlist.sql).

export type JoinResult = { ok: true; new: boolean } | { ok: false; reason: "rate_limited" };

export type Deps = {
  join: (phoneE164: string, handle: string, ipHash: string | null) => Promise<JoinResult>;
  hashIp: (ip: string) => Promise<string>;
};

const MAX_BODY = 2_000;
const MAX_HANDLE = 100;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

// "+91 98765 43210", "+91 098765 43210", "098765 43210", "919876543210", "9876543210"
// → "+919876543210". Another country code, or anything but a 10-digit mobile, is null.
export function toE164(raw: string): string | null {
  let s = raw.trim().replace(/[\s().-]/g, "").replace(/^00/, "+");
  if (s.startsWith("+")) {
    if (!s.startsWith("+91")) return null;
    s = s.slice(3);
  } else if (/^91[0-9]{10}$/.test(s)) s = s.slice(2);
  if (/^0[0-9]{10}$/.test(s)) s = s.slice(1);
  return /^[6-9][0-9]{9}$/.test(s) ? `+91${s}` : null;
}

function clientIp(req: Request): string | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip");
  return ip || null;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const text = await req.text();
  if (text.length > MAX_BODY) return reply({ error: "too_large" }, 413);
  let body: { handle?: unknown; phone?: unknown; hp?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return reply({ error: "bad_json" }, 400);
  }
  if (typeof body?.hp === "string" && body.hp.trim()) return reply({ ok: true });

  const handle = typeof body?.handle === "string" ? body.handle.trim().replace(/\s+/g, " ") : "";
  if (!handle || handle.length > MAX_HANDLE) return reply({ error: "bad_handle" }, 400);
  const phone = typeof body?.phone === "string" ? toE164(body.phone) : null;
  if (!phone) return reply({ error: "bad_phone" }, 400);

  const ip = clientIp(req);
  const res = await deps.join(phone, handle, ip ? await deps.hashIp(ip) : null);
  if (!res.ok) return reply({ error: "rate_limited" }, 429);
  return reply({ ok: true });
}
