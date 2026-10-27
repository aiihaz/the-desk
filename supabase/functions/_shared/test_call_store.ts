// In-memory CallStore for the dial and sarvam-webhook tests.
import type { CallStore, DialTarget, Reservation } from "./call_store.ts";
import type { CallInputs } from "./call_vars.ts";
import type { CallKind, CallResult } from "./sarvam.ts";

type Row = { id: string; status: string; providerCallId: string | null; outcome: string | null };

export class FakeCallStore implements CallStore {
  calls = new Map<string, Row>();
  events = new Set<string>();
  reservation: Reservation = {
    ok: true,
    call_id: "c-1",
    caller_number_id: "n-1",
    agent_version: "3",
    must_reask: false,
    flags: [],
  };
  reserved: { requestId: string; kind: CallKind; optionId: string | null; isRetry: boolean }[] = [];

  async reserveCall(requestId: string, kind: CallKind, optionId: string | null, isRetry: boolean) {
    this.reserved.push({ requestId, kind, optionId, isRetry });
    if (this.reservation.ok) {
      this.calls.set(this.reservation.call_id, {
        id: this.reservation.call_id,
        status: "queued",
        providerCallId: null,
        outcome: null,
      });
    }
    return this.reservation;
  }
  async dialTarget(): Promise<DialTarget> {
    return { businessPhone: "+919876543210", callerNumber: "+918041234567" };
  }
  inputs: CallInputs = {
    task: "booking",
    fields: {
      party_size: 4,
      customer_name: "Ihaz",
      exact_time: "2026-10-23T20:00:00+05:30",
      may_book: true,
      max_advance_rs: 0,
    },
    businessName: "Paragon",
    customerPhone: "+919812345678",
    option: null,
    prev: null,
  };
  async callInputs() {
    return this.inputs;
  }
  async markDialing(callId: string, attemptId: string) {
    const c = this.calls.get(callId)!;
    c.providerCallId = attemptId;
    if (c.status === "queued") c.status = "dialing";
  }
  async markFailed(callId: string, reason: string) {
    const c = this.calls.get(callId)!;
    c.status = "failed";
    c.outcome = reason;
  }
  async saveEvent(attemptId: string) {
    if (this.events.has(attemptId)) return false;
    this.events.add(attemptId);
    return true;
  }
  async finishCall(r: CallResult) {
    const c = r.callId
      ? this.calls.get(r.callId)
      : [...this.calls.values()].find((x) => x.providerCallId === r.attemptId);
    if (!c || !["queued", "dialing", "in_progress"].includes(c.status)) return null;
    c.status = r.status;
    c.providerCallId = r.attemptId;
    c.outcome = r.failureReason ?? r.status;
    return c.id;
  }
}
