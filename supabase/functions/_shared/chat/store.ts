// Database access for the chat agent. Every state change is an RPC into 0004_chat.sql,
// so version bumps, prompt closing and voiding happen in one transaction.
// The interface lets tests use a fake.
import type { CallKind } from "../sarvam.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import type { PlaceHit } from "../places.ts";
import { serviceClient } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import type { RecentRequest } from "./cards.ts";
import { mediaMarker, type OpenPrompt } from "./gate.ts";
import type { BookingSummary, Place, Prompt } from "./readback.ts";
import type { RouteLog } from "./router.ts";
import type { Fields } from "./slots.ts";
import type { State, Task } from "./states.ts";

export type ActiveRequest = {
  id: string;
  task: Task;
  state: State;
  version: number;
  fields: Fields;
  businessId: string | null;
  bookingId: string | null;
  createdAt: Date;
  // Set while the user has asked the Desk to wait (pause_request); no read-back goes out.
  pausedAt: Date | null;
};

export type UserInfo = {
  name: string | null;
  phone: string | null;
  language: string;
  city: string | null;
  // Set by STOP, cleared by START.
  stoppedAt: Date | null;
};

// claim_turn(): a turn takes every unhandled message up to its own as one batch.
export type TurnClaim =
  | { status: "claimed"; batch: string[] }
  | { status: "busy" | "newer" | "handled" };

export type Refused = { ok: false; reason: string };
export type Changed = { ok: true; changed: boolean; state: State; version: number };
export type ConsentStored = {
  ok: true;
  consent_id: string;
  kind: "ask" | "book" | "pay";
  request_id: string;
  option_id: string | null;
};

// One line of the WhatsApp conversation, as Luna sees it. quoted: the text of the
// message a WhatsApp reply quotes, so "this one" means what the user pointed at.
export type ChatLine = { from: "user" | "desk"; text: string; at: Date; quoted?: string };

// A finished call, for the report to the user (report.ts).
export type CallForReport = {
  callId: string;
  requestId: string;
  userId: string;
  waId: string;
  kind: CallKind;
  task: Task;
  // A redial (no answer, or a confirm call's second try).
  isRetry: boolean;
  businessId: string;
  // The business's number, for "please check with them".
  phone: string;
  // Booking calls: the option the user picked.
  option: { label: string; value: Record<string, unknown> } | null;
  // Payment confirm: the held booking's time. Cancel, reschedule: the booking's time.
  bookingTime: string | null;
};

// settle_call(): what a finished call did to its request (0007).
export type CallSettlement = {
  // held, retry, unconfirmed, cancelled: advances and booking changes (0011).
  result: "done" | "options" | "back" | "held" | "retry" | "unconfirmed" | "cancelled";
  options?: { label: string; value: Record<string, unknown>; advance_required: boolean }[];
  // done: verified means all three checks of eng plan 3.5 agreed (verify.ts); otherwise
  // the booking is stored as probably_booked and flagged, with the problems, for review.
  // held: the hold's payment details. back: fee_rs, a cancellation charge they stated.
  booking?: {
    time?: string | null;
    reference?: string | null;
    verified?: boolean;
    problems?: string[];
    amount_rs?: number | null;
    upi_id?: string | null;
    payee_name?: string | null;
    deadline?: string | null;
    fee_rs?: number | null;
    said?: string | null;
  } | null;
  optOut?: boolean;
};

export type UpcomingBooking = {
  id: string;
  status: string;
  time: Date | null;
  place: string;
  what: string | null;
  reference: string | null;
};

export type HeldBooking = {
  bookingId: string;
  requestId: string;
  businessId: string;
  amountRs: number | null;
  upiId: string | null;
  payeeName: string | null;
  deadline: Date | null;
  // When the hold call was made: a payment before it can't be for this hold.
  heldAt: Date;
  time: Date | null;
};

export type LiveOption = { id: string; label: string; detail: string | null };

