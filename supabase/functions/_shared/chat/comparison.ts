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

// Shared by the consent readback and each caller brief. Do not serialize the whole
// fields record: names and phone numbers have their own explicit sharing controls.
export function comparisonQuestions(f: Record<string, unknown>): string[] {
  const qs = Array.isArray(f.questions)
    ? f.questions.filter((q): q is string => typeof q === "string")
    : typeof f.question === "string"
    ? [f.question]
    : [];
  const text = (value: unknown): string | null => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return value.filter((x) => typeof x === "string").join(", ") || null;
    return null;
  };
  const labels: Record<string, string> = {
    service: "Service",
    party_size: "Party size",
    exact_time: "Requested time",
    window_start: "Earliest time",
    window_end: "Latest time",
    tolerance_min: "Time flexibility in minutes",
    max_price_rs: "Budget in rupees",
    service_details: "Service details",
    also_ask: "Also ask",
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = text(f[key]);
    if (value) qs.push(`${label}: ${value}`);
  }
  return qs;
}
