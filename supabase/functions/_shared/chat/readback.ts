// Code-built plans: what the Desk will say and agree to on a call, and the options after
// call 1 (eng plan 2 step 3, E4 design 2.6-2.9). The user approves exactly this text, in
// their own words, and the voice agent gets the same stored fields. Luna never writes
// these; it can put one short line of its own before a plan (note). No buttons and no
// "reply YES": each ends with a plain question, and approval is read in context
// (approval.ts). English only for now; translations need a native speaker's review.
import type { Outbound } from "../whatsapp.ts";
import { currentQuestions, type Fields } from "./slots.ts";

const TZ = "Asia/Kolkata";

// webNumber: the phone came from a web search, not Google Maps (eng plan 3.3).
export type Place = { name: string; address: string | null; city: string | null; webNumber?: boolean };

// Who a plan will call. A number found on the web is said, so the user can stop a call
// to the wrong number.
function callee(p: Place): string {
  return placeName(p) + (p.webNumber ? " (on a number I found on the web, not on Google Maps)" : "");
}

export type Prompt = {
  kind: "ask" | "options";
  optionIds: string[];
  confirmWord: "yes" | "cancel";
  text: string;
  message: Outbound;
};

export function placeName(p: Place): string {
  const where = p.address ?? p.city;
  return where ? `${p.name}, ${where}` : p.name;
}

// "+91 98…": enough for the user to recognise their own number.
export function maskPhone(e164: string): string {
  return e164.startsWith("+91") ? `+91 ${e164.slice(3, 5)}…` : `${e164.slice(0, 4)}…`;
}

function ist(
  d: Date,
): { y: number; m: number; day: number; h: number; min: number; wd: string; mon: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const mon = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, month: "short" }).format(d);
  return {
    y: +parts.year,
    m: +parts.month,
    day: +parts.day,
    h: +parts.hour,
    min: +parts.minute,
    wd: parts.weekday,
    mon,
  };
}

function sameDay(a: ReturnType<typeof ist>, b: ReturnType<typeof ist>) {
  return a.y === b.y && a.m === b.m && a.day === b.day;
}

// "8:15 pm", "11:00 am", "12:30 pm".
export function fmtTime(d: Date): string {
  const t = ist(d);
  const h12 = t.h % 12 === 0 ? 12 : t.h % 12;
  return `${h12}:${String(t.min).padStart(2, "0")} ${t.h < 12 ? "am" : "pm"}`;
}

// "tonight", "today", "tomorrow", or "Sat 25 Oct", relative to now in IST.
export function fmtDay(d: Date, now: Date): string {
  const t = ist(d);
  const n = ist(now);
  if (sameDay(t, n)) return t.h >= 17 ? "tonight" : "today";
  if (sameDay(t, ist(new Date(now.getTime() + 86_400_000)))) return "tomorrow";
  return `${t.wd} ${t.day} ${t.mon}`;
}

// "tomorrow (Sun 25 Oct)": the relative day plus the date, so a read-back is never ambiguous.
export function fmtDayFull(d: Date, now: Date): string {
  const rel = fmtDay(d, now);
  const t = ist(d);
  const date = `${t.wd} ${t.day} ${t.mon}`;
  return rel === date ? date : `${rel} (${date})`;
}

// "tonight, 7:30–9:00 pm", "tomorrow, 11:30 am–1:00 pm", "tonight at 8:00 pm".
// With full, the day carries its date: "tomorrow (Sun 25 Oct), 7:30–8:30 pm".
export function fmtWhen(f: Fields, now: Date, full = false): string {
  const day = full ? fmtDayFull : fmtDay;
  if (f.window_start && f.window_end) {
    const a = new Date(f.window_start);
    const b = new Date(f.window_end);
    if (!sameDay(ist(a), ist(b))) {
      return `${day(a, now)} ${fmtTime(a)} to ${day(b, now)} ${fmtTime(b)}`;
    }
    const ta = fmtTime(a);
    const tb = fmtTime(b);
    const range = ta.slice(-2) === tb.slice(-2) ? `${ta.slice(0, -3)}–${tb}` : `${ta}–${tb}`;
    return `${day(a, now)}, ${range}`;
  }
  if (f.exact_time) {
    const t = new Date(f.exact_time);
    const tol = f.tolerance_min ? ` (up to ${f.tolerance_min} min either way)` : "";
    return `${day(t, now)} at ${fmtTime(t)}${tol}`;
  }
  return "";
}

// "a table for 4", "your table for 4", or "table for 4" with article "".
function what(f: Fields, article: "a" | "your" | "" = "a"): string {
  const own = article === "your" ? "your " : "";
  if (f.service && f.party_size) return `${own}${f.service} for ${f.party_size}`;
  if (f.service) return `${own}${f.service}`;
  return `${article ? article + " " : ""}table for ${f.party_size}`;
}

function rs(n: number): string {
  return `Rs ${n.toLocaleString("en-IN")}`;
}

function ask(text: string, word: "yes" | "cancel" = "yes"): Prompt {
  return { kind: "ask", optionIds: [], confirmWord: word, text, message: { kind: "text", body: text } };
}

