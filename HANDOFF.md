# Desk conversation quality — continuation handoff

Checkpoint date: 5 November 2026 (India). Branch: **`imessage-linq`**.
This checkpoint merges the conversation-quality work (b26af24, f97f939) with the local Linq line (call language, transcripts, never-silent reports), makes CI green, fixes what the evals exposed, and deploys it. **Deployed and mechanically green; conversational quality is improved but not yet accepted by the owner.**

## Read this first

The goal is the **entire conversational experience**, not phrase patches: attentive, warm, simple and efficient across real phone errands in India (restaurants, salons, laundry, clinics). Understand context, ask only what's genuinely missing, keep uncertainty honest, remember useful preferences, and get natural approval for the exact action. The source review is [docs/reviews/README.md](docs/reviews/README.md), with conversation, runtime and dependency reviews.

Meaning comes from models, never word lists; code guards money and state. **Do not claim all issues are fixed**: the known gaps below are real.

## Non-negotiable operational constraints

- Every actual Sarvam call stays hardcoded to **+918848878757**, never a business/Maps destination. Purchased outgoing caller ID is **+918064269395**.
- Calling stays paused until the owner explicitly resumes: `DESK_CALLS_PAUSED=1` and database `kill_switch=true` (both verified after this deployment). No automatic unpause, no real call tests.
- Work stays on `imessage-linq`; don't push it into main or overwrite the Codex branch.
- Supabase project **rvglpiyctuzpegbvlane** (`thedesk`). Preserve data and migration history.
- Never commit or print credentials. A project secret key was pasted into chat on 2026-11-05: **rotate it** (Project Settings → API Keys) and update the Vault entry the cron workers use. It was not used.

## Deployed

- Runtime **2626b73** (`DESK_GIT_SHA`), all eight functions: linq-inbound, wa-inbound, sarvam-webhook, reconcile, health, follow-through, dial, wa-send. Previously fc443f5.
- **c2bc169 is not deployed yet**: it gives grounding a 40s deadline (2626b73 has 20s, so one hung model call refuses an edit) and fixes eval-only code. Redeploy the eight functions and set `DESK_GIT_SHA=c2bc169`; no migration.
- Schema **0025**. 0023 `call_language_and_transcripts`, 0024 `never_silent`, 0025 `turn_freshness` were first applied in a hosted transaction ending in rollback, then pushed.
- After deploy: kill switch true; migrations 0022–0025 recorded; `assert_turn` rejects superseded turns; cron jobs desk-expire, desk-health, desk-reconcile, desk-retention, desk-stale-options, desk-transcripts, desk-window-updates. Unsigned linq-inbound, and health/dial without credentials, return 401.
- Not done: the `health` endpoint itself wasn't called (it needs the secret key); Linq `reaction.added`/`reaction.removed` are **not subscribed**; no iMessage conversation was tried on the deployed build.

## What changed in this checkpoint

Mechanics
- Turn freshness renumbered **0023 → 0025** (it clashed with local 0023/0024; none was hosted). Only `assert_turn` changes.
- CI: the db job failed because the ubuntu-26.04 image of 2026-11-01 held port 54322 before Supabase started. CI now names what holds it and runs on 55432. The passing runs got the older image, so that path hasn't run on GitHub yet.
- The three failing follow_through tests now test the intended behaviour rather than being deleted.

Behaviour
- **A promised reminder has to exist in every Jev mode.** Shadow keeps style and scope as measurements, but a reply promising an unset reminder is queried in shadow too, once per turn, so a Jev misreading can't end in the fallback.
- **Reactions:** every 👍 reaches Luna with what it points at; a removed one is ignored at the gate; approval reads only reactions on the plan.
- **A turn lost between the YES and Sarvam** (superseded at the check before `reserve_call`, or before Sarvam) left the request in calling_1 with no call. `dialForTurn` releases it outside the fence: a plan's YES via `defer_changed_consent` (back to its plan), the confirm call via `call_not_started`.
- **Grounding** (independent check before slot changes and plans):
  - a question cited as `questions[0]` counts;
  - null over a never-set field is no change;
  - it never asks to go ahead or re-asks an uncorrected value;
  - it checks one errand of a multi-errand message;
  - 40s deadline.
  Its over-refusals were the largest source of bad turns.
- **Plans:** if the written wording fails or isn't faithful, the plan goes out as the readback instead of "failed on our side". Plans are written in the register of the user's latest messages (Hinglish gets Hinglish).
- **OpenAI client:** 20s per attempt; a hang, 429 or 5xx is retried twice at most within 45s and the caller's deadline. Over 176 answered calls: p50 2.1s, p95 7.7s, max 19s; anything still open at 30s was a hang.
- **Luna prompt:**
  - an errand meant *as well* is queued without asking "after or instead";
  - a saved city is only where to search;
  - window fields are for ranges whose ends were given;
  - a question errand needs no time;
  - "around 8" is asked about without Luna suggesting a number.

Evaluation ([dev/conversation_eval.ts](dev/conversation_eval.ts), now type-checked by `deno task check`)
- Harness faults found and fixed, each of which had been read as a product failure:
  - fake business ids weren't UUIDs (complete-booking "selection isn't going through");
  - a run-wide model-call cap starved cases 12–24;
  - the fake `setBusiness` ignored which errand it wrote.
