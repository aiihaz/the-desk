// Database access for the chat agent. Every state change is an RPC into 0004_chat.sql,
// so version bumps, prompt closing and voiding happen in one transaction.
// The interface lets tests use a fake.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import type { PlaceHit } from "../places.ts";
import { serviceClient } from "../store.ts";
import type { Outbound } from "../whatsapp.ts";
import type { RecentRequest } from "./cards.ts";
import { mediaMarker, type OpenPrompt } from "./gate.ts";
import type { BookingSummary, Place, Prompt } from "./readback.ts";
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
};

export type UserInfo = { name: string | null; phone: string | null; language: string; city: string | null };

export type Refused = { ok: false; reason: string };
export type Changed = { ok: true; changed: boolean; state: State; version: number };
export type ConsentStored = {
  ok: true;
  consent_id: string;
  kind: "ask" | "book";
  request_id: string;
  option_id: string | null;
};

// One line of the WhatsApp conversation, as Luna sees it.
export type ChatLine = { from: "user" | "desk"; text: string; at: Date };
export type LiveOption = { id: string; label: string; detail: string | null };

export interface ChatStore {
  user(userId: string): Promise<UserInfo>;
  // The user's active request (not queued, not ended) and its open prompt.
  active(userId: string): Promise<{ request: ActiveRequest | null; prompt: OpenPrompt | null }>;
  // The user's queued request, if any (at most one; start_request replaces older ones).
  queued(userId: string): Promise<ActiveRequest | null>;
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
  // The last `limit` messages since `since`, oldest first.
  history(userId: string, since: Date, limit: number): Promise<ChatLine[]>;
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

  touch(requestId: string, at: Date): Promise<void>;
  startRequest(userId: string, task: Task): Promise<{
    ok: true;
    request_id: string;
    state: State;
    replaced_request_id: string | null;
  }>;
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
  };
}

export class DbChatStore implements ChatStore {
  constructor(private db: SupabaseClient = serviceClient()) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  async user(userId: string): Promise<UserInfo> {
    const { data, error } = await this.db.from("users")
      .select("name, phone_e164, language, city").eq("id", userId).single();
    if (error) throw error;
    return { name: data.name, phone: data.phone_e164, language: data.language, city: data.city };
  }

  async active(userId: string) {
    const { data, error } = await this.db.from("requests")
      .select("id, task, state, version, fields, business_id, booking_id, created_at")
      .eq("user_id", userId).in("state", ACTIVE).maybeSingle();
    if (error) throw error;
    if (!data) return { request: null, prompt: null };
    const { data: p, error: e2 } = await this.db.from("consent_prompts")
      .select("id, kind, option_ids, confirm_word, wa_message_id")
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
        }
        : null,
    };
  }

  async queued(userId: string): Promise<ActiveRequest | null> {
    const { data, error } = await this.db.from("requests")
      .select("id, task, state, version, fields, business_id, booking_id, created_at")
      .eq("user_id", userId).eq("state", "queued")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? toRequest(data) : null;
  }

  async request(requestId: string): Promise<ActiveRequest> {
    const { data, error } = await this.db.from("requests")
      .select("id, task, state, version, fields, business_id, booking_id, created_at").eq("id", requestId)
      .single();
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
        "time, deposit_amount, requests!bookings_request_id_fkey(fields, businesses(name, address, city))",
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
      // Fees stated on the booking call come with E6's output mapping.
      knownFeeRs: null,
    };
  }

  async history(userId: string, since: Date, limit: number): Promise<ChatLine[]> {
    const { data, error } = await this.db.from("messages")
      .select("direction, body, at").eq("user_id", userId).gte("at", since.toISOString())
      .order("at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data.reverse().map((m: Row) => ({
      from: m.direction === "in" ? "user" as const : "desk" as const,
      text: m.direction === "in" ? inboundText(m.body) : outboundText(m.body),
      at: new Date(m.at),
    }));
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

  recordConsent(promptId: string, optionId: string | null, word: "yes" | "cancel", waMessageId: string) {
    return this.rpc<ConsentStored | Refused>("record_consent", {
      p_prompt_id: promptId,
      p_option_id: optionId,
      p_word: word,
      p_wa_message_id: waMessageId,
    });
  }
}

// Stored inbound bodies are Meta's raw message (or the dev page's equivalent).
function inboundText(b: Row): string {
  if (typeof b?.text === "string") return b.text;
  if (b?.text?.body) return b.text.body;
  const reply = b?.interactive?.button_reply ?? b?.interactive?.list_reply;
  if (reply?.title) return `[tapped: ${reply.title}]`;
  if (b?.button?.text) return `[tapped: ${b.button.text}]`;
  if (b?.replyId) return `[tapped: ${b.title ?? b.replyId}]`;
  return mediaMarker(b?.type ?? "unknown");
}

// Stored outbound bodies are our Outbound. Code-built prompts are marked so Luna
// knows code sent them, and can refer to them without repeating them.
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
