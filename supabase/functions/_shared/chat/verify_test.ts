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
  maxAdvanceRs: 0,
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

const confirmed = {
  decision: "confirmed" as const,
  evidence: "Haan, confirmed, 8:15 for four.",
  issues: [],
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

Deno.test("verified only when the time matches and the business's own words confirm it", async () => {
  const seen: string[] = [];
  const v = await verifyBooking(model(confirmed, seen), "m", "low", base);
  assertEquals(v, { verified: true, problems: [], verdict: { ...confirmed, why: "" } });
  assertEquals(seen[0].includes("People: 4"), true);
  assertEquals(seen[0].includes("business: Haan, confirmed"), true);
});

Deno.test("a quote that only the agent said is not the business confirming", async () => {
  const v = await verifyBooking(
    model({ ...confirmed, evidence: "Shall I confirm?" }),
    "m",
    "low",
    base,
  );
  assertEquals(v.verified, false);
  assertEquals(v.problems, ["transcript: confirmation not found in the business's words"]);
});

Deno.test("not confirmed, unclear, an extra condition, a wrong time, no transcript: all unverified", async () => {
  const cases: [Partial<BookingCheck>, Record<string, unknown>][] = [
    [{}, { decision: "not_confirmed", evidence: "", issues: [], why: "they said 8:45" }],
    [{}, { decision: "unclear", evidence: "", issues: [], why: "line dropped" }],
    [{}, { ...confirmed, issues: ["Rs 1000 minimum spend"] }],
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

Deno.test("a year-less or date-only reading is never a time, and never the year 2001", () => {
  const a = "2026-11-08T20:00:00+05:30";
  assertEquals(readBookedWhen("November 8", a), { time: null, date: "2026-11-08", captured: "November 8" });
  assertEquals(readBookedWhen("8th Nov", a).date, "2026-11-08");
  assertEquals(readBookedWhen("2026-11-08", a), { time: null, date: "2026-11-08", captured: "2026-11-08" });
  assertEquals(readBookedWhen("November 9", a).date, null);
  assertEquals(readBookedWhen("tomorrow evening", a), {
    time: null,
    date: null,
    captured: "tomorrow evening",
  });
  assertEquals(readBookedWhen("2026-11-08T20:00", a).time, "2026-11-08T20:00+05:30");
  assertEquals(instant("November 8"), null);
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

Deno.test("a wrong year is corrected only when the call confirmed the approved booking", async () => {
  const c = year("2025-11-08T20:00:00+05:30");
  const v = await verifyBooking(model(confirmed), "m", "low", c);
  assertEquals(v.verified, true);
  assertEquals(v.correction?.from, "2025-11-08T20:00:00+05:30");
  assertEquals(v.correction?.to, "2026-11-08T20:00:00+05:30");

  const not = await verifyBooking(model({ ...confirmed, decision: "not_confirmed" }), "m", "low", c);
  assertEquals([not.verified, not.correction, not.badYear], [false, undefined, true]);

  const fee = await verifyBooking(model({ ...confirmed, issues: ["a Rs 200 fee"] }), "m", "low", c);
  assertEquals([fee.verified, fee.correction, fee.badYear], [false, undefined, true]);

  const none = await verifyBooking(model(confirmed), "m", "low", { ...c, transcript: null });
  assertEquals([none.verified, none.badYear], [false, true]);
});

Deno.test("a different day is not a year mistake: nothing is corrected", async () => {
  const v = await verifyBooking(model(confirmed), "m", "low", year("2025-11-09T20:00:00+05:30"));
  assertEquals([v.verified, v.correction, v.badYear], [false, undefined, undefined]);
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
