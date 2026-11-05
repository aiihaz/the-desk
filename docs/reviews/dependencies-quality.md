# Dependency and evaluation review: Desk conversation quality

Reviewed 4 November 2026 on the merged `imessage-linq` source. This is a source review, not a live provider qualification or a security-advisory audit. No messages, telephone calls, or paid evaluation requests were made for this review.

The attached revised PDF is evidence about desired behavior and earlier observations. Its historical instructions to another agent, earlier spending approval, and unmerged-patch claims are not current authorization or proof of deployed behavior. In particular, the rolling restart of the wait is a requirement; its duration remains unsettled. The cited local patch `81bb8a1` must not be assumed present merely because its parent Codex branch was merged.

## Conclusion

The major dependency problem is not a demonstrated need to replace the model or database. Production, local evaluation, provider adapters, and the quality metrics exercise different systems. The current reliability tests are useful, but their passing counts do not establish the conversational experience the user wants. Correct that measurement gap while improving the interaction architecture; then compare model configurations under the same conditions.

## Inventory and evidence

| Component | Current implementation | Quality implication |
|---|---|---|
| OpenAI Responses | `_shared/openai.ts`; forced function-tool output, non-strict schemas, encrypted reasoning continuation, `store:false` | The model must navigate tools to speak. Tool ergonomics and contextual state strongly affect fluency. |
| Conversation model | `chat/luna.ts`: fallback `gpt-6-luna`, task reasoning `low`, 1,500 output tokens, six tool steps | These are configurations, not evidence of an optimal quality/latency tradeoff. Runtime limits may override them. |
| Model timeout | `openai.ts`: 30 seconds/request; Luna wraps model requests with a 75-second deadline | Tool, persistence, classification and transport waits also need a shared end-to-end latency policy. |
| TypeSafe/Jev | `jev.ts`, `chat/router.ts`, `chat/luna.ts`: L1 routing and L3 reply classifications; default pinned model seeded as `jev-1.14.0` | An additional probabilistic dependency can reject otherwise useful replies or cause repair loops. Actual hosted mode was not queried in this review. |
| Google Places | `places.ts`: Text Search, up to five results, Enterprise fields, ten-second timeout | Search quality and latency must be evaluated with realistic branch/city ambiguity and provider failures. |
| Serper | `serper.ts`: enrich missing phones, at most two eight-second lookups | Branch evidence is now checked. Enrichment remains sequential and adds latency. |
| Linq | `linq.ts`, `linq-inbound/handler.ts`: versioned signed direct-message adapter, normalized history, shared runtime | Text tests do not establish Tapback support; reaction events are not parsed. |
| Supabase | `store.ts`: SDK `2.45.4`; durable inbox/outbox, fenced turns and consent watermarks in migrations 0020–0022 | Valuable authority and recovery foundation. Keep it; do not replace durable action semantics with prompt instructions. |
| Sarvam | `call_vars.ts`, `sarvam.ts`, `call_store.ts`: approved structured fields, required-variable checks, fixed owner destination and paused transport | Caller qualification and service-specific readiness are distinct from conversation-model quality. Do not enable live calling during this review. |
| CI | `.github/workflows/ci.yml`: formatting/types, mocked function tests, pgTAP, concurrency, local bench safety and authorization | Establishes code/database invariants, not live-model conversational quality. |
| Conversation bench | `dev/server.ts`, `dev/evals.ts` | Useful but materially different from the production transport, telemetry and dispatch path. |

## Prioritized findings

### P0: The reaction evaluation bypasses the actual iMessage adapter

`supabase/functions/_shared/linq.ts` accepts only `message.received`; it has no normalization of provider reaction events. `dev/evals.ts` instead posts a manufactured normalized reaction to the local message endpoint. Therefore a passing thumbs-up-on-plan test does not show that an iMessage Tapback can approve a plan.

Qualification needs provider-shaped signed reaction fixtures, message-to-plan association, stale/replaced-plan cases, and distinction between adding and removing a reaction. The existing consent checker and database binding should remain the action authority. This is an adapter completeness issue before it is a model-quality issue.