export interface ChatStore {
  user(userId: string): Promise<UserInfo>;
  // The user's active request (not queued, not ended) and its open prompt.
  active(userId: string): Promise<{ request: ActiveRequest | null; prompt: OpenPrompt | null }>;
  // The oldest errand waiting behind the current one, if any.
  queued(userId: string): Promise<ActiveRequest | null>;
  // Every waiting errand, oldest first.
  queuedList(userId: string): Promise<ActiveRequest[]>;
  // An inbound message no turn has taken yet: the user said more while this turn ran.
  hasUnhandledInbound(userId: string): Promise<boolean>;
  request(requestId: string): Promise<ActiveRequest>;
  lastOutboundId(userId: string): Promise<string | null>;
  heldDeposit(userId: string): Promise<boolean>;
  inboundSince(userId: string, since: Date): Promise<number>;
  limitInt(key: string, userId: string): Promise<number | null>;
  limitBool(key: string, userId: string): Promise<boolean>;
  limitText(key: string, userId: string): Promise<string | null>;
  // Falls back to English; returns null if the key has no English row either.
  template(key: string, language: string): Promise<string | null>;
  place(businessId: string): Promise<Place>;
  booking(bookingId: string): Promise<BookingSummary>;
  // The last `limit` messages since `since`, oldest first, in the order the Desk stored
  // them (messages.seq), not by timestamp: WhatsApp's clock and ours can disagree.
  history(userId: string, since: Date, limit: number): Promise<ChatLine[]>;
  // Every message stored after this one (by seq), oldest first: what came after a plan.
  linesAfter(userId: string, waMessageId: string, limit: number): Promise<ChatLine[]>;
  // Unvoided options of a request, oldest first (the order the user saw them).
  liveOptions(requestId: string): Promise<LiveOption[]>;
  // The last 3 finished requests (done, cancelled, expired).
  recent(userId: string): Promise<RecentRequest[]>;
  placeLabels(userId: string): Promise<string[]>;
  // A saved place by label or alias, case-insensitive.
  myPlace(userId: string, label: string): Promise<{ label: string; business_id: string | null } | null>;
  businessExists(businessId: string): Promise<boolean>;
  // Upserts a search result by place_id (fresh phone and hours each search) and returns its id.
  savePlace(p: PlaceHit): Promise<string>;
  setCity(userId: string, city: string): Promise<void>;
  logRoute(log: RouteLog): Promise<void>;
  // One turn per user at a time, and a burst of messages is one turn (0006).
  claimTurn(userId: string, waMessageId: string, ttlS: number): Promise<TurnClaim>;
  releaseTurn(userId: string, waMessageId: string): Promise<void>;
  // A message handled outside a turn (a command), so no later batch counts it.
  markHandled(waMessageId: string): Promise<void>;
  // STOP, START, "delete my data" (0006). Stopping ends every request not yet calling.
  stopUser(userId: string): Promise<{ ok: true; cancelled: number; in_flight: boolean }>;
  resumeUser(userId: string): Promise<{ ok: true; was_stopped: boolean }>;
  requestDeletion(userId: string): Promise<{ ok: true; cancelled: number; in_flight: boolean }>;
  pauseRequest(requestId: string): Promise<{ ok: true; state: State } | Refused>;
  resumeRequest(requestId: string): Promise<{ ok: true; changed: boolean; state: State } | Refused>;
  // The consent's call could not start: the request ends.
  callNotStarted(requestId: string): Promise<{ ok: true } | Refused>;
  // Gate-mode redirects since `since`, for the daily redirect cap.
  redirectsSince(userId: string, since: Date): Promise<number>;

