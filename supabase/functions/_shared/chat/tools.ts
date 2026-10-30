// What Luna's action tools do (E4 design 2, L2). Luna proposes; this code checks,
// stores through the SQL functions and moves the state. Nothing here sends a plan:
// Luna asks for one with propose_plan when the conversation is ready (turn.ts).
// The dev test page calls these directly.
import type { User } from "../store.ts";
import { errandRef } from "./cards.ts";
import { checkSlots, collectingState, missing, type QuestionOps } from "./slots.ts";
import { group, type Task, TASKS } from "./states.ts";
import type { ActiveRequest } from "./store.ts";
import type { PromptDeps } from "./turn.ts";

export type ToolDeps = PromptDeps & { trace?: (event: string, data: unknown) => void };

// The tool result goes back to Luna as is, so reasons are short and plain.
export type ToolResult = { ok: true; [k: string]: unknown } | {
  ok: false;
  reason: string;
  errors?: string[];
  [k: string]: unknown;
};

// mode "replace": the new errand takes the place of the current one, whose details are
// dropped, so code refuses unless Luna has asked first (confirm_replace). A request with
// at most one detail, or one in flight (the new one then waits), goes ahead without
// asking (E4 design 2.5). mode "after": the new errand waits behind the current one,
// keeping both (queue_request).
export async function startNewRequest(
  deps: ToolDeps,
  user: User,
  task: Task,
  confirmReplace = false,
  mode: "replace" | "after" = "replace",
): Promise<ToolResult> {
  if (!TASKS.includes(task)) {
    return {
      ok: false,
      reason: "changing or cancelling bookings isn't available yet. Say so once, plainly, and that they " +
        "should contact the place directly. Don't collect details for it",
    };
  }
  if (mode === "after") {
    const res = await deps.store.queueRequest(user.id, task);
    deps.trace?.("queue_request", res);
    return res.ok ? { ok: true, errand: errandRef(res.request_id), state: res.state } : res;
  }
  const { request: cur } = await deps.store.active(user.id);
  if (!confirmReplace && cur && wouldLose(cur)) {
    const where = cur.businessId ? ` at ${(await deps.store.place(cur.businessId)).name}` : "";
    const res = {
      ok: false as const,
      reason: `this would drop the open ${cur.task}${where}. Ask what they want: drop it, keep it and do ` +
        "this one after (mode after), or change it (set_slots, find_business). Call again with " +
        "confirm_replace only if they say to drop it",
    };
    deps.trace?.("replace_guard", res);
    return res;
  }
  const res = await deps.store.startRequest(user.id, task);
  deps.trace?.("start_request", res);
  return {
    ok: true,
    errand: errandRef(res.request_id),
    state: res.state,
    replaced: !!res.replaced_request_id,
  };
}

function wouldLose(r: ActiveRequest): boolean {
  const g = group(r.state);
  if (g === "after_call_1" || r.state === "awaiting_yes") return true;
  if (g !== "before_consent") return false;
  return Object.keys(r.fields).length + (r.businessId ? 1 : 0) >= 2;
}

// The errand a tool acts on: the one named by ref, else the current one, else the
// first waiting one.
export async function target(deps: ToolDeps, user: User, ref?: string | null): Promise<ActiveRequest | null> {
  const { request } = await deps.store.active(user.id);
  const waiting = await deps.store.queuedList(user.id);
  if (ref) {
    const want = ref.trim().toLowerCase().replace(/^r-/, "");
    return [request, ...waiting].find((r) => r && r.id.toLowerCase().startsWith(want)) ?? null;
  }
  return request ?? waiting[0] ?? null;
}

// Reschedule and cancel (E4 design 2.7, 2.9): the Desk booking the user means. One match
// is set on the current change errand; several are listed with refs to choose by.
export async function findBooking(deps: ToolDeps, user: User, hint: string): Promise<ToolResult> {
  const all = await deps.store.upcomingBookings(user.id);
  if (!all.length) {
    return {
      ok: false,
      reason:
        "they have no upcoming bookings made by the Desk. Only those can be changed; offer to book fresh",
    };
  }
  const h = hint.toLowerCase();
  const words = h.split(/[^a-z0-9&]+/).filter((w) => w.length > 2);
  const hits = all.filter((b) =>
    b.id.startsWith(h.trim()) || b.reference?.toLowerCase() === h.trim() ||
    words.some((w) => b.place.toLowerCase().includes(w) || (b.what ?? "").toLowerCase().includes(w))
  );
  const list = hits.length ? hits : all;
  const show = (b: (typeof all)[number]) => ({
    ref: b.id.slice(0, 8),
    place: b.place,
    what: b.what,
    time: b.time?.toISOString() ?? null,
    held_for_payment: b.status === "held_pending_deposit",
  });
  const { request } = await deps.store.active(user.id);
  const change = request && (request.task === "reschedule" || request.task === "cancel") ? request : null;
  if (list.length === 1 && change) {
    const res = await deps.store.setRequestBooking(change.id, list[0].id);
    deps.trace?.("set_request_booking", res);
    if (!res.ok) return { ok: false, reason: `that booking can't be changed (${res.reason})` };
    return { ok: true, booking: show(list[0]), set_on: errandRef(change.id) };
  }
  return {
    ok: true,
    bookings: list.map(show),
    next: change
      ? "ask which one, then find_booking with its ref"
      : "start a reschedule or cancel errand first",
  };
}

