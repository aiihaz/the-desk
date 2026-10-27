// The chat agent's entry for one stored inbound message. wa-inbound (production) and
// the dev bench both come through here, so what the bench evaluates is what users get.
// Commands run at once. Anything else waits turn_debounce_ms, then runs as one turn per
// user at a time (claim_turn): a burst of messages is one turn, answered once, and Luna
// sees every message in it.
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
    await store.markHandled(msg.messageId);
    return handleTurn(user, msg, deps);
  }

  await sleep((await store.limitInt("turn_debounce_ms", user.id)) ?? 1500);
  for (let waited = 0;; waited += RETRY_MS) {
    const claim = await store.claimTurn(user.id, msg.messageId, LEASE_S);
    if (claim.status === "claimed") {
      try {
        return await handleTurn(user, msg, deps, claim.batch);
      } finally {
        await store.releaseTurn(user.id, msg.messageId);
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
