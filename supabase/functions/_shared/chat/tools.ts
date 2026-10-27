// What Luna's action tools do (E4 design 2, L2). Luna proposes; this code checks,
// stores through the SQL functions, moves the state, and sends the code-built
// read-back once nothing is missing. The dev test page calls these directly.
import type { User } from "../store.ts";
import { checkSlots, collectingState, rewordingProblem } from "./slots.ts";
import { group, type Task, TASKS } from "./states.ts";
import type { ActiveRequest, Refused } from "./store.ts";
import { bookItPrompt } from "./readback.ts";
import { presentReadback, type PromptDeps, sendPrompt } from "./turn.ts";

export type ToolDeps = PromptDeps & { trace?: (event: string, data: unknown) => void };

// The tool result goes back to Luna as is, so reasons are short and plain.
export type ToolResult = { ok: true; [k: string]: unknown } | {
  ok: false;
  reason: string;
  errors?: string[];
};

// Replacing drops what the user already gave, so code refuses unless Luna has asked
// first (confirm_replace). A request with at most one detail, or one in flight (the new
// one is queued), goes ahead without asking (E4 design 2.5).
export async function startNewRequest(
  deps: ToolDeps,
  user: User,
  task: Task,
  confirmReplace = false,
): Promise<ToolResult> {
  if (!TASKS.includes(task)) {
    return {
      ok: false,
      reason: "changing or cancelling bookings isn't available yet. Say so once, plainly, and that they " +
        "should contact the place directly. Don't collect details for it",
    };
  }
  const { request } = await deps.store.active(user.id);
  const cur = request ?? await deps.store.queued(user.id);
  // Another place for the same task is the same request with a new business; a new
  // request would drop the details they gave.
  if (cur && cur.task === task && group(cur.state) === "before_consent") {
    const res = {
      ok: false as const,
      reason: `there is already an open ${task}. To change the place, find_business and choose_business ` +
        "on it; to change details, set_slots. Its details stay. Only if they want to start over, " +
        "cancel_request first",
    };
    deps.trace?.("same_task_guard", res);
    return res;
  }
  if (!confirmReplace) {
    if (cur && wouldLose(cur)) {
      const where = cur.businessId ? ` at ${(await deps.store.place(cur.businessId)).name}` : "";
      const res = {
        ok: false as const,
        reason: `this would drop the open ${cur.task}${where}. Ask the user first; call again with ` +
          "confirm_replace only if they say to drop it",
      };
      deps.trace?.("replace_guard", res);
      return res;
    }
  }
  const res = await deps.store.startRequest(user.id, task);
  deps.trace?.("start_request", res);
  return res;
}

function wouldLose(r: ActiveRequest): boolean {
  const g = group(r.state);
  if (g === "after_call_1" || r.state === "awaiting_yes") return true;
  if (g !== "before_consent" && g !== "queued") return false;
  return Object.keys(r.fields).length + (r.businessId ? 1 : 0) >= 2;
}

export async function cancelActive(deps: ToolDeps, user: User): Promise<ToolResult> {
  const { request } = await deps.store.active(user.id);
  if (!request) return { ok: false, reason: "no_active_request" };
  const res = await deps.store.cancelRequest(request.id);
  deps.trace?.("cancel_request", res);
  return res;
}

// drop: what the user asked to remove from question or also_ask (rewordingProblem).
export async function setSlots(
  deps: ToolDeps,
  user: User,
  patch: Record<string, unknown>,
  drop: string[] = [],
): Promise<ToolResult> {
  const r = await current(deps, user);
  if (!r) return { ok: false, reason: "no_active_request" };
  const check = checkSlots(r.task, r.fields, patch, deps.now?.() ?? new Date());
  deps.trace?.("check_slots", check);
  if (!check.ok) return { ok: false, reason: "invalid", errors: check.errors };
  const reworded = rewordingProblem(r.fields, check.patch, drop);
  if (reworded) {
    deps.trace?.("reword_guard", reworded);
    return { ok: false, reason: reworded };
  }
  const res = await deps.store.updateSlots(r.id, check.patch);
  deps.trace?.("update_slots", res);
  if (!res.ok) return res;
  return settle(deps, user, r.id);
}

// After the user picks a place (find_business in step 3, or the dev page).
export async function setBusiness(deps: ToolDeps, user: User, businessId: string): Promise<ToolResult> {
  if (!UUID.test(businessId)) return { ok: false, reason: UNKNOWN_BUSINESS };
  const r = await current(deps, user);
  if (!r) return { ok: false, reason: "no_active_request" };
  const res = await deps.store.setBusiness(r.id, businessId);
  deps.trace?.("set_business", res);
  if (!res.ok) return res;
  return settle(deps, user, r.id);
}

