import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { openCard, profileCard, recentCard, taskCard } from "./cards.ts";

const now = new Date("2026-10-23T12:00:00+05:30");

Deno.test("profile card", () => {
  assertEquals(
    profileCard({
      name: "Ihaz",
      language: "en-IN",
      city: "Kozhikode",
      phone: "+919812345678",
      bookOnFirstCall: true,
      placeLabels: ["paragon"],
    }),
    "PROFILE\nname: Ihaz\nlanguage: en-IN\nhome city: Kozhikode\nbookings, last 90 days: none\nphone: +91 98…\nbook_on_first_call: yes\nsaved places: paragon\nsaved addresses: none",
  );
});

Deno.test("task card: the errand ref, what is known, what a plan still needs, and the state's tools", () => {
  assertEquals(
    taskCard({
      ref: "r-1a2b3c4d",
      task: "booking",
      state: "collecting",
      fields: { party_size: 4, place_query: "paragon" },
      place: null,
      hasBooking: false,
      options: [],
      has: { profileName: true },
    }, now),
    [
      "TASK",
      "errand: r-1a2b3c4d",
      "task: booking",
      "state: collecting (collecting details)",
      "known: party_size=4; place_query=paragon",
      "missing_for_plan: when (exact_time, or window_start and window_end), which business",
      "business: not picked",
      "business lookup: resolve the named place internally; ask only for genuine ambiguity, mismatch, or competing branches",
      "tools: reply, set_slots, find_business, choose_business, my_places, find_booking, propose_plan, pause_request, " +
      "cancel_request, start_new_request, stay_quiet, react, set_follow_up, recall_errands, show_transcript, remember, forget, set_name, set_home_city, save_address",
    ].join("\n"),
  );
  assertEquals(
    taskCard(null, now),
    "TASK\nnone active\ntools: reply, start_new_request, set_slots, find_business, choose_business, my_places, find_booking, stay_quiet, react, recall_errands, show_transcript, remember, forget, set_name, set_home_city, save_address",
  );
});

Deno.test("a plan waiting for an answer, and an errand waiting behind it", () => {
  const card = taskCard(
    {
      ref: "r-1",
      task: "question",
      state: "awaiting_yes",
      fields: { questions: ["Pickup?"] },
      place: { name: "Test Laundry", address: null, city: "Bengaluru" },
      hasBooking: false,
      options: [],
      planSentAt: new Date("2026-10-23T11:58:00+05:30"),
    },
    now,
    [{
      ref: "r-2",
      task: "booking",
      state: "queued",
      fields: { service: "dental checkup" },
      place: null,
      hasBooking: false,
      options: [],
      has: { profileName: true },
    }],
  );
  assertEquals(card.includes("plan sent: 11:58 am"), true);
  assertEquals(card.includes('known: question 1="Pickup?"'), true);
  assertEquals(card.includes("waiting behind it: r-2 booking; known: service=dental checkup"), true);
  assertEquals(card.includes("tools: reply, approve_plan,"), true);
});

Deno.test("a paused request says so, offers resume, and no plan or approval", () => {
  const card = taskCard({
    ref: "r-1",
    task: "booking",
    state: "confirming",
    fields: {},
    place: null,
    hasBooking: false,
    options: [],
    paused: true,
  }, now);
  assertEquals(card.includes("paused: yes"), true);
  assertEquals(card.includes("resume_request") && !card.includes("pause_request"), true);
  assertEquals(card.includes("propose_plan") || card.includes("approve_plan"), false);
});

Deno.test("recent requests, at most three", () => {
  const r = {
    at: new Date("2026-10-12T19:00:00+05:30"),
    task: "booking" as const,
    state: "expired" as const,
    endReason: "expired",
    placeName: "Paragon",
    fields: { party_size: 4 },
  };
  assertEquals(recentCard([r, r, r, r], now).split("\n").length, 4);
  assertEquals(recentCard([r], now), "RECENT\n12 Oct expired, not confirmed: Paragon, table for 4");
});

Deno.test("an update still being written shows, so a reply doesn't guess or go quiet", () => {
  const c = openCard([], [], ["Paragon, Kannur Rd"]);
  assertEquals(c.includes("update being written: the call to Paragon, Kannur Rd is finished"), true);
  assertEquals(openCard([], [], []), "OPEN\nnothing");
});

Deno.test("saved service context remains visible on later turns", () => {
  const card = taskCard({
    ref: "r-1",
    task: "booking",
    state: "collecting",
    fields: {
      service: "laundry pickup",
      service_address: "Flat 4, Cedar House",
      service_details: "Two blazers; needed by Friday",
    },
    place: null,
    hasBooking: false,
    options: [],
  }, now);
  assertEquals(card.includes("service_address=Flat 4, Cedar House"), true);
  assertEquals(card.includes("service_details=Two blazers; needed by Friday"), true);
});

Deno.test("recent bookings are shown as facts per city, most booked first, never as a home city", () => {
  const base = {
    name: "Ihaz",
    language: "en-IN",
    city: null,
    phone: null,
    bookOnFirstCall: false,
    placeLabels: [],
  };
  const at = (d: string) => new Date(`2026-${d}T13:00:00+05:30`);
  const lines = (bookedIn: { city: string; at: Date }[], city: string | null = null) =>
    profileCard({ ...base, city, bookedIn }).split("\n").slice(3, 5);
  assertEquals(lines([]), ["home city: unknown", "bookings, last 90 days: none"]);
  // Five in Bengaluru and one in Kochi is a pattern for Luna to read, not a tie code drops.
  const six = [
    { city: "Kochi", at: at("11-03") },
    ...["11-02", "10-28", "10-20", "10-11", "10-02"].map((d) => ({ city: "bengaluru", at: at(d) })),
  ];
  six[1].city = "Bengaluru";
  assertEquals(lines(six)[1], "bookings, last 90 days: Bengaluru ×5 (latest 2 Nov), Kochi ×1 (latest 3 Nov)");
  // A saved city that the bookings don't match is shown beside them, for Luna to notice.
  assertEquals(lines(six, "Chennai"), [
    "home city: Chennai",
    "bookings, last 90 days: Bengaluru ×5 (latest 2 Nov), Kochi ×1 (latest 3 Nov)",
  ]);
});
