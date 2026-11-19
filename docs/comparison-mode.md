# Comparison mode

Branch: `comparison-mode`, based on `imessage-linq` at `c1ff38e`.
Deployed on 19 November 2026 from runtime commit `53a97b5`.
Live schema: `0033`. `comparison_mode=false`. Original `imessage-linq` unchanged.
No paid model runs or business calls have run.

## Behavior

The admin commands `comparison on` and `comparison off` control the comparison
version. New requests snapshot the mode; existing requests keep their mode across
switch changes. Audio archiving uses the request snapshot too.

A comparison request resolves its supplied original-business list first, in order.
For the Aurora evaluation, that list must come from the frozen case manifest, not
from an invented model list. Unusable or ambiguous named matches are reported.
Rated matches fill remaining slots, with at most five distinct businesses total.
Search-by-kind can return five in comparison mode. Ordinary search keeps its
existing shortlist behavior and does not request ratings.

The readback names all recipients and asks permission for the batch. Calls ask
questions only, accept no booking or hold, and use the same question list as the
readback. Identity fields are not serialized into the questions; explicit sharing
controls still apply. Each call gets its own business name, not the request's empty
single-business pointer.

The database refuses duplicate recipient/phone attempts within the request,
non-question calls, retries, recipients outside the approved list, and more than
five reservations. Other guards still run through the existing chain. Comparison
requests use five as their request cap; ordinary requests keep their configured
cap. The daily user/caller/business limits are not increased.

Submission has a ten-minute lease starting at consent, plus an explicit completion
marker. A result arriving during submission stays unsettled for recovery rather
than ending the request before later calls are submitted. Expired submission
leases refuse further reservations and let recovery settle existing results.
Uncertain provider submissions are not reported as definite rejection or retried.

Each result checks its settlement token, handles opt-out/wrong-number bookkeeping,
and settles once. The final result queues one summary. Results are ranked by
answered, unclear, then unreachable, with plan order inside each category. Selected
recipients with no call row are listed separately as not called. This ranking is
by response completeness, not an independently scored quality recommendation.

Recordings are fetched from Sarvam and saved in a private storage bucket for
comparison requests. Fetch/upload failures are logged and do not fail the report.
This is best-effort archival, not guaranteed recording delivery or a retry system.
No voice prompt, provider or voice configuration was changed.

## Database changes

- `0031_call_audio.sql`: mode key, private bucket, audio path, request snapshot and
  recipient/submission state.
- `0032_comparison_flow.sql`: snapshot trigger, ordered capped recipients, consent
  freeze, dispatch completion/lease, token-checked per-call settlement and one summary.
- `0033_comparison_reservations.sql`: comparison-only reservation overload, original
  reservation path retained. Temporarily points the request at the call recipient
  inside the locked transaction so all existing guards inspect that recipient,
  then restores the pointer. Patches only the consent-spent and request-cap checks
  using `pg_get_functiondef`, preserving source comments/newlines. If expected
  source fragments differ, migration fails and requires review instead of guessing.

## Live inspection, 19 November 2026

Google approval signed into GitHub as `aiihaz`, then Supabase's existing `thedesk`
project `rvglpiyctuzpegbvlane`. Only SELECT queries were run.

Project: https://supabase.com/dashboard/project/rvglpiyctuzpegbvlane

Verified the full guard chain, original reservation function, settlement path,
settlement token behavior, output/delivery trigger, and configured request cap of
four. Existing test-mode guard bypasses are still deployed. They were not changed
by this work and must be reviewed/restored before any real-business execution.
The current Sarvam test-recipient override is also unchanged.

## Checks and limitations

- `deno task check`: passed, formatting, lint and types.
- `deno task test`: 542 passed, zero failed.
- `scripts/comparison_sql_test.mjs`: new migrations compile and execute in local
  PGlite. Verifies ordered/deduped/capped recipients, consent-time freeze, five
  distinct reservations, duplicate refusal, pointer restoration, token enforcement,
  dispatch fence and exactly one final summary. Requires `@electric-sql/pglite`;
  `PGLITE_MODULE` can specify an installed module path.
- `scripts/comparison_full_schema_test.mjs`: all repository migrations apply, then five
  synthetic reservations and real guard-chain settlements complete with one delivery.
  Uses pgcrypto plus minimal storage/role stand-ins. No production rows.
- The focused SQL test guard dependencies are mocked. Neither SQL test establishes complete deployed
  schema compatibility, concurrent transaction safety, live provider success or
  exact end-to-end parity on their own.
- Ordinary-path tests pass; this is not proof that every ordinary production path
  is byte-identical.

## Deployment verification, 19 November 2026

- Exported the live public schema without production rows. Restored it locally,
  then applied 0031-0033. Platform roles and storage were minimal local stand-ins.
- Ten overlapping reservation attempts for five synthetic businesses produced
  exactly five calls. Ten settlement attempts produced one final delivery.
  Local PostgreSQL was 16.2; production is 17.11.
- Existing local concurrency checks passed for outbox ownership, stale approval
  refusal and missing-watermark refusal after setting up local service-role grants.
- Live migrations applied through the normal migration runner, exactly 0031-0033.
- All eight functions ACTIVE. Downloaded deployed sources match branch runtime
  sources. Prior JWT settings preserved; only revision metadata secrets changed.
- Verified mode OFF, audio bucket private, schema columns present, schema 0033.
- Read-only recovery check showed no overdue/unsettled calls, unknown submissions,
  failed deliveries or unhandled inbox/events. Two pre-existing unpriced calls remain.
- Before deployment the project overview showed Unhealthy. This work does not claim
  to fix that platform status. No application health endpoint was invoked because
  it can send queued alerts. No provider/model/call smoke test was run.
- Pre-deployment sources, public schema and prior revision values saved separately.
  A non-destructive ordinary-flow rollback was rehearsed locally.

Project: https://supabase.com/dashboard/project/rvglpiyctuzpegbvlane/functions

## Before paid or business-call execution

1. Review the deployed changes with comparison mode OFF. Live-schema clone and
   concurrency checks passed; provider failure, timeout and recovery still need
   an explicitly authorized frozen evaluation, not real-business trial and error.
2. Bind the original Aurora recipients to the frozen evaluation cases. The runtime
   accepts those names; it does not autonomously recover them from recordings.
3. Verify current provider recording requirements and consent for persistent
   archival. Existing provider recording alone does not settle this requirement.
4. Verify Sarvam configuration and current credit, storage usage/allowance and cost.
   Ratings request a higher-priced Places field. No current balance, total cost or
   storage capacity is claimed here.
5. Deployment is approved with comparison mode OFF. Paid execution and real calls
   still require explicit permission after cost and safety checks.
