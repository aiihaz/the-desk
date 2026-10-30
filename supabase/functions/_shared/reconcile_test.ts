import { assertEquals } from "jsr:@std/assert@1.0.8";
import { type OpenCall, reconcile, type ReconcileDeps } from "./reconcile.ts";
import type { Attempt, CallResult } from "./sarvam.ts";

const now = new Date("2026-10-23T20:00:00+05:30");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

function setup(calls: OpenCall[], attempts: Attempt[]) {
  const finished: CallResult[] = [];
  const timedOut: string[] = [];
  const lost: string[] = [];
  const asked: { from: Date; to: Date }[] = [];
  const deps: ReconcileDeps = {
    openCalls: async () => calls,
    limitInt: async (k) =>
      ({ reconcile_after_minutes: 15, reconcile_give_up_minutes: 120 } as Record<string, number>)[k],
    listAttempts: async (from, to) => {
      asked.push({ from, to });
      return attempts;
    },
    transcript: async () => [{ role: "agent", en_text: "Hello" }, { role: "user", en_text: "Yes, booked." }],
    finish: async (r) => void finished.push(r),
    timeoutCall: async (id) => (timedOut.push(id), true),
    reportLost: async (id) => void lost.push(id),
    now: () => now,
  };
  return { deps, finished, timedOut, lost, asked };
}

const attempt = (id: string, status: string, vars: Record<string, unknown> | null = null): Attempt => ({
  attempt_id: id,
  interaction_id: "20261023/abc",
  connectivity_status: status,
  failure_reason: "NO_FAILURE_REASON",
  duration_in_seconds: 95.6,
  agent_variables: vars,
  bot_contact_identifier: "+918041234567",
});

Deno.test("a finished attempt is reported as its webhook would have been, with the transcript", async () => {
  const { deps, finished, asked } = setup(
    [{ id: "c1", attemptId: "a1", createdAt: ago(30) }],
    [attempt("a1", "connected", { outcome: "booked" })],
  );
  const sum = await reconcile(deps);
  assertEquals(sum, { checked: 1, found: 1, timed_out: 0, waiting: 0 });
  assertEquals(finished[0].callId, "c1");
  assertEquals(finished[0].status, "completed");
  assertEquals(finished[0].durationS, 96);
  assertEquals(finished[0].failureReason, null);
  assertEquals(finished[0].outputs, { outcome: "booked" });
  assertEquals(finished[0].transcript?.length, 2);
  assertEquals(asked[0].from, ago(35));
});

Deno.test("an attempt still going, or not found, waits until the give-up time", async () => {
  const { deps, finished, timedOut } = setup(
    [{ id: "c1", attemptId: "a1", createdAt: ago(30) }, { id: "c2", attemptId: "a2", createdAt: ago(40) }],
    [attempt("a1", "in_progress")],
  );
  assertEquals(await reconcile(deps), { checked: 2, found: 0, timed_out: 0, waiting: 2 });
  assertEquals(finished.length + timedOut.length, 0);
});

Deno.test("no result after the give-up time: closed as timeout, the user told, never redialled", async () => {
  const { deps, timedOut, lost } = setup(
    [{ id: "c1", attemptId: null, createdAt: ago(121) }, { id: "c2", attemptId: "a2", createdAt: ago(200) }],
    [],
  );
  assertEquals(await reconcile(deps), { checked: 2, found: 0, timed_out: 2, waiting: 0 });
  assertEquals(timedOut, ["c1", "c2"]);
  assertEquals(lost, ["c1", "c2"]);
});

Deno.test("no-answer attempts need no transcript; Analytics down closes nothing early", async () => {
  const { deps, finished } = setup([{ id: "c1", attemptId: "a1", createdAt: ago(20) }], [
    attempt("a1", "no_answer"),
  ]);
  let transcripts = 0;
  deps.transcript = async () => (transcripts++, []);
  await reconcile(deps);
  assertEquals(finished[0].status, "no_answer");
  assertEquals(transcripts, 0);

  const down = setup([{ id: "c1", attemptId: "a1", createdAt: ago(20) }], []);
  down.deps.listAttempts = async () => {
    throw new Error("503");
  };
  assertEquals(await reconcile(down.deps), { checked: 1, found: 0, timed_out: 0, waiting: 1 });
});

Deno.test("nothing open: Sarvam isn't asked", async () => {
  const { deps, asked } = setup([], []);
  await reconcile(deps);
  assertEquals(asked.length, 0);
});
