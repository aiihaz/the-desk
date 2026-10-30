// Database access for the call functions (dial, sarvam-webhook). The interface lets tests use a fake.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import type { CallInputs } from "./call_vars.ts";
import type { CallKind, CallResult } from "./sarvam.ts";
import { serviceClient } from "./store.ts";

// reserve_call() result (0003_guards.sql).
export type Reservation =
  | { ok: false; reason: string }
  | {
    ok: true;
    call_id: string;
    caller_number_id: string;
    agent_version: string;
    must_reask: boolean;
    flags: string[];
  };

export type DialTarget = { businessPhone: string; callerNumber: string };

export interface CallStore {
  reserveCall(
    requestId: string,
    kind: CallKind,
    optionId: string | null,
    isRetry: boolean,
  ): Promise<Reservation>;
  dialTarget(callId: string): Promise<DialTarget>;
  // What the voice agent's variables are built from, read for a reserved call (P15).
  callInputs(callId: string): Promise<CallInputs>;
  markDialing(callId: string, attemptId: string): Promise<void>;
  markFailed(callId: string, reason: string): Promise<void>;
  // false if this attempt's result was already stored.
  saveEvent(attemptId: string, payload: unknown): Promise<boolean>;
  // Writes the result to a call that is still open. Returns its id, or null if the
  // call is unknown or already has a result (a redelivery), so hand-off runs once.
  finishCall(result: CallResult): Promise<string | null>;
}

// What reconcile needs on top of the CallStore.
export interface ReconcileStore {
  openCalls(before: Date): Promise<{ id: string; attemptId: string | null; createdAt: Date }[]>;
  timeoutCall(callId: string): Promise<boolean>;
}

const OPEN = ["queued", "dialing", "in_progress"];

export class DbCallStore implements CallStore, ReconcileStore {
  constructor(private db: SupabaseClient = serviceClient()) {}

  async reserveCall(requestId: string, kind: CallKind, optionId: string | null, isRetry: boolean) {
    const { data, error } = await this.db.rpc("reserve_call", {
      p_request_id: requestId,
      p_kind: kind,
      p_option_id: optionId,
      p_is_retry: isRetry,
    });
    if (error) throw error;
    return data as Reservation;
  }

  async dialTarget(callId: string): Promise<DialTarget> {
    const { data, error } = await this.db.from("calls")
      .select("businesses(phone_e164), caller_numbers(e164)").eq("id", callId).single();
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    const row = data as any;
    return { businessPhone: row.businesses.phone_e164, callerNumber: row.caller_numbers.e164 };
  }

  async callInputs(callId: string): Promise<CallInputs> {
    const { data, error } = await this.db.from("calls").select("request_id, option_id").eq("id", callId)
      .single();
    if (error) throw error;
    return this.requestInputs(data.request_id, data.option_id);
  }

  // The same inputs for a request with no call yet (the dev bench shows what a call would get).
  async requestInputs(requestId: string, optionId: string | null): Promise<CallInputs> {
    const { data, error } = await this.db.from("requests")
      .select("task, fields, booking_id, businesses(name), users(phone_e164)").eq("id", requestId).single();
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    const row = data as any;
    let option: CallInputs["option"] = null;
    if (optionId) {
      const { data: o, error: e2 } = await this.db.from("options").select("label, value")
        .eq("id", optionId).single();
      if (e2) throw e2;
      option = { label: o.label, value: o.value ?? {} };
    }
    const { data: first, error: e3 } = await this.db.from("calls").select("created_at, outputs")
      .eq("request_id", requestId).eq("kind", "first").eq("status", "completed")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (e3) throw e3;
    const change = await this.bookingInputs(requestId, row.booking_id);
    return {
      task: row.task,
      fields: row.fields ?? {},
      businessName: row.businesses?.name ?? "",
      customerPhone: row.users?.phone_e164 ?? null,
      option,
      booking: change.booking,
      payment: change.payment,
      approvedLossRs: change.approvedLossRs,
      prev: change.prev ?? (first
        ? {
          at: first.created_at,
          contactName: typeof first.outputs?.contact_name === "string" ? first.outputs.contact_name : null,
          // summary in the Genie contract, notes in eng plan 3.4.
          summary: typeof first.outputs?.summary === "string"
            ? first.outputs.summary
            : typeof first.outputs?.notes === "string"
            ? first.outputs.notes
            : null,
        }
        : null),
    };
  }

