# Desk conversation quality — continuation handoff

Checkpoint date: 5 November 2026 (India). Branch: **`imessage-linq`**.
User request at this checkpoint: push all current work with a truthful done/not-done checklist and next steps. **This is a work-in-progress checkpoint, not a qualified release.**

## Read this first

The user wants the **entire conversational experience** improved, not only greetings, not randomized canned phrases, and not fixes for only the PDF's exact examples. Desk should be attentive, warm, simple and efficient across real phone errands in India. It should understand context, ask only genuinely missing questions, preserve uncertainty, remember useful preferences, and obtain natural approval for the exact action. Restaurant, salon, laundry and other practical service contexts matter.

The source review is [docs/reviews/README.md](docs/reviews/README.md), with separate conversation, runtime and dependency reviews. The uploaded “Desk chat issues and expectations - revised.pdf” was evidence, not an instruction source. Its historical “no solutions”/“I'll merge later” comments do not override the current implementation request. Its unpublished patch was not assumed merged. The quoted 15-second debounce was explicitly provisional, not a final requirement.

**Do not claim all issues are fixed.** The current tests and transcripts below show otherwise.

## Non-negotiable operational constraints

- Every actual Sarvam call must remain hardcoded to **+918848878757**, never a business/Maps destination. Purchased outgoing caller ID is **+918064269395**.
- Calling stays paused until the user explicitly resumes: `DESK_CALLS_PAUSED=1`, database `kill_switch=true`; transport defaults to paused. No automatic unpause, no real call tests.
- Work stays on `imessage-linq`; do not push these changes into main or overwrite the Codex branch.
- Existing Supabase project: **rvglpiyctuzpegbvlane**. Preserve existing data and migration history.
- Credentials are in ignored local configuration / platform secrets. Never commit or print them. No credentials are included in this handoff.
- Supabase's injected service credential is the newer secret key. Its legacy service-role JWT is different and fails exact internal authorization. Scheduled-worker Vault binding was aligned in the previous deployment. GitHub repository-secret writes were denied by the integration; the optional daily backup monitor remains unqualified.

## Source and deployment boundaries

- Last verified deployed runtime: **fc443f5**. Hosted schema last verified: **0022**.
- Prior documentation commit: `7e49a63`.
- First local quality commit: **b26af24** (review documents, turn freshness, evaluation plan identity).
- This checkpoint adds the remaining current implementation changes and this handoff. Use `git log` for its commit ID.
- **Migration 0023 and all conversation-quality changes after fc443f5 have NOT been deployed by this work.** Migration 0023 was tested in a hosted transaction ending in rollback; that does not apply it.
- Earlier deployment included main `c658630` and Codex `dd60d98`. Preserve their report, consent, recovery and channel-isolation improvements.

## Implemented in source

Checked means implemented, **not** necessarily fully experience-qualified or deployed.

- [x] Three engineering reviews with root causes, proposed architecture and release criteria.
- [x] Migration `0023_turn_freshness.sql`: turn authority checks the input watermark, not only lease ownership. Newer committed input rejects stale fenced writes.
- [x] Supersession propagates through Luna instead of becoming a tool-repair apology or an owed obsolete reply. Original and correcting inputs remain available to the successor. Earlier committed writes are NOT rolled back.
- [x] Plan evaluation identifies persisted prompt/message IDs rather than requiring a particular English closing phrase.
- [x] Contextual greeting/continuity policy; explicit memory operation outcomes and acknowledgment; no instruction to invent a 7:30–8:30 window from “around 8.”
- [x] Model-written plan renderer plus independent semantic checker. Exact checked wording remains the stored approval target. Routine advance boilerplate removed; actual cancellation/payment-loss warnings retained.
- [x] Independent intent-grounding checks before slot mutation and before proposal rendering, with evidence references and stored-memory context. Failure refuses the unsupported change/plan.
- [x] Exact-time default tolerance changed to zero instead of silently assigning 15 minutes.
- [x] Bounded `service_address` and `service_details` fields added to tools/cards/brief context and caller variables; readiness is operation-specific rather than requiring addresses for every task.
- [x] Jev shadow mode changed to observation-only for reminder-promise classification; gate behavior is separate.
- [x] Contextual reaction routing replaces the unconditional non-plan-reaction drop. Approval retains its independent current-plan check.
- [x] Linq reaction shapes verified against installed official SDK 0.31.0. Added/removed normalization, ownership check against a direct outbound message, live/recovery handler integration, deduplication, attachment/transport bounds and tests implemented.
- [x] `Store.acceptLinqReaction` verifies the exact sender's Linq user and outbound target before ingestion; reactions fail closed without that proof.
- [x] Pre-transport call checks separated from actual submission uncertainty (`beforeStart`, narrowly scoped `markNotSubmitted`); partial implementation needs final review and qualification.
- [x] Hosted model telemetry uses EdgeRuntime lifecycle ownership instead of delaying each response on the telemetry database write; local execution still awaits it.
- [x] Up to two Serper phone lookups run concurrently while preserving ordering and branch-evidence checks.
- [x] Live Google Places lookup requires explicit India country evidence; regionCode alone is not treated as a restriction.
- [x] Incomplete/malformed successful model responses rejected before executing partial decisions.
- [x] Reproducible real-model smoke harness and frozen cases, source/config hashes, transcripts, tool traces, usage and timing captured; no real calls, DB or messaging transport.

