// Diagnostics for the Desk's checks (0027): which check ran, what it decided, on which attempt,
// and whether the writer's words or a fallback went out. Recording only: nothing here changes
// what a check decides or what the user gets.
//
// Two tiers. A CheckEvent holds no conversation text: its reason is always one of the short
// codes made here, never a model's words or a raw error message (an API error can echo the
// request). A checker's own words go in `detail`, and the database keeps them only while an
// investigation has them switched on (check_details_until), and never for someone awaiting
// erasure (record_checks decides both, so no caller can skip it).
//
// Events are buffered per turn or per report and written once, after the user's message has
// gone, so a failed write never costs a reply. A lost batch is counted in the logs, and shows
// as a turn, plan or report with no event of its own (see 0027).
import type { ChatStore } from "./store.ts";

export type CheckName =
  | "plan_check"
  | "plan_source"
  | "report_check"
  | "report_source"
  | "reply_code"
  | "reply_jev"
  | "reply_promise"
  | "luna_turn"
  | "redirect"
  | "grounding"
  | "approval"
  | "diag_dropped";

export type CheckOutcome =
  | "pass"
  | "reject"
  | "unusable"
  | "error"
  | "writer"
  | "readback"
  | "plain"
  | "fallback"
  | "template";

// From the check's purpose, set here, never read from a model.
export type CheckCategory = "fidelity" | "format" | "safety" | "obligation" | "consent" | "availability";

export type CheckEvent = {
  check: CheckName;
  outcome: CheckOutcome;
  category?: CheckCategory;
  reason?: string;
  attempt?: number;
  run_id?: string;
  model?: string;
  latency_ms?: number;
  request_id?: string | null;
  delivery_id?: string | null;
  prompt_id?: string | null;
  // The checker's own words: tier two, kept only while switched on. May quote the user.
  detail?: string[];
};

const MAX_EVENTS = 50;
const MAX_DETAIL_ITEMS = 10;
const MAX_DETAIL_CHARS = 300;

// A reason is a code: lower case, digits, _ : - only, and short. Anything else is replaced,
// so a caller can't slip text in by mistake.
export function code(reason: string): string {
  const c = reason.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return c || "unknown";
}

// What kind of failure a model call was, as a code. The message itself never leaves here.
export function errorKind(e: unknown): string {
  const err = e as { name?: string; message?: string };
  const msg = String(err?.message ?? e ?? "");
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || /timed? ?out|timeout/i.test(msg)) {
    return "timeout";
  }
  const incomplete = /^openai response (\w+): (\w+)/.exec(msg);
  if (incomplete) return code(`${incomplete[1]}:${incomplete[2]}`);
  const status = /^openai (\d)\d\d\b/.exec(msg);
  if (status) return `http_${status[1]}xx`;
  if (/missing output/.test(msg)) return "no_output";
  if (/turn lease lost|turn_invalid/i.test(msg)) return "turn_lost";
  return "other";
}

// checkReply's reasons (tell.ts) as codes.
export function replyRule(problem: string): string {
  if (problem === "empty") return "empty";
  if (problem.startsWith("too long")) return "too_long";
  if (problem.startsWith("no links")) return "link";
  if (problem.startsWith("no markdown")) return "markdown";
  return code(problem);
}

export class CheckLog {
  private events: CheckEvent[] = [];
  private dropped = 0;
  // The turn's or report's own summary, written last (luna_turn, redirect, report_source).
  summary: CheckEvent | null = null;

  record(e: CheckEvent): void {
    if (this.events.length >= MAX_EVENTS) {
      this.dropped++;
      return;
    }
    this.events.push({
      ...e,
      ...(e.reason !== undefined ? { reason: code(e.reason) } : {}),
      ...(e.detail
        ? { detail: e.detail.slice(0, MAX_DETAIL_ITEMS).map((d) => String(d).slice(0, MAX_DETAIL_CHARS)) }
        : {}),
    });
  }

  // Everything recorded, then the summary, then how many didn't fit.
  drain(): CheckEvent[] {
    const out = [...this.events];
    if (this.summary) out.push({ ...this.summary, reason: this.summary.reason && code(this.summary.reason) });
    if (this.dropped) {
      out.push({ check: "diag_dropped", outcome: "error", reason: `dropped:${this.dropped}` });
    }
    this.events = [];
    this.summary = null;
    this.dropped = 0;
    return out;
  }

  // One write, never thrown: diagnostics must not cost the user anything.
  // waMessageId: the message the turn answered; the database links every event to it.
  async flush(
    store: Pick<ChatStore, "recordChecks">,
    userId: string,
    waMessageId?: string | null,
  ): Promise<void> {
    const events = this.drain();
    if (!events.length || !store.recordChecks) return;
    try {
      await store.recordChecks(userId, events, codeVersion(), waMessageId ?? null);
    } catch (e) {
      console.warn("check_events write failed", { lost: events.length, kind: errorKind(e) });
    }
  }
}

// The deployed commit, set at deploy (DESK_CODE_VERSION). Unset reads as unknown, never a guess.
export function codeVersion(): string {
  try {
    const v = Deno.env.get("DESK_CODE_VERSION");
    return v ? code(v) : "unknown";
  } catch {
    return "unknown";
  }
}
