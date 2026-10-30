import { assertEquals } from "jsr:@std/assert@1.0.8";
import { profileCard, recentCard, taskCard } from "./cards.ts";

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
    "PROFILE\nname: Ihaz\nlanguage: en-IN\ncity: Kozhikode\nphone: +91 98…\nbook_on_first_call: yes\nsaved places: paragon",
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
      "still needed for a plan: when (exact_time, or window_start and window_end), which business",
      "business: not picked",
      "tools: reply, set_slots, find_business, choose_business, my_places, find_booking, propose_plan, pause_request, " +
      "cancel_request, start_new_request",
    ].join("\n"),
  );
  assertEquals(
    taskCard(null, now),
    "TASK\nnone active\ntools: reply, start_new_request, set_slots, find_business, choose_business, my_places, find_booking",
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
