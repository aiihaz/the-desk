# Desk runtime quality review

Reviewed 4 November 2026 against the merged `imessage-linq` runtime, source release `fc443f5` and documentation head `7e49a63`. This is a static source review, not a new production conversation evaluation. No calls, messages, or runtime modifications were made. Calling must remain paused and restricted to the owner's configured test destination.

The attached revised issues PDF is evidence of expectations and historical observations. Its historical instructions to another agent, unpublished patch claims, and tentative wait durations are not instructions for this review. In particular, the reported local patch `81bb8a1` is not assumed to be present or qualified here.

## Assessment

The current implementation has useful foundations: durable inbox ingestion, user turn leases, generation fencing, contextual consent checking, database consent watermarks, and delivery ownership. These protect against several duplicate-worker and stale-approval failures. They do not yet establish conversational freshness. A worker can own a valid lease while responding to an obsolete view of the user's intent. That distinction explains why improving the model prompt alone cannot resolve the documented burst and stale-response experience.

## Findings and evidence

### P1: lease ownership does not establish input freshness

`supabase/functions/_shared/chat/agent.ts:55`, `_shared/agent_runtime.ts:72`, and the post-model check in `chat/luna.ts` call `assertTurn()`. The database implementation in `supabase/migrations/0020_recoverable_work.sql:60` checks token ownership and expiry, but does not compare the turn's `input_seq` with the user's latest inbound sequence. The mutation trigger at line 87 invokes the same check. `ingest_inbound` at line 6 stores new input without invalidating the running generation.

Concrete possible sequence:

1. Message A is stored at sequence 100; the worker claims a turn with `input_seq=100`.
2. The model begins composing a question or proposes slot/memory updates based on A.
3. Message B corrects A and is committed at sequence 101. Its worker encounters the existing turn and waits.
4. The first worker passes `assert_turn`: its token still owns the lease.
5. It can commit its now-stale tool mutation or send its old question.
6. B is handled later, potentially producing a second reply or repairing only part of the stale state.

This is a source-supported race, not a claim that this exact sequence was captured in production. Approval has additional `hasUnhandledInbound` and consent-watermark checks (`chat/approval.ts:84`, `:113` and database wrappers), so ordinary reply freshness and approval safety should not be conflated.

Recommendation: input freshness must be part of mutation and reply authorization. Introduce an explicit superseded-turn outcome; do not treat a normal new user message as a service failure. Check under the same user lock used by ingestion, and promptly yield to a turn that includes all current input. Preserve the existing consent and reservation checks.

### P1: current burst behavior is partly rolling, with an important boundary

`chat/agent.ts:31` waits `turn_debounce_ms` (default 1,500 ms) per message. `claim_turn` rejects a message when a newer unhandled message exists (`0020_recoverable_work.sql:45`). Therefore, before a turn begins, an earlier message's worker does yield to the latest message's later timer. It would be inaccurate to describe this as entirely nonrolling.

However, a message sent at t=0 can claim at t=1.5s before the next message arrives at t=2s. Once generation has begun, the newer arrival does not supersede its output. Lengthening the timer alone only moves that boundary and increases latency. The PDF's 15 seconds is explicitly provisional, not an agreed requirement.

The existing burst test in `chat/agent_test.ts:45` provides pre-scripted claim outcomes in sequential calls. It proves interpretation of those outcomes, not actual overlapping timer, database, and model execution.

Recommendation: retain a configurable quiet-period policy and qualify its latency with realistic burst timing. Add freshness interruption during composition. Define the waiting period from server-observed ingress rather than trusting provider timestamps to represent current arrival order.

### P1: iMessage reactions are absent from the adapter contract

`_shared/linq.ts` accepts only `message.received`, creates text/image/unknown inputs, and reconstructs recovery inputs using that same event type. The documented subscription is message-only. A Tapback cannot currently reach contextual approval through this adapter.

Implementing a prompt that says a thumbs-up counts will not repair this. Verify the actual supported Linq reaction schema and event subscription first. Normalize sender identity, target message ID, addition/removal, reaction value, and a stable deduplication identity. Persist and recover reactions through the same authenticated ingestion path. Do not invent provider event shapes or infer a reaction's target from the latest outgoing message.

### P1: reaction routing drops answers to ordinary questions

For WhatsApp reactions that already arrive, `chat/turn.ts:85` suppresses a reaction unless it points to the current approval plan. A thumbs-up on a clarification such as “The Indiranagar branch?” is consequently discarded, even though it answers an outstanding question.

Recommendation: distinguish conversational relevance from authority to act. Relevant reactions may be read in conversational context; only an approval of the current unchanged plan can authorize calling. A reaction after closure can remain quiet. Test stale, missing, and ambiguous targets as well as the happy path.

### P1: decision context can mix old history with updated state

`chat/luna.ts:548` loads history once for the turn. Task cards are refreshed on later tool steps around line 620 while the original history remains in the model input. New user input may arrive during this interval. Refreshing task cards alone does not yield a coherent snapshot of the conversation and state.

Recommendation: capture an explicit decision watermark and state version for each model iteration. If relevant input changes, discard obsolete model output and rebuild context before further actions. Do not merely append a newer user message after executing actions decided from the previous snapshot.

