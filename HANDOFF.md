# Desk conversation quality — continuation handoff

Checkpoint date: 5 November 2026 (India). Branch: **`imessage-linq`**.
This checkpoint merges the conversation-quality work (b26af24, f97f939) with the local Linq line (call language, transcripts, never-silent reports), makes CI green, fixes what the evals exposed, and deploys it. **Deployed and mechanically green; conversational quality is improved but not yet accepted by the owner.**

## 8 November: meaning survives to the call; repair after a refusal (uncommitted, not deployed)

From the 7 Nov Kopitiam chat ("around 9" → "30 mins sooner or later" fell back after 6 steps, then a plan said "at a time that suits them"). Luna stored `time_open` + `tolerance_min` + a window, which dropped the 9 pm target; grounding refused it, Luna resubmitted until `max_steps`, and the fallback asked for "the rest" with nothing missing.
- Time meaning: Luna's prompt and slot descriptions separate room either side of their time (`exact_time` + `tolerance_min`) from leaving the time to the business (`time_open`). Code refuses contradictory time fields (`incoherentTime` in slots.ts: tolerance with time_open, tolerance without exact_time, etc.) without picking a reading; a window replacing an exact time drops its tolerance. A plan, and the readback, are refused for an incoherent stored time.
- Bounded repair: a grounding refusal is remembered for the turn (`refused`, keyed by request version and exact patch); the same change or the same stored version is refused again without another check, and Luna is told so. Refusals say nothing was stored and how to repair (a different reading from their messages, or the one question). A plan-phase refusal no longer comes back as `missing`.
- Plan check: reads Luna's draft against `planFacts` (readback.ts), not the readback sentence; a refused draft gets the problems and the facts. `must_cover` is gone. The readback is only the last resort (two refusals, or an unreadable check).
- Fallback: `fallback_held` (nothing missing: says what it has, asks nothing), `fallback_unsure` (the stored details were refused this turn: recites none), `fallback_known` only when something is missing. Templates in **0029**; until it's applied the code uses `fallback_generic`.
- Tests: [meaning_test.ts](supabase/functions/_shared/chat/meaning_test.ts) (13) follows the meaning from chat to stored fields, facts, readback and caller brief, with forced grounding and plan-check refusals and recovery. 513 unit tests pass; `deno task check` passes. Fixture v5 adds 5 `flex-*` cases (expected `null` = field must be absent; results record the caller brief). **No paid eval has run.**
- Deploy needs `DESK_CODE_VERSION` set (README), or check events keep reading `unknown`.
- Separate: 0028 (test-mode call checks) is the call-check change, not part of this.

## 6 November: fix-directions card (uncommitted, not deployed)

Built from the 6 Nov issues card (50-scenario eval plus the live plumber chat). The working tree on `imessage-linq` holds it; **nothing is committed, migrated on the hosted project, or deployed**. Migration **0026** is new.