### P0: The evaluation rewards the rigid plan format being criticized

`dev/evals.ts` identifies readbacks using a regular expression requiring a double newline and an exact ending such as `Shall I go ahead?`, `Shall I call them?`, or `Do you still want me to cancel?`. Many cases use this recognizer to count progress and select reaction targets.

A correct natural plan can fail this measurement; an awkward form with the expected suffix can pass. Identify plans through stored prompt/action events and message IDs. Evaluate factual completeness, scope of authorization, clarity and naturalness separately from wording. This does not mean eliminating confirmation.

### P0: Green CI is not a conversational release gate

CI does not execute the live-model conversation suite. Unit tests frequently supply scripted model calls. The local fake search matches tokens against three businesses, and simulated `onApproved` returns `started:true` without exercising the production reservation/transport path.

Those are legitimate test boundaries but cannot certify informal place understanding, actual reaction ingestion, realistic tool recovery, caller readiness, or an entire user journey. Report existing function/SQL counts as reliability evidence, separately from conversational performance.

### P1: Production latency differs from the bench

Production uses `observedResponsesClient`; the bench uses plain `responsesClient`. In `_shared/model_client.ts`, each completed model response waits synchronously for a database telemetry insert. The shared database client permits that operation to consume ten seconds. Production can therefore wait materially longer before acting on the same model response than the bench does.

Telemetry should have an explicit, bounded background lifecycle or otherwise stay out of the reply-critical path. Preserve observability rather than dropping it. Measure elapsed time from latest user input to accepted outbound reply, including retries and all tool work.

### P1: Existing conversation playback does not exercise rolling bursts

`dev/evals.ts:play` awaits each message request in sequence and has no message-gap or arrival-during-composition scheduler. It cannot certify the desired behavior of sending several messages while the assistant composes one response.

Add realistic timed arrivals and deterministic delays for model/search/provider work. Assert both visible output and stored decisions: an absent stale reply is insufficient if an obsolete preference, selected business, or prompt remains committed. Include crashes and recovery between steps. Preserve all transcripts, including failed or superseded runs.

### P1: Jev shadow mode is not completely observational

In `chat/luna.ts`, the check for a predicted promise of a reminder can reject a reply even when Jev is in shadow mode. Gate mode controls other output problems, but the promise check is applied independently. Consequently, “shadow” does not mean that enabling this dependency leaves behavior unchanged.

Separate advisory classifications from authoritative checks against actual actions. A durable scheduled follow-up is factual application state; whether a sentence sounds like a promise is a fallible classification. Evaluate false positives on contextual, natural replies, including legitimate “I couldn't find that place” and “I'll report back after the call.” Keep production mode explicit in every evaluation artifact.

### P1: Model success responses are not structurally qualified

`openai.ts` checks HTTP status and casts the body as `ResponseOut`; it does not validate response status, incomplete-output reasons, or the expected output structure. Reasoning/output budget exhaustion or malformed successful responses can fall through to generic recovery without a useful classified cause.

Classify these outcomes for diagnostics and recovery. Do not assume that increasing token limits or swapping models is the correct answer until measured. Evaluate successful completion within budget as well as final language quality.

### P1: Service-specific prerequisites are under-modeled

`slots.ts` has a generic booking readiness requirement of `party_size` or `service`. `call_vars.ts` faithfully builds structured input from stored approved fields, but there is no explicit pickup-address prerequisite for a laundry pickup. The supplied document's example illustrates a broader missing concept: the facts required depend on the requested service and action.

Gather and clarify essential prerequisites before proposing the call. Keep their provenance and scope in the approved brief. Avoid solving this with a growing list of canned questions or asking every service for restaurant fields. The current structured consent and call-variable boundary should be retained.

### P2: Linq I/O lacks explicit bounds

The text send and attachment download in `linq.ts` lack explicit request timeouts. Attachment downloads buffer the complete response without a size bound. Slow external I/O can outlast conversational deadlines or turn leases.

