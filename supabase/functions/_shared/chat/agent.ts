// The chat agent's entry for one stored inbound message. wa-inbound (production) and
// the dev bench both come through here, so what the bench evaluates is what users get.
// Commands run at once. Anything else waits turn_debounce_ms, then runs as one turn per
// user at a time (claim_turn): a burst of messages is one turn, answered once, and Luna
// sees every message in it.
import { isTurnInvalidated } from "./turn_control.ts";
import type { User } from "../store.ts";
import type { Inbound } from "../whatsapp.ts";
import { command } from "./gate.ts";
import { handleTurn, type TurnDeps } from "./turn.ts";

export type AgentDeps = TurnDeps & { sleep?: (ms: number) => Promise<void> };

// A turn that dies holds the user for at most this long.
const LEASE_S = 90;
// How long a message waits for the turn before it, and how often it checks.
const MAX_WAIT_MS = 100_000;
const RETRY_MS = 400;

export async function handleInbound(user: User, msg: Inbound, deps: AgentDeps): Promise<void> {
  const { store } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // STOP must act now, even mid-turn. START only counts while stopped; otherwise it is text.
  const cmd = command(msg, deps.isAdmin(user.waId));
  if (cmd && (cmd.command !== "start" || (await store.user(user.id)).stoppedAt)) {
    await handleTurn(user, msg, deps);
    await store.markHandled(msg.messageId);
    return;
  }

  await sleep((await store.limitInt("turn_debounce_ms", user.id)) ?? 1500);
  for (let waited = 0;; waited += RETRY_MS) {
    const claim = await store.claimTurn(user.id, msg.messageId, LEASE_S);
    if (claim.status === "claimed") {
      const bound = claim.token ? store.forTurn?.(user.id, claim.token) : undefined;
      let lost = false;
      let renewing: Promise<void> | null = null;
      const heartbeat = bound
        ? setInterval(() => {
          if (!renewing) {
            renewing = bound.renewTurn!().catch(() => {
              lost = true;
            }).finally(() => {
              renewing = null;
            });
          }
        }, 20_000)
        : undefined;
      const guarded = bound
        ? {
          ...deps,
          store: bound,
          send: async (...args: Parameters<AgentDeps["send"]>) => {
            if (lost) throw new Error("turn lease lost");
            await bound.assertTurn?.();
            return deps.send(...args);
          },
          luna: (u: User, t: string, m: Inbound) => deps.luna(u, t, m, bound),
          onPayment: (u: User, r: Parameters<AgentDeps["onPayment"]>[1], m: Inbound) =>
            deps.onPayment(u, r, m, bound),
        }
        : deps;
      try {
        await handleTurn(user, msg, guarded, claim.batch);
        if (bound) await bound.completeTurn?.();
        return;
      } catch (e) {
        if (bound) await bound.abandonTurn?.().catch(() => {});
        // The latest inbound worker (or durable recovery) owns the next decision.
        // Never convert a normal correction/STOP into an apology or stale outbox item.
        if (isTurnInvalidated(e)) return;
        throw e;
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (renewing) await renewing;
        if (!bound) await store.releaseTurn(user.id, msg.messageId);
      }
    }
    // newer: a later message's turn takes this one too. handled: a turn already took it.
    deps.trace?.("turn_wait", { message: msg.messageId, status: claim.status });
    if (claim.status !== "busy") return;
    if (waited >= MAX_WAIT_MS) {
      console.error("turn wait timed out", msg.messageId);
      return;
    }
    await sleep(RETRY_MS);
  }
}
