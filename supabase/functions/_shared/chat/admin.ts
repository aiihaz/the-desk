// Admin commands on WhatsApp (eng plan 8), from the wa_ids in DESK_ADMIN_WA_IDS only
// (gate.ts). Code parses the message and the database does the work (0010_admin.sql);
// the reply is plain text built from what the database returned.
//   status · review · resolve <id> · stop all · resume · credit <rs> · optout <+91…>
//   limits · set limit <key> <value> [for <wa_id>] · numbers · number off|on <number or id>
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { toE164 } from "../places.ts";
import { serviceClient, type User } from "../store.ts";

export type AlertRow = {
  id: string;
  kind: string;
  at: Date;
  detail: Record<string, unknown>;
  requestId: string | null;
  callId: string | null;
};

// deno-lint-ignore no-explicit-any
type Json = any;

export interface AdminStore {
  status(): Promise<Json>;
  openAlerts(limit: number): Promise<AlertRow[]>;
  resolveAlert(prefix: string, by: string): Promise<{ ok: boolean; reason?: string }>;
  // value is JSON text ("20", "null", "\"gpt-6-luna\""); userWaId sets a per-user override.
  setLimit(
    key: string,
    value: unknown,
    by: string,
    userWaId: string | null,
  ): Promise<{ ok: boolean; reason?: string }>;
  limits(): Promise<{ key: string; value: unknown }[]>;
  addCredit(rs: number, by: string): Promise<number>;
  optOut(phone: string): Promise<boolean>;
  numbers(): Promise<Json[]>;
  setNumberActive(ref: string, active: boolean): Promise<{ ok: boolean; reason?: string; e164?: string }>;
  // Alerts not yet sent to an admin (alerts.ts).
  newAlerts(): Promise<AlertRow[]>;
  markNotified(ids: string[]): Promise<void>;
}

export const HELP =
  "Admin: status · review · resolve <id> · stop all · resume · credit <rs> · optout <+91…> · " +
  "limits · set limit <key> <value> [for <wa_id>] · numbers · number off|on <number or id>";

// One line per alert, the id prefix first so "resolve" can name it.
export function alertLine(a: AlertRow): string {
  const at = a.at.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const problems = Array.isArray(a.detail.problems) ? `: ${(a.detail.problems as string[]).join("; ")}` : "";
  return `${a.id.slice(0, 6)} ${at} ${a.kind}${problems}`.slice(0, 300);
}

export async function runAdmin(store: AdminStore, text: string, by: string): Promise<string> {
  const t = text.trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  let m: RegExpMatchArray | null;

  if (lower === "status") {
    const s = await store.status();
    const calls = Object.entries(s.calls_today ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
    return [
      s.kill_switch === true ? "STOPPED: no calls go out (resume to restart)." : "Running.",
      `Agent version: ${s.agent_version ?? "not set"}`,
      `Credit: Rs ${Number(s.credit_rs).toFixed(0)}`,
      `Calls today: ${calls}`,
      `Bookings today: ${s.bookings_today}`,
      `Active requests: ${s.active_requests}`,
      `Open alerts: ${s.open_alerts}${s.open_alerts ? " (review)" : ""}`,
      `Stopped users: ${s.stopped_users}`,
    ].join("\n");
  }
  if (lower === "review") {
    const rows = await store.openAlerts(10);
    if (!rows.length) return "Nothing to review.";
    return `Open alerts (resolve <id> when handled):\n${rows.map(alertLine).join("\n")}`;
  }
  if ((m = lower.match(/^resolve ([0-9a-f]{4,})$/))) {
    const r = await store.resolveAlert(m[1], by);
    return r.ok
      ? `Resolved ${m[1]}.`
      : r.reason === "ambiguous"
      ? `${m[1]} matches several; give more of the id.`
      : `No open alert ${m[1]}.`;
  }
  if (lower === "stop all" || lower === "resume") {
    const on = lower === "stop all";
    const r = await store.setLimit("kill_switch", on, by, null);
    if (!r.ok) return `Couldn't change the kill switch: ${r.reason}`;
    return on
      ? "Stopped: no new calls will go out. Calls already under way finish."
      : "Resumed: calls can go out.";
  }
  if ((m = lower.match(/^credit (?:rs\.? ?)?([0-9]+(?:\.[0-9]+)?)$/))) {
    try {
      const balance = await store.addCredit(Number(m[1]), by);
      return `Added Rs ${m[1]}. Balance: Rs ${balance.toFixed(0)}.`;
    } catch (e) {
      return `Not added: ${String((e as Error)?.message ?? e)}`;
    }
  }
  if ((m = t.match(/^optout (.+)$/i))) {
    const phone = toE164(m[1]);
    if (!phone) return `Not a phone number: ${m[1]}`;
    return (await store.optOut(phone))
      ? `Opted out ${phone}: no Desk number will call it.`
      : `${phone} was already opted out.`;
  }
  if (lower === "limits") {
    const rows = await store.limits();
    return rows.map((r) => `${r.key} = ${JSON.stringify(r.value)}`).join("\n");
  }
  if ((m = t.match(/^set limit ([a-z0-9_]+) (.+?)(?: for ([0-9]{8,15}))?$/i))) {
    const [, key, raw, waId] = m;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // A bare word is a string: "set limit luna_model gpt-6-luna".
      value = raw;
    }
    const r = await store.setLimit(key.toLowerCase(), value, by, waId ?? null);
    return r.ok
      ? `${key} = ${JSON.stringify(value)}${waId ? ` for ${waId}` : ""}.`
      : `Not changed: ${r.reason}`;
  }
  if (lower === "numbers") {
    const rows = await store.numbers();
    if (!rows.length) return "No caller numbers.";
    return rows.map((n) =>
      `${n.id} ${n.e164} ${n.active ? "on" : "off"}${
        n.declared ? "" : " (not declared)"
      }, ${n.calls_today} calls today`
    ).join("\n");
  }
  if ((m = t.match(/^number (off|on) (\S+)$/i))) {
    const on = m[1].toLowerCase() === "on";
    const ref = m[2].startsWith("+") ? m[2] : m[2].toLowerCase();
    const r = await store.setNumberActive(ref, on);
    if (!r.ok) {
      return r.reason === "ambiguous" ? `${m[2]} matches several numbers.` : `No caller number ${m[2]}.`;
    }
    return `${r.e164} is ${on ? "on" : "off"}.`;
  }
  return HELP;
}

