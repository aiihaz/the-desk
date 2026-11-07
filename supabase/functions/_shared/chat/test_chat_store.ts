// In-memory ChatStore for the chat-agent tests. The real rules live in SQL (chat_test.sql).
import type { CheckEvent } from "./checks.ts";
import type { CallKind } from "../sarvam.ts";
import type { Outbound } from "../whatsapp.ts";
import type { Delivery, DueFollowUp } from "./followup.ts";
import type { OpenPrompt } from "./gate.ts";
import type { Prompt } from "./readback.ts";
import type { RouteLog } from "./router.ts";
import type {
  ActiveRequest,
  CallForReport,
  CallReport,
  CallSettlement,
  ChatLine,
  ChatStore,
  ConsentStored,
  HeldBooking,
  KeptTranscript,
  LiveOption,
  Memory,
  OpenDecision,
  Refused,
  TurnClaim,
  Unwritten,
  UpcomingBooking,
} from "./store.ts";
import type { Facts } from "./tell.ts";

export class FakeChatStore implements ChatStore {
  req: ActiveRequest | null = null;
  prompt: (OpenPrompt & { message: Outbound }) | null = null;
  lastOut: string | null = null;
  inbound = 1;
  limits: Record<string, number | boolean | null> = {
    max_inbound_per_user_per_day: 60,
    book_on_first_call: true,
    match_tolerance_minutes: 15,
  };
  consentResult: ConsentStored | Refused = {
    ok: true,
    consent_id: "k1",
    kind: "ask",
    request_id: "r1",
    option_id: null,
  };
  consents: unknown[] = [];
  slotWrites: Record<string, unknown>[] = [];

