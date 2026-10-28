// One inbound turn through the deterministic part of the chat agent: code gate (L0),
// then the daily cap, then Luna (L1-L3). Nothing here reads approval: Luna proposes
// plans and reads the user's answer, approval.ts checks it, the database binds it.
import type { User } from "../store.ts";
import type { Inbound, Outbound } from "../whatsapp.ts";
import { classify, type Route } from "./gate.ts";
import {
  bookingReadback,
  cancelReadback,
  type Prompt,
  questionReadback,
  rescheduleReadback,
} from "./readback.ts";
import { missing } from "./slots.ts";
import type { ChatStore, Refused } from "./store.ts";

export type TurnDeps = {
  store: ChatStore;
  send: (user: User, msg: Outbound) => Promise<string>;
  isAdmin: (waId: string) => boolean;
  // Free text and media markers (Jev router, Luna, output check).
  luna: (user: User, text: string, msg: Inbound) => Promise<void>;
  // STOP, delete my data, admin commands.
  onCommand: (user: User, route: Extract<Route, { kind: "command" }>) => Promise<void>;
  // Payment screenshot (E7).
  onPayment: (user: User, route: Extract<Route, { kind: "screenshot" }>, msg: Inbound) => Promise<void>;
  now?: () => Date;
  // Decision log (the dev test page shows it; production leaves it unset).
  trace?: (event: string, data: unknown) => void;
};

// Midnight IST, as an instant.
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
}

// msg is the last message of the turn; batch is the text of every message the turn
// took (claim_turn), oldest first. Luna reads them all from the history.
export async function handleTurn(
  user: User,
  msg: Inbound,
  deps: TurnDeps,
  batch: string[] = [],
): Promise<void> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const [{ request }, heldDeposit, info] = await Promise.all([
    store.active(user.id),
    store.heldDeposit(user.id),
    store.user(user.id),
  ]);
  const route = classify(msg, { heldDeposit, isAdmin: deps.isAdmin(user.waId), stopped: !!info.stoppedAt });
  deps.trace?.("gate", { route, state: request?.state ?? null, stopped: !!info.stoppedAt, batch });

  // STOP and delete my data always work, even over the daily cap.
  if (route.kind === "command") return deps.onCommand(user, route);

  const cap = await store.limitInt("max_inbound_per_user_per_day", user.id);
  if (cap !== null) {
    const n = await store.inboundSince(user.id, istDayStart(now));
    if (n > cap) {
      deps.trace?.("daily_cap", { inboundToday: n, cap });
      // One message says when the Desk replies again; later ones are stored, not answered.
      if (n === cap + 1) await sendTemplate(deps, user, "daily_cap");
      return;
    }
  }

  if (request) await store.touch(request.id, now);

  switch (route.kind) {
    case "ignore":
      return;
    case "stopped":
      return sendTemplate(deps, user, "stopped_reminder");
    case "screenshot":
      return deps.onPayment(user, route, msg);
    case "luna":
      return deps.luna(user, route.text, msg);
  }
}

export async function sendTemplate(deps: PromptDeps, user: User, key: string): Promise<void> {
  const { language } = await deps.store.user(user.id);
  const text = await deps.store.template(key, language);
  if (!text) throw new Error(`no template ${key}`);
  await deps.send(user, { kind: "text", body: text });
}

export type PromptDeps = Pick<TurnDeps, "store" | "send" | "now">;

// Opens a prompt (a plan or an option list) on the request's current version and sends it.
export async function sendPrompt(
  deps: PromptDeps,
  user: User,
  requestId: string,
  p: Prompt,
): Promise<{ ok: true; promptId: string } | Refused> {
  const promptId = crypto.randomUUID();
  const opened = await deps.store.openPrompt(requestId, promptId, p);
  if (!opened.ok) return opened;
  const id = await deps.send(user, p.message);
  await deps.store.promptSent(promptId, id);
  return { ok: true, promptId };
}

// Luna asked to propose the plan (propose_plan). Refused while anything is missing or the
// request is paused. First writes the code-only fields the consent must cover (may_book,
// max_advance_rs, tolerance, the profile name to book under), so a later change to a
// limit can't change what the user approved. note: Luna's own short line before the plan.
export async function proposePlan(
  deps: PromptDeps,
  user: User,
  requestId: string,
  note: string | null = null,
): Promise<
  { ok: true; promptId: string; text: string } | Refused | { ok: false; reason: string; missing: string[] }
> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  let r = await store.request(requestId);
  if (r.pausedAt) return { ok: false, reason: "paused" };
  const info = await store.user(user.id);
  const mayBook = r.task === "booking" || r.task === "reschedule"
    ? await store.limitBool("book_on_first_call", user.id)
    : undefined;
  const need = missing(r.task, r.fields, {
    business: !!r.businessId,
    booking: !!r.bookingId,
    profileName: !!info.name,
    mayBook,
  });
  if (need.length) return { ok: false, reason: "not ready", missing: need };
  if (r.state !== "confirming" && r.state !== "awaiting_yes") {
    if (r.state === "collecting" || r.state === "choosing_place") {
      await store.advance(r.id, "confirming");
      r = await store.request(requestId);
    } else return { ok: false, reason: "wrong_state" };
  }

  const code: Record<string, unknown> = {};
  if (mayBook !== undefined) code.may_book = mayBook;
  if (r.task === "booking") {
    code.max_advance_rs = await store.limitInt("max_advance_rs", user.id) ?? 0;
    if (mayBook && !r.fields.customer_name && info.name) code.customer_name = info.name;
  }
  if (r.fields.exact_time && r.fields.tolerance_min === undefined) {
    code.tolerance_min = await store.limitInt("match_tolerance_minutes", user.id) ?? 0;
  }
  if (Object.entries(code).some(([k, v]) => (r.fields as Record<string, unknown>)[k] !== v)) {
    const res = await store.updateSlots(requestId, code);
    if (!res.ok) return res;
    r = await store.request(requestId);
  }

  let p: Prompt;
  switch (r.task) {
    case "booking":
      p = bookingReadback({
        place: await store.place(r.businessId!),
        f: r.fields,
        customerPhone: info.phone,
        now,
        note,
      });
      break;
    case "question":
      p = questionReadback({ place: await store.place(r.businessId!), f: r.fields, note });
      break;
    case "reschedule":
      p = rescheduleReadback({ booking: await store.booking(r.bookingId!), f: r.fields, now });
      break;
    case "cancel":
      p = cancelReadback({ booking: await store.booking(r.bookingId!), now });
      break;
  }
  const sent = await sendPrompt(deps, user, requestId, p);
  return sent.ok ? { ...sent, text: p.text } : sent;
}