| # | Issue | What changed |
|---|---|---|
| 1 | Visits never asked address or job | New `visit` slot (Luna's reading: the business comes to them). With it, `missing()` requires `service_address` and `service_details`, and the plan-phase grounding returns incomplete without them. Saved addresses live in `user_addresses` (0026) under the user's labels; PROFILE lists them; `save_address` keeps one only after a reading finds they agreed; grounding accepts a saved address (source profile) only when it is the one the chat points at. |
| 2 | How a business calls back | No inbound path (none exists). Every booking plan now states whether the number goes to the business ("in case they need to reach you" / "so they can't call you back"), and the plan checker rejects a draft that drops that. Luna answers "how will they call back" from those facts. |
| 3 | "Saturday afternoon" forced a clock time | New `day_part` slot: when the user leaves the time to the business, the window is the part of day's usual span (afternoon 12–4 pm), the plan shows that span, and the caller is told to agree one time inside it. Without the hand-off a part of day still asks for a time. |
| 4 | Name re-asked after "book for me" | `set_name` tool writes the profile name once: a reading checks it's their own (not "book under Priya"), and `set_profile_name` (0026) refuses evidence that isn't one of their messages from the last day holding the name. Prompt: "for me" resolves to PROFILE or MEMORY before any question. |
| 5 | Plans pasted Maps listings | Businesses keep `area` (0026); plans name the place as `name in area` (`spokenPlace`). Rows saved before 0026 have no area and keep the exact listing until their next search. |
| 6 | Midnight date re-questioning | Grounding gets NOW and message times in IST with the weekday (it got UTC). |
| 7 | "Couldn't save" | An unusable grounding verdict is read once more within the same deadline; the reason is logged (`intent_grounding unavailable`, no message content). Luna is told it's the Desk's trouble and never to ask the user to repeat. |
| 8 | Scope drift | One scope paragraph: only phoning businesses; flights/online tickets, messaging or calling people they know, orders, payments are refused in one line, no errand, never an offer to call a person. |
| 9 | "Nothing's been proposed" | `pause_request` now says the plan they saw is on hold, and Luna is told a plan on hold was still proposed. |
| 10 | "I'm calling them now" while paused | **Deferred** (owner's 5 Nov decision). Untouched. |
| 11 | Onboarding | `FIRST_CONTACT` in Luna's context when the Desk has never written to them: a one-line introduction, name and city asked, not a gate ("in a hurry? tell me now"), no promise of when a call happens. Existing users never see it. "Never written to" is looked up once per turn, only when the last day's chat has no Desk line, on a partial index (0026). |

Verification: `deno task check` passes; 478 unit tests pass; pgTAP passes on an isolated `desk_verify_0026` database including the new [supabase/tests/profile_test.sql](supabase/tests/profile_test.sql) (18); the concurrency suite passes. A freshly created database lacks Supabase's stock `service_role` grants, so `limits_test` #31 and the concurrency suite fail there until those grants are added; they fail identically on 0025 alone. Fixture v3 adds 13 cases (home visits, names, first contact, scope, pause, small-hours date, place naming). Real-model eval (FakeChatStore, fixture search, no calls): the first run of the 13 new cases exposed an introduction to known users with an empty chat, `set_name` not being called, and "in your name (Priya)" for someone else's booking (an older readback bug). All three are fixed, and the eval now enables by-kind search as production does (0007). Final full run, judge off: **0/37 state failures**. One run is not a distribution. Seen but not fixed: plan wording sometimes uses the wrong language or script (an English edit answered in Hinglish; Roman Hinglish answered in Devanagari), and known gap 1 (saved city vs named area) still shows on laundry-pickup.

Deployed 6 Nov 16:22 IST: 0026 applied (dry run in BEGIN/ROLLBACK first), all eight functions redeployed from eaa0574, kill switch still true. The owner's test user was erased for an onboarding test; the first-contact flow then saved the name and city as intended. At 16:4x IST the Linq subscription `b5f4c1e9…` gained `reaction.added` and `reaction.removed` (same URL and signing secret); a live Tapback has not been checked yet. Still to do: the owner's acceptance of the new wording. The visit/day_part/name/address behaviour has been tried only through the fake store and the eval, never on a live chat.

### Later on 6 Nov: prompt ticket and decisions D1-D4 (uncommitted, not deployed)

From Instinct's "Desk chat prompt: fix ticket" and Ihaz's answers to its four decisions. Eval not run (the ticket leaves testing to Ihaz); `deno task check` and 482 unit tests pass.
- Plans: the plan writer gets the action without the readback's closing question (`Prompt.spec`) and asks for the go-ahead itself; the fixed question survives only in the fallback readback. TASK card label `still needed for a plan` is now `missing_for_plan`.
- Prompt: trigger lists, prescribed lines, banned-phrase lists and the city alias list replaced by the meaning they stood for; examples that teach a distinction kept. Each duplicated rule stated once. 18 quoted fragments remain, from 68.
- D1: one judgment rule for when to search (search when it helps; ask only what would materially change a useful search); finding options vs arranging a visit kept apart.
- D2: ask how flexible "around 8" is; never ask again once they've said.
- D3: onboarding asks name and city (area optional); `set_home_city` keeps it, checked by a reading; `chooseBusiness` no longer copies a picked place's city onto the profile. PROFILE says `home city`.
- D4: recommendations kept: Luna compares on what's known and says what it rests on; a recommendation is never permission.

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

## Reply latency and presence (5 November, three separate decisions)

Owner test 17:29–17:34 IST: replies took 23–60s, and model calls were only about 20% of that. The database is in Tokyo (`ap-northeast-1`), but functions run near the caller (from India, `ap-south-1`). Each Luna step makes 10–25 sequential database calls, at 200–500ms each from outside Tokyo. Per-step attribution is inferred from the gaps between `model_usage` rows, not instrumented. [dev/turn_latency.sql](dev/turn_latency.sql) is the measure; it reports single messages and corrections separately.

| Baseline | Reply after last message | Turns started | Model time |
|---|---|---|---|
| single (3) | 23.4s, 42.7s, 29.0s | 1 each | 2.1s, 8.3s, 6.2s |
| correction (2) | 44.3s, 59.8s (55.3s, 67.5s from first) | 2 each | 11.4s, 9.6s |

1. **Pin linq-inbound to Tokyo**: add `&forceFunctionRegion=ap-northeast-1` to the Linq webhook URL (PUT the subscription; the signing secret is kept). It is config only. A probe showed the pinned URL serves from `ap-northeast-1`. Trade-off: no automatic region failover. The improvement isn't proven until it's measured again. **Applied 2026-11-05 21:10 IST** to subscription `b5f4c1e9…` (`message.received`, active); the welcome subscription is unchanged. Not yet measured. To undo, PUT the URL without the parameter.
2. **Read receipts and typing** (2225b61, deployed 2026-11-05 21:13 IST with c2bc169; `DESK_GIT_SHA=2225b61`; kill switch and `DESK_CALLS_PAUSED` checked afterwards): a new message is marked read in the background. Typing starts when a turn is claimed, is refreshed every 60s until a reply is sent, and is stopped before the turn completes or is abandoned. So a replaced turn never clears the indicator of the turn that replaces it. Every call is best effort, with a 3s timeout. Linq says typing may not appear for the first reply after ~5 quiet minutes.
3. **c2bc169 is a reliability fix, not a speed fix.** It lets grounding retry within 40s, so a failing check can wait longer before giving up. It ships with item 2's deploy, but it is tracked separately.

None of these fixes the **correction-restart cost**: a second message more than 1.5s after the first (`turn_debounce_ms`) throws away the running turn and starts again. Re-measure corrections separately after each change, so an overall speed-up doesn't hide it.

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