  stoppedAt: Date | null = null;
  profileName: string | null = "Ihaz";
  async user() {
    return {
      name: this.profileName,
      phone: "+919812345678",
      language: "en-IN",
      city: this.city,
      stoppedAt: this.stoppedAt,
    };
  }
  async active() {
    return { request: this.req, prompt: this.prompt };
  }
  async request() {
    return this.req!;
  }
  waiting: ActiveRequest[] = [];
  async queued() {
    return this.waiting[0] ?? null;
  }
  async queuedList() {
    return this.waiting;
  }
  // The user wrote again while the turn ran.
  unhandled = false;
  async hasUnhandledInbound() {
    return this.unhandled;
  }
  async lastOutboundId() {
    return this.lastOut;
  }
  async heldDeposit() {
    return this.holds.length > 0;
  }
  async inboundSince() {
    return this.inbound;
  }
  async limitInt(key: string) {
    return this.limits[key] as number | null;
  }
  async limitBool(key: string) {
    return this.limits[key] as boolean;
  }
  texts: Record<string, string | null> = {};
  async limitText(key: string) {
    return this.texts[key] ?? null;
  }
  async template(key: string) {
    return `[${key}]`;
  }
  async place() {
    return { name: "Paragon", address: "Kannur Rd, Kozhikode", city: "Kozhikode" };
  }
  async booking(): Promise<never> {
    throw new Error("not used");
  }
  // id: the line's WhatsApp message id, for linesAfter.
  lines: (ChatLine & { id?: string })[] = [];
  wrongNumbers = new Set<string>();
  async wrongNumberFor(_u: string, businessId: string) {
    return this.wrongNumbers.has(businessId);
  }
  asked: Date | null = null;
  async lastAsk() {
    return this.asked;
  }
  async history(_u: string, since: Date) {
    return this.lines.filter((l) => l.at >= since);
  }
  // Lines are in stored order; "after the plan" is after its line in the list.
  async linesAfter(_u: string, wa: string) {
    const i = this.lines.findIndex((l) => l.id === wa);
    return i < 0 ? [] : this.lines.slice(i + 1);
  }
  options: LiveOption[] = [];
  async liveOptions() {
    return this.options;
  }
  async recent() {
    return [];
  }
  async placeLabels() {
    return [];
  }
  async myPlace() {
    return null;
  }
  async businessExists() {
    return true;
  }
  saved: string[] = [];
  city: string | null = "Kozhikode";
  async savePlace(p: { placeId: string }) {
    this.saved.push(p.placeId);
    return `b:${p.placeId}`;
  }
  async setCity(_u: string, city: string) {
    this.city = city;
  }
  bookedIn: { city: string; at: Date }[] = [];
  // Diagnostics batches as record_checks would get them; checksFail makes the write throw.
  checks: { events: CheckEvent[]; version: string; waMessageId: string | null }[] = [];
  checksFail = false;
  async recordChecks(_u: string, events: CheckEvent[], version: string, waMessageId: string | null) {
    if (this.checksFail) throw new Error("record_checks down");
    this.checks.push({ events: structuredClone(events), version, waMessageId });
  }
  async bookedCities() {
    return this.bookedIn;
  }
  // As set_profile_name (0026): the evidence must be a user line holding the name. The
  // last-day window is the database's (profile_test.sql); tests here run on fixed clocks.
  async setProfileName(_u: string, name: string, evidence: string) {
    const said = this.lines.find((l) =>
      l.from === "user" && l.text.toLowerCase().includes(evidence.trim().toLowerCase())
    );
    if (!said) return { ok: false as const, reason: "evidence_not_said" };
    if (!said.text.toLowerCase().includes(name.trim().toLowerCase())) {
      return { ok: false as const, reason: "name_not_in_evidence" };
    }
    const previous = this.profileName;
    this.profileName = name.trim();
    return { ok: true as const, name: this.profileName, previous };
  }
  savedAddresses: { label: string; address: string }[] = [];
  async addresses() {
    return this.savedAddresses;
  }
  async saveAddress(_u: string, label: string, address: string | null) {
    const i = this.savedAddresses.findIndex((a) => a.label.toLowerCase() === label.trim().toLowerCase());
    if (address === null) {
      if (i < 0) return { ok: false as const, reason: "no_such_label" };
      const [gone] = this.savedAddresses.splice(i, 1);
      return { ok: true as const, removed: gone.label };
    }
    const kept = { label: label.trim(), address: address.trim() };
    if (i < 0) this.savedAddresses.push(kept);
    else this.savedAddresses[i] = kept;
    return { ok: true as const, ...kept };
  }
  // Tests and the eval treat the user as known unless a case says otherwise.
  isFirstContact = false;
  firstContactLookups = 0;
  async firstContact() {
    this.firstContactLookups++;
    return this.isFirstContact;
  }
  routes: RouteLog[] = [];
  redirects = 0;
  async logRoute(l: RouteLog) {
    this.routes.push(structuredClone(l));
  }
  async redirectsSince() {
    return this.redirects;
  }
  // Turns: each claimTurn result in order, then "claimed" with an empty batch.
  claims: TurnClaim[] = [];
  turnLog: string[] = [];
  async claimTurn(_u: string, wa: string) {
    const c = this.claims.shift() ?? { status: "claimed" as const, batch: [] };
    this.turnLog.push(`claim:${wa}:${c.status}`);
    return c;
  }
  async releaseTurn(_u: string, wa: string) {
    this.turnLog.push(`release:${wa}`);
  }
  async markHandled(wa: string) {
    this.turnLog.push(`handled:${wa}`);
  }
  async stopUser() {
    this.stoppedAt = new Date();
    this.req = null;
    this.prompt = null;
    return { ok: true as const, cancelled: 1, in_flight: false };
  }
  async resumeUser() {
    const was = !!this.stoppedAt;
    this.stoppedAt = null;
    return { ok: true as const, was_stopped: was };
  }
  deletionRequested = false;
  async requestDeletion() {
    this.deletionRequested = true;
    return this.stopUser();
  }
  async pauseRequest() {
    this.req = { ...this.req!, pausedAt: new Date(), state: "confirming" };
    this.prompt = null;
    return { ok: true as const, state: this.req.state };
  }
  async resumeRequest() {
    this.req = { ...this.req!, pausedAt: null };
    return { ok: true as const, changed: true, state: this.req.state };
  }
  notStarted: string[] = [];
  async callNotStarted(id: string) {
    this.notStarted.push(id);
    return { ok: true as const };
  }
  async touch() {}
  queuedTasks: string[] = [];
  queueResult: { ok: true; request_id: string; state: "queued" } | Refused = {
    ok: true,
    request_id: "q1000000-0000-4000-8000-000000000000",
    state: "queued",
  };
  async queueRequest(_u: string, task: string) {
    this.queuedTasks.push(task);
    return this.queueResult;
  }
  activated: string | null = null;
  async activateQueued() {
    return { ok: true as const, request_id: this.activated };
  }
  call: CallForReport | null = null;
  async callForReport() {
    return this.call;
  }
  last: { kind: CallKind; status: string } | null = null;
  async lastCall() {
    return this.last;
  }
  bookings: UpcomingBooking[] = [];
  async upcomingBookings() {
    return this.bookings;
  }
  transcripts: (KeptTranscript & { lines: { role: string; en_text: string }[] })[] = [];
  transcriptMessages: [string, string][] = [];
  async keptTranscripts() {
    return this.transcripts.map(({ lines: _, ...k }) => k);
  }
  async transcriptLines(_u: string, callId: string) {
    return this.transcripts.find((k) => k.id === callId)?.lines ?? [];
  }
  async markTranscriptMessage(waMessageId: string, callId: string) {
    this.transcriptMessages.push([waMessageId, callId]);
  }
  bookingSet: string[] = [];
  async setRequestBooking(_r: string, bookingId: string) {
    this.bookingSet.push(bookingId);
    return { ok: true as const, changed: true, state: "collecting" as const, version: 2 };
  }
  payments: { passed: boolean; payment: Record<string, unknown> }[] = [];
  paymentResult: { ok: true; consent_id: string | null } | Refused = { ok: true, consent_id: "k9" };
  async recordPayment(_r: string, passed: boolean, payment: Record<string, unknown>) {
    this.payments.push({ passed, payment });
    return passed ? this.paymentResult : { ok: true as const, consent_id: null };
  }
  holds: HeldBooking[] = [];
  async heldBookings() {
    return this.holds;
  }
  decisions: OpenDecision[] = [];
  async openDecisions() {
    return this.decisions;
  }
  async owedUpdates() {
    return this.deliveries.filter((d) => d.status !== "sent" && !d.message && d.kind === "report")
      .map((d) => d.facts?.place ?? "the business");
  }
  accepted: { bookingId: string; basis: Record<string, unknown> }[] = [];
  async acceptCondition(bookingId: string, _u: string, basis: Record<string, unknown>) {
    this.accepted.push({ bookingId, basis });
    return { ok: true as const };
  }
  settled: CallSettlement[] = [];
  settleResult: { ok: true; request_id: string; state: "done"; option_ids: string[] } | Refused = {
    ok: true,
    request_id: "r1",
    state: "done",
    option_ids: [],
  };
  // Like settle_and_report: the facts are stored with the settlement, to be written.
  deliveries: (Delivery & { status: string; final?: boolean; facts?: Facts; written?: number })[] = [];
  reports: CallReport[] = [];
  async settleCall(_c: string, s: CallSettlement, report?: CallReport) {
    this.settled.push(structuredClone(s));
    if (!this.settleResult.ok || !report) return this.settleResult;
    this.reports.push(structuredClone(report));
    const next = report.next && this.activated === report.next.request_id ? report.next.facts : null;
    this.owe({ ...report.facts, ...(next ? { next_errand: next } : {}) }, s.result === "options");
    return this.settleResult;
  }
  private owe(facts: Facts, options = false) {
    const id = `d${this.deliveries.length + 1}`;
    this.deliveries.push({
      id,
      userId: "u1",
      waId: "919812345678",
      message: undefined as unknown as Outbound,
      attempts: 0,
      kind: "report",
      status: "pending",
      facts,
    });
    if (options) this.optionDeliveries.add(id);
  }
  optionDeliveries = new Set<string>();
  owedFacts: { key: string; facts: Facts }[] = [];
  async oweFacts(_u: string, _r: string | null, key: string, _k: "notice", facts: Facts) {
    if (this.owedFacts.some((o) => o.key === key)) return;
    this.owedFacts.push({ key, facts });
    this.owe(facts);
  }
  createdAt = new Date("2026-10-23T12:00:00+05:30");
  async takeUnwritten(): Promise<Unwritten[]> {
    return this.deliveries.filter((d) => d.status === "pending" && !d.message && d.facts).map((d) => ({
      id: d.id,
      userId: d.userId,
      requestId: "r1",
      facts: d.facts!,
      // As take_unwritten counts it: this write is one more.
      attempts: (d.written ?? 0) + 1,
      createdAt: this.createdAt,
    }));
  }
  async deliveryWritten(id: string, message: Outbound) {
    const d = this.deliveries.find((x) => x.id === id)!;
    d.message = message;
    if (this.optionDeliveries.has(id)) {
      this.prompt = {
        id: "p-options",
        kind: "options",
        optionIds: this.settleResult.ok ? this.settleResult.option_ids : [],
        confirmWord: "yes",
        waMessageId: null,
        sentAt: this.promptAt,
        text: (message as { body: string }).body,
        message,
      };
    }
  }
  unwritten: string[] = [];
  async deliveryUnwritten(id: string, error: string) {
    this.unwritten.push(error);
    const d = this.deliveries.find((x) => x.id === id)!;
    d.written = (d.written ?? 0) + 1;
    // Backed off: not due again in this test unless it asks.
    d.status = "backing_off";
  }
  alerts: { kind: string; detail: Record<string, unknown> }[] = [];
  outputsSeen: string[] = [];
  async recordCallerOutputs(_c: string, outputs: string[]) {
    this.outputsSeen.push(...outputs);
  }
  brokenCalls: string[] = [];
  async callerContractBroken(c: string) {
    this.brokenCalls.push(c);
  }
  async raiseAlert(kind: string, _r: string, _c: string | null, detail: Record<string, unknown>) {
    this.alerts.push({ kind, detail });
  }
  owed: { key: string; message: Outbound }[] = [];
  async oweMessage(_u: string, _r: string | null, key: string, message: Outbound) {
    this.owed.push({ key, message });
  }
  takenAt: (Date | undefined)[] = [];
  async takeDeliveries(now?: Date) {
    this.takenAt.push(now);
    const d = this.deliveries.find((x) => x.status === "pending" && x.attempts === 0 && x.message);
    if (!d) return [];
    d.attempts++;
    return [d];
  }
  async deferDelivery(id: string) {
    const d = this.deliveries.find((d) => d.id === id)!;
    d.attempts = Math.max(d.attempts, 1);
  }
  async deliverySent(id: string) {
    this.deliveries.find((d) => d.id === id)!.status = "sent";
  }
  async deliveryFailed(id: string, _e: string, final: boolean) {
    const d = this.deliveries.find((x) => x.id === id)!;
    if (final) d.status = "failed";
    d.final = final;
    return d.status;
  }
  due: DueFollowUp[] = [];
  async dueFollowUps() {
    return this.due;
  }
  queuedFollowUps: { reason: string; facts: Facts }[] = [];
  async queueFollowUp(_r: string, reason: string, _s: number, facts: Facts) {
    this.queuedFollowUps.push({ reason, facts });
    this.owe(facts);
    return true;
  }
  followUps: { waitingFor: string | null; remindAt: string | null }[] = [];
  async setFollowUp(_r: string, waitingFor: string | null, remindAt: string | null) {
    this.followUps.push({ waitingFor, remindAt });
    this.req = { ...this.req!, waitingFor, remindAt: remindAt ? new Date(remindAt) : null };
    return { ok: true as const };
  }
  cancelledAfterCall: string[] = [];
  async cancelAfterCall(id: string) {
    this.cancelledAfterCall.push(id);
    return { ok: true as const };
  }
  kept: (Memory & { evidence?: string | null })[] = [];
  async memories() {
    return this.kept;
  }
  async addMemory(_u: string, m: Omit<Memory, "id"> & { evidence?: string | null }) {
    if (this.kept.some((k) => k.text.toLowerCase() === m.text.toLowerCase())) return null;
    const mem = { id: `${this.kept.length + 1}0000000-aaaa`, ...m };
    this.kept.push(mem);
    return mem;
  }
  async forgetMemory(_u: string, id: string) {
    this.kept = this.kept.filter((k) => k.id !== id);
  }
  async startRequest(): Promise<never> {
    throw new Error("not used");
  }
  cancelResult: { ok: true } | Refused | null = null;
  async cancelRequest() {
    if (!this.cancelResult) throw new Error("not used");
    return this.cancelResult;
  }
  async setBusiness(): Promise<never> {
    throw new Error("not used");
  }
  async updateSlots(_id: string, patch: Record<string, unknown>) {
    this.slotWrites.push(patch);
    // Like bump_request: an edit closes the open plan.
    this.prompt = null;
    this.req = { ...this.req!, fields: { ...this.req!.fields, ...patch }, state: "confirming" };
    return { ok: true as const, changed: true, state: this.req.state, version: this.req.version + 1 };
  }
  async advance() {
    return { ok: true };
  }
  async openPrompt(_r: string, promptId: string, p: Prompt) {
    this.prompt = {
      id: promptId,
      kind: p.kind,
      optionIds: p.optionIds,
      confirmWord: p.confirmWord,
      waMessageId: null,
      sentAt: this.promptAt,
      text: p.text,
      message: p.message,
    };
    return { ok: true as const };
  }
  async promptSent(_id: string, wa: string) {
    this.prompt!.waMessageId = wa;
  }
  async promptForMessage(_u: string, wa: string) {
    return this.prompt?.waMessageId === wa ? this.prompt.id : null;
  }
  async promptMessage() {
    return this.prompt!.message;
  }
  promptAt = new Date("2026-10-23T12:00:00+05:30");
  async recordConsent(
    promptId: string,
    optionId: string | null,
    word: string,
    wa: string,
    basis?: Record<string, unknown>,
  ) {
    this.consents.push({ promptId, optionId, word, wa, basis });
    return this.consentResult;
  }
}
