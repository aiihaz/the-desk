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
// area: the neighbourhood from Maps (0026), which tells two outlets apart.
export type Place = {
  name: string;
  address: string | null;
  city: string | null;
  area?: string | null;
  webNumber?: boolean;
};

// Who a plan will call, as a person would say it. A number found on the web is said, so
// the user can stop a call to the wrong number.
function callee(p: Place): string {
  return spokenPlace(p) + (p.webNumber ? " (on a number I found on the web, not on Google Maps)" : "");
}

export type Prompt = {
  kind: "ask";
  optionIds: string[];
  confirmWord: "yes" | "cancel";
  text: string;
  // The action without the closing question: what the plan writer words, asking for the
  // go-ahead itself. text keeps the question for when the readback goes out as it is.
  spec?: string;
  message: Outbound;
};

export function placeName(p: Place): string {
  const where = p.address ?? p.city;
  return where ? `${p.name}, ${where}` : p.name;
}

// "Mani's Dum Biryani in Bellandur": the name and area, which is enough to say which
// outlet. The business row keeps the exact listing, and the consent binds that row. A
// place saved before areas were kept has only its listing, which is still exact.
export function spokenPlace(p: Place): string {
  if (!p.area) return placeName(p);
  return p.name.toLowerCase().includes(p.area.toLowerCase()) ? p.name : `${p.name} in ${p.area}`;
}

// "2026-11-07T00:05+05:30": a moment as the clock in India shows it, for model inputs,
// so a check never reads the day from UTC.
export function istIso(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16) + "+05:30";
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

// "Sat 8 Nov 2026, 7:30 pm": what a follow-up call reads out, so the year is never left out.
export function fmtFull(d: Date): string {
  const t = ist(d);
  return `${t.wd} ${t.day} ${t.mon} ${t.y}, ${fmtTime(d)}`;
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
    // "tomorrow afternoon, 12:00–4:00 pm": their words, then the span the plan stands for.
    return f.day_part ? `${day(a, now)} ${f.day_part}, ${range}` : `${day(a, now)}, ${range}`;
  }
  if (f.exact_time) {
    const t = new Date(f.exact_time);
    const tol = f.tolerance_min ? ` (up to ${f.tolerance_min} min either way)` : "";
    return `${day(t, now)} at ${fmtTime(t)}${tol}`;
  }
  return "";
}

// "a table for 4", "your haircut for 2", "a dentist checkup". party_size with no service is
// a table.
function what(f: Fields, article: "a" | "your" = "a"): string {
  const thing = f.service ?? "table";
  return `${article} ${thing}${f.party_size ? ` for ${f.party_size}` : ""}`;
}

function rs(n: number): string {
  return `Rs ${n.toLocaleString("en-IN")}`;
}

// Every readback ends with its question in a paragraph of its own.
function ask(text: string, word: "yes" | "cancel" = "yes"): Prompt {
  const cut = text.lastIndexOf("\n\n");
  return {
    kind: "ask",
    optionIds: [],
    confirmWord: word,
    text,
    spec: cut > 0 ? text.slice(0, cut) : text,
    message: { kind: "text", body: text },
  };
}

// A short line of Luna's own before the plan, when there is one.
function withNote(note: string | null | undefined, text: string): string {
  return note?.trim() ? `${note.trim()}\n\n${text}` : text;
}

function serviceContext(f: Fields): string {
  if (f.visit) {
    return [
      f.service_address ? `They'd come to ${f.service_address}.` : "",
      f.service_details ? `The job: ${f.service_details}.` : "",
    ].filter(Boolean).map((text) => ` ${text}`).join("");
  }
  return [
    f.service_address ? `Service location: ${f.service_address}.` : "",
    f.service_details ? `Details: ${f.service_details}.` : "",
  ].filter(Boolean).map((text) => ` ${text}`).join("");
}

// "in your name (Ihaz)", or "under the name Priya" for a booking that isn't in theirs.
function whose(name: string | undefined, profileName: string | null | undefined): string {
  const theirs = profileName === undefined || !name ||
    name.trim().toLowerCase() === (profileName ?? "").trim().toLowerCase();
  return theirs ? `in your name (${name})` : `under the name ${name}`;
}

// A time left to the business inside a part of day: the call agrees one within the span.
function dayPartNote(f: Fields): string {
  return f.day_part && f.window_start && f.window_end ? ", at whatever time they can do in that window" : "";
}