// A short line from Luna before the plan ("Found it."), when there is one.
function withNote(note: string | null | undefined, text: string): string {
  return note?.trim() ? `${note.trim()}\n\n${text}` : text;
}

// Plans lead with what will happen (place, what, when), then what will be shared and
// what the Desk won't agree to, then one plain question. f.may_book and f.max_advance_rs
// must already be set from limits, so the consent covers them.
export function bookingReadback(
  x: { place: Place; f: Fields; customerPhone: string | null; now: Date; note?: string | null },
): Prompt {
  const { place, f, now } = x;
  const price = f.max_price_rs !== undefined ? `, for up to ${rs(f.max_price_rs)}` : "";
  const what_ = `${what(f)}, ${fmtWhen(f, now, true)}${price}`;
  const also = f.also_ask ? ` I'll also ask: "${f.also_ask}".` : "";
  if (!f.may_book) {
    return ask(withNote(
      x.note,
      `I'll call ${callee(place)} and ask if they can do ${what_}. I won't book anything or give ` +
        `your name or number yet; I'll come back to you with what they say.${also}\n\nShall I call them?`,
    ));
  }
  const who = x.customerPhone ? `${f.customer_name}, ${maskPhone(x.customerPhone)}` : f.customer_name;
  const advance = f.max_advance_rs
    ? `If they want an advance of up to ${rs(f.max_advance_rs)}, I'll hold it and you pay them directly.`
    : "If they want an advance, I won't agree to it.";
  return ask(withNote(
    x.note,
    `I'll call ${callee(place)} and book ${what_}, in your name (${who}). ${advance} ` +
      `If that isn't free, I won't book anything else; I'll come back to you with what they have.${also}` +
      "\n\nShall I go ahead?",
  ));
}

export function questionReadback(x: { place: Place; f: Fields; note?: string | null }): Prompt {
  const qs = currentQuestions(x.f);
  const asks = qs.length === 1 ? `"${qs[0]}"` : qs.map((q, i) => `\n${i + 1}. ${q}`).join("");
  return ask(withNote(
    x.note,
    `I'll call ${callee(x.place)} and ask: ${asks}\n\nI won't book anything or share your name or ` +
      "number.\n\nShall I call them?",
  ));
}

export type BookingSummary = {
  place: Place;
  f: Fields;
  time: Date;
  customerName: string;
  depositRs: number | null;
  knownFeeRs: number | null;
};

// "Paragon · your table for 4, tonight 8:15 pm (Ihaz)"
function bookingLine(b: BookingSummary, now: Date): string {
  return `${b.place.name} · ${what(b.f, "your")}, ${fmtDay(b.time, now)} ${
    fmtTime(b.time)
  } (${b.customerName})`;
}

export function rescheduleReadback(x: { booking: BookingSummary; f: Fields; now: Date }): Prompt {
  const b = x.booking;
  const ifCan = x.f.may_book
    ? "If they can, I'll move it."
    : "If they can, I'll check with you before moving it.";
  return ask(
    `${bookingLine(b, x.now)}\nI'll call and ask to move it to ${fmtWhen(x.f, x.now, true)}. ${ifCan} ` +
      `If not, I'll ask them to keep ${fmtTime(b.time)} and check with you.\n\nShall I call them?`,
  );
}

// A known deposit or fee needs the user to accept the loss in so many words (2.9):
// confirm word "cancel", which the approval check holds to.
export function cancelReadback(x: { booking: BookingSummary; now: Date }): Prompt {
  const b = x.booking;
  const top = bookingLine(b, x.now);
  if (b.depositRs) {
    return ask(
      `${top}\nYou paid a ${rs(b.depositRs)} advance, and they may keep it. I'll ask about a refund, ` +
        "but cancelling could mean losing it.\n\nDo you still want me to cancel?",
      "cancel",
    );
  }
  if (b.knownFeeRs) {
    return ask(
      `${top}\nThey said cancelling costs ${rs(b.knownFeeRs)}. If you cancel, you may have to pay it.` +
        "\n\nDo you still want me to cancel?",
      "cancel",
    );
  }
  return ask(
    `${top}\nI'll call and cancel it. If they mention a charge, I won't agree to it; I'll check with you first.` +
      "\n\nShall I call them?",
  );
}

export type OptionRow = { id: string; label: string; detail: string | null };

// The options after call 1. The user picks one in their own words, and that pick is
// consent #2 for booking it (approval.ts).
export function optionsPrompt(
  x: { place: Place; options: OptionRow[]; lead: string; customerName: string | null },
): Prompt {
  const numbered = x.options.map((o, i) => `${i + 1}. ${o.label}${o.detail ? ` (${o.detail})` : ""}`);
  const who = x.customerName ? ` in your name (${x.customerName})` : "";
  const text = [
    x.lead,
    ...numbered,
    "",
    `Tell me which one and I'll call back to book it${who}. If one needs an advance, I won't agree to ` +
    "it without checking with you.",
  ].join("\n");
  return {
    kind: "options",
    optionIds: x.options.map((o) => o.id),
    confirmWord: "yes",
    text,
    message: { kind: "text", body: text },
  };
}
