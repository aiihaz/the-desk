# Comparison review fixes, local only

The runtime currently deployed is `53a97b5`, with schema `0033` and comparison mode OFF as last verified on 19 November 2026. Before this review-fix commit, the branch's remote head was `24c01a7`, a documentation-only follow-up. The fixes described below are committed on `comparison-mode` for branch review under the user's 22:11 IST push approval. They have not been migrated, rolled back or deployed. No calls or paid model/provider tests were run for this review pass.

Do not enable the deployed comparison version. The review found real errors that the earlier checks missed.

## Corrections

| Review finding | Local correction | Direct check |
|---|---|---|
| New columns might be missing in production | No repair was needed for this specific failure: 0031-0033 ran before functions, and a read-only check verified the columns. Deployment ordering remains a requirement. | Prior live schema check, not a chat smoke test |
| Switch affects every account and cancellation/rescheduling | New snapshots ignore the global default and require an explicit per-user override. Admin on/off targets the requesting admin's account. The generic limit command cannot enable comparison globally or for someone else. Cancellation/rescheduling remain ordinary tasks, including legacy rows and task changes. | Isolated SQL tests with global ON and unopted user; SQL and application task-exclusion tests |
| Unseen Bolna migration conflict | Left aside at the user's request. Deployed migration history is not edited. Bolna is not marked applied or reconciled. | No changes to 0031-0033 |
| Audio has no retention or erasure | Durable deletion tombstones, Storage API removal, retention tied to existing `transcript_until`, cleanup before erasure, and a live-upload lease check. Tombstones survive cascade deletion and cover deterministic paths even after an upload-before-ack crash. | SQL expiry/erasure/leased-upload tests and storage-failure unit tests |
| Business identity uses keywords | Removed `nameMatches`. A model decision reads the full listing, name, address, area and city and must select an ID actually returned by that search. Ambiguous identities or failed checks stop for clarification. No callable result is disclosed and rated fallback may fill that slot. | Mocked semantic resolver tests, invented-ID rejection and unresolved-branch test |
| Raw JSON in question text | Allowed fields are rendered as labelled plain text; nested objects and identity fields are not serialized. The same builder still feeds readback and caller. | Question rendering regression |
| New message silently drops remaining batch | Stop further calls, close dispatch and queue one durable interruption notice. A narrow machine-owned cleanup RPC survives the superseded turn fence. Already submitted calls still settle. A fast early result cannot be rewound to confirming. | Both returned `new_inbound` and actual thrown turn-invalidation tests; SQL notice dedupe and early-result tests |
| Final summary can be stale | Each settlement stores its own classification. The final result list is built from those committed classifications while holding the settlement/user lock, not from the caller's pre-lock batch snapshot. | Ten overlapping settlement attempts with deliberately stale incoming summary facts; final output must contain five current answers |
| Cancelled/expired batches never settle | Received results still settle and keep opt-out/wrong-number bookkeeping, without reopening the errand or sending an obsolete final summary. Cancellation during dispatch is covered. | SQL cancellation/expiry tests with an active dispatch lease |
| Audio not ready at webhook or only found by recovery | Database result persistence queues durable audio work regardless of whether a webhook or recovery found the result. The scheduled worker retries missing recordings and upload failures. One job is claimed at a time, leased and bounded by a 24-hour retry window and the earlier retention deadline. | SQL queue/retry/completion tests and worker unavailable-then-ready tests |
| Business labels shift after missing rows | Recipient display data retains `businessId`; labels use ID lookup, not array position. | Missing-middle-listing regression |
| Booking label for question-only comparison | Comparison reports explicitly identify question-only comparison, no booking or hold. | Application report path and SQL fact assembly |
| Misleading defaults and formatting | Ordinary requests default to dispatching=false; unsupported task changes clear comparison; dead cap branch and odd switch formatting removed. | SQL scope checks, formatting/lint/type checks |

Rating remains the requested highest-rating sort. Review counts are now fetched and returned alongside ratings. This is not a weighted reliability ranking and does not claim that 5.0 from three reviews is stronger evidence than 4.6 from 3,000. The final call summary is grouped by answer completeness, not business quality.

## Recording permission gate

`DESK_AUDIO_ARCHIVE_APPROVED` defaults to absent/false. The production admin adapter refuses to turn comparison on until recording and retention consent requirements have been verified and that deployment gate is explicitly enabled. This is a safety prerequisite, not a second user-facing feature mode. The audio worker performs deletion cleanup even while archiving is disabled. No call voice prompt was changed. No claim is made that the current provider configuration satisfies recording notice/consent requirements.

Never set that gate merely to make an evaluation pass. Confirm provider rules, lawful notice/consent, the approved retention policy, current credits and storage cost, then obtain the required approval for actual execution.

## Reproducing local checks

