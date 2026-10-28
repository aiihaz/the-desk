import { assertEquals } from "jsr:@std/assert@1.0.8";
import { checkSlots, collectingState, missing } from "./slots.ts";

const now = new Date("2026-10-23T12:00:00+05:30");

Deno.test("questions are a list: a follow-up is added, never swapped in (P7, P10)", () => {
  const cur = { questions: ["Can you dry clean a blazer by Friday, for under Rs 300?"] };
  assertEquals(checkSlots("question", cur, {}, now, { add: ["Do you do pickup?"] }), {
    ok: true,
    patch: { questions: ["Can you dry clean a blazer by Friday, for under Rs 300?", "Do you do pickup?"] },
  });
  // Rewording and removing name the question by number, so nothing else moves.
  assertEquals(
    checkSlots("question", cur, {}, now, { reword: [{ number: 1, text: "Blazer dry clean under Rs 300?" }] }),
    { ok: true, patch: { questions: ["Blazer dry clean under Rs 300?"] } },
  );
  assertEquals(checkSlots("question", cur, {}, now, { remove: [1] }), {
    ok: true,
    patch: { questions: null },
  });
  assertEquals(checkSlots("question", cur, {}, now, { remove: [2] }).ok, false);
  // The whole list can't be overwritten through fields.
  assertEquals(checkSlots("question", cur, { questions: ["x"] }, now).ok, false);
  assertEquals(checkSlots("question", cur, { question: "x" }, now).ok, false);
  // An old single question is folded into the list.
  assertEquals(checkSlots("question", { question: "Open Sunday?" }, {}, now, { add: ["Walk-ins?"] }), {
    ok: true,
    patch: { questions: ["Open Sunday?", "Walk-ins?"], question: null },
  });
  assertEquals(checkSlots("booking", {}, {}, now, { add: ["x"] }).ok, false);
});

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
    "question: use add_questions, reword_questions or remove_questions",
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

Deno.test("what a plan still needs, and the collecting state", () => {
  const has = { business: false, booking: false };
  assertEquals(missing("booking", {}, has), [
    "what to book (party_size or service)",
    "when (exact_time, or window_start and window_end)",
    "the name to book under",
    "which business",
  ]);
  // The profile name, or a call that doesn't book, means no name to ask for.
  assertEquals(
    missing("booking", {}, { ...has, profileName: true }).includes("the name to book under"),
    false,
  );
  assertEquals(missing("booking", {}, { ...has, mayBook: false }).includes("the name to book under"), false);
  const f = { party_size: 4, exact_time: "2026-10-23T20:00:00+05:30", customer_name: "Ihaz" };
  assertEquals(collectingState("booking", f, has), "choosing_place");
  assertEquals(collectingState("booking", f, { ...has, business: true }), "confirming");
  assertEquals(collectingState("booking", { party_size: 4 }, has), "collecting");
  assertEquals(
    collectingState("question", { questions: ["Size 32?"] }, { ...has, business: true }),
    "confirming",
  );
  assertEquals(missing("cancel", {}, has), ["which booking"]);
  assertEquals(collectingState("cancel", {}, { business: true, booking: true }), "confirming");
});
