import { assertEquals } from "jsr:@std/assert@1.0.8";
import { checkSlots, collectingState, missing } from "./slots.ts";

const now = new Date("2026-10-23T12:00:00+05:30");

Deno.test("valid booking slots pass and strings are trimmed", () => {
  assertEquals(
    checkSlots("booking", {}, {
      party_size: 4,
      window_start: "2026-10-23T19:30:00+05:30",
      window_end: "2026-10-23T21:00:00+05:30",
      customer_name: " Ihaz ",
    }, now),
    {
      ok: true,
      patch: {
        party_size: 4,
        window_start: "2026-10-23T19:30:00+05:30",
        window_end: "2026-10-23T21:00:00+05:30",
        customer_name: "Ihaz",
      },
    },
  );
});

Deno.test("bad values are refused with a reason for Luna", () => {
  const bad = (patch: Record<string, unknown>) => {
    const r = checkSlots("booking", {}, patch, now);
    return r.ok ? [] : r.errors;
  };
  assertEquals(bad({ party_size: 0 }), ["party_size: a whole number from 1 to 30"]);
  assertEquals(bad({ party_size: 31 }).length, 1);
  assertEquals(bad({ party_size: 2.5 }).length, 1);
  assertEquals(bad({ party_size: "4" }).length, 1);
  assertEquals(bad({ window_end: "2026-10-23 21:00" }).length, 1, "no offset");
  assertEquals(bad({ window_end: "2026-10-23T21:00:00" }).length, 1, "no offset");
  assertEquals(bad({ window_end: "2026-10-23T11:00:00+05:30" }), ["window_end: must be in the future"]);
  assertEquals(bad({ window_start: "2026-10-23T21:00:00+05:30", window_end: "2026-10-23T20:00:00+05:30" }), [
    "window_start: must be before window_end",
  ]);
  assertEquals(bad({ customer_name: "" }).length, 1);
});

Deno.test("Luna cannot set code-only slots or another task's slots", () => {
  const r = checkSlots("booking", {}, { may_book: true, max_advance_rs: 5000, question: "x" }, now);
  assertEquals(r.ok ? [] : r.errors, [
    "may_book: not a booking slot",
    "max_advance_rs: not a booking slot",
    "question: not a booking slot",
  ]);
  assertEquals(checkSlots("question", {}, { party_size: 4 }, now).ok, false);
});

Deno.test("also_ask is a booking slot, capped at 150 characters", () => {
  assertEquals(checkSlots("booking", {}, { also_ask: "Do you have parking?" }, now).ok, true);
  assertEquals(checkSlots("booking", {}, { also_ask: "x".repeat(151) }, now).ok, false);
  assertEquals(checkSlots("question", {}, { also_ask: "x" }, now).ok, false);
});

Deno.test("an edit is checked against the merged fields", () => {
  const cur = { window_start: "2026-10-23T19:30:00+05:30", window_end: "2026-10-23T21:00:00+05:30" };
  assertEquals(checkSlots("booking", cur, { window_start: "2026-10-23T21:30:00+05:30" }, now).ok, false);
  assertEquals(checkSlots("booking", cur, { exact_time: "2026-10-23T22:00:00+05:30" }, now).ok, false);
  assertEquals(checkSlots("booking", cur, { window_end: null }, now), {
    ok: true,
    patch: { window_end: null },
  });
});

Deno.test("missing slots and the collecting state", () => {
  const has = { business: false, booking: false };
  assertEquals(missing("booking", {}, has), [
    "party_size or service",
    "time (window_start and window_end, or exact_time)",
    "customer_name",
    "business",
  ]);
  const f = { party_size: 4, exact_time: "2026-10-23T20:00:00+05:30", customer_name: "Ihaz" };
  assertEquals(collectingState("booking", f, has), "choosing_place");
  assertEquals(collectingState("booking", f, { ...has, business: true }), "confirming");
  assertEquals(collectingState("booking", { party_size: 4 }, has), "collecting");
  assertEquals(
    collectingState("question", { question: "Size 32?" }, { ...has, business: true }),
    "confirming",
  );
  assertEquals(missing("cancel", {}, has), ["booking"]);
  assertEquals(collectingState("cancel", {}, { business: true, booking: true }), "confirming");
});