  // The booking a call is about: the one being rescheduled or cancelled (booking_id), else
  // the request's held one (payment confirm), with its payment and the call that made it.
  private async bookingInputs(requestId: string, bookingId: string | null): Promise<{
    booking: CallInputs["booking"];
    payment: CallInputs["payment"];
    approvedLossRs: number;
    prev: CallInputs["prev"];
  }> {
    const q = this.db.from("bookings")
      .select(
        "id, time, reference, deposit_amount, known_fee_rs, call_id, requests!bookings_request_id_fkey(fields), " +
          "calls!bookings_call_id_fkey(created_at, outputs)",
      );
    const { data: b, error } =
      await (bookingId
        ? q.eq("id", bookingId)
        : q.eq("request_id", requestId).eq("status", "held_pending_deposit").order("created_at", {
          ascending: false,
        })
          .limit(1)).maybeSingle();
    if (error) throw error;
    if (!b) return { booking: null, payment: null, approvedLossRs: 0, prev: null };
    // deno-lint-ignore no-explicit-any
    const row = b as any;
    const booking = {
      time: row.time,
      reference: row.reference,
      customerName: row.requests?.fields?.customer_name ?? null,
      depositRs: row.deposit_amount === null ? null : Number(row.deposit_amount),
      knownFeeRs: row.known_fee_rs === null ? null : Number(row.known_fee_rs),
    };
    const { data: p } = await this.db.from("payments").select("amount_rs, utr, paid_at, payee")
      .eq("booking_id", row.id).eq("passed", true).order("at", { ascending: false }).limit(1).maybeSingle();
    // A CANCEL answer to a read-back that named the loss accepts it (E4 design 2.9).
    const { data: k } = await this.db.from("consents").select("consent_prompts(confirm_word)")
      .eq("request_id", requestId).eq("kind", "ask").is("voided_at", null).order("at", { ascending: false })
      .limit(1).maybeSingle();
    // deno-lint-ignore no-explicit-any
    const word = (k as any)?.consent_prompts?.confirm_word;
    return {
      booking,
      payment: p
        ? {
          amountRs: Number(p.amount_rs),
          ref: String(p.utr ?? "").slice(-6),
          paidAt: p.paid_at,
          payee: p.payee,
        }
        : null,
      approvedLossRs: word === "cancel" ? booking.depositRs ?? booking.knownFeeRs ?? 0 : 0,
      prev: bookingId && row.calls
        ? {
          at: row.calls.created_at,
          contactName: typeof row.calls.outputs?.contact_name === "string"
            ? row.calls.outputs.contact_name
            : null,
          summary: typeof row.calls.outputs?.summary === "string" ? row.calls.outputs.summary : null,
        }
        : null,
    };
  }

  async markDialing(callId: string, attemptId: string): Promise<void> {
    // The webhook may already have closed the call (instant failure); keep its status.
    const { error } = await this.db.from("calls").update({ provider_call_id: attemptId })
      .eq("id", callId);
    if (error) throw error;
    const { error: e2 } = await this.db.from("calls").update({ status: "dialing" })
      .eq("id", callId).eq("status", "queued");
    if (e2) throw e2;
  }

  async markFailed(callId: string, reason: string): Promise<void> {
    const { error } = await this.db.from("calls").update({ status: "failed", outcome: reason })
      .eq("id", callId).in("status", OPEN);
    if (error) throw error;
  }

  async saveEvent(attemptId: string, payload: unknown): Promise<boolean> {
    const { data, error } = await this.db.from("webhook_events")
      .upsert({ source: "sarvam", external_id: attemptId, payload }, {
        onConflict: "source,external_id",
        ignoreDuplicates: true,
      })
      .select("id");
    if (error) throw error;
    return data.length > 0;
  }

  async finishCall(r: CallResult): Promise<string | null> {
    const q = this.db.from("calls").update({
      provider_call_id: r.attemptId,
      status: r.status,
      outcome: r.failureReason ?? r.status,
      outputs: r.outputs,
      transcript: r.transcript,
      duration_s: r.durationS,
    }).in("status", OPEN);
    const { data, error } = await (r.callId ? q.eq("id", r.callId) : q.eq("provider_call_id", r.attemptId))
      .select("id");
    if (error) throw error;
    return data[0]?.id ?? null;
  }

  async openCalls(before: Date) {
    const { data, error } = await this.db.from("calls").select("id, provider_call_id, created_at")
      .in("status", OPEN).lt("created_at", before.toISOString()).order("created_at").limit(200);
    if (error) throw error;
    // deno-lint-ignore no-explicit-any
    return data.map((c: any) => ({
      id: c.id,
      attemptId: c.provider_call_id,
      createdAt: new Date(c.created_at),
    }));
  }

  async timeoutCall(callId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc("timeout_call", { p_call_id: callId });
    if (error) throw error;
    return data === true;
  }
}
