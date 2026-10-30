import { assertEquals } from "jsr:@std/assert@1.0.8";
import { readOutputs } from "./outputs.ts";

Deno.test("the eng plan 3.4 contract reads as itself", () => {
  const o = readOutputs("first", {
    booking_status: "not_booked",
    no_match_reason: "no_slot",
    options: [{ time: "2026-10-24T20:30:00+05:30", party_size: 4 }],
    advance_amount: 500,
    opt_out_requested: "no",
  });
  assertEquals(o, {
    booking_status: "not_booked",
    no_match_reason: "no_slot",
    options: [{ time: "2026-10-24T20:30:00+05:30", party_size: 4 }],
    advance_amount: 500,
    opt_out_requested: "no",
  });
});

Deno.test("the Genie contract: outcome maps by call kind; strings are read as what they mean", () => {
  const raw = {
    outcome: "options_found",
    options: '[{"time": "2026-10-24T20:30:00+05:30", "details": "table for 4, patio", "price_rs": 0}]',
    advance_amount_rs: "Rs 500",
    opt_out_requested: "Yes",
  };
  const first = readOutputs("first", raw)!;
  assertEquals(first.booking_status, "not_booked");
  assertEquals(first.options![0].label, "table for 4, patio");
  assertEquals(first.advance_amount, 500);
  assertEquals(first.opt_out_requested, "yes");
  const second = readOutputs("booking", raw)!;
  assertEquals(second.booking_status, "option_gone");
  assertEquals(second.alternatives![0].time, "2026-10-24T20:30:00+05:30");
});

Deno.test("outcomes that say nothing about a booking give no booking_status", () => {
  for (const outcome of ["voicemail", "phone_menu", "uncertain", "wrong_number", "disconnected"]) {
    const o = readOutputs("first", { outcome })!;
    assertEquals(o.booking_status, undefined, outcome);
    assertEquals(o.outcome, outcome);
  }
});

Deno.test("needs_customer_decision is a new condition; empty and 'null' strings are unknown", () => {
  const o = readOutputs("first", { outcome: "needs_customer_decision", booked_time: "null", upi_id: " " })!;
  assertEquals(o.booking_status, "not_booked");
  assertEquals(o.no_match_reason, "new_condition");
  assertEquals(o.booked_time, undefined);
  assertEquals(o.upi_id, undefined);
});

Deno.test("an unintended commitment is kept, in their words", () => {
  const o = readOutputs("first", {
    outcome: "uncertain",
    possible_unintended_commitment: "yes",
    unintended_commitment_details: "I've put you down for 8",
  })!;
  assertEquals(o.unintended_commitment, "I've put you down for 8");
  assertEquals(readOutputs("first", null), null);
});
