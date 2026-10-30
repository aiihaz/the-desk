import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { type CallInputs, callVariables, MissingCallInput } from "../call_vars.ts";
import { callKind } from "./calls.ts";
import { FakeChatStore } from "./test_chat_store.ts";
import { findBooking } from "./tools.ts";

Deno.test("callKind: the consent and the task decide the call", () => {
  assertEquals(callKind("ask", "booking"), "first");
  assertEquals(callKind("ask", "question"), "question");
  assertEquals(callKind("ask", "cancel"), "cancel");
  assertEquals(callKind("ask", "reschedule"), "reschedule");
  assertEquals(callKind("book", "booking"), "booking");
  assertEquals(callKind("book", "reschedule"), "reschedule");
  assertEquals(callKind("pay", "booking"), "payment_confirm");
});

const booking = {
  time: "2026-10-24T20:15:00+05:30",
  reference: "T12",
  customerName: "Ihaz",
  depositRs: null,
  knownFeeRs: null,
};
const base: CallInputs = {
  task: "cancel",
  fields: { party_size: 4 },
  businessName: "Paragon",
  customerPhone: "+919812345678",
  option: null,
  prev: { at: "2026-10-23T18:00:00+05:30", contactName: "Ravi", summary: "Booked table for 4." },
  booking,
  payment: null,
  approvedLossRs: 0,
};

Deno.test("cancel variables: the booking to identify, and no loss accepted unless CANCEL was said", () => {
  const v = callVariables("cancel", base, false);
  assertEquals(v.existing_booking, "Sat, 24 Oct, 8:15 pm, table for 4, name Ihaz, ref T12");
  assertEquals(v.approved_loss_rs, 0);
  assertEquals(v.prev_contact_name, "Ravi");
  assertEquals(callVariables("cancel", { ...base, approvedLossRs: 500 }, false).approved_loss_rs, 500);
  assertThrows(() => callVariables("cancel", { ...base, booking: null }, false), MissingCallInput);
});

Deno.test("reschedule variables: the new window, or exactly the picked option on call 2", () => {
  const r = {
    ...base,
    task: "reschedule",
    fields: { ...base.fields, window_start: "a", window_end: "b", may_book: true },
  };
  const one = callVariables("reschedule", r, false);
  assertEquals([one.window_start, one.window_end, one.may_book, one.picked_option], ["a", "b", true, null]);
  const two = callVariables(
    "reschedule",
    { ...r, option: { label: "9:45 pm", value: { time: "2026-10-24T21:45:00+05:30" } } },
    true,
  );
  assertEquals([two.exact_time, two.window_start, two.picked_option, two.must_reask], [
    "2026-10-24T21:45:00+05:30",
    null,
    "9:45 pm",
    true,
  ]);
});

Deno.test("payment_confirm variables need the held booking and the payment", () => {
  const p = {
    ...base,
    task: "booking",
    payment: { amountRs: 500, ref: "344321", paidAt: null, payee: "p@ok" },
  };
  const v = callVariables("payment_confirm", p, false);
  assertEquals([v.paid_amount_rs, v.payment_ref, v.payee], [500, "344321", "p@ok"]);
  assertThrows(() => callVariables("payment_confirm", { ...p, payment: null }, false), MissingCallInput);
});

Deno.test("find_booking: one match is set on the change errand; several are listed; none says so", async () => {
  const store = new FakeChatStore();
  const user = { id: "u1", waId: "919812345678", blocked: false };
  const deps = { store, send: async () => "wamid" };
  assertEquals((await findBooking(deps, user, "paragon")).ok, false);

  store.bookings = [
    {
      id: "bk111111-x",
      status: "booked",
      time: new Date("2026-10-24T20:15:00+05:30"),
      place: "Paragon",
      what: "table for 4",
      reference: null,
    },
    {
      id: "bk222222-y",
      status: "booked",
      time: new Date("2026-10-25T11:00:00+05:30"),
      place: "Toni&Guy",
      what: "haircut",
      reference: null,
    },
  ];
  store.req = {
    id: "r1",
    task: "cancel",
    state: "collecting",
    version: 1,
    fields: {},
    businessId: null,
    bookingId: null,
    createdAt: new Date(),
    pausedAt: null,
  };
  const one = await findBooking(deps, user, "my Paragon table");
  assertEquals(one.ok && one.set_on, "r-r1");
  assertEquals(store.bookingSet, ["bk111111-x"]);

  const several = await findBooking(deps, user, "my booking");
  assertEquals(several.ok && (several.bookings as unknown[]).length, 2);
  const byRef = await findBooking(deps, user, "bk222222");
  assertEquals(byRef.ok && (byRef.booking as { place: string }).place, "Toni&Guy");
});
