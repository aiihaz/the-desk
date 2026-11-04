// Gateway JWT validation is not authorization to run a machine-only endpoint.
export function authorizeInternal(req: Request, serviceKey: string): Response | null {
  const value = req.headers.get("authorization") ?? "";
  const given = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (!serviceKey || !given) return new Response("unauthorized", { status: 401 });
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(serviceKey);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch ? new Response("forbidden", { status: 403 }) : null;
}
