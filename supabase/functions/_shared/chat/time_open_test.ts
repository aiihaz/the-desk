// A time left to the business ("anything works", "any time after 2") is an answer, not a
// gap: it is stored with only the limits they gave, shown back in the plan, carried into the
// call as "ask what suits them", and verified against those limits. And a search shows what
// happened when the Desk called each place before, without leaving any place out.
import { deepStrictEqual as assertEquals } from "node:assert/strict";
import type { User } from "../store.ts";
import { type CallInputs, callVariables } from "../call_vars.ts";
import { findBusiness } from "./find.ts";
import { fmtWhen } from "./readback.ts";
import { checkSlots, missing } from "./slots.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { approvedText, timeCheck } from "./verify.ts";

const now = new Date("2026-11-07T10:00:00+05:30");
const has = { business: true, booking: false, profileName: true, mayBook: true };

Deno.test("'any time after 2 on Sunday': stored with their limit only, and complete for a plan", () => {
  const r = checkSlots("booking", { service: "sink repair" }, {
    time_open: true,
    day: "2026-11-08",
    window_start: "2026-11-08T14:00:00+05:30",
  }, now);
  assertEquals(r.ok, true);
  const f = r.ok ? r.patch : {};
  assertEquals(f.time_given, "start");
  assertEquals(f.window_start, "2026-11-08T14:00:00+05:30");
  assertEquals(f.window_end, "2026-11-08T23:59:00+05:30");
  assertEquals(missing("booking", { service: "sink repair", ...f } as never, has), []);
});

Deno.test("'anything works on Sunday': the day alone is enough; no limit is invented", () => {
  const r = checkSlots("booking", { party_size: 2 }, { time_open: true, day: "2026-11-08" }, now);
  assertEquals(r.ok && [r.patch.time_given, r.patch.window_start], [
    "none",
    "2026-11-08T00:00:00+05:30",
  ]);
  // A limit on another day, a part of day or an exact time doesn't mix with it.
  assertEquals(
    checkSlots(
      "booking",
      {},
      { time_open: true, day: "2026-11-08", window_end: "2026-11-09T12:00:00+05:30" },
      now,
    )
      .ok,
    false,
  );
  assertEquals(
    checkSlots("booking", {}, { time_open: true, day: "2026-11-08", day_part: "evening" }, now).ok,
    false,
  );
  assertEquals(checkSlots("booking", {}, { time_open: true }, now).ok, false);
  assertEquals(checkSlots("booking", {}, { time_given: "both" }, now).ok, false);
});

Deno.test("a time they give later replaces 'anything works'", () => {
  const open = {
    time_open: true,
    time_given: "none" as const,
    window_start: "2026-11-08T00:00:00+05:30",
    window_end: "2026-11-08T23:59:00+05:30",
  };
  const r = checkSlots("booking", open, { exact_time: "2026-11-08T15:00:00+05:30" }, now);
  assertEquals(r.ok && [r.patch.time_open, r.patch.time_given, r.patch.window_start], [null, null, null]);
});

Deno.test("the plan and the call show only the limits they gave, and the call asks what suits the business", () => {
  const f = {
    service: "sink repair",
    time_open: true,
    time_given: "start" as const,
    window_start: "2026-11-08T14:00:00+05:30",
    window_end: "2026-11-08T23:59:00+05:30",
  };
  assertEquals(fmtWhen(f, now), "tomorrow, at a time that suits them from 2:00 pm");
  assertEquals(fmtWhen({ ...f, time_given: "none" }, now), "tomorrow, at a time that suits them");
  assertEquals(fmtWhen(f, now).includes("11:59"), false);

  const x: CallInputs = {
    task: "booking",
    fields: { ...f, customer_name: "Ihaz", may_book: true },
    businessName: "Jagan Plumber",
    customerPhone: "+919812345678",
    option: null,
    prev: null,
    booking: null,
    payment: null,
    approvedLossRs: 0,
  };
  const v = callVariables("first", x, false, now);
  const brief = String(v.task_context);
  assertEquals(brief.includes("any time that suits the business, at or after 2:00 pm IST"), true);
  assertEquals(brief.includes("ask what time suits them that day, at or after 2:00 pm IST"), true);
  assertEquals(brief.includes("11:59"), false);
});

Deno.test("verification holds the booked time to their limit and the day, nothing tighter", () => {
  const fields = {
    time_open: true,
    time_given: "start",
    window_start: "2026-11-08T14:00:00+05:30",
    window_end: "2026-11-08T23:59:00+05:30",
  };
  const check = (bookedTime: string) =>
    timeCheck({
      kind: "first",
      fields,
      option: null,
      bookedTime,
      transcript: null,
      defaultToleranceMin: 15,
      advancePaidRs: 0,
    });
  assertEquals(check("2026-11-08T16:30:00+05:30"), null);
  assertEquals(check("2026-11-08T13:00:00+05:30") !== null, true);
  assertEquals(check("2026-11-09T10:00:00+05:30") !== null, true);
  assertEquals(
    approvedText({
      kind: "first",
      fields,
      option: null,
      bookedTime: null,
      transcript: null,
      defaultToleranceMin: 15,
      advancePaidRs: 0,
    })
      .startsWith("Time: any time the business offered"),
    true,
  );
});

Deno.test("a search shows past calls with each place, and leaves a place whose call went wrong in", async () => {
  const user: User = { id: "u1", waId: "919812345678", blocked: false };
  const store = new FakeChatStore();
  store.limits.place_search_by_kind = true;
  store.city = "Bengaluru";
  store.called.set("b:gbj", [{
    at: new Date("2026-11-06T15:00:00+05:30"),
    kind: "first",
    call: "completed",
    errand: "cancelled: user",
    booking: null,
  }]);
  const place = (id: string, name: string) => ({
    placeId: id,
    name,
    address: `${name}, HSR Layout, Bengaluru`,
    area: "HSR Layout",
    city: "Bengaluru",
    phone: "+919999999990",
    closed: false,
    countryCode: "IN",
  });
  const r = await findBusiness(
    {
      store,
      send: async () => "x",
      now: () => now,
      searchPlaces: async () => [place("gbj", "GBJ Plumbing"), place("ravi", "Ravi Plumbing")],
    } as never,
    user,
    { query: "plumber", area: "HSR Layout", city: null, byKind: true },
  );
  const matches = (r as unknown as { matches: Record<string, unknown>[] }).matches;
  assertEquals(matches.map((m) => m.name), ["GBJ Plumbing", "Ravi Plumbing"]);
  assertEquals(matches[0].past_calls, [{
    on: "6 Nov",
    kind: "first",
    call: "completed",
    errand: "cancelled: user",
  }]);
  assertEquals("past_calls" in matches[1], false);
});