- Cases assert what must be true afterwards, from state: plan stored and sent, final fields, business bound, separate errand with its question, open booking unchanged, memories, replies. A fallback is a failure.
- An optional model judge (`DESK_EVAL_JUDGE=off` to skip) is recorded beside state checks, never as the human verdict. It has the clock and Desk's rules (a plan asks to go ahead; branch from search; profile name).
- Fixture v2: 24 frozen cases. `DESK_EVAL_ONLY=id,id` runs named ones.

## Verified

- `deno task check` passes; **456 unit tests pass, 0 fail**; bench safety 3/3; internal auth passes.
- pgTAP **514/514** (incl. the lost-turn release), on an isolated local database with stock Supabase grants; concurrency suite passes. GitHub CI green on 2626b73 (deployed) and c2bc169 (both jobs).
- Real-model eval (FakeChatStore, fixture search, no calls/DB/transport; [evidence](docs/reviews/evidence/)):
  - Baseline after harness fixes: 12/24 state failures, half of them invalid (cap) — `conversation-eval-2026-11-05-baseline.json`.
  - Candidate (2626b73): 5/24 state failures, 8 judge misses — `…-candidate.json`. Two of those 5 were since traced to the harness `setBusiness` fault and the grounding deadline, fixed in c2bc169 and rerun clean — `…-rerun.json`.
  - Cases flip between runs; one run is not a distribution. ~423k input tokens per full run.
- No hard failure in any run: no unapproved action, stale approval, wrong destination, fabricated outcome, or cross-errand write in product code.

## Known gaps (in order of how often they showed)

1. **Saved city vs named area.** "Snow White Laundry in Indiranagar" with a saved city of Kozhikode still gets "Is that the one?" (returning-conversation, laundry-price). The prompt line didn't move it; the find result probably needs to say the match is in the area they named.
2. **Edits don't always re-propose.** Usually "nine people, same time" → updated plan; sometimes a confirmation question instead. Watch `unambiguous-edit` / `correction-after-plan` across runs.
3. **A plan doesn't mention the other errand it queued** (two-errands-one-message): state is right, wording omits it.
4. **"Around 8"** is asked about flexibility; the review allows that, the judge dislikes it. Decide the intended behaviour (propose "about 8" vs ask).
5. **Laundry pickup** asks for a time range on top of the address.
6. Not qualified at all: real search, PostgreSQL races through the real adapters, Linq reaction webhooks live, voice calls.

## Next steps

1. **Owner acceptance on iMessage** against the deployed build: restaurant, salon, laundry, clinic, a correction, a second errand. Calls stay paused; plans are the thing to judge.
2. Fix gap 1 at the tool result (say when the match is in the named area), then rerun those cases a few times.
3. Run the full 24 at least three times per candidate and compare distributions per case, not single runs.
4. Enable `reaction.added`/`reaction.removed` on the Linq subscription only after verifying signature/ownership on the deployed handler with a real Tapback.
5. Rotate the pasted secret key; configure the GitHub daily monitor's repository secrets (still unqualified).

## Commands

```bash
export PATH=~/.deno/bin:$PATH
deno task check && deno task test && deno task test:bench && deno task test:auth
# Database: an isolated desk_verify_* database in the local Supabase container (never production)
python3 scripts/test_db_concurrency.py --database desk_verify_<name>
# Real-model eval (paid; no calls, DB or transport)
DESK_EVAL_CASES=24 DESK_EVAL_OUTPUT=/tmp/desk-eval.json deno run --allow-read --allow-write=/tmp \
  --allow-env --allow-net=api.openai.com dev/conversation_eval.ts
# Release (Supabase CLI 3; `supabase login` stores the token in the macOS keychain)
npx supabase@3.0.0 migration list --remote=rvglpiyctuzpegbvlane
npx supabase@3.0.0 db push --remote=rvglpiyctuzpegbvlane --yes
npx supabase@3.0.0 functions deploy linq-inbound wa-inbound sarvam-webhook reconcile health \
  follow-through dial wa-send --remote=rvglpiyctuzpegbvlane --use-api --yes
```

`scripts/test_db_concurrency.py` names the Linux Docker socket; on macOS drop its `--host` argument locally. For a hosted dry run, wrap the migrations in BEGIN/ROLLBACK and run `db query --remote=… --file=…`.

## File map

All `_shared` paths are under `supabase/functions/`.
- Runtime and consistency: `_shared/chat/agent.ts`, `turn_control.ts`, `_shared/dial.ts` (`dialForTurn`), `agent_runtime.ts`, migration 0025.
- Meaning and proposals: `chat/intent_grounding.ts`, `plan_writer.ts`, `turn.ts` (`proposePlan`), `tools.ts`, `slots.ts`, `readback.ts`, `call_vars.ts`.
- Conversation: `chat/luna.ts`, `cards.ts`.
- Transport: `_shared/linq.ts`, `linq-inbound/handler.ts`, `_shared/store.ts`.
- Dependencies: `_shared/openai.ts` (retry), `model_client.ts`, `places.ts`, `serper.ts`.
- Evaluation: `dev/conversation_eval.ts`, `fixtures/conversation/quality-smoke.json`.
