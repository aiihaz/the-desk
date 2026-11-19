// The comparison version's recipient list (owner's rule, 19 Nov 2026): the businesses
// from his Aurora recordings first, otherwise the highest-rated matching five, never
// more than five distinct businesses per errand. This file is the pure selection rule;
// docs/comparison-mode.md is the design for how a comparison errand runs.

export const COMPARISON_CAP = 5;

// An explicit list (a frozen evaluation set, requests.recipient_ids) wins as given:
// order preserved, duplicates removed, capped at five. Returns null when there is no
// explicit list, so the caller falls back to picking from search results.
export function explicitRecipients(ids: string[] | null | undefined): string[] | null {
  if (!ids?.length) return null;
  return [...new Set(ids)].slice(0, COMPARISON_CAP);
}

// The fallback when an errand has no explicit list: highest rated first, unrated last,
// ties keep the search order, capped at five. Ratings come from the search result;
// see docs/comparison-mode.md on the Places SKU cost of asking for them.
export function rankedRecipients<T extends { id: string; rating?: number | null }>(hits: T[]): T[] {
  return [...new Map(hits.map((h) => [h.id, h])).values()]
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (b.h.rating ?? -1) - (a.h.rating ?? -1) || a.i - b.i)
    .slice(0, COMPARISON_CAP)
    .map(({ h }) => h);
}

// Named businesses first (the recordings' businesses), the rated search results only as
// the fallback that fills what the named list can't: named ids win in their given order,
// then fill ids that aren't already picked, never more than five in total.
export function mergeRecipients(primary: string[], fill: string[]): string[] {
  const out: string[] = [];
  for (const id of [...primary, ...fill]) {
    if (!out.includes(id)) out.push(id);
    if (out.length >= COMPARISON_CAP) break;
  }
  return out;
}

// Whether a search hit is the business someone named, forgiving about case, extra
// words and punctuation ("TONI&GUY HSR" naming "Toni & Guy Essensuals"). Words of four
// letters or more from the named text must all appear in the hit's name.
export function nameMatches(named: string, hitName: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const hit = new Set(words(hitName));
  const significant = words(named).filter((w) => w.length >= 2);
  return significant.length > 0 && significant.every((w) => hit.has(w));
}

// Shared by the consent readback and each caller brief. Do not serialize the whole
// fields record: names and phone numbers have their own explicit sharing controls.
export function comparisonQuestions(f: Record<string, unknown>): string[] {
  const qs = Array.isArray(f.questions)
    ? f.questions.filter((q): q is string => typeof q === "string")
    : typeof f.question === "string"
    ? [f.question]
    : [];
  const keys = [
    "service",
    "party_size",
    "exact_time",
    "window_start",
    "window_end",
    "tolerance_min",
    "max_price_rs",
    "service_details",
    "also_ask",
  ];
  const details = Object.fromEntries(
    keys.filter((k) => f[k] !== undefined && f[k] !== null)
      .map((k) => [k, f[k]]),
  );
  if (Object.keys(details).length) {
    qs.push(`Ask about availability, price and conditions for: ${JSON.stringify(details)}`);
  }
  return qs;
}
