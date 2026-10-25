// One inbound message through the deterministic part of the chat agent:
// code gate (L0) → daily cap → consent, re-send, or hand to Luna (L1-L3, step 2).
// Also builds and sends the code-built read-back once slots are complete.
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
import type { ChatStore, ConsentStored, Refused } from "./store.ts";

export type TurnDeps = {
  store: ChatStore;
  send: (user: User, msg: Outbound) => Promise<string>;
  isAdmin: (waId: string) => boolean;
  // Free text and media markers (step 2: Jev router, Luna, output check).
  luna: (user: User, text: string, msg: Inbound) => Promise<void>;
  // A stored consent: start the call (E6, through dial).
  onConsent: (user: User, consent: ConsentStored) => Promise<void>;
  // STOP, delete my data, admin commands (E7).
  onCommand: (user: User, route: Extract<Route, { kind: "command" }>) => Promise<void>;
  // Payment screenshot, or "paid" with no screenshot (E7).
  onPayment: (
    user: User,
    route: Extract<Route, { kind: "screenshot" | "ask_screenshot" }>,
    msg: Inbound,
  ) => Promise<void>;
  now?: () => Date;
  // Decision log (the dev test page shows it; production leaves it unset).
  trace?: (event: string, data: unknown) => void;
};

// Midnight IST, as an instant.
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000);
}

export async function handleTurn(user: User, msg: Inbound, deps: TurnDeps): Promise<void> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  const { request, prompt } = await store.active(user.id);
  const [lastOutboundId, heldDeposit, quotedPromptId] = await Promise.all([
    store.lastOutboundId(user.id),
    store.heldDeposit(user.id),
    msg.quotedId ? store.promptForMessage(user.id, msg.quotedId) : Promise.resolve(null),
  ]);
  const route = classify(msg, {
    state: request?.state ?? null,
    prompt,
    lastOutboundId,
    quotedPromptId,
    heldDeposit,
    isAdmin: deps.isAdmin(user.waId),
  });
  deps.trace?.("gate", {
    route,
    state: request?.state ?? null,
    prompt,
    lastOutboundId,
    quoted: msg.quotedId ? { message: msg.quotedId, prompt: quotedPromptId } : null,
    heldDeposit,
  });

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
    case "consent": {
      const res = await store.recordConsent(route.promptId, route.optionId, route.word, msg.messageId);
      deps.trace?.("consent", res);
      if (res.ok) return deps.onConsent(user, res);
      console.warn("consent refused", route.promptId, res.reason);
      return refuseStale(deps, user);
    }
    case "stale_approval":
      return refuseStale(deps, user);
    case "resend_prompt":
      return resendOpenPrompt(deps, user);
    case "screenshot":
    case "ask_screenshot":
      return deps.onPayment(user, route, msg);
    case "luna":
      return deps.luna(user, route.text, msg);
  }
}

async function sendTemplate(deps: TurnDeps, user: User, key: string): Promise<void> {
  const { language } = await deps.store.user(user.id);
  const text = await deps.store.template(key, language);
  if (!text) throw new Error(`no template ${key}`);
  await deps.send(user, { kind: "text", body: text });
}

// The approval was for something no longer shown: say so, then re-send what is current.
async function refuseStale(deps: TurnDeps, user: User): Promise<void> {
  const { prompt } = await deps.store.active(user.id);
  await sendTemplate(deps, user, prompt ? "stale_approval" : "stale_approval_none");
  if (prompt) await resend(deps, user, prompt.id);
}

async function resendOpenPrompt(deps: TurnDeps, user: User): Promise<void> {
  const { prompt } = await deps.store.active(user.id);
  if (prompt) await resend(deps, user, prompt.id);
}

// Same prompt row, same text and buttons; the new message becomes the one a typed YES binds to.
async function resend(deps: TurnDeps, user: User, promptId: string): Promise<void> {
  const id = await deps.send(user, await deps.store.promptMessage(promptId));
  await deps.store.promptSent(promptId, id);
}

export type PromptDeps = Pick<TurnDeps, "store" | "send" | "now">;

// Opens a prompt and sends it. The prompt id goes into the button ids, so it is made here.
export async function sendPrompt(
  deps: PromptDeps,
  user: User,
  requestId: string,
  build: (promptId: string) => Prompt,
): Promise<{ ok: true; promptId: string } | Refused> {
  const promptId = crypto.randomUUID();
  const p = build(promptId);
  const opened = await deps.store.openPrompt(requestId, promptId, p);
  if (!opened.ok) return opened;
  const id = await deps.send(user, p.message);
  await deps.store.promptSent(promptId, id);
  return { ok: true, promptId };
}

// Called by code once the slots are complete (state confirming). First writes the
// code-only fields the consent must cover (may_book, max_advance_rs, tolerance), so
// a later change to a limit can't change what the user approved.
export async function presentReadback(
  deps: PromptDeps,
  user: User,
  requestId: string,
): Promise<{ ok: true; promptId: string } | Refused> {
  const { store } = deps;
  const now = deps.now?.() ?? new Date();
  let r = await store.request(requestId);
  if (r.state !== "confirming" && r.state !== "awaiting_yes") return { ok: false, reason: "wrong_state" };

  const code: Record<string, unknown> = {};
  if (r.task === "booking" || r.task === "reschedule") {
    code.may_book = await store.limitBool("book_on_first_call", user.id);
  }
  if (r.task === "booking") code.max_advance_rs = await store.limitInt("max_advance_rs", user.id) ?? 0;
  if (r.fields.exact_time && r.fields.tolerance_min === undefined) {
    code.tolerance_min = await store.limitInt("match_tolerance_minutes", user.id) ?? 0;
  }
  if (Object.entries(code).some(([k, v]) => (r.fields as Record<string, unknown>)[k] !== v)) {
    const res = await store.updateSlots(requestId, code);
    if (!res.ok) return res;
    r = await store.request(requestId);
  }

  switch (r.task) {
    case "booking": {
      if (!r.businessId) return { ok: false, reason: "no_business" };
      const [place, info] = await Promise.all([store.place(r.businessId), store.user(user.id)]);
      return sendPrompt(
        deps,
        user,
        requestId,
        (id) => bookingReadback(id, { place, f: r.fields, customerPhone: info.phone, now }),
      );
    }
    case "question": {
      if (!r.businessId) return { ok: false, reason: "no_business" };
      const place = await store.place(r.businessId);
      return sendPrompt(deps, user, requestId, (id) => questionReadback(id, { place, f: r.fields }));
    }
    case "reschedule": {
      if (!r.bookingId) return { ok: false, reason: "no_booking" };
      const booking = await store.booking(r.bookingId);
      return sendPrompt(deps, user, requestId, (id) => rescheduleReadback(id, { booking, f: r.fields, now }));
    }
    case "cancel": {
      if (!r.bookingId) return { ok: false, reason: "no_booking" };
      const booking = await store.booking(r.bookingId);
      return sendPrompt(deps, user, requestId, (id) => cancelReadback(id, { booking, now }));
    }
  }
}