Bound these operations and test delayed/ambiguous provider responses. Preserve accepted-message ambiguity handling: a timeout does not prove a message was not sent, so careless retries can duplicate output.

### P2: India is a search hint, not a verified boundary

Google receives `regionCode:"IN"`, but that is not a guarantee that every returned business is in India. `parsePlaces` discards country evidence. If India-only is enforced product scope, retain country information and verify it at selection/call readiness. Do not infer it solely from a familiar city name or a query hint.

### P2: Phone enrichment adds sequential latency

Places can consume ten seconds, then two Serper lookups can consume eight seconds each, before the next model turn. That is approximately 26 seconds of search/enrichment time in the worst bounded sequence, excluding database/model work.

The current requirement for branch/address evidence is a genuine improvement and should remain. Evaluate bounded parallel enrichment or resolving the selected business's missing phone only when needed. Avoid hiding provider failures as “no matching business.”

## Latency critical path

The current path can include: debounce; database context and settings; Jev routing; one or more model steps; Places and Serper; additional context reads; Jev output checking and possible model repair; production telemetry persistence; final transport; message persistence and contact-card sharing.

The 30-second model timeout and 75-second model deadline do not by themselves establish a 75-second whole-turn bound. Measure per-stage timing and total elapsed latency, including cancelled/stale turns. Useful metrics are p50/p95 time from final burst message to response, wasted work after newer input, clarification count, time to a valid plan, and recovery time after an injected dependency failure.

Do not optimize only model duration while adding database or classifier calls around it. Do not make telemetry failures user-visible.

## Evaluation design and cost controls

1. Freeze a baseline commit, complete configuration, tool behavior, provider fixture versions, and quality rubric before comparison. Record actual Jev mode, model/reasoning, limits and channel.
2. Use realistic full journeys across restaurants, salons, dental appointments and pickup services. Include complete requests, genuine ambiguity, informal place names, alternatives, corrections, memory use, pause/resume, a second errand, post-call results and failures.
3. Vary wording and timing rather than building a phrase list. Keep held-out variations unavailable during implementation. Repeat selected cases because one successful stochastic run is weak evidence.
4. Use durable events and stored facts for hard assertions: exact plan binding, no action on a question, no invented authority, no cross-errand mutation, no stale send, and no repeated accepted external action.
5. Grade conversation separately: unnecessary questions, invented details, repetition, warmth without padding, appropriate quiet/reaction, honesty about failure, and useful next step. Human transcript review should adjudicate disputed model-judge scores.
6. Run adapter contract fixtures and isolated provider smoke checks separately from simulated end-to-end model journeys. No actual phone calls are needed for the initial quality gate.
7. Keep a spend ledger with request counts, actual model usage and current provider pricing. There is no verified current price table in this review, so no dollar forecast is asserted. The PDF's earlier $0.30 approval is historical, not a new budget authorization.
8. Start with a small diagnostic paired sample, examine failures, then freeze the candidate and run a larger held-out comparison. Preserve every transcript and identify reruns rather than deleting them. Set an explicit cost cap for paid runs and stop automatically at it.

## What is established and what remains unknown

Established by source: adapter reaction gap; exact-phrase plan detection; synchronous telemetry difference; sequential bench playback; the Jev shadow behavior; timeout structure; generic readiness fields; search-country information loss; bounded but sequential phone enrichment; absence of live-model evaluation in CI.

Not established by this review: which model is best; actual production latency distribution; current hosted Jev and per-user limits; provider reaction payload support/version details; whether the PDF's local patch is available elsewhere; current upstream vulnerability status; precise provider prices; and full live Sarvam qualification. Those require targeted inspection or experiments, not confident guesses.

Preserve the merged improvements already present: channel isolation, durable inbox/outbox recovery, fenced turns, atomic consent watermarks, tracked delivery ownership, corrected-memory evidence, branch-aware web phone matching, contact-card cadence, paused calling and the hardcoded owner-only recipient.