  touch(requestId: string, at: Date): Promise<void>;
  startRequest(userId: string, task: Task): Promise<{
    ok: true;
    request_id: string;
    state: State;
    replaced_request_id: string | null;
  }>;
  // A second errand behind the current one (queue_request).
  queueRequest(userId: string, task: Task): Promise<{ ok: true; request_id: string; state: State } | Refused>;
  // After an errand ends: the oldest waiting one becomes current.
  activateQueued(userId: string): Promise<{ ok: true; request_id: string | null }>;
  callForReport(callId: string): Promise<CallForReport | null>;
  // The request's latest call, for telling a retry from a new call.
  lastCall(requestId: string): Promise<{ kind: CallKind; status: string } | null>;
  // This user's upcoming Desk bookings (booked or held), soonest first.
  upcomingBookings(userId: string): Promise<UpcomingBooking[]>;
  setRequestBooking(requestId: string, bookingId: string): Promise<Changed | Refused>;
  // A payment screenshot's check result (record_payment, 0011).
  recordPayment(
    requestId: string,
    passed: boolean,
    payment: Record<string, unknown>,
  ): Promise<{ ok: true; consent_id: string | null } | Refused>;
  // The held booking waiting for this user's payment, with what the hold call said.
  heldBooking(userId: string): Promise<HeldBooking | null>;
  settleCall(
    callId: string,
    s: CallSettlement,
  ): Promise<{ ok: true; request_id: string; state: State; option_ids: string[] } | Refused>;
  cancelRequest(requestId: string): Promise<{ ok: true } | Refused>;
  setBusiness(requestId: string, businessId: string): Promise<Changed | Refused>;
  updateSlots(requestId: string, patch: Record<string, unknown>): Promise<Changed | Refused>;
  advance(requestId: string, to: "collecting" | "choosing_place" | "confirming"): Promise<{ ok: boolean }>;
  openPrompt(requestId: string, promptId: string, p: Prompt): Promise<{ ok: true } | Refused>;
  promptSent(promptId: string, waMessageId: string): Promise<void>;
  // The prompt a WhatsApp message showed (any send of it), for quote-replies.
  promptForMessage(userId: string, waMessageId: string): Promise<string | null>;
  promptMessage(promptId: string): Promise<Outbound>;
  recordConsent(
    promptId: string,
    optionId: string | null,
    word: "yes" | "cancel",
    waMessageId: string,
    basis?: Record<string, unknown>,
  ): Promise<ConsentStored | Refused>;
}

const ACTIVE: State[] = [
  "collecting",
  "choosing_place",
  "confirming",
  "awaiting_yes",
  "calling_1",
  "options_ready",
  "awaiting_pick",
  "calling_2",
  "verifying",
  "stale_options",
];

// deno-lint-ignore no-explicit-any
type Row = any;

function toRequest(r: Row): ActiveRequest {
  return {
    id: r.id,
    task: r.task,
    state: r.state,
    version: r.version,
    fields: r.fields ?? {},
    businessId: r.business_id,
    bookingId: r.booking_id,
    createdAt: new Date(r.created_at),
    pausedAt: r.paused_at ? new Date(r.paused_at) : null,
  };
}

const REQUEST_COLUMNS = "id, task, state, version, fields, business_id, booking_id, created_at, paused_at";

export class DbChatStore implements ChatStore {
  constructor(private db: SupabaseClient = serviceClient()) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  async user(userId: string): Promise<UserInfo> {
    const { data, error } = await this.db.from("users")
      .select("name, phone_e164, language, city, stopped_at").eq("id", userId).single();
    if (error) throw error;
    return {
      name: data.name,
      phone: data.phone_e164,
      language: data.language,
      city: data.city,
      stoppedAt: data.stopped_at ? new Date(data.stopped_at) : null,
    };
  }

  async active(userId: string) {
    const { data, error } = await this.db.from("requests")
      .select(REQUEST_COLUMNS)
      .eq("user_id", userId).in("state", ACTIVE).maybeSingle();
    if (error) throw error;
    if (!data) return { request: null, prompt: null };
    const { data: p, error: e2 } = await this.db.from("consent_prompts")
      .select("id, kind, option_ids, confirm_word, wa_message_id, sent_at, text_shown")
      .eq("request_id", data.id).is("closed_at", null)
      .order("sent_at", { ascending: false }).limit(1).maybeSingle();
    if (e2) throw e2;
    return {
      request: toRequest(data),
      prompt: p
        ? {
          id: p.id,
          kind: p.kind,
          optionIds: p.option_ids,
          confirmWord: p.confirm_word,
          waMessageId: p.wa_message_id,
          sentAt: new Date(p.sent_at),
          text: p.text_shown,
        }
        : null,
    };
  }

