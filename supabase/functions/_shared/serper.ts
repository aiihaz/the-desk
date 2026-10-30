// Serper (eng plan 3.3): when Google Places lists a place but no phone number, look the
// place up on Google search's local results and take a number only from a result whose
// name fits. Such a number is marked as found on the web (businesses.source 'serper'),
// and the read-back says so, so the user can stop a call to the wrong number.
import { nameFits } from "./chat/find.ts";
import type { PlaceHit, SearchPlaces } from "./places.ts";

export type WebPlace = { title: string; address: string | null; phone: string | null };
export type SearchWeb = (q: string) => Promise<WebPlace[]>;

export function serperClient(apiKey: string, timeoutMs = 8_000, f: typeof fetch = fetch): SearchWeb {
  return async (q) => {
    const res = await f("https://google.serper.dev/places", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q, gl: "in", hl: "en" }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`serper ${res.status}: ${JSON.stringify(body?.message ?? body)}`);
    // deno-lint-ignore no-explicit-any
    return ((body.places ?? []) as any[]).map((p) => ({
      title: String(p.title ?? ""),
      address: typeof p.address === "string" ? p.address : null,
      phone: typeof p.phoneNumber === "string" ? p.phoneNumber : null,
    }));
  };
}

// Indian numbers as local results show them: "+91 98470 12345", "098470 12345",
// "0495 270 0001", "9847012345". Anything else is not callable.
export function indianE164(s: string | null): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  if (s.trim().startsWith("+")) return /^[1-9][0-9]{6,14}$/.test(d) ? `+${d}` : null;
  if (/^91[0-9]{10}$/.test(d)) return `+${d}`;
  if (/^0[1-9][0-9]{9}$/.test(d)) return `+91${d.slice(1)}`;
  if (/^[6-9][0-9]{9}$/.test(d)) return `+91${d}`;
  return null;
}

// At most this many web lookups per search: each costs a Serper query.
const MAX_LOOKUPS = 2;

export function withWebPhones(search: SearchPlaces, web: SearchWeb): SearchPlaces {
  return async (q) => {
    const hits = await search(q);
    let lookups = 0;
    const out: PlaceHit[] = [];
    for (const p of hits) {
      if (p.phone || p.closed || lookups >= MAX_LOOKUPS) {
        out.push(p);
        continue;
      }
      lookups++;
      try {
        const found = await web([p.name, p.address ?? p.city].filter(Boolean).join(", "));
        // Every word of the name, and the fewest others: "Hotel Paragon" over "Paragon Hotel Tours".
        const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
        const fit = found.filter((w) => indianE164(w.phone) && nameFits(p.name, w.title))
          .sort((a, b) => words(a.title) - words(b.title))[0];
        out.push(fit ? { ...p, phone: indianE164(fit.phone), phoneFromWeb: true } : p);
      } catch (e) {
        console.warn("serper lookup failed", p.name, String((e as Error)?.message ?? e));
        out.push(p);
      }
    }
    return out;
  };
}