// Plans lead with what will happen (place, what, when), then what will be shared, then
// one plain question. No call agrees an advance, so a plan doesn't mention one: if the
// business wants one, its terms come back to the user. f.may_book must already be set from
// limits, so the consent covers it.
// profileName: theirs, so a booking under someone else's name isn't read back as "your name".
export function bookingReadback(
  x: {
    place: Place;
    f: Fields;
    customerPhone: string | null;
    now: Date;
    note?: string | null;
    profileName?: string | null;
  },
): Prompt {
  const { place, f, now } = x;
  const price = f.max_price_rs !== undefined ? `, for up to ${rs(f.max_price_rs)}` : "";
  const what_ = `${what(f)}, ${fmtWhen(f, now, true)}${dayPartNote(f)}${price}`;
  const also = (f.also_ask ? ` I'll also ask: "${f.also_ask}".` : "") + serviceContext(f);
  if (!f.may_book) {
    return ask(withNote(
      x.note,
      `I'll call ${callee(place)} and ask if they can do ${what_}. I won't book anything or give ` +
        `your name or number yet; I'll come back to you with what they say.${also}\n\nShall I call them?`,
    ));
  }
  // The Desk can't take calls, so the number the plan gives is how the business reaches
  // them back. Whether it goes is said every time: their yes covers it for this call.
  const phone = f.share_phone === false
    ? "I won't give them your number, so they can't call you back; if they need it to book, I'll come back to you first."
    : x.customerPhone
    ? `I'll give them your number (${maskPhone(x.customerPhone)}) in case they need to reach you.`
    : "";
  return ask(withNote(
    x.note,
    `I'll call ${callee(place)} and book ${what_}, ${whose(f.customer_name, x.profileName)}.${
      phone ? ` ${phone}` : ""
    }${also ? " " : ""}` +
      `${also.trimStart()}` +
      "\n\nShall I go ahead?",
  ));
}

export function questionReadback(
  x: { place: Place; f: Fields; customerPhone?: string | null; note?: string | null },
): Prompt {
  const qs = currentQuestions(x.f);
  const asks = qs.length === 1 ? `"${qs[0]}"` : qs.map((q, i) => `\n${i + 1}. ${q}`).join("");
  const name = x.f.share_name ? `your name (${x.f.customer_name})` : null;
  const phone = x.f.share_phone && x.customerPhone ? `your number (${maskPhone(x.customerPhone)})` : null;
  const shared = [name, phone].filter(Boolean).join(" and ");
  const who = shared
    ? `I'll give them ${shared} so they know who's asking, and I won't book anything.`
    : "I won't book anything or share your name or number.";
  return ask(withNote(
    x.note,
    `I'll call ${callee(x.place)} and ask: ${asks}${
      serviceContext(x.f)
    }\n\n${who} If they offer to book, I'll check with ` +
      "you first.\n\nShall I call them?",
  ));
}

export type BookingSummary = {
  place: Place;
  f: Fields;
  // Null when the call gave no time; date then says the day, if it gave one.
  time: Date | null;
  date?: string | null;
  customerName: string;
  // An advance the user has paid: asked for and not paid isn't a loss.
  paidRs: number | null;
  knownFeeRs: number | null;
  // They said cancelling costs something, even with no amount.
  chargeStated?: boolean;
  // The business may not have this booking: the Desk couldn't confirm it.
  uncertain?: boolean;
};

// "Paragon · your table for 4, tonight 8:15 pm (Ihaz)"
function bookingLine(b: BookingSummary, now: Date): string {
  const at = b.time
    ? `${fmtDay(b.time, now)} ${fmtTime(b.time)}`
    : b.date
    ? `${fmtDate(b.date, now)}, no time confirmed`
    : "no time confirmed";
  return `${b.place.name} · ${what(b.f, "your")}, ${at} (${b.customerName})`;
}

// A date with no time: "tomorrow (Sat 8 Nov)". Noon, so no timezone moves the day.
export function fmtDate(date: string, now: Date): string {
  return fmtDayFull(new Date(`${date}T12:00:00+05:30`), now);
}

export function rescheduleReadback(x: { booking: BookingSummary; f: Fields; now: Date }): Prompt {
  const b = x.booking;
  const ifCan = x.f.may_book
    ? "If they can, I'll move it."
    : "If they can, I'll check with you before moving it.";
  return ask(
    `${bookingLine(b, x.now)}\nI'll call and ask to move it to ${fmtWhen(x.f, x.now, true)}. ${ifCan} ` +
      `If not, I'll ask them to keep ${b.time ? fmtTime(b.time) : "it as it is"} and check with you.${
        serviceContext(x.f)
      }` +
      "\n\nShall I call them?",
  );
}

// A known deposit or fee needs the user to accept the loss in so many words (2.9):
// confirm word "cancel", which the approval check holds to.
export function cancelReadback(x: { booking: BookingSummary; now: Date }): Prompt {
  const b = x.booking;
  const top = bookingLine(b, x.now);
  if (b.paidRs) {
    return ask(
      `${top}\nYou paid a ${rs(b.paidRs)} advance, and they may keep it. I'll ask about a refund, ` +
        "but cancelling could mean losing it.\n\nDo you still want me to cancel?",
      "cancel",
    );
  }
  if (b.knownFeeRs || b.chargeStated) {
    const fee = b.knownFeeRs ? rs(b.knownFeeRs) : "something, though they didn't say how much";
    return ask(
      `${top}\nThey said cancelling costs ${fee}. If you cancel, you may have to pay it.` +
        "\n\nDo you still want me to cancel?",
      "cancel",
    );
  }
  const unsure = b.uncertain ? "\nI couldn't confirm they have this booking, so I'll ask them about it." : "";
  return ask(
    `${top}${unsure}\nI'll call and cancel it. If they mention a charge, I won't agree to it; I'll check ` +
      "with you first.\n\nShall I call them?",
  );
}
