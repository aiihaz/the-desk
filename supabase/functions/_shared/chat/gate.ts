// L0 code gate (E4 design 2, L0). Pure: decides what an inbound message is before
// any model sees it. No model ever creates a consent; only a route from here can.
// The database re-checks every consent (record_consent), so this is the first of two checks.
import type { Inbound } from "../whatsapp.ts";
import type { State } from "./states.ts";

export type OpenPrompt = {
  id: string;
  kind: "ask" | "options" | "book";
  optionIds: string[];
  confirmWord: "yes" | "cancel";
  waMessageId: string | null;
};

export type GateContext = {
  state: State | null;
  // The open prompt of the active request, if any.
  prompt: OpenPrompt | null;
  // The Desk's last outbound message to this user.
  lastOutboundId: string | null;
  // The prompt this message quotes (a WhatsApp reply to any send of it, open or closed), else null.
  quotedPromptId: string | null;
  // The user has a booking held_pending_deposit (eng plan 2.2).
  heldDeposit: boolean;
  isAdmin: boolean;
};

export type Route =
  | { kind: "consent"; promptId: string; optionId: string | null; word: "yes" | "cancel" }
  // A tap or reply for a prompt that is no longer open: refuse, re-send the current one.
  | { kind: "stale_approval" }
  // A typed approval word while a prompt is open but not the last thing sent: re-send it.
  | { kind: "resend_prompt" }
  | { kind: "screenshot" }
  | { kind: "ask_screenshot" }
  | { kind: "command"; command: "stop" | "delete_data" | "admin"; text: string }
  | { kind: "ignore" }
  // Free text, or a marker for media Luna can't read, goes to the router and Luna.
  | { kind: "luna"; text: string };

// Typed approvals. Short and fixed on purpose: anything else goes to Luna, which
// cannot consent. "ok" is left out because it is often only an acknowledgement.
// Needs a native speaker's review for hi, ml and ta.
const YES = new Set([
  "yes",
  "y",
  "yes please",
  "yeah",
  "yep",
  "yup",
  "haan",
  "haa",
  "han",
  "ha",
  "haan ji",
  "ji haan",
  "हाँ",
  "हां",
  "हाँ जी",
  "जी हाँ",
  "sari",
  "shari",
  "athe",
  "ശരി",
  "അതെ",
  "aam",
  "aama",
  "aamaa",
  "ஆம்",
  "ஆமா",
  "சரி",
]);

const PAID = new Set(["paid", "i paid", "i have paid", "payment done", "done paid", "paid it"]);

const ADMIN = /^(status|review|stop all|resume|credit\b|optout\b|limits|set limit\b|numbers|number off\b)/;

// Lower-case, trim, collapse spaces, drop trailing punctuation: "Yes!" → "yes".
export function normalise(text: string): string {
  return text.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!,]+$/u, "").trim();
}

export function classify(msg: Inbound, ctx: GateContext): Route {
  // 1. Button and list taps.
  if (msg.replyId) return tap(msg.replyId, ctx);

  // 2. Media. A screenshot while a deposit is held goes to the payment check.
  if (msg.type === "reaction") return { kind: "ignore" };
  if (msg.type === "image" && ctx.heldDeposit) return { kind: "screenshot" };
  if (msg.type !== "text") return { kind: "luna", text: mediaMarker(msg.type) };

  const raw = msg.text ?? "";
  const t = normalise(raw);

  // 3. Commands. STOP and delete always work, whatever the state or daily cap.
  if (ctx.isAdmin && ADMIN.test(t)) return { kind: "command", command: "admin", text: raw.trim() };
  if (t === "stop") return { kind: "command", command: "stop", text: raw.trim() };
  if (t === "delete my data") return { kind: "command", command: "delete_data", text: raw.trim() };

  // 4. Typed approvals bind to the open prompt if it was the last thing sent, or if the
  //    user quoted it (review item 12). Quoting an older prompt is refused like an old tap.
  const p = ctx.prompt;
  const approval = YES.has(t) || t === "cancel" || /^[1-9]$/.test(t);
  const quotedOpen = !!p && ctx.quotedPromptId === p.id;
  if (ctx.quotedPromptId && !quotedOpen && approval) return { kind: "stale_approval" };
  const bound = quotedOpen || (!!p?.waMessageId && p.waMessageId === ctx.lastOutboundId);
  if (p && p.kind === "ask") {
    const word = YES.has(t) ? "yes" : t === "cancel" ? "cancel" : null;
    if (word && word === p.confirmWord) {
      return bound ? { kind: "consent", promptId: p.id, optionId: null, word } : { kind: "resend_prompt" };
    }
  }
  if (p && p.kind === "book" && YES.has(t)) {
    return bound
      ? { kind: "consent", promptId: p.id, optionId: p.optionIds[0], word: "yes" }
      : { kind: "resend_prompt" };
  }
  // A bare digit picks from the option list ("Reply 1 or 2 to book").
  if (p && p.kind === "options" && bound && /^[1-9]$/.test(t)) {
    const i = Number(t) - 1;
    if (i < p.optionIds.length) {
      return { kind: "consent", promptId: p.id, optionId: p.optionIds[i], word: "yes" };
    }
  }

  // 5. "paid" with no screenshot.
  if (ctx.heldDeposit && PAID.has(t)) return { kind: "ask_screenshot" };

  return { kind: "luna", text: raw };
}

function tap(replyId: string, ctx: GateContext): Route {
  const [verb, promptId, optionId] = replyId.split(":");
  const p = ctx.prompt;
  if (!p || p.id !== promptId) return { kind: "stale_approval" };
  if ((verb === "yes" || verb === "cancel") && p.kind === "ask" && verb === p.confirmWord && !optionId) {
    return { kind: "consent", promptId, optionId: null, word: verb };
  }
  if (verb === "pick" && p.kind !== "ask" && optionId && p.optionIds.includes(optionId)) {
    return { kind: "consent", promptId, optionId, word: "yes" };
  }
  return { kind: "stale_approval" };
}

export function mediaMarker(type: string): string {
  switch (type) {
    case "audio":
      return "[voice note: not supported yet]";
    case "image":
      return "[image: not read]";
    case "sticker":
      return "[sticker]";
    case "video":
      return "[video: not supported]";
    case "document":
      return "[document: not read]";
    case "location":
      return "[location shared: not read yet]";
    case "contacts":
      return "[contact card: not read]";
    default:
      return `[${type}: not supported]`;
  }
}
