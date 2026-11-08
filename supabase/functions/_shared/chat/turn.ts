import type { CheckLog } from "./checks.ts";
import type { CheckIntent, GroundingResult } from "./intent_grounding.ts";
// One inbound turn through the deterministic part of the chat agent: code gate (L0),
// then the daily cap, then Luna (L1-L3). Nothing here reads approval: Luna proposes
// plans and reads the user's answer, approval.ts checks it, the database binds it.
import type { PlanChecker } from "./plan_writer.ts";
import type { User } from "../store.ts";
import type { Inbound, Outbound } from "../whatsapp.ts";
import { classify, type Route } from "./gate.ts";
import {
  bookingReadback,
  cancelReadback,
  istIso,
  type Place,
  type PlanFacts,
  planFacts,
  type Prompt,
  questionReadback,
  rescheduleReadback,
} from "./readback.ts";
import { incoherentTime, missing } from "./slots.ts";
import type { ChatStore, Refused } from "./store.ts";
import { WRONG_NUMBER } from "./tools.ts";

export type TurnDeps = {
  store: ChatStore;
  send: (user: User, msg: Outbound) => Promise<string>;
  isAdmin: (waId: string) => boolean;
  // Free text and media markers (Jev router, Luna, output check).
  luna: (user: User, text: string, msg: Inbound, turnStore?: ChatStore) => Promise<void>;
  // STOP, delete my data, admin commands.
  onCommand: (user: User, route: Extract<Route, { kind: "command" }>) => Promise<void>;
  // Payment screenshot (E7).
  onPayment: (
    user: User,
    route: Extract<Route, { kind: "screenshot" }>,
    msg: Inbound,
    turnStore?: ChatStore,
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
    case "luna": {
      // Reactions can answer a clarification as well as a calling plan. Let Luna
      // read the quoted conversation and decide whether an answer is needed.
      // Routing is never approval: approvePlan separately checks the exact plan,
      // its current version, the reaction's target, and subsequent corrections.
      return deps.luna(user, route.text, msg);
    }
  }
}

export async function sendTemplate(deps: PromptDeps, user: User, key: string): Promise<void> {
  const { language } = await deps.store.user(user.id);
  const text = await deps.store.template(key, language);
  if (!text) throw new Error(`no template ${key}`);
  await deps.send(user, { kind: "text", body: text });
}

export type PromptDeps = Pick<TurnDeps, "store" | "send" | "now" | "trace"> & {
  // Checks the plan Luna wrote against the stored action before it can be approved.
  checkPlan?: PlanChecker;
  // Luna's plan drafts refused so far this turn: after two, the readback goes instead.
  planRejections?: { count: number };
  checkIntent?: CheckIntent;
  // Where check results are recorded for diagnostics (checks.ts). Recording only.
  checks?: CheckLog;
  // What grounding refused this turn (refusalKey), so the same reading isn't checked, or
  // refused, again: repair has to be a different reading or a question.
  refused?: Map<string, { reason: string; clarification: string }>;
};

// Keys for PromptDeps.refused. An edit is the exact change on the version it was read
// against; a plan is the stored version itself.
export function refusalKey(
  phase: "edit" | "plan",
  requestId: string,
  version: number,
  patch?: unknown,
): string {
  return phase === "plan" ? `plan:${requestId}:${version}` : `edit:${requestId}:${version}:${stable(patch)}`;
}