// The queued request if one exists and nothing is active, else the active one.
// A queued request still collects slots (2.5).
async function current(deps: ToolDeps, user: User): Promise<ActiveRequest | null> {
  const { request } = await deps.store.active(user.id);
  return request ?? await deps.store.queued(user.id);
}

// Moves a collecting request to where its slots put it, and sends the read-back
// when nothing is missing. A queued request is left alone until it activates.
async function settle(deps: ToolDeps, user: User, requestId: string): Promise<ToolResult> {
  const r = await deps.store.request(requestId);
  if (group(r.state) !== "before_consent") return { ok: true, state: r.state };
  const to = collectingState(r.task, r.fields, { business: !!r.businessId, booking: !!r.bookingId });
  if (r.state !== "awaiting_yes" && r.state !== to) {
    await deps.store.advance(r.id, to);
    deps.trace?.("advance", { from: r.state, to });
  }
  if (to !== "confirming") return { ok: true, state: to };
  if (r.state === "awaiting_yes") return { ok: true, state: r.state };
  if (r.pausedAt) return { ok: true, state: to, paused: "no read-back until they say to carry on" };
  const sent: { ok: true; promptId: string } | Refused = await presentReadback(deps, user, r.id);
  deps.trace?.("read_back", sent);
  return sent.ok ? { ok: true, state: "awaiting_yes", prompt_id: sent.promptId } : sent;
}

// The user picked a place from find_business results. The id must exist; the
// read-back names the place, so the user's YES confirms it. With no saved city yet,
// the picked place's city becomes theirs, so the next search starts there.
export async function chooseBusiness(deps: ToolDeps, user: User, businessId: string): Promise<ToolResult> {
  // Checked before the database: a made-up id ("PLACEHOLDER", a name) is not a uuid and
  // would fail the query, and with it the whole turn.
  if (!UUID.test(businessId) || !(await deps.store.businessExists(businessId))) {
    return { ok: false, reason: UNKNOWN_BUSINESS };
  }
  if (!(await deps.store.user(user.id)).city) {
    const { city } = await deps.store.place(businessId);
    if (city) {
      await deps.store.setCity(user.id, city);
      deps.trace?.("set_city", { city, from: "picked place" });
    }
  }
  return setBusiness(deps, user, businessId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_BUSINESS = "unknown business_id; use one from find_business or my_places";

// "Hang on, don't do anything yet": the read-back closes and nothing is sent or called
// until resumeActive. A YES meanwhile gets the paused_hold template (gate).
export async function pauseActive(deps: ToolDeps, user: User): Promise<ToolResult> {
  const r = await current(deps, user);
  if (!r) return { ok: false, reason: "no_active_request" };
  const res = await deps.store.pauseRequest(r.id);
  deps.trace?.("pause_request", res);
  return res.ok
    ? { ok: true, state: res.state, paused: "nothing is sent or called until they're back" }
    : res;
}

// They're back: lift the pause, and send the read-back again if nothing is missing.
export async function resumeActive(deps: ToolDeps, user: User): Promise<ToolResult> {
  const r = await current(deps, user);
  if (!r) return { ok: false, reason: "no_active_request" };
  const res = await deps.store.resumeRequest(r.id);
  deps.trace?.("resume_request", res);
  if (!res.ok) return res;
  return settle(deps, user, r.id);
}

// A saved place by label or alias ("paragon", "the usual biryani place").
export async function myPlaces(deps: ToolDeps, user: User, label: string): Promise<ToolResult> {
  const hit = await deps.store.myPlace(user.id, label);
  return hit ? { ok: true, ...hit } : { ok: false, reason: "no saved place with that name" };
}

// "the second one" / "9:30 wala": code sends a Book-it button for that option.
// Not a consent: the tap (or a typed YES) on that button is.
export async function pickOption(deps: ToolDeps, user: User, number: number): Promise<ToolResult> {
  const { request } = await deps.store.active(user.id);
  if (!request || group(request.state) !== "after_call_1") {
    return { ok: false, reason: "no options to pick from" };
  }
  const options = await deps.store.liveOptions(request.id);
  const option = options[number - 1];
  if (!option) return { ok: false, reason: `there are ${options.length} options` };
  const place = await deps.store.place(request.businessId!);
  const sent = await sendPrompt(deps, user, request.id, (id) => bookItPrompt(id, { place, option }));
  deps.trace?.("book_it_prompt", sent);
  return sent.ok ? { ok: true, sent: "Book-it button", option: option.label } : sent;
}

// Text from outside (search results now, call transcripts later) is data, not
// instructions (review item 10). Drop control and invisible formatting characters,
// collapse whitespace, cap the length.
export function cleanField(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max - 1) + "…" : t) : null;
}
