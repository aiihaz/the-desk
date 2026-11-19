import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { COMPARISON_CAP, comparisonQuestions, explicitRecipients, rankedRecipients } from "./comparison.ts";

Deno.test("explicit list keeps order, dedupes and caps at five", () => {
  assertEquals(explicitRecipients(null), null);
  assertEquals(explicitRecipients([]), null);
  assertEquals(explicitRecipients(["a", "b", "a", "c", "d", "e", "f"]), ["a", "b", "c", "d", "e"]);
  assertEquals(explicitRecipients(["x"]), ["x"]);
});

Deno.test("ranked fallback sorts by rating, unrated last, ties keep search order", () => {
  const hits = [
    { id: "a", rating: 4.7 },
    { id: "b", rating: 4.9 },
    { id: "c", rating: null },
    { id: "d", rating: 4.9 },
    { id: "e", rating: 4.8 },
    { id: "f", rating: 4.6 },
  ];
  assertEquals(rankedRecipients(hits).map((h) => h.id), ["b", "d", "e", "a", "f"]);
  assertEquals(COMPARISON_CAP, 5);
});

Deno.test("comparison question brief excludes unapproved identity fields", () => {
  const qs = comparisonQuestions({
    service: "blow dry",
    customer_name: "Private",
    phone: "+919999999999",
    service_address: "Private address",
  });
  assertEquals(qs.join(" ").includes("Private"), false);
  assertEquals(qs.join(" ").includes("999999"), false);
  assertEquals(qs.join(" ").includes("blow dry"), true);
});
Deno.test("comparison recipient identity and unique cap", () => {
  assertEquals(
    rankedRecipients([{ id: "a", rating: 5 }, { id: "a", rating: 5 }, { id: "b", rating: 4 }]).map((x) =>
      x.id
    ),
    ["a", "b"],
  );
});
