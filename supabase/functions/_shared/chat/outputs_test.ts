import contract from "../../../../agent/contract.json" with { type: "json" };
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
  assertEquals(o.payment_address, undefined);
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

Deno.test("every result the report depends on is in the caller contract", () => {
  const names = contract.required.map((o) => o.name);
  for (
    const n of [
      "outcome",
      "booked_time",
      "booking_reference",
      "options",
      "no_match_reason",
      "advance_amount_rs",
      "advance_redeemable",
      "advance_refund",
      "advance_hold",
      "payment_mode",
      "payment_address",
      "payee_name",
      "payment_deadline",
      "payment_status",
      "cancel_status",
      "cancel_charge_rs",
      "refund_stated",
      "original_booking_status",
      "answer",
      "also_answer",
      "opt_out_requested",
      "summary",
    ]
  ) assertEquals(names.includes(n), true, n);
});

Deno.test("the contract the database enforces is agent/contract.json", async () => {
  const seeds = await Deno.readTextFile("supabase/migrations/0013_caller_contract.sql");
  const change = await Deno.readTextFile("supabase/migrations/0014_advances_and_conditions.sql");
  const name = /^ {2}\('([a-z_]+)'\)[,;]$/gm;
  const dropped = [...change.matchAll(/delete from caller_contract where name = '([a-z_]+)'/g)].map((m) =>
    m[1]
  );
  const seeded = [...[...seeds.matchAll(name)], ...[...change.matchAll(name)]].map((m) => m[1]);
  assertEquals(
    seeded.filter((n) => !dropped.includes(n)).sort(),
    contract.required.map((o) => o.name).sort(),
  );
});

// Every outcome the caller can return is read on purpose (S9: wrong_number once fell through
// to "unclear" and became an answer from the business). A new value fails here until it is.
Deno.test("every outcome in the contract has a meaning on the Desk side", () => {
  const values = contract.required.find((o) => o.name === "outcome")?.values ?? [];
  // A booking status, by call kind (outputs.ts OUTCOME).
  const mapped = [
    "booked",
    "advance_required",
    "options_found",
    "unavailable",
    "refused",
    "needs_customer_decision",
  ];
  // Read before any call kind (report.ts): nobody reached, or not this business.
  const beforeKind = ["wrong_number", "voicemail", "phone_menu", "no_conversation"];
  // Read by the call kind they belong to (report.ts decidePayment, decideCancel,
  // decideReschedule, the question call's answer).
  const byKind = ["payment_not_seen", "hold_expired", "cancelled", "moved", "kept", "question_answered"];
  // Nothing clear: the kind's own "unclear" path, which never says nothing happened.
  const unclear = ["uncertain", "disconnected"];
  assertEquals([...mapped, ...beforeKind, ...byKind, ...unclear].sort(), [...values].sort());
  for (const o of mapped) assertEquals(!!readOutputs("first", { outcome: o })?.booking_status, true, o);
});
