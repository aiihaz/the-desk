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
  // The user sent STOP and not START since (users.stopped_at).
  stopped: boolean;
  // The active request is paused (requests.paused_at).
  paused: boolean;
  // This turn takes several different messages at once (claim_turn). An approval at the
  // end of a burst ("make it 7", "yes") would approve the plan before the edit: not consent.
  burst: boolean;
};

export type Route =
  | { kind: "consent"; promptId: string; optionId: string | null; word: "yes" | "cancel" }
  // A tap or reply for a prompt that is no longer open: refuse, re-send the current one.
  | { kind: "stale_approval" }
  // A typed approval word while a prompt is open but not the last thing sent: re-send it.
  | { kind: "resend_prompt" }
  | { kind: "screenshot" }
  | { kind: "ask_screenshot" }
  | { kind: "command"; command: "stop" | "start" | "delete_data" | "admin"; text: string }
  // Anything but START while stopped: say how to turn the Desk back on.
  | { kind: "stopped" }
  // An approval while the request is paused: nothing is open to approve; say so.
  | { kind: "paused" }
  | { kind: "ignore" }
  // Free text, or a marker for media Luna can't read, goes to the router and Luna.
  | { kind: "luna"; text: string };

// Typed approvals. Short and fixed on purpose: anything else goes to Luna, which
// cannot consent. Needs a native speaker's review for hi, ml and ta.
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

// Plain-words approvals (P2): "sure go ahead", "okay", "haan theek hai". A message counts
// only if it is made of these phrases and nothing else, so "yes but make it 7" (an edit)
// and "did you ask them yet?" go to Luna. Like YES, it binds only to a "yes" prompt that
// is the last thing sent or is quoted; a CANCEL prompt still needs the word CANCEL.
const ASSENT = [
  "ok",
  "okay",
  "okk",
  "okie",
  "sure",
  "alright",
  "all right",
  "fine",
  "go ahead",
  "go on",
  "go for it",
  "do it",
  "proceed",
  "confirm",
  "confirmed",
  "call them",
  "book it",
  "sounds good",
  "perfect",
  "theek hai",
  "thik hai",
  "chalo",
  "kar do",
  "karo",
  "ठीक है",
];
// Words that may go with an approval but are not one on their own ("please", "ji").
const ASSENT_FILLER = ["please", "pls", "plz", "ji", "then", "now"];
const ASSENT_PHRASES = [...YES, ...ASSENT, ...ASSENT_FILLER].map((p) => p.split(" "))
  .sort((a, b) => b.length - a.length);

export function isAssent(t: string): boolean {
  const words = t.replace(/[,.!]+/g, " ").split(" ").filter(Boolean);
  let core = false;
  for (let i = 0; i < words.length;) {
    const hit = ASSENT_PHRASES.find((p) => p.every((w, k) => words[i + k] === w));
    if (!hit) return false;
    if (!ASSENT_FILLER.includes(hit.join(" "))) core = true;
    i += hit.length;
  }
  return core;
}

const START = new Set(["start", "resume"]);

const PAID = new Set(["paid", "i paid", "i have paid", "payment done", "done paid", "paid it"]);

const ADMIN = /^(status|review|stop all|resume|credit\b|optout\b|limits|set limit\b|numbers|number off\b)/;

// Lower-case, trim, collapse spaces, drop trailing punctuation: "Yes!" → "yes".
export function normalise(text: string): string {
  return text.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!,]+$/u, "").trim();
}

// The command a message is, whatever the state. Code runs these before any wait or turn.
export function command(msg: Inbound, isAdmin: boolean): Extract<Route, { kind: "command" }> | null {
  if (msg.type !== "text" || msg.replyId) return null;
  const raw = (msg.text ?? "").trim();
  const t = normalise(raw);
  if (isAdmin && ADMIN.test(t)) return { kind: "command", command: "admin", text: raw };
  if (t === "stop") return { kind: "command", command: "stop", text: raw };
  if (t === "delete my data") return { kind: "command", command: "delete_data", text: raw };
  if (START.has(t)) return { kind: "command", command: "start", text: raw };
  return null;
}

export function classify(msg: Inbound, ctx: GateContext): Route {
  if (msg.type === "reaction") return { kind: "ignore" };

  // 1. Commands. STOP, START and delete always work, whatever the state or daily cap.
  //    START when not stopped is just a word, for Luna.
  const cmd = command(msg, ctx.isAdmin);
  if (cmd && (cmd.command !== "start" || ctx.stopped)) return cmd;

  // 2. Stopped: nothing else does anything until START (P1).
  if (ctx.stopped) return { kind: "stopped" };

  const raw = msg.text ?? "";
  const t = msg.type === "text" ? normalise(raw) : "";
  const yes = YES.has(t) || isAssent(t);
  const approval = yes || t === "cancel" || /^[1-9]$/.test(t);

  // 3. Paused: a tap or a typed approval has nothing open to approve (P3).
  if (ctx.paused && (msg.replyId || approval)) return { kind: "paused" };

  // 4. Button and list taps.
  if (msg.replyId) return tap(msg.replyId, ctx);

  // 5. Media. A screenshot while a deposit is held goes to the payment check.
  if (msg.type === "image" && ctx.heldDeposit) return { kind: "screenshot" };
  if (msg.type !== "text") return { kind: "luna", text: mediaMarker(msg.type) };

  // 6. Typed approvals bind to the open prompt if it was the last thing sent, or if the
  //    user quoted it (review item 12). Quoting an older prompt is refused like an old tap.
  //    At the end of a burst they go to Luna with the rest of it.
  const p = ctx.prompt;
  if (ctx.burst && approval) return { kind: "luna", text: raw };
  const quotedOpen = !!p && ctx.quotedPromptId === p.id;
  if (ctx.quotedPromptId && !quotedOpen && approval) return { kind: "stale_approval" };
  const bound = quotedOpen || (!!p?.waMessageId && p.waMessageId === ctx.lastOutboundId);
  if (p && p.kind === "ask") {
    const word = t === "cancel" ? "cancel" : yes ? "yes" : null;
    if (word && word === p.confirmWord) {
      return bound ? { kind: "consent", promptId: p.id, optionId: null, word } : { kind: "resend_prompt" };
    }
  }
  if (p && p.kind === "book" && yes) {
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