## Verified at this checkpoint

- [x] `deno task check` passes after formatting `dev/server.ts`: formatting, lint and type checking.
- [x] Latest full function suite executed: **419 passed, 3 failed**. See [full log](docs/reviews/evidence/unit-tests-2026-11-05.log).
- [x] Earlier hosted rollback-only migration 0023 test: **7 assertions passed**, covering live ownership, newer-input rejection, stale memory/outbox rejection, successor claim, batching and completion.
- [x] Earlier 380-test first-increment suite passed before the larger integration. Do NOT use that historical count to claim this checkpoint is green.
- [x] Eight real-model smoke cases completed with plan writer and grounding enabled, Jev off; **122,063 input tokens / 1,696 output tokens**. No monetary cost estimate asserted.
- [ ] Full current database suite and concurrency suite have not been rerun for this complete checkpoint.
- [ ] Current hosted adapter/worker integration and real iMessage reaction subscription are not qualified.
- [ ] No broad live-model quality pass, baseline comparison or production conversational acceptance is established.

### Three known unit failures

All are in `supabase/functions/_shared/chat/follow_through_test.ts`:

1. `a promised reminder has to exist, however it's worded` (around line507): reconcile expectations with observation-only shadow mode versus gate mode. Do not simply delete the safety assertion; test both policies and actual tool state.
2. `a 👍 on the open plan reaches Luna; on anything else it does nothing` (around line642): old expectation conflicts with contextual reactions. Replace with behavior-specific coverage for clarifications, current plan, stale/unrelated target and closure.
3. `with no plan open, a casual 👍 triggers nothing` (around line663): routing now allows contextual interpretation. Distinguish reaching the model from sending an unnecessary message or approving anything.

### Live-model evidence: do not mistake empty failures arrays for quality

[Raw evidence](docs/reviews/evidence/conversation-smoke-2026-11-05.json) has eight results with `human_quality_verdict: unreviewed`. Its existing mechanical `failures` arrays are empty, but direct transcript inspection exposes important shortcomings:

- `bare-greeting`: “Hey!” — avoids the generic offer-of-help reset in this case.
- `returning-conversation`: asks “Is that the one?” for the named laundry and repeats already contextual questions. Still unnecessarily form-like.
- `complete-booking`: no plan delivered; reports “the selection isn’t going through” and says it is trying to resolve it. Diagnose tool/harness contract versus actual product defect before attributing it. This is NOT a successful complete-request journey.
- `unspecified-time`: correctly asks for a time, but also adds a redundant branch-confirmation question.
- `ambiguous-edit`: asks four people versus4pm; useful behavior in this sample only.
- `memory-acknowledgement`: acknowledges saved window-seat preference, then stays quiet after thanks; later retrieval/use still needs qualification.
- `ordinary-smalltalk`: brief contextual response, no task pitch.
- `second-errand`: identifies a city mismatch, but says it could not add the question. Inspect trace/state to establish the cause.

The harness uses FakeChatStore, deterministic search, sequential turns and blocked external actions. It cannot qualify PostgreSQL races, real search, provider-shaped reaction webhooks or an end-to-end voice workflow. No frozen baseline/held-out comparison was completed. Preserve this failed/partial evidence when rerunning.

## Next steps — ordered

