// Google Places API (New) Text Search (eng plan 3, step 2 FIND). Only what find_business
// needs: up to 5 places with a phone number, address, city and opening hours.
// Places with no phone can't be called; serper.ts looks those up on the web.

export type PlaceHit = {
  placeId: string;
  name: string;
  address: string | null;
  // The neighbourhood, to tell two branches apart ("MG Road", "Indiranagar").
  area: string | null;
  city: string | null;
  phone: string | null;
  // The phone came from a web search (serper.ts), not Google Maps.
  phoneFromWeb?: boolean;
  // regularOpeningHours as Places returns it (periods with day/hour/minute).
  openingHours: unknown;
  closed: boolean;
};

export type SearchPlaces = (q: { text: string }) => Promise<PlaceHit[]>;

// Phone, hours and address components put this in the Enterprise tier (eng plan 3).
const FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.internationalPhoneNumber",
  "places.regularOpeningHours",
  "places.addressComponents",
  "places.businessStatus",
].join(",");

export function placesClient(apiKey: string, timeoutMs = 10_000, f: typeof fetch = fetch): SearchPlaces {
  return async ({ text }) => {
    const res = await f("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify({ textQuery: text, regionCode: "IN", languageCode: "en", pageSize: 5 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`places ${res.status}: ${JSON.stringify(body?.error?.message ?? body)}`);
    return parsePlaces(body);
  };
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export function parsePlaces(body: Row): PlaceHit[] {
  return ((body.places ?? []) as Row[]).map((p) => ({
    placeId: String(p.id),
    name: String(p.displayName?.text ?? ""),
    address: shortAddress(p.shortFormattedAddress ?? p.formattedAddress),
    area: component(p.addressComponents, "sublocality_level_1") ??
      component(p.addressComponents, "sublocality") ?? component(p.addressComponents, "route"),
    city: component(p.addressComponents, "locality") ??
      component(p.addressComponents, "administrative_area_level_3"),
    phone: toE164(p.internationalPhoneNumber),
    openingHours: p.regularOpeningHours ?? null,
    closed: p.businessStatus === "CLOSED_PERMANENTLY" || p.businessStatus === "CLOSED_TEMPORARILY",
  })).filter((p) => p.name);
}

// Read-backs need enough to recognise the place, not the full postal line: keep the
// last three parts of a long address ("Craig Park Layout, Ashok Nagar, Bengaluru").
export function shortAddress(a: unknown): string | null {
  if (typeof a !== "string" || !a.trim()) return null;
  if (a.length <= 60) return a;
  return a.split(",").map((s) => s.trim()).filter(Boolean).slice(-3).join(", ");
}

function component(cs: Row[] | undefined, type: string): string | null {
  return cs?.find((c) => c.types?.includes(type))?.longText ?? null;
}

// "+91 96869 78053" → "+919686978053". Anything else is not callable.
export function toE164(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const e = "+" + s.replace(/\D/g, "");
  return /^\+[1-9][0-9]{6,14}$/.test(e) && s.trim().startsWith("+") ? e : null;
}
