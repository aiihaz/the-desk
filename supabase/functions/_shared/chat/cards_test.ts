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

Deno.test("task card shows filled, missing, and the state's tools", () => {
  assertEquals(
    taskCard({
      task: "booking",
      state: "collecting",
      fields: { party_size: 4, place_query: "paragon" },
      place: null,
      hasBooking: false,
      options: [],
    }, now),
    [
      "TASK",
      "task: booking",
      "state: collecting (collecting details)",
      "filled: party_size=4; place_query=paragon",
      "missing: time (window_start and window_end, or exact_time), customer_name, business",
      "business: not picked",
      "tools: reply, set_slots, find_business, choose_business, my_places, find_booking, cancel_request, start_new_request",
    ].join("\n"),
  );
  assertEquals(
    taskCard(null, now),
    "TASK\nnone active\ntools: reply, start_new_request, set_slots, find_business, my_places, find_booking",
  );
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
