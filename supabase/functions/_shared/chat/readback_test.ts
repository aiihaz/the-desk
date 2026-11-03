import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildPayload } from "../whatsapp.ts";
import {
  bookingReadback,
  cancelReadback,
  fmtDay,
  fmtWhen,
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

// No plan has a button or asks for a typed word: each ends with a plain question.
function noButtonsNoYes(p: { text: string; message: { kind: string } }) {
  assertEquals(p.message.kind, "text");
  assertEquals(/\bYES\b|\btap\b|\breply\b/i.test(p.text), false, p.text);
  buildPayload("919812345678", p.message as never);
}

Deno.test("booking plan: what will happen, what is shared, what isn't agreed, then a plain question", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true },
    customerPhone: "+919812345678",
    now,
  });
  assertEquals(
    p.text,
    "I'll call Paragon, Kannur Rd, Kozhikode and book a table for 4, tonight (Fri 23 Oct), 7:30–9:00 pm, " +
      "in your name (Ihaz, +91 98…). If that isn't free, or they want an advance, I won't agree to anything; " +
      "I'll come back to you with what they say.\n\nShall I go ahead?",
  );
  assertEquals(p.kind, "ask");
  noButtonsNoYes(p);
});

Deno.test("a note from Luna goes before the plan", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true },
    customerPhone: null,
    now,
    note: "Found it.",
  });
  assertEquals(p.text.startsWith("Found it.\n\nI'll call Paragon"), true);
});

Deno.test("with book_on_first_call off, the plan promises no booking and shares nothing", () => {
  const p = bookingReadback({ place: paragon, f: { ...tonight, may_book: false }, customerPhone: null, now });
  assertEquals(
    p.text,
    "I'll call Paragon, Kannur Rd, Kozhikode and ask if they can do a table for 4, tonight (Fri 23 Oct), " +
      "7:30–9:00 pm. I won't book anything or give your name or number yet; I'll come back to you with " +
      "what they say.\n\nShall I call them?",
  );
  noButtonsNoYes(p);
});

Deno.test("an extra question for the call is in the plan, so the approval covers it", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true, also_ask: "Do you have parking?" },
    customerPhone: null,
    now,
  });
  assertEquals(p.text.includes(`I'll also ask: "Do you have parking?".`), true);
});

Deno.test("no plan commits money: an advance only ever comes back to them", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true },
    customerPhone: null,
    now,
  });
  assertEquals(p.text.includes("in your name (Ihaz). If that isn't free, or they want an advance"), true);
  assertEquals(p.text.includes("Rs"), false);
});

Deno.test("question plan: one question quoted, several numbered; nothing shared", () => {
  const zudio = { name: "Zudio", address: "Mavoor Rd, Kozhikode", city: null };
  const one = questionReadback({
    place: zudio,
    f: { questions: ["Do you have the black jeans in size 32?"] },
  });
  assertEquals(
    one.text,
    'I\'ll call Zudio, Mavoor Rd, Kozhikode and ask: "Do you have the black jeans in size 32?"\n\n' +
      "I won't book anything or share your name or number. If they offer to book, I'll check with you first.\n\nShall I call them?",
  );
  noButtonsNoYes(one);
  const two = questionReadback({
    place: zudio,
    f: { questions: ["Walk-ins today?", "Do you take insurance?"] },
  });
  assertEquals(two.text.includes("ask: \n1. Walk-ins today?\n2. Do you take insurance?"), true);
  // A row stored before 0007 still reads.
  assertEquals(
    questionReadback({ place: zudio, f: { question: "Open Sunday?" } }).text.includes('"Open Sunday?"'),
    true,
  );
});

const booking = {
  place: paragon,
  f: { party_size: 4, customer_name: "Ihaz" },
  time: new Date("2026-10-23T20:15:00+05:30"),
  customerName: "Ihaz",
  paidRs: null,
  knownFeeRs: null,
};

Deno.test("reschedule plan asks to move, never to cancel", () => {
  const p = rescheduleReadback({
    booking,
    f: { window_start: "2026-10-23T21:00:00+05:30", window_end: "2026-10-23T21:30:00+05:30", may_book: true },
    now,
  });
  assertEquals(
    p.text,
    "Paragon · your table for 4, tonight 8:15 pm (Ihaz)\nI'll call and ask to move it to tonight " +
      "(Fri 23 Oct), 9:00–9:30 pm. If they can, I'll move it. If not, I'll ask them to keep 8:15 pm " +
      "and check with you.\n\nShall I call them?",
  );
  noButtonsNoYes(p);
});

Deno.test("cancel plan: a known loss needs the user to accept it in so many words", () => {
  const free = cancelReadback({ booking, now });
  assertEquals(free.confirmWord, "yes");
  noButtonsNoYes(free);
  const paid = cancelReadback({ booking: { ...booking, paidRs: 500 }, now });
  assertEquals(paid.confirmWord, "cancel");
  assertEquals(
    paid.text,
    "Paragon · your table for 4, tonight 8:15 pm (Ihaz)\nYou paid a Rs 500 advance, and they may keep " +
      "it. I'll ask about a refund, but cancelling could mean losing it.\n\nDo you still want me to cancel?",
  );
  noButtonsNoYes(paid);
});

Deno.test("a table recorded as a service still reads as a table", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, service: "table", may_book: true },
    customerPhone: null,
    now,
  });
  assertEquals(p.text.includes("book a table for"), true);
});