  async queued(userId: string): Promise<ActiveRequest | null> {
    return (await this.queuedList(userId))[0] ?? null;
  }

  async queuedList(userId: string): Promise<ActiveRequest[]> {
    const { data, error } = await this.db.from("requests")
      .select(REQUEST_COLUMNS)
      .eq("user_id", userId).eq("state", "queued")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data.map(toRequest);
  }

  async hasUnhandledInbound(userId: string): Promise<boolean> {
    const { count, error } = await this.db.from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("direction", "in").is("handled_at", null);
    if (error) throw error;
    return (count ?? 0) > 0;
  }

  async request(requestId: string): Promise<ActiveRequest> {
    const { data, error } = await this.db.from("requests")
      .select(REQUEST_COLUMNS).eq("id", requestId).single();
    if (error) throw error;
    return toRequest(data);
  }

  async lastOutboundId(userId: string): Promise<string | null> {
    const { data, error } = await this.db.from("messages")
      .select("wa_message_id").eq("user_id", userId).eq("direction", "out")
      .order("at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data?.wa_message_id ?? null;
  }

  async heldDeposit(userId: string): Promise<boolean> {
    const { data, error } = await this.db.from("bookings")
      .select("id, requests!bookings_request_id_fkey!inner(user_id)").eq("requests.user_id", userId)
      .eq("status", "held_pending_deposit").limit(1);
    if (error) throw error;
    return data.length > 0;
  }

  async inboundSince(userId: string, since: Date): Promise<number> {
    const { count, error } = await this.db.from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("direction", "in").gte("at", since.toISOString());
    if (error) throw error;
    return count ?? 0;
  }

  limitInt(key: string, userId: string) {
    return this.rpc<number | null>("limit_int", { p_key: key, p_user_id: userId });
  }

  limitBool(key: string, userId: string) {
    return this.rpc<boolean>("limit_bool", { p_key: key, p_user_id: userId });
  }

  limitText(key: string, userId: string) {
    return this.rpc<string | null>("limit_text", { p_key: key, p_user_id: userId });
  }

  async template(key: string, language: string): Promise<string | null> {
    const base = language.split("-")[0];
    const { data, error } = await this.db.from("reply_templates")
      .select("language, text").eq("key", key).in("language", [base, "en"]);
    if (error) throw error;
    const hit = data.find((r) => r.language === base) ?? data.find((r) => r.language === "en");
    if (hit && hit.language !== base) console.warn("template missing language", key, base);
    return hit?.text ?? null;
  }

  async place(businessId: string): Promise<Place> {
    const { data, error } = await this.db.from("businesses")
      .select("name, address, city").eq("id", businessId).single();
    if (error) throw error;
    return { name: data.name, address: data.address, city: data.city };
  }

  async booking(bookingId: string): Promise<BookingSummary> {
    const { data, error } = await this.db.from("bookings")
      .select(
        "time, deposit_amount, known_fee_rs, requests!bookings_request_id_fkey(fields, businesses(name, address, city))",
      )
      .eq("id", bookingId).single();
    if (error) throw error;
    const r = data as Row;
    const fields: Fields = r.requests.fields ?? {};
    return {
      place: r.requests.businesses,
      f: fields,
      time: new Date(r.time),
      customerName: fields.customer_name ?? "",
      depositRs: r.deposit_amount === null ? null : Number(r.deposit_amount),
      // A charge the business stated on an earlier cancel call (settle_call, 0011).
      knownFeeRs: r.known_fee_rs === null ? null : Number(r.known_fee_rs),
    };
  }

  async logRoute(l: RouteLog): Promise<void> {
    let messageId: string | null = null;
    if (l.waMessageId) {
      const { data } = await this.db.from("messages").select("id").eq("wa_message_id", l.waMessageId)
        .maybeSingle();
      messageId = data?.id ?? null;
    }
    const { error } = await this.db.from("router_log").insert({
      user_id: l.userId,
      message_id: messageId,
      request_id: l.requestId,
      jev_mode: l.jevMode,
      model: l.model,
      intent: l.intent,
      probabilities: l.probabilities,
      injection: l.injection,
      mode: l.mode,
      luna_tools: l.lunaTools,
      l3_result: l.l3Result,
      l3_failed: l.l3Failed,
      latency_ms: l.latencyMs,
      luna_model: l.lunaModel,
      luna_reasoning_effort: l.lunaEffort,
      luna_max_output_tokens: l.lunaMaxOutputTokens,
    });
    if (error) throw error;
  }

  async claimTurn(userId: string, waMessageId: string, ttlS: number): Promise<TurnClaim> {
    const res = await this.rpc<{ status: TurnClaim["status"]; batch?: Row[] }>("claim_turn", {
      p_user_id: userId,
      p_message_id: waMessageId,
      p_ttl_s: ttlS,
    });
    return res.status === "claimed"
      ? { status: "claimed", batch: (res.batch ?? []).map(inboundText) }
      : { status: res.status } as TurnClaim;
  }

  async releaseTurn(userId: string, waMessageId: string): Promise<void> {
    await this.rpc("release_turn", { p_user_id: userId, p_message_id: waMessageId });
  }

  async markHandled(waMessageId: string): Promise<void> {
    const { error } = await this.db.from("messages").update({ handled_at: new Date().toISOString() })
      .eq("wa_message_id", waMessageId).is("handled_at", null);
    if (error) throw error;
  }

  stopUser(userId: string) {
    return this.rpc<{ ok: true; cancelled: number; in_flight: boolean }>("stop_user", { p_user_id: userId });
  }

  resumeUser(userId: string) {
    return this.rpc<{ ok: true; was_stopped: boolean }>("resume_user", { p_user_id: userId });
  }

  requestDeletion(userId: string) {
    return this.rpc<{ ok: true; cancelled: number; in_flight: boolean }>("request_data_deletion", {
      p_user_id: userId,
    });
  }

  pauseRequest(requestId: string) {
    return this.rpc<{ ok: true; state: State } | Refused>("pause_request", { p_request_id: requestId });
  }

  resumeRequest(requestId: string) {
    return this.rpc<{ ok: true; changed: boolean; state: State } | Refused>("resume_request", {
      p_request_id: requestId,
    });
  }

  callNotStarted(requestId: string) {
    return this.rpc<{ ok: true } | Refused>("call_not_started", { p_request_id: requestId });
  }

  async redirectsSince(userId: string, since: Date): Promise<number> {
    const { count, error } = await this.db.from("router_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("jev_mode", "gate").eq("mode", "redirect").gte("at", since.toISOString());
    if (error) throw error;
    return count ?? 0;
  }

  // Inbound messages count once a turn has taken them, so a turn never answers a
  // message that arrived during it; the next turn does.
  async history(userId: string, since: Date, limit: number): Promise<ChatLine[]> {
    const { data, error } = await this.db.from("messages")
      .select("direction, body, at").eq("user_id", userId).gte("at", since.toISOString())
      .or("direction.eq.out,handled_at.not.is.null")
      .order("seq", { ascending: false }).limit(limit);
    if (error) throw error;
    return this.lines(data);
  }

  async linesAfter(userId: string, waMessageId: string, limit: number): Promise<ChatLine[]> {
    const { data: m, error: e1 } = await this.db.from("messages").select("seq")
      .eq("user_id", userId).eq("wa_message_id", waMessageId).maybeSingle();
    if (e1) throw e1;
    if (!m) return [];
    const { data, error } = await this.db.from("messages")
      .select("direction, body, at").eq("user_id", userId).gt("seq", m.seq)
      .or("direction.eq.out,handled_at.not.is.null")
      .order("seq", { ascending: false }).limit(limit);
    if (error) throw error;
    return this.lines(data);
  }

  // Newest-first rows → chat lines, oldest first, with quoted messages filled in.
  private async lines(data: Row[]): Promise<ChatLine[]> {
    const quotedOf = (b: Row) => b?.context?.id ?? b?.reaction?.message_id;
    const quotedIds = [...new Set(data.map((m: Row) => m.direction === "in" ? quotedOf(m.body) : null))]
      .filter((id): id is string => typeof id === "string");
    const quoted = new Map<string, string>();
    if (quotedIds.length) {
      const { data: q, error: e2 } = await this.db.from("messages")
        .select("wa_message_id, direction, body").in("wa_message_id", quotedIds);
      if (e2) throw e2;
      for (const m of q) {
        quoted.set(m.wa_message_id, m.direction === "in" ? inboundText(m.body) : outboundText(m.body));
      }
    }
    return data.reverse().map((m: Row) => {
      const q = m.direction === "in" ? quoted.get(quotedOf(m.body)) : undefined;
      return {
        from: m.direction === "in" ? "user" as const : "desk" as const,
        text: m.direction === "in" ? inboundText(m.body) : outboundText(m.body),
        at: new Date(m.at),
        ...(q ? { quoted: q } : {}),
      };
    });
  }

  async liveOptions(requestId: string): Promise<LiveOption[]> {
    const { data, error } = await this.db.from("options")
      .select("id, label, advance_required").eq("request_id", requestId).is("voided_at", null)
      .order("created_at");
    if (error) throw error;
    return data.map((o: Row) => ({
      id: o.id,
      label: o.label,
      detail: o.advance_required ? "advance" : null,
    }));
  }

  async recent(userId: string): Promise<RecentRequest[]> {
    const { data, error } = await this.db.from("requests")
      .select("updated_at, task, state, end_reason, fields, businesses(name)")
      .eq("user_id", userId).in("state", ["done", "cancelled", "expired"])
      .order("updated_at", { ascending: false }).limit(3);
    if (error) throw error;
    return data.map((r: Row) => ({
      at: new Date(r.updated_at),
      task: r.task,
      state: r.state,
      endReason: r.end_reason,
      placeName: r.businesses?.name ?? null,
      fields: r.fields ?? {},
    }));
  }

  async placeLabels(userId: string): Promise<string[]> {
    const { data, error } = await this.db.from("user_places").select("label").eq("user_id", userId);
    if (error) throw error;
    return data.map((p: Row) => p.label);
  }

  async myPlace(userId: string, label: string) {
    const want = label.trim().toLowerCase();
    const { data, error } = await this.db.from("user_places")
      .select("label, aliases, place_id").eq("user_id", userId);
    if (error) throw error;
    const hit = data.find((p: Row) =>
      p.label.toLowerCase() === want || (p.aliases ?? []).some((a: string) => a.toLowerCase() === want)
    );
    if (!hit) return null;
    const { data: b } = await this.db.from("businesses").select("id").eq("place_id", hit.place_id)
      .maybeSingle();
    return { label: hit.label, business_id: b?.id ?? null };
  }

  async businessExists(businessId: string): Promise<boolean> {
    const { data, error } = await this.db.from("businesses").select("id").eq("id", businessId).maybeSingle();
    if (error) throw error;
    return !!data;
  }

  async savePlace(p: PlaceHit): Promise<string> {
    const { data, error } = await this.db.from("businesses").upsert({
      place_id: p.placeId,
      name: p.name,
      address: p.address,
      city: p.city,
      phone_e164: p.phone,
      opening_hours: p.openingHours,
      source: p.placeId.startsWith("dev/") ? "user" : "places",
      updated_at: new Date().toISOString(),
    }, { onConflict: "place_id" }).select("id").single();
    if (error) throw error;
    return data.id;
  }

  async setCity(userId: string, city: string): Promise<void> {
    const { error } = await this.db.from("users").update({ city }).eq("id", userId);
    if (error) throw error;
  }

  async touch(requestId: string, at: Date): Promise<void> {
    const { error } = await this.db.from("requests")
      .update({ last_user_msg_at: at.toISOString() }).eq("id", requestId);
    if (error) throw error;
  }

  startRequest(userId: string, task: Task) {
    return this.rpc<{ ok: true; request_id: string; state: State; replaced_request_id: string | null }>(
      "start_request",
      { p_user_id: userId, p_task: task },
    );
  }

  queueRequest(userId: string, task: Task) {
    return this.rpc<{ ok: true; request_id: string; state: State } | Refused>("queue_request", {
      p_user_id: userId,
      p_task: task,
    });
  }

  activateQueued(userId: string) {
    return this.rpc<{ ok: true; request_id: string | null }>("activate_queued", { p_user_id: userId });
  }

  async callForReport(callId: string): Promise<CallForReport | null> {
    const { data, error } = await this.db.from("calls")
      .select(
        "id, request_id, user_id, kind, is_retry, business_id, requests(task), users(wa_id), " +
          "businesses(phone_e164), " +
          "options!calls_option_id_fkey(label, value)",
      ).eq("id", callId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as Row;
    let bookingTime: string | null = null;
    if (["payment_confirm", "cancel", "reschedule"].includes(row.kind)) {
      const { data: r } = await this.db.from("requests").select("booking_id").eq("id", row.request_id)
        .single();
      const q = this.db.from("bookings").select("time");
      const { data: b } = await (r?.booking_id
        ? q.eq("id", r.booking_id)
        : q.eq("request_id", row.request_id).order("created_at", { ascending: false }).limit(1))
        .maybeSingle();
      bookingTime = b?.time ?? null;
    }
    return {
      bookingTime,
      callId: row.id,
      requestId: row.request_id,
      userId: row.user_id,
      waId: row.users.wa_id,
      kind: row.kind,
      task: row.requests.task,
      isRetry: row.is_retry,
      businessId: row.business_id,
      phone: row.businesses.phone_e164,
      option: row.options ? { label: row.options.label, value: row.options.value ?? {} } : null,
    };
  }

  async lastCall(requestId: string) {
    const { data, error } = await this.db.from("calls").select("kind, status").eq("request_id", requestId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data as { kind: CallKind; status: string } | null;
  }

  async upcomingBookings(userId: string): Promise<UpcomingBooking[]> {
    const { data, error } = await this.db.from("bookings")
      .select(
        "id, status, time, reference, requests!bookings_request_id_fkey!inner(user_id, fields, businesses(name))",
      )
      .eq("requests.user_id", userId).in("status", ["booked", "held_pending_deposit"])
      .or(`time.is.null,time.gt.${new Date().toISOString()}`).order("time").limit(10);
    if (error) throw error;
    return data.map((b: Row) => ({
      id: b.id,
      status: b.status,
      time: b.time ? new Date(b.time) : null,
      place: b.requests.businesses?.name ?? "",
      what: typeof b.requests.fields?.party_size === "number"
        ? `table for ${b.requests.fields.party_size}`
        : b.requests.fields?.service ?? null,
      reference: b.reference,
    }));
  }

  setRequestBooking(requestId: string, bookingId: string) {
    return this.rpc<Changed | Refused>("set_request_booking", {
      p_request_id: requestId,
      p_booking_id: bookingId,
    });
  }

  recordPayment(requestId: string, passed: boolean, payment: Record<string, unknown>) {
    return this.rpc<{ ok: true; consent_id: string | null } | Refused>("record_payment", {
      p_request_id: requestId,
      p_passed: passed,
      p_payment: payment,
    });
  }

  async heldBooking(userId: string): Promise<HeldBooking | null> {
    const { data, error } = await this.db.from("bookings")
      .select(
        "id, request_id, time, deposit_amount, upi_id, payee_name, payment_deadline, " +
          "calls!bookings_call_id_fkey(created_at), requests!bookings_request_id_fkey!inner(user_id, state, business_id)",
      )
      .eq("requests.user_id", userId).eq("requests.state", "awaiting_payment").eq(
        "status",
        "held_pending_deposit",
      )
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const b = data as Row;
    return {
      bookingId: b.id,
      requestId: b.request_id,
      businessId: b.requests.business_id,
      amountRs: b.deposit_amount === null ? null : Number(b.deposit_amount),
      upiId: b.upi_id,
      payeeName: b.payee_name,
      deadline: b.payment_deadline ? new Date(b.payment_deadline) : null,
      heldAt: new Date(b.calls.created_at),
      time: b.time ? new Date(b.time) : null,
    };
  }

  settleCall(callId: string, s: CallSettlement) {
    return this.rpc<{ ok: true; request_id: string; state: State; option_ids: string[] } | Refused>(
      "settle_call",
      {
        p_call_id: callId,
        p_result: s.result,
        p_options: s.options ?? [],
        p_booking: s.booking ?? null,
        p_opt_out: s.optOut ?? false,
      },
    );
  }

  cancelRequest(requestId: string) {
    return this.rpc<{ ok: true } | Refused>("cancel_request", { p_request_id: requestId });
  }

  setBusiness(requestId: string, businessId: string) {
    return this.rpc<Changed | Refused>("set_request_business", {
      p_request_id: requestId,
      p_business_id: businessId,
    });
  }

  updateSlots(requestId: string, patch: Record<string, unknown>) {
    return this.rpc<Changed | Refused>("update_slots", { p_request_id: requestId, p_fields: patch });
  }

  advance(requestId: string, to: "collecting" | "choosing_place" | "confirming") {
    return this.rpc<{ ok: boolean }>("advance_request", { p_request_id: requestId, p_to: to });
  }

  openPrompt(requestId: string, promptId: string, p: Prompt) {
    return this.rpc<{ ok: true } | Refused>("open_prompt", {
      p_prompt_id: promptId,
      p_request_id: requestId,
      p_kind: p.kind,
      p_option_ids: p.optionIds,
      p_confirm_word: p.confirmWord,
      p_text: p.text,
      p_message: p.message,
    });
  }

  async promptSent(promptId: string, waMessageId: string): Promise<void> {
    await this.rpc("prompt_sent", { p_prompt_id: promptId, p_wa_message_id: waMessageId });
  }

  async promptForMessage(userId: string, waMessageId: string): Promise<string | null> {
    const { data, error } = await this.db.from("consent_prompts")
      .select("id, requests!inner(user_id)").eq("requests.user_id", userId)
      .contains("sent_ids", [waMessageId]).limit(1).maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  }

  async promptMessage(promptId: string): Promise<Outbound> {
    const { data, error } = await this.db.from("consent_prompts")
      .select("message").eq("id", promptId).single();
    if (error) throw error;
    return data.message;
  }

  recordConsent(
    promptId: string,
    optionId: string | null,
    word: "yes" | "cancel",
    waMessageId: string,
    basis?: Record<string, unknown>,
  ) {
    return this.rpc<ConsentStored | Refused>("record_consent", {
      p_prompt_id: promptId,
      p_option_id: optionId,
      p_word: word,
      p_wa_message_id: waMessageId,
      p_basis: basis ?? null,
    });
  }
}

// Stored inbound bodies are Meta's raw message (or the dev page's equivalent).
export function inboundText(b: Row): string {
  if (typeof b?.text === "string") return b.text;
  if (b?.text?.body) return b.text.body;
  const reply = b?.interactive?.button_reply ?? b?.interactive?.list_reply;
  if (reply?.title) return `[tapped: ${reply.title}]`;
  if (b?.button?.text) return `[tapped: ${b.button.text}]`;
  if (b?.replyId) return `[tapped: ${b.title ?? b.replyId}]`;
  if (b?.type === "reaction") {
    return b.reaction?.emoji ? `[reacted ${b.reaction.emoji}]` : "[removed a reaction]";
  }
  return mediaMarker(b?.type ?? "unknown");
}

// Stored outbound bodies are our Outbound. Plans are sent as text and shown as they are.
function outboundText(b: Row): string {
  switch (b?.kind) {
    case "text":
      return b.body;
    case "buttons":
      return `[code-built, buttons: ${b.buttons.map((x: Row) => x.title).join(" / ")}] ${b.body}`;
    case "list":
      return `[code-built list] ${b.body}`;
    case "template":
      return `[template ${b.name}]`;
    default:
      return JSON.stringify(b);
  }
}