const NO_ERRAND = { ok: false as const, reason: "no such errand; use the errand ref from the TASK card" };

export async function cancelActive(deps: ToolDeps, user: User, ref?: string | null): Promise<ToolResult> {
  const r = await target(deps, user, ref);
  if (!r) return ref ? NO_ERRAND : { ok: false, reason: "no_active_request" };
  const res = await deps.store.cancelRequest(r.id);
  deps.trace?.("cancel_request", res);
  if (!res.ok) return res;
  // The next waiting errand, if any, becomes current.
  const next = await deps.store.activateQueued(user.id);
  deps.trace?.("activate_queued", next);
  return next.request_id ? { ok: true, now_current: errandRef(next.request_id) } : { ok: true };
}

export async function setSlots(
  deps: ToolDeps,
  user: User,
  patch: Record<string, unknown>,
  ops: QuestionOps = {},
  ref?: string | null,
): Promise<ToolResult> {
  const r = await target(deps, user, ref);
  if (!r) return ref ? NO_ERRAND : { ok: false, reason: "no_active_request; start_new_request first" };
  const check = checkSlots(r.task, r.fields, patch, deps.now?.() ?? new Date(), ops);
  deps.trace?.("check_slots", check);
  if (!check.ok) return { ok: false, reason: "invalid", errors: check.errors };
  const res = await deps.store.updateSlots(r.id, check.patch);
  deps.trace?.("update_slots", res);
  if (!res.ok) return res;
  return settle(deps, user, r.id);
}

// After the user picks a place (choose_business, or the dev page).
export async function setBusiness(
  deps: ToolDeps,
  user: User,
  businessId: string,
  ref?: string | null,
): Promise<ToolResult> {
  if (!UUID.test(businessId)) return { ok: false, reason: UNKNOWN_BUSINESS };
  const r = await target(deps, user, ref);
  if (!r) return ref ? NO_ERRAND : { ok: false, reason: "no_active_request" };
  const res = await deps.store.setBusiness(r.id, businessId);
  deps.trace?.("set_business", res);
  if (!res.ok) return res;
  return settle(deps, user, r.id);
}

// Moves a collecting request to where its slots put it, and says what is still needed.
// An edit to a plan already sent closes it (the version bump in update_slots), so the
// user's next "ok" can't approve the old one; Luna proposes again when ready.
async function settle(deps: ToolDeps, user: User, requestId: string): Promise<ToolResult> {
  const r = await deps.store.request(requestId);
  const errand = errandRef(r.id);
  if (group(r.state) !== "before_consent") return { ok: true, errand, state: r.state };
  const info = await deps.store.user(user.id);
  const mayBook = r.task === "booking"
    ? await deps.store.limitBool("book_on_first_call", user.id)
    : undefined;
  const has = { business: !!r.businessId, booking: !!r.bookingId, profileName: !!info.name, mayBook };
  const to = collectingState(r.task, r.fields, has);
  if (r.state !== to) {
    await deps.store.advance(r.id, to);
    deps.trace?.("advance", { from: r.state, to });
  }
  const need = missing(r.task, r.fields, has);
  return {
    ok: true,
    errand,
    state: to,
    ...(need.length ? { still_needed: need } : { ready: "propose_plan when they have nothing more to add" }),
    ...(r.state === "awaiting_yes" ? { plan: "the plan they saw is now out of date" } : {}),
    ...(r.pausedAt ? { paused: "no plan until they say to carry on" } : {}),
  };
}

// The user picked a place from find_business results. The id must exist; the plan names
// the place, so the user's approval covers it. With no saved city yet, the picked
// place's city becomes theirs, so the next search starts there.
export async function chooseBusiness(
  deps: ToolDeps,
  user: User,
  businessId: string,
  ref?: string | null,
): Promise<ToolResult> {
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
  return setBusiness(deps, user, businessId, ref);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_BUSINESS = "unknown business_id; use one from find_business or my_places";

// "Hang on, don't do anything yet": the plan closes and nothing is proposed, approved or
// called until resumeActive.
export async function pauseActive(deps: ToolDeps, user: User): Promise<ToolResult> {
  const r = await target(deps, user);
  if (!r) return { ok: false, reason: "no_active_request" };
  const res = await deps.store.pauseRequest(r.id);
  deps.trace?.("pause_request", res);
  return res.ok
    ? { ok: true, state: res.state, paused: "nothing is proposed or called until they're back" }
    : res;
}

// They're back: lift the pause. Luna proposes the plan again when they want to go on.
export async function resumeActive(deps: ToolDeps, user: User): Promise<ToolResult> {
  const r = await target(deps, user);
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

// Text from outside (search results now, call transcripts later) is data, not
// instructions (review item 10). Drop control and invisible formatting characters,
// collapse whitespace, cap the length.
export function cleanField(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max - 1) + "…" : t) : null;
}
