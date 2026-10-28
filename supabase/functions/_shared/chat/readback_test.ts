import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildPayload } from "../whatsapp.ts";
import {
  bookingReadback,
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

// No plan has a button or asks for a typed word: each ends with a plain question.
function noButtonsNoYes(p: { text: string; message: { kind: string } }) {
  assertEquals(p.message.kind, "text");
  assertEquals(/\bYES\b|\btap\b|\breply\b/i.test(p.text), false, p.text);
  buildPayload("919812345678", p.message as never);
}

Deno.test("booking plan: what will happen, what is shared, what isn't agreed, then a plain question", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true, max_advance_rs: 500 },
    customerPhone: "+919812345678",
    now,
  });
  assertEquals(
    p.text,
    "I'll call Paragon, Kannur Rd, Kozhikode and book a table for 4, tonight (Fri 23 Oct), 7:30–9:00 pm, " +
      "in your name (Ihaz, +91 98…). If they want an advance of up to Rs 500, I'll hold it and you pay them " +
      "directly. If that isn't free, I won't book anything else; I'll come back to you with what they have." +
      "\n\nShall I go ahead?",
  );
  assertEquals(p.kind, "ask");
  noButtonsNoYes(p);
});

Deno.test("a note from Luna goes before the plan", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true, max_advance_rs: 0 },
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
    f: { ...tonight, may_book: true, max_advance_rs: 0, also_ask: "Do you have parking?" },
    customerPhone: null,
    now,
  });
  assertEquals(p.text.includes(`I'll also ask: "Do you have parking?".`), true);
});

Deno.test("with no advance allowed, the plan says it won't agree to one (P5)", () => {
  const p = bookingReadback({
    place: paragon,
    f: { ...tonight, may_book: true, max_advance_rs: 0 },
    customerPhone: null,
    now,
  });
  assertEquals(p.text.includes("in your name (Ihaz). If they want an advance, I won't agree to it."), true);
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
      "I won't book anything or share your name or number.\n\nShall I call them?",
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
  depositRs: null,
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
  const paid = cancelReadback({ booking: { ...booking, depositRs: 500 }, now });
  assertEquals(paid.confirmWord, "cancel");
  assertEquals(
    paid.text,
    "Paragon · your table for 4, tonight 8:15 pm (Ihaz)\nYou paid a Rs 500 advance, and they may keep " +
      "it. I'll ask about a refund, but cancelling could mean losing it.\n\nDo you still want me to cancel?",
  );
  noButtonsNoYes(paid);
});

Deno.test("options after a call: numbered text, picked in words", () => {
  const opts = [
    { id: "o1", label: "9:30 pm", detail: null },
    { id: "o2", label: "9:45 pm", detail: "they want an advance" },
  ];
  const list = optionsPrompt({
    place: paragon,
    options: opts,
    lead: "Paragon offered:",
    customerName: "Ihaz",
  });
  assertEquals(
    list.text,
    "Paragon offered:\n1. 9:30 pm\n2. 9:45 pm (they want an advance)\n\nTell me which one and I'll call " +
      "back to book it in your name (Ihaz). If one needs an advance, I won't agree to it without checking with you.",
  );
  assertEquals(list.kind, "options");
  assertEquals(list.optionIds, ["o1", "o2"]);
  noButtonsNoYes(list);
});