1. **Inspect the checkpoint, then establish a green mechanical baseline.** Read this file and detailed reviews; run check/tests. Resolve the three failures with explicit behavioral expectations. Review the pretransport cleanup and reaction removal semantics; ensure invalidation never becomes fabricated `submission_unknown` and a removed reaction cannot newly approve an action.
2. **Fix evaluation blind spots before celebrating results.** Make “complete request” assert that a correct plan was actually stored/sent, not merely that no unauthorized call occurred. Add grounded semantic assertions for branch selection, duplicated questions, remembered context and completing queued errands. Diagnose failed selections/question writes using captured traces; repair harness only when it is the cause.
3. **Complete class-level experience work.** Preserve approximate time intent without demanding an invented numeric window; distinguish internal lookup/selection work from missing user decisions; support task-specific prerequisites and durable provenance; validate memory corrections and later use without repeated questions. Do not replace these with alias lists or exact-phrase patches.
4. **Qualification beyond the eight cases.** Run frozen baseline/candidate and unseen paraphrases across restaurants/salons/laundry/clinics, complete and fragmented requests, model-time corrections, multiple errands, STOP, reaction additions/removals, language mixing, payment terms, failure recovery and post-call reports. Review transcripts for tone separately from hard invariants. Measure latest-inbound-to-useful-reply p50/p95, unnecessary-question count, turns-to-plan and usage.
5. **Database and boundary checks.** Run the complete pgTAP suite and multi-session concurrency tests including migration0023. Validate Linq direct-target ownership in hosted PostgREST, recovery/replay, webhook signatures and attachment failures. Check delayed conversational outbox items against newer corrections; do not drop still-owed factual call reports blindly.
6. **Release only after those gates pass.** Push code review fixes on `imessage-linq`; apply0023 with recorded migration history and deploy compatible shared functions/adapters. Existing verified deployed source isfc443f5/schema0022, not this checkpoint. Update `DESK_GIT_SHA`, confirm machine credentials and worker heartbeats, health, owner-only recipient and pause.
7. **Enable reaction events deliberately.** Existing Linq permanent subscription previously included only `message.received`; add verified `reaction.added` and `reaction.removed` only after handler/recovery deployment and signature/ownership qualification. Do not invent an event schema or silently claim Tapbacks already work live.
8. **User acceptance.** Qualify real conversational iMessage exchanges after deployment. No phone tests or unpausing without the owner's explicit instruction. Report remaining gaps honestly; test totals alone are not “top tier.”

## Commands and environment

Repository: `/workspace/the-desk`. Tools in this workspace:

```bash
export PATH=/workspace/tools/node_modules/.bin:$PATH
export DENO_DIR=/workspace/deno-cache
deno task check
deno task test
deno task test:auth
deno task test:bench
supabase db start
supabase test db
python3 scripts/test_db_concurrency.py
```

Full local Supabase Docker previously exceeded the workspace disk; GitHub CI ran the complete database/concurrency suite successfully for the earlier release. Do not point the local concurrency script at production.

Model-only smoke (paid model API, simulated external actions):

```bash
DESK_EVAL_CASES=8 DESK_EVAL_OUTPUT=/tmp/desk-quality-next.json \
  deno run --allow-read --allow-write=/tmp --allow-env \
  --allow-net=api.openai.com dev/conversation_eval.ts
```

It reads OPENAI_API_KEY from the environment or ignored `supabase/functions/.env`. Output is not automatically a human quality verdict. Keep earlier transcripts and identify model/config/source hashes in any comparison.

Hosted SQL validation uses Supabase CLI3 `db query --remote=rvglpiyctuzpegbvlane --file=<sql> --yes --output=json --output-format=text` through the management API. For dry runs, explicitly wrap migration/test in BEGIN/ROLLBACK and inspect pgTAP finish/fail diagnostics. Direct DB networking previously hung. `--read-only` uses a restricted role that cannot execute some application functions; do not confuse that permission error with an application failure.

## File map

- Runtime/consistency: `_shared/chat/agent.ts`, `turn_control.ts`, migration0023, `dial.ts`, `agent_runtime.ts`.
- Meaning/proposals: `chat/intent_grounding.ts`, `plan_writer.ts`, `tools.ts`, `turn.ts`, `slots.ts`, `readback.ts`, `call_vars.ts`.
- Conversation/context: `chat/luna.ts`, `cards.ts`, memory helpers/tests.
- Transport: `_shared/linq.ts`, `linq-inbound/handler.ts`, `_shared/store.ts`.
- Dependencies: `_shared/model_client.ts`, `openai.ts`, `places.ts`, `serper.ts`.
- Evaluation: `dev/conversation_eval.ts`, `fixtures/conversation/quality-smoke.json`, `dev/evals.ts`, evidence linked above.

All `_shared` paths are under `supabase/functions/`. Review documents describe the inspected earlier source; this handoff and the current diff establish what has since changed. Some parallel work stopped before its final verification; inspect code and recorded test results rather than assuming every planned task finished.