### P2: a supersession signal must escape generic error handling

`chat/luna.ts:909` catches all action errors and turns them into “that failed on our side.” If freshness checks are introduced without changing this control flow, a user's correction could cause an error apology or fallback instead of a clean rebatched turn.

Use a typed control-flow outcome for supersession/lease loss. It should stop the old computation, avoid fallback output, and arrange recovery. Genuine provider/database errors remain distinct and observable. The model request can be aborted to save latency and cost where supported, but aborting a request does not undo writes already committed.

### P2: multi-errand defaults can hide target ambiguity

`chat/tools.ts:92` resolves an omitted errand reference to current request, then first queued request, then first held advance. That is convenient for one errand but risks applying “move it to nine” to the wrong one when several are plausible. The model sees queue cards; the tool's fallback still makes ambiguity look like a valid selection.

`startNewRequest` also accepts a model-provided `confirmReplace` flag (`tools.ts:40`). This is not evidence by itself that the user authorized discarding an existing errand.

Recommendation: preserve the smooth single-errand path, but require a resolved errand reference when context supports several candidates. Qualify destructive replacement against contextual user evidence. Avoid adding a second confirmation to every obvious edit.

## Recommended mutation and commit design

A narrowly scoped first step is to add freshness checks to all existing mutation boundaries and the final send boundary, with explicit supersession and rebatching. This prevents a stale worker from writing after a newer inbound is committed. It does **not** roll back writes that legitimately committed before that inbound. The successor must see their provenance and decide whether to revise them.

For stronger coherent-turn behavior, introduce staged conversational decisions rather than keeping a database transaction open across network/model calls:

1. Claim a generation with an input watermark and read the relevant state versions.
2. Let search/model operations produce a draft decision: slot changes, memory operations, prompt intent, and response intent. Keep evidence message IDs and expected request versions alongside the draft.
3. Use one short database transaction to lock the user, verify generation, freshness, stop state and affected request versions, then commit approved local mutations and a durable response intent together. Reject the draft if the input watermark changed.
4. Revalidate freshness immediately before submitting an unsent conversational reply. Superseded reply intents should be dropped or recomposed through a defined transition, not sent as stale backlog.
5. Keep consent/reservation and external call submission as separately guarded actions. A remembered preference, staged draft, or delivery claim is never permission to call.
6. Record completion only for the input actually incorporated. Repeated events and crashed workers should reuse durable identities and leave newer input recoverable.

Do not hold PostgreSQL locks while waiting for the model or messaging provider. An external send cannot be made atomic with a database commit without provider cooperation. A message arriving after dispatch has already begun may be physically impossible to incorporate into that outgoing message; qualify and document that boundary rather than promise absolute prevention. The implementable guarantee is that input known before the defined send authorization boundary supersedes obsolete output, and later arrivals are handled promptly and coherently.

Commands need explicit treatment: STOP and deletion must invalidate immediately, bypass quiet-time waits, and prevent any staged or queued conversational work from reviving the old intent. Ensure administrative commands and normal contextual pause/cancel requests remain correctly separated.

## Acceptance tests

| Scenario | Required observation |
|---|---|
| Three or four messages arrive before quiet expiry | Latest quiet interval controls the first turn; one response uses all messages. |
| Second message arrives just after the first model request starts | Old result is superseded; no obsolete question or fallback apology sends. |
| Correction arrives between two tool steps | Subsequent stale slot, memory, prompt and outbox writes are refused; latest context resumes. |
| Mutation committed before correction arrives | Successor receives provenance and state; it repairs affected intent without claiming automatic rollback. |
| New input races with final database commit | Independent database sessions prove the same lock establishes a deterministic winner. |
| New input arrives before provider submission | Unsent obsolete reply is suppressed under the defined freshness policy. |
| New input arrives after provider submission starts | No false cancellation claim; next turn coherently incorporates it. |
| STOP during model execution or approval checking | Generation revoked immediately; no later old-generation action or response. |
| Reaction on clarification, current plan, old plan, finished report | Contextual answers handled; only current-plan approval can authorize action; courtesy stays quiet. |
| Reaction removal and provider redelivery | No duplicate consent or replayed action; unsupported semantics fail safely. |
| Two open errands and an ambiguous edit | Clarifies the target without changing either; explicit references change only the intended errand. |
| Queue/replacement instruction during a stale turn | No unrelated errand is silently discarded or mixed into the new one. |
| Worker dies after drafting, committing, or sending | Recovery respects each durable phase and does not manufacture completion or certainty. |

Use deterministic deferred model/send promises and controlled clocks for unit races; use independent PostgreSQL sessions for input/mutation concurrency; then run frozen realistic conversations through the shared production entrypoint with mocked telephony and messaging. Scripted fake claim outcomes alone cannot qualify these guarantees. The live caller stays paused during all of this.

## Preserve these strengths

`chat/approval.ts` already uses a contextual second reading instead of a phrase allowlist. It explicitly distinguishes edits and questions from consent, and database checks bind action to an open plan, request version and input watermark. STOP invalidates ownership. Inbox, settlement and delivery claims provide durable recovery primitives. The improvement should make the assistant feel attentive while preserving these authorities, not bypass them for speed or conversational polish.