// JSON with sorted keys, so the same change written in another order is the same change.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${
      Object.keys(v as Record<string, unknown>).sort()
        .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")
    }}`;
  }
  return JSON.stringify(v);
}

// What Luna gets back when grounding refuses: nothing changed, and the way to repair it.
export function refusal(
  g: { reason: string; clarification: string },
  repeated: boolean,
): { ok: false; reason: string; clarification: string; stored: "nothing"; next: string } {
  return {
    ok: false,
    reason: g.reason,
    clarification: g.clarification,
    stored: "nothing",
    next: (repeated ? "You already sent this and it was refused; it wasn't checked again. " : "") +
      "Reread their messages. If they settle this, store what they actually said (a different reading). " +
      "If they genuinely leave it open, ask them the clarification in your words. Don't ask for anything " +
      "they've already given.",
  };
}

// A grounding result as a diagnostic: its reason code, and its clarification as detail.
export function recordGrounding(
  log: CheckLog | undefined,
  g: GroundingResult,
  ids: { request_id: string; phase: string },
): void {
  if (!log) return;
  if (g.ok) {
    // An edit that changes nothing is passed without a model call: not a check that ran.
    const ran = g.evidence.length > 0 || ids.phase !== "edit";
    log.record({
      check: "grounding",
      outcome: "pass",
      category: "fidelity",
      reason: ran ? ids.phase : `${ids.phase}:nothing_to_check`,
      request_id: ids.request_id,
    });
    return;
  }
  const unavailable = g.reason === "grounding_unavailable";
  log.record({
    check: "grounding",
    outcome: unavailable ? "unusable" : "reject",
    category: unavailable ? "availability" : "fidelity",
    reason: `${ids.phase}:${
      unavailable
        ? (g.detail?.startsWith("model call failed") ? "model_error" : "unusable_verdict")
        : g.reason
    }`,
    request_id: ids.request_id,
    ...(unavailable ? {} : { detail: [g.clarification] }),
  });
}

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
  deps.trace?.("plan_sent", { prompt_id: promptId, request_id: requestId, wa_message_id: id });
  return { ok: true, promptId };
}

// The plan check gave no usable answer: the Desk's trouble, not a detail of theirs.
const UNCHECKED_PLAN = "the plan couldn't be checked on our side just now. Don't say it's ready and don't " +
  "ask them to repeat anything: say in a few words that you hit a snag putting it together and will try " +
  "again when they reply";

// Luna asked to propose the plan (propose_plan). Refused while anything is missing or the
// request is paused. First writes the code-only fields the consent must cover (may_book,
// tolerance, the profile name to book under), so a later change to a limit can't change
// what the user approved. note: a short line before the readback, when the readback is
// what goes out. text: the plan as Luna wrote it, which goes out once the check agrees.
export async function proposePlan(
  deps: PromptDeps,
  user: User,
  requestId: string,
  note: string | null = null,
  text: string | null = null,
): Promise<
  | { ok: true; promptId: string; text: string }
  | Refused
  | { ok: false; reason: string; [k: string]: unknown }
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
  // A plan, and the readback behind it, only ever describe a coherent state.
  const incoherent = incoherentTime(r.fields);
  if (incoherent.length) {
    return {
      ok: false,
      reason:
        "the stored time doesn't hold together, so no plan can describe it. Fix it with set_slots from " +
        "what they said; don't ask them for what they've already given",
      errors: incoherent,
    };
  }
  if (r.businessId && (await store.wrongNumberFor(user.id, r.businessId))) {
    return { ok: false, reason: WRONG_NUMBER };
  }
  if (r.task === "question" && r.fields.share_phone && !info.phone) {
    return { ok: false, reason: "no number on file to share" };
  }
  const planKey = refusalKey("plan", r.id, r.version);
  const before = deps.refused?.get(planKey);
  if (before) {
    deps.trace?.("plan_grounding_repeat", { request_id: requestId });
    deps.checks?.record({
      check: "grounding",
      outcome: "reject",
      category: "fidelity",
      reason: "plan:repeated",
      request_id: requestId,
    });
    return refusal(before, true);
  }
  if (deps.checkIntent) {
    const [messages, memories, addresses] = await Promise.all([
      store.history(user.id, new Date(now.getTime() - 24 * 3_600_000), 40),
      store.memories(user.id),
      store.addresses(user.id),
    ]);
    const grounded = await deps.checkIntent({
      phase: "plan",
      task: r.task,
      current: r.fields,
      patch: {},
      messages,
      memories,
      now,
      profile: { name: info.name, phone: info.phone, addresses },
    });
    deps.trace?.("plan_grounding", grounded);
    recordGrounding(deps.checks, grounded, { request_id: requestId, phase: "plan" });
    await store.assertTurn?.();
    if (!grounded.ok) {
      if (grounded.reason === "grounding_unavailable") return { ok: false, reason: UNCHECKED_PLAN };
      // The stored details themselves were refused: the repair is set_slots, which makes a
      // new version, or a question. The same version isn't checked again this turn.
      deps.refused?.set(planKey, grounded);
      return {
        ...refusal(grounded, false),
        next: "The stored details were refused, not your words. " + refusal(grounded, false).next,
      };
    }
  }
  if (r.state !== "confirming" && r.state !== "awaiting_yes") {
    if (r.state === "collecting" || r.state === "choosing_place") {
      await store.advance(r.id, "confirming");
      r = await store.request(requestId);
    } else return { ok: false, reason: "wrong_state" };
  }

  const code: Record<string, unknown> = {};
  if (mayBook !== undefined) code.may_book = mayBook;
  if (r.task === "booking" && mayBook && !r.fields.customer_name && info.name) {
    code.customer_name = info.name;
  }
  if (r.task === "question" && r.fields.share_name && !r.fields.customer_name && info.name) {
    code.customer_name = info.name;
  }
  if (r.fields.exact_time && r.fields.tolerance_min === undefined) {
    code.tolerance_min = 0;
  }
  if (Object.entries(code).some(([k, v]) => (r.fields as Record<string, unknown>)[k] !== v)) {
    const res = await store.updateSlots(requestId, code);
    if (!res.ok) return res;
    r = await store.request(requestId);
  }

  // The readback (last resort, exact by construction) and the facts the plan check reads
  // Luna's words against, from the same rows.
  let p: Prompt;
  let facts: PlanFacts;
  const place: Place | null = r.businessId && (r.task === "booking" || r.task === "question")
    ? await store.place(r.businessId)
    : null;
  switch (r.task) {
    case "booking":
      p = bookingReadback({
        place: place!,
        f: r.fields,
        customerPhone: info.phone,
        now,
        note,
        profileName: info.name,
      });
      facts = planFacts({
        task: "booking",
        place: place!,
        f: r.fields,
        customerPhone: info.phone,
        now,
        profileName: info.name,
      });
      break;
    case "question":
      p = questionReadback({
        place: place!,
        f: r.fields,
        customerPhone: info.phone,
        note,
      });
      facts = planFacts({ task: "question", place: place!, f: r.fields, customerPhone: info.phone });
      break;
    case "reschedule": {
      const booking = await store.booking(r.bookingId!);
      p = rescheduleReadback({ booking, f: r.fields, now });
      facts = planFacts({ task: "reschedule", booking, f: r.fields, now });
      break;
    }
    case "cancel": {
      const booking = await store.booking(r.bookingId!);
      p = cancelReadback({ booking, now });
      facts = planFacts({ task: "cancel", booking, now });
      break;
    }
  }
  // Which words go out, and why: Luna's, or the readback and the reason (diagnostics).
  const runId = crypto.randomUUID();
  let source: { outcome: "writer" | "readback"; reason: string } = {
    outcome: "readback",
    reason: "no_checker",
  };
  if (deps.checkPlan) {
    const draft = text?.trim() ?? "";
    if (!draft) {
      return {
        ok: false,
        reason: "text: write the plan yourself, in this conversation's words, and propose_plan again",
        facts,
      };
    }
    const chat = await store.history(user.id, new Date(now.getTime() - 24 * 3_600_000), 24);
    const tried = deps.planRejections?.count ?? 0;
    const v = await deps.checkPlan(
      {
        task: r.task,
        facts,
        ...(place ? { place: { name: place.name, area: place.area ?? null, city: place.city } } : {}),
        chat: chat.map(({ from, text }) => ({ from, text })),
        language: info.language,
        now: istIso(now),
        timezone: "Asia/Kolkata",
      },
      draft,
      deps.checks,
      runId,
      tried + 1,
    );
    await store.assertTurn?.();
    if (v.ok) {
      p = { ...p, text: draft, message: { kind: "text", body: draft } };
      source = { outcome: "writer", reason: "checked" };
    } else if ("problems" in v) {
      if (deps.planRejections) deps.planRejections.count = tried + 1;
      // Luna fixes its own words; a second refusal this turn sends the exact readback.
      if (tried + 1 < 2) {
        return {
          ok: false,
          reason: `the plan doesn't match what the call will do: ${
            v.problems.join("; ")
          }. Fix those points in your own words and propose_plan again`,
          problems: v.problems,
          facts,
        };
      }
      source = { outcome: "readback", reason: "rejected_twice" };
    } else {
      source = { outcome: "readback", reason: `checker_${v.unusable}` };
    }
    if (source.outcome === "readback") {
      deps.trace?.("plan_readback_used", { request_id: requestId, why: source.reason });
    }
    const current = await store.request(requestId);
    if (current.version !== r.version || current.pausedAt) {
      deps.checks?.record({
        check: "plan_source",
        outcome: "error",
        reason: "plan_changed",
        run_id: runId,
        request_id: requestId,
      });
      return { ok: false, reason: "the plan changed while it was checked; read the current request again" };
    }
  }
  const sent = await sendPrompt(deps, user, requestId, p);
  deps.checks?.record({
    check: "plan_source",
    ...(sent.ok ? source : { outcome: "error" as const, reason: `not_sent:${sent.reason}` }),
    run_id: runId,
    request_id: requestId,
    prompt_id: sent.ok ? sent.promptId : null,
  });
  return sent.ok ? { ...sent, text: p.text } : sent;
}
