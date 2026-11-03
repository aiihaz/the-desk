import { assertEquals } from "jsr:@std/assert@1.0.8";
import type { CreateResponse } from "../openai.ts";
import { type BookingCheck, instant, readBookedWhen, timeCheck, verifyBooking } from "./verify.ts";

const base: BookingCheck = {
  kind: "first",
  fields: {
    window_start: "2026-10-23T19:30:00+05:30",
    window_end: "2026-10-23T21:00:00+05:30",
    party_size: 4,
    customer_name: "Ihaz",
  },
  option: null,
  bookedTime: "2026-10-23T20:15:00+05:30",
  transcript: [
    { role: "agent", en_text: "Table for 4 at 8:15 tonight, name Ihaz. Shall I confirm?" },
    { role: "user", en_text: "Haan, confirmed, 8:15 for four." },
  ],
  defaultToleranceMin: 15,
  advancePaidRs: 0,
};

// A fake model that answers with the given verdict.
function model(v: Record<string, unknown>, seen: string[] = []): CreateResponse {
  return async (req) => {
    seen.push(String(req.input[0].content));
    return {
      output: [{ type: "function_call", name: "verdict", arguments: JSON.stringify(v) }],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
}

const confirmed = { decision: "confirmed" as const, line: 2, conditions: [], why: "" };
const held = {
  decision: "confirmed" as const,
  evidence: "Haan, confirmed, 8:15 for four.",
  conditions: [],
  bookedWhen: null,
  why: "",
};

Deno.test("timeCheck: call 1 window", () => {
  assertEquals(timeCheck(base), null);
  assertEquals(timeCheck({ ...base, bookedTime: "2026-10-23T21:15:00+05:30" })?.includes("outside"), true);
  assertEquals(timeCheck({ ...base, bookedTime: null }), "no booked time reported");
  assertEquals(
    timeCheck({ ...base, bookedTime: "eight fifteen" })?.startsWith("booked time unreadable"),
    true,
  );
});

Deno.test("timeCheck: call 1 exact time uses the request's tolerance, else the default", () => {
  const exact = { ...base, fields: { exact_time: "2026-10-23T20:00:00+05:30" } };
  assertEquals(timeCheck({ ...exact, bookedTime: "2026-10-23T20:15:00+05:30" }), null);
  assertEquals(timeCheck({ ...exact, bookedTime: "2026-10-23T20:20:00+05:30" }) !== null, true);
  assertEquals(
    timeCheck({
      ...exact,
      fields: { ...exact.fields, tolerance_min: 30 },
      bookedTime: "2026-10-23T20:20:00+05:30",
    }),
    null,
  );
});

Deno.test("timeCheck: call 2 must be the picked option's time", () => {
  const two: BookingCheck = {
    ...base,
    kind: "booking",
    option: { label: "8:30 pm", value: { time: "2026-10-23T20:30:00+05:30" } },
  };
  assertEquals(timeCheck({ ...two, bookedTime: "2026-10-23T20:30:00+05:30" }), null);
  // Inside the original window is not enough on call 2.
  assertEquals(timeCheck({ ...two, bookedTime: "2026-10-23T20:15:00+05:30" }) !== null, true);
  assertEquals(
    timeCheck({ ...two, option: { label: "Sat lunch", value: {} } }),
    "the picked option has no time",
  );
});

Deno.test("verified only when the time matches and a line of the business's confirms it", async () => {
  const seen: string[] = [];
  const v = await verifyBooking(model(confirmed, seen), "m", "low", base);
  assertEquals(v, { verified: true, problems: [], verdict: held, conditions: [] });
  assertEquals(seen[0].includes("People: 4"), true);
  assertEquals(seen[0].includes("2. business: Haan, confirmed"), true);
});

Deno.test("the agent's line, or no line, is not the business confirming", async () => {
  for (const line of [1, 9, null]) {
    const v = await verifyBooking(model({ ...confirmed, line }), "m", "low", base);
    assertEquals(v.verified, false, String(line));
    assertEquals(v.verdict?.decision, "unclear");
  }
});

Deno.test("what's kept as the business's confirmation is their line, whatever language it's in", async () => {
  const hindi = [
    { role: "agent", en_text: "Table for 4 at 8:15?" },
    { role: "user", en_text: "हाँ, हो गया" },
  ];
  const v = await verifyBooking(model(confirmed), "m", "low", { ...base, transcript: hindi });
  assertEquals(v.verified, true);
  assertEquals(v.verdict?.evidence, "हाँ, हो गया");
});

const condition = (over: Record<string, unknown>) => ({
  line: 2,
  what: "a Rs 1000 minimum spend",
  required: true,
  covered: false,
  ...over,
});

Deno.test("something optional is disclosed, not blocking: the booking stands", async () => {
  const v = await verifyBooking(
    model({
      ...confirmed,
      conditions: [condition({ required: false, what: "valet, Rs 100 if you want it" })],
    }),
    "m",
    "low",
    base,
  );
  assertEquals(v.verified, true);
  assertEquals(v.conditions?.[0].required, false);
  assertEquals(v.conditions?.[0].words, "Haan, confirmed, 8:15 for four.");
});

Deno.test("something required that the user already approved doesn't block", async () => {
  const v = await verifyBooking(
    model({ ...confirmed, conditions: [condition({ covered: true })] }),
    "m",
    "low",
    base,
  );
  assertEquals(v.verified, true);
});

Deno.test("one rule: a required condition the user never approved blocks, and is theirs to decide", async () => {
  const v = await verifyBooking(model({ ...confirmed, conditions: [condition({})] }), "m", "low", base);
  assertEquals(v.verified, false);
  assertEquals(v.decisionOpen, true);
  assertEquals(v.problems, ["condition: a Rs 1000 minimum spend"]);
});

Deno.test("a condition on a booking that didn't check out isn't a decision: it's unverified", async () => {
  const v = await verifyBooking(
    model({ ...confirmed, conditions: [condition({})] }),
    "m",
    "low",
    { ...base, bookedTime: "2026-10-23T22:00:00+05:30" },
  );
  assertEquals([v.verified, v.decisionOpen], [false, undefined]);
});

Deno.test("a condition with a bad line or unclear judgment isn't dropped: it counts as required", async () => {
  const v = await verifyBooking(
    model({ ...confirmed, conditions: [{ line: 99, what: "cash only" }] }),
    "m",
    "low",
    base,
  );
  assertEquals(v.conditions, [{ words: "cash only", what: "cash only", required: true, covered: false }]);
  assertEquals(v.verified, false);
});

Deno.test("what the user accepted reaches the check, so it can be covered", async () => {
  const seen: string[] = [];
  await verifyBooking(model(confirmed, seen), "m", "low", {
    ...base,
    kind: "booking",
    bookedTime: "2026-10-23T20:30:00+05:30",
    option: { label: "8:30 pm", value: { time: "2026-10-23T20:30:00+05:30", conditions: "90 minutes only" } },
    advancePaidRs: 500,
  });
  assertEquals(seen[0].includes("Accepted: 90 minutes only"), true);
  assertEquals(seen[0].includes("Advance: Rs 500, already paid"), true);
});

Deno.test("not confirmed, unclear, a wrong time, no transcript: all unverified", async () => {
  const cases: [Partial<BookingCheck>, Record<string, unknown>][] = [
    [{}, { decision: "not_confirmed", line: null, conditions: [], why: "they said 8:45" }],
    [{}, { decision: "unclear", line: null, conditions: [], why: "line dropped" }],
    [{ bookedTime: "2026-10-23T22:00:00+05:30" }, confirmed],
    [{ transcript: [] }, confirmed],
    [{}, { decision: "booked!!" }],
  ];
  for (const [patch, verdict] of cases) {
    const v = await verifyBooking(model(verdict), "m", "low", { ...base, ...patch });
    assertEquals(v.verified, false, JSON.stringify(verdict));
    assertEquals(v.problems.length > 0, true);
  }
});

Deno.test("a failing model call is not a verification", async () => {
  const v = await verifyBooking(
    async () => {
      throw new Error("timeout");
    },
    "m",
    "low",
    base,
  );
  assertEquals(v.verified, false);
  assertEquals(v.problems, ["transcript check failed: timeout"]);
});

Deno.test("a year-less reading is never a time or a guess; the call's own reading settles it", async () => {
  assertEquals(readBookedWhen("November 8"), { time: null, date: null, captured: "November 8" });
  assertEquals(readBookedWhen("2026-11-08"), { time: null, date: "2026-11-08", captured: "2026-11-08" });
  assertEquals(readBookedWhen("2026-11-08T20:00").time, "2026-11-08T20:00+05:30");
  assertEquals(instant("November 8"), null);

  const seen: string[] = [];
  const v = await verifyBooking(
    model({ ...confirmed, booked_when: "2026-10-23T20:15:00+05:30" }, seen),
    "m",
    "low",
    { ...base, bookedTime: null, today: "Fri 23 Oct 2026, 6:00 pm" },
  );
  assertEquals(v.verified, true);
  assertEquals(v.heard, { time: "2026-10-23T20:15:00+05:30", date: null });
  assertEquals(seen[0].startsWith("TODAY: Fri 23 Oct 2026"), true);
});

const year = (bookedTime: string) => ({
  ...base,
  fields: {
    ...base.fields,
    window_start: undefined,
    window_end: undefined,
    exact_time: "2026-11-08T20:00:00+05:30",
  },
  bookedTime,
});

Deno.test("a wrong year is never corrected: the booking stays unverified, flagged", async () => {
  const c = year("2025-11-08T20:00:00+05:30");
  const v = await verifyBooking(model(confirmed), "m", "low", c);
  assertEquals([v.verified, v.badYear], [false, true]);

  const none = await verifyBooking(model(confirmed), "m", "low", { ...c, transcript: null });
  assertEquals([none.verified, none.badYear], [false, true]);
});

Deno.test("a note wrong only in its year: the call's own reading, from TODAY, can settle it (S2)", async () => {
  const c = { ...year("2025-11-08T20:00:00+05:30"), today: "Fri 23 Oct 2026, 6:00 pm" };
  const v = await verifyBooking(
    model({ ...confirmed, booked_when: "2026-11-08T20:00:00+05:30" }),
    "m",
    "low",
    c,
  );
  assertEquals([v.verified, v.badYear], [true, undefined]);
  assertEquals(v.heard, { time: "2026-11-08T20:00:00+05:30", date: null });

  // If the call's reading doesn't agree either, it stays unverified and flagged.
  const off = await verifyBooking(
    model({ ...confirmed, booked_when: "2025-11-08T20:00:00+05:30" }),
    "m",
    "low",
    c,
  );
  assertEquals([off.verified, off.badYear], [false, true]);
});

Deno.test("a different day is not a year mistake", async () => {
  const v = await verifyBooking(model(confirmed), "m", "low", year("2025-11-09T20:00:00+05:30"));
  assertEquals([v.verified, v.badYear], [false, undefined]);
});

Deno.test("a date with no time is flagged, never verified", async () => {
  const v = await verifyBooking(model(confirmed), "m", "low", {
    ...year("2026-11-08T20:00:00+05:30"),
    bookedTime: null,
    bookedDate: "2026-11-08",
  });
  assertEquals(v.verified, false);
  assertEquals(v.problems[0], "date only, no time confirmed: 2026-11-08");
});