export class DbAdminStore implements AdminStore {
  constructor(private db: SupabaseClient = serviceClient()) {}

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  status() {
    return this.rpc<Json>("admin_status");
  }

  async openAlerts(limit: number): Promise<AlertRow[]> {
    const { data, error } = await this.db.from("alerts").select("id, kind, at, detail, request_id, call_id")
      .is("resolved_at", null).order("at").limit(limit);
    if (error) throw error;
    return data.map(alertRow);
  }

  resolveAlert(prefix: string, by: string) {
    return this.rpc<{ ok: boolean; reason?: string }>("resolve_alert", { p_prefix: prefix, p_by: by });
  }

  async setLimit(key: string, value: unknown, by: string, userWaId: string | null) {
    let userId: string | null = null;
    if (userWaId) {
      const { data } = await this.db.from("users").select("id").eq("wa_id", userWaId).maybeSingle();
      if (!data) return { ok: false, reason: `no user ${userWaId}` };
      userId = data.id;
    }
    const { error } = await this.db.rpc("set_limit", {
      p_key: key,
      p_value: value,
      p_changed_by: `admin ${by}`,
      p_user_id: userId,
    });
    // 22023: unknown key or a value of the wrong type; the message says which.
    return error ? { ok: false, reason: error.message } : { ok: true };
  }

  async limits() {
    const { data, error } = await this.db.from("limits").select("key, value").order("key");
    if (error) throw error;
    return data;
  }

  addCredit(rs: number, by: string) {
    return this.rpc<number>("add_credit", { p_rs: rs, p_by: by }).then(Number);
  }

  optOut(phone: string) {
    return this.rpc<boolean>("admin_opt_out", { p_phone: phone });
  }

  numbers() {
    return this.rpc<Json[]>("caller_numbers_today");
  }

  setNumberActive(ref: string, active: boolean) {
    return this.rpc<{ ok: boolean; reason?: string; e164?: string }>("set_caller_number_active", {
      p_ref: ref,
      p_active: active,
    });
  }

  async newAlerts(): Promise<AlertRow[]> {
    const { data, error } = await this.db.from("alerts").select("id, kind, at, detail, request_id, call_id")
      .is("notified_at", null).is("resolved_at", null).order("at").limit(20);
    if (error) throw error;
    return data.map(alertRow);
  }

  async markNotified(ids: string[]): Promise<void> {
    await this.rpc("mark_alerts_notified", { p_ids: ids });
  }

  // The admins who have a user row (they've messaged the Desk at least once).
  async users(waIds: string[]): Promise<User[]> {
    if (!waIds.length) return [];
    const { data, error } = await this.db.from("users").select("id, wa_id, blocked").in("wa_id", waIds);
    if (error) throw error;
    return data.map((u: Json) => ({ id: u.id, waId: u.wa_id, blocked: u.blocked }));
  }
}

function alertRow(a: Json): AlertRow {
  return {
    id: a.id,
    kind: a.kind,
    at: new Date(a.at),
    detail: a.detail ?? {},
    requestId: a.request_id,
    callId: a.call_id,
  };
}
