// In-memory ChatStore for the chat-agent tests. The real rules live in SQL (chat_test.sql).
import type { Outbound } from "../whatsapp.ts";
import type { OpenPrompt } from "./gate.ts";
import type { Prompt } from "./readback.ts";
import type { RouteLog } from "./router.ts";
import type { ActiveRequest, ChatStore, ConsentStored, Refused, TurnClaim } from "./store.ts";

export class FakeChatStore implements ChatStore {
  req: ActiveRequest | null = null;
  prompt: (OpenPrompt & { message: Outbound }) | null = null;
  lastOut: string | null = null;
  inbound = 1;
  limits: Record<string, number | boolean | null> = {
    max_inbound_per_user_per_day: 60,
    book_on_first_call: true,
    max_advance_rs: 500,
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
  async user() {
    return {
      name: "Ihaz",
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
  async queued() {
    return null;
  }
  async lastOutboundId() {
    return this.lastOut;
  }
  async heldDeposit() {
    return false;
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
  async history() {
    return [];
  }
  async liveOptions() {
    return [];
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
  async startRequest(): Promise<never> {
    throw new Error("not used");
  }
  async cancelRequest(): Promise<never> {
    throw new Error("not used");
  }
  async setBusiness(): Promise<never> {
    throw new Error("not used");
  }
  async updateSlots(_id: string, patch: Record<string, unknown>) {
    this.slotWrites.push(patch);
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
  async recordConsent(promptId: string, optionId: string | null, word: string, wa: string) {
    this.consents.push({ promptId, optionId, word, wa });
    return this.consentResult;
  }
}
