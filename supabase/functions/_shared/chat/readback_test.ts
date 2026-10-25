import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildPayload } from "../whatsapp.ts";
import {
  bookingReadback,
  bookItPrompt,
  cancelReadback,
  fmtDay,
  fmtWhen,
  optionsPrompt,
  questionReadback,
  rescheduleReadback,
} from "./readback.ts";

const now = new Date("2026-10-23T12:00:00+05:30"); // Friday
const paragon = { name: "Paragon", address: "Kannur Rd, Kozhikode", city: "Kozhikode" };
const tonight = {
  party_size: 4,
  customer_name: "Ihaz",
  window_start: "2026-10-23T19:30:00+05:30",
  window_end: "2026-10-23T21:00:00+05:30",
};

Deno.test("days and windows in IST", () => {
  assertEquals(fmtDay(new Date("2026-10-23T19:30:00+05:30"), now), "tonight");
  assertEquals(fmtDay(new Date("2026-10-23T13:00:00+05:30"), now), "today");
  assertEquals(fmtDay(new Date("2026-10-24T10:00:00+05:30"), now), "tomorrow");
  assertEquals(fmtDay(new Date("2026-10-25T10:00:00+05:30"), now), "Sun 25 Oct");
  // 23:30 IST on the 23rd is still "tonight" though it is the 23rd 18:00 UTC.
  assertEquals(fmtDay(new Date("2026-10-23T18:00:00Z"), now), "tonight");
  assertEquals(fmtWhen(tonight, now), "tonight, 7:30–9:00 pm");
  assertEquals(
    fmtWhen({ window_start: "2026-10-24T11:30:00+05:30", window_end: "2026-10-24T13:00:00+05:30" }, now),
    "tomorrow, 11:30 am–1:00 pm",
  );
  assertEquals(
    fmtWhen({ exact_time: "2026-10-23T20:00:00+05:30", tolerance_min: 15 }, now),
    "tonight at 8:00 pm (up to 15 min either way)",
  );
});

Deno.test("booking read-back leads with the plan, then what is shared and when it comes back", () => {
  const p = bookingReadback("p1", {
    place: paragon,
    f: { ...tonight, may_book: true, max_advance_rs: 500 },
    customerPhone: "+919812345678",
    now,
  });
  assertEquals(
    p.text,
    "Paragon, Kannur Rd, Kozhikode\nTable for 4 · tonight (Fri 23 Oct), 7:30–9:00 pm\n\n" +
      "I'll call and book it in your name (Ihaz, +91 98…). If they want an advance of up to Rs 500, " +
      "I'll hold it and you pay them directly. If it isn't available, I'll come back with what they have." +
      "\n\nTap YES to book.",
  );
  assertEquals(p.text.length <= 300, true);
  assertEquals(p.message.kind === "buttons" && p.message.buttons, [{ id: "yes:p1", title: "YES, book it" }]);
  buildPayload("919812345678", p.message); // within Meta's limits
});

Deno.test("with book_on_first_call off, the read-back promises no booking", () => {
  const p = bookingReadback("p1", {
    place: paragon,
    f: { ...tonight, may_book: false },
    customerPhone: null,
    now,
  });
  assertEquals(
    p.text,
    "Paragon, Kannur Rd, Kozhikode\nTable for 4 · tonight (Fri 23 Oct), 7:30–9:00 pm\n\n" +
      "I'll call and ask what they have, then check with you before booking anything.\n\nTap YES to call.",
  );
});

Deno.test("an extra question for the call is in the read-back, so the YES covers it", () => {
  const p = bookingReadback("p1", {
    place: paragon,
    f: { ...tonight, may_book: true, max_advance_rs: 500, also_ask: "Do you have parking?" },
    customerPhone: null,
    now,
  });
  assertEquals(
    p.text.endsWith(`what they have. I'll also ask: "Do you have parking?"\n\nTap YES to book.`),
    true,
  );
});

Deno.test("with no advance allowed, the read-back says it won't agree to one", () => {
  const p = bookingReadback("p1", {
    place: paragon,
    f: { ...tonight, may_book: true, max_advance_rs: 0 },
    customerPhone: null,
    now,
  });
  assertEquals(p.text.includes("in your name (Ihaz). If they want an advance, I won't agree to it"), true);
});

Deno.test("question read-back shares nothing", () => {
  const p = questionReadback("p1", {
    place: { name: "Zudio", address: "Mavoor Rd, Kozhikode", city: null },
    f: { question: "Do you have the black jeans in size 32?" },
  });
  assertEquals(
    p.text,
    'Zudio, Mavoor Rd, Kozhikode\nI\'ll call and ask: "Do you have the black jeans in size 32?"\n' +
      "I won't book anything or share your name or number.\n\nTap YES to call.",
  );
});

const booking = {
  place: paragon,
  f: { party_size: 4, customer_name: "Ihaz" },
  time: new Date("2026-10-23T20:15:00+05:30"),
  customerName: "Ihaz",
  depositRs: null,
  knownFeeRs: null,
};

Deno.test("reschedule read-back asks to move, never to cancel", () => {
  const p = rescheduleReadback("p1", {
    booking,
    f: { window_start: "2026-10-23T21:00:00+05:30", window_end: "2026-10-23T21:30:00+05:30", may_book: true },
    now,
  });
  assertEquals(
    p.text,
    "Paragon · your table for 4, tonight 8:15 pm (Ihaz)\nI'll call and ask to move it to tonight " +
      "(Fri 23 Oct), 9:00–9:30 pm. If they can, I'll move it. If not, I'll ask them to keep 8:15 pm " +
      "and check with you.\n\nTap YES to call.",
  );
});

Deno.test("cancel read-back: YES with no known loss, CANCEL with a deposit", () => {
  const free = cancelReadback("p1", { booking, now });
  assertEquals(free.confirmWord, "yes");
  assertEquals(
    free.text,
    "Paragon · your table for 4, tonight 8:15 pm (Ihaz)\nI'll call and cancel it. If they mention a " +
      "charge, I won't agree to it; I'll check with you first.\n\nTap YES to cancel.",
  );
  const paid = cancelReadback("p1", { booking: { ...booking, depositRs: 500 }, now });
  assertEquals(paid.confirmWord, "cancel");
  assertEquals(paid.message.kind === "buttons" && paid.message.buttons, [{
    id: "cancel:p1",
    title: "CANCEL",
  }]);
  assertEquals(
    paid.text,
    "Paragon · your table for 4, tonight 8:15 pm (Ihaz)\nYou paid a Rs 500 advance, and they may keep " +
      "it. I'll ask about a refund, but cancelling could mean losing it.\n\nReply CANCEL to go ahead.",
  );
});

Deno.test("option list and Book-it prompt carry the prompt id in every row", () => {
  const opts = [
    { id: "o1", label: "9:30 pm", detail: null },
    { id: "o2", label: "9:45 pm", detail: "Rs 500 advance" },
  ];
  const list = optionsPrompt("p2", { place: paragon, options: opts });
  assertEquals(
    list.text,
    "Paragon can do:\n1. 9:30 pm\n2. 9:45 pm (Rs 500 advance)\n" +
      "Tap one or reply its number, and I'll call back to book it in your name.",
  );
  assertEquals(list.message.kind === "list" && list.message.rows.map((r) => r.id), [
    "pick:p2:o1",
    "pick:p2:o2",
  ]);
  buildPayload("919812345678", list.message);
  const one = bookItPrompt("p3", { place: paragon, option: opts[0] });
  assertEquals(one.text, "Book 9:30 pm at Paragon in your name?");
  assertEquals(one.optionIds, ["o1"]);
});