Application checks:

```sh
deno task check
deno task test
```

Whole-repository SQL flow in PGlite:

```sh
node scripts/comparison_full_schema_test.mjs
```

Install `@electric-sql/pglite` separately. `PGLITE_MODULE` and `PGLITE_PGCRYPTO_MODULE` may point to its installed module files. The script creates only synthetic users/businesses/calls and applies all repository migrations. Its storage schema and platform roles are minimal stand-ins.

The stronger concurrency/regression path uses a previously exported schema-only **pre-0031** public schema plus explicitly exported non-personal limits/caller-contract configuration. It never reads production rows or connects to production. It needs Python `pgserver` and `psycopg`:

```sh
python scripts/prepare_comparison_review_db.py SCHEMA.sql CONFIG.json /tmp/review-local-uri
python scripts/comparison_review_db_test.py /tmp/review-local-uri
```

Each preparation creates a fresh isolated local database. The public schema export is restored, then 0031-0034 apply. The local engine is PostgreSQL 16.2; production is 17.11. This is not a complete Supabase staging environment: storage/roles are stand-ins, private platform schemas and remote provider behavior are not reproduced. Live test-mode guard bypasses remain outside these fixes and must not be confused with real-business safety validation.

## Final local results

- `deno task check`: passed formatting, lint and type checks.
- `deno task test`: 554 passed, zero failed.
- Full repository migrations 0001-0034 and five-call reserve/settle flow: passed in PGlite.
- Isolated PostgreSQL review regressions: all eight groups passed, including ten overlapping settlements, early result, interrupted dispatch, cancellation/expiry, audio retries, retention/cascade cleanup and leased-upload erasure.
- `git diff --check`: passed.

These are synthetic local tests. They do not verify production traffic or the remote model/provider/storage path.

## Remaining gates

- Independent review of this patch and migration 0034.
- Storage deletion failures remain durable cleanup work and prevent an erasure confirmation. The existing deletion-confirmation path is not a durable message outbox: an outage after profile deletion can lose that confirmation, although audio tombstones remain for cleanup retries. Do not promise immediate deletion during a storage outage or guaranteed confirmation delivery.
- The user approved pushing this review-fix pass only. No merge or deployment is authorized. If later approved, apply migration before runtime changes and preserve current JWT/provider settings.
- No paid semantic-model benchmark or provider/storage integration test has been run. Identity quality, actual recording readiness/deletion, and remote crash/retry behavior remain unverified end to end.
- Original Aurora recipient binding and frozen case evaluation remain separate work.
- Bolna migration reconciliation is explicitly left aside, not resolved.

## Second review pass, 19 November 2026

Fixes to the review-fix commit above. Like that commit, these are not migrated or deployed. They edit `0034` in place because `0034` has never been applied anywhere.

| Second-review finding | Correction | Check |
|---|---|---|
| Audio work ran first in reconcile and threw on any Storage/RPC error or after 20 deletion batches, blocking call recovery, settlement retries, event replay and erasure | `runCallAudio` catches and reports the error in the job's detail. Reconcile runs it last. A backlog is left for the next run, not thrown | `call_audio_test.ts`: outage returns `ok:false`, backlog stops at 20 batches |
| Erasure confirmation depended on the audio worker throwing | `erase_requested_users` now skips a user who still has a saved recording, an archive job or a queued deletion of their own. `call_audio_deletions.user_id` (no foreign key) keeps the owner after cascade. A Storage outage now delays only that user's erasure | `comparison_audio_erasure_test.mjs`: erasure waits for saved audio and for a late upload, then completes |
| Every deleted call queued a deletion, comparison or not | The delete trigger queues one only when bytes can exist: a saved `audio_path`, or a job taken at least once | Ordinary and never-attempted calls queue nothing |
| Archive jobs that expired unattempted (gate off) turned into deletion entries | Only attempted jobs queue their path when dropped | Expired unattempted job leaves no entry |
| A named business with no number was reported as "identity unresolved" | The resolver sees every listing the search returned. A resolved listing that has no phone, is closed or is outside India is reported with that reason | `comparison_review_test.ts` no-phone case |
| SQL test scripts failed on paths containing spaces | Root path is URL-decoded | Scripts run from `the desk/` |

Still open: the `erase_requested_users` and `defer_changed_consent` patches match on repository source text. If the live functions differ, the migration stops with "source changed: review required" rather than misapplying. Compare against the live definitions before applying.

Checks for this pass: `deno task check` clean; `deno task test` 557 passed, 0 failed; `comparison_full_schema_test.mjs`, `comparison_sql_test.mjs` and the new `comparison_audio_erasure_test.mjs` pass in PGlite 0.5.17. `comparison_review_db_test.py` was updated to the new behaviour but not run here (no `pgserver`).
