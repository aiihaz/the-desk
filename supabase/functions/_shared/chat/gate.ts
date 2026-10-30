// L0 code gate (E4 design 2, L0). Pure: decides what an inbound message is before any
// model sees it. Only what must never depend on a model is decided here: STOP, START and
// "delete my data", and that nothing else happens while the user is stopped. Approvals
// are not words to match: they are read in context by approval.ts, and the database
// re-checks every consent (record_consent), the plan version and the stop state.
import type { Inbound } from "../whatsapp.ts";

export type OpenPrompt = {
  id: string;
  kind: "ask" | "options" | "book";
  optionIds: string[];
  confirmWord: "yes" | "cancel";
  waMessageId: string | null;
  // When the plan was first sent, and its exact text: approval is read from what came after.
  sentAt: Date;
  text: string;
};

export type GateContext = {
  // The user has a booking held_pending_deposit (eng plan 2.2).
  heldDeposit: boolean;
  isAdmin: boolean;
  // The user sent STOP and not START since (users.stopped_at).
  stopped: boolean;
};

export type Route =
  | { kind: "screenshot" }
  | { kind: "command"; command: "stop" | "start" | "delete_data" | "admin"; text: string }
  // Anything but START while stopped: say how to turn the Desk back on.
  | { kind: "stopped" }
  | { kind: "ignore" }
  // Free text, a tap on an old button, or a marker for media Luna can't read.
  | { kind: "luna"; text: string };

const START = new Set(["start", "resume"]);

// Whole words only, so an admin's "status of my booking?" is still a conversation.
const ADMIN =
  /^(status|review|stop all|resume|limits|numbers)$|^(credit|optout|set limit|number (on|off)|resolve) /;

// Lower-case, trim, collapse spaces, drop trailing punctuation: "Stop!" → "stop".
export function normalise(text: string): string {
  return text.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!,]+$/u, "").trim();
}

// The command a message is, whatever the state. Code runs these before any wait or turn.
// They are the published opt-out words, exact on purpose: "stop, wrong time" is a
// conversation for Luna, which can pause or cancel; a bare STOP stops everything.
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
  // A reaction is something the user said about one message (a 👍 on a plan); a removed
  // one says nothing.
  if (msg.type === "reaction" && !msg.text) return { kind: "ignore" };

  // 1. Commands. STOP, START and delete always work, whatever the state or daily cap.
  //    START when not stopped is just a word, for Luna.
  const cmd = command(msg, ctx.isAdmin);
  if (cmd && (cmd.command !== "start" || ctx.stopped)) return cmd;

  // 2. Stopped: nothing else does anything until START (P1).
  if (ctx.stopped) return { kind: "stopped" };

  // 3. A screenshot while a deposit is held goes to the payment check.
  if (msg.type === "image" && ctx.heldDeposit) return { kind: "screenshot" };

  // 4. Everything else is conversation. A tap on a button from an older message reads
  //    as its title, so Luna sees what was tapped.
  if (msg.replyId) return { kind: "luna", text: `[tapped: ${msg.text ?? msg.replyId}]` };
  if (msg.type === "reaction") return { kind: "luna", text: `[reacted ${msg.text}]` };
  if (msg.type !== "text") return { kind: "luna", text: mediaMarker(msg.type) };
  return { kind: "luna", text: msg.text ?? "" };
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
