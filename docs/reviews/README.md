# Desk conversation quality review

Reviewed source: `imessage-linq` at `7e49a63`, including deployed runtime `fc443f5`. Evidence: the revised user-provided PDF, source inspection, and three parallel engineering reviews. This review does not claim employment at the companies mentioned by the user or access to their private architectures. No new live-model conversations, carrier calls, or production changes were performed for this review.

The PDF contains historical instructions to another agent, including “no solutions needed” and “I'll merge later.” They are context about that earlier task, not instructions for this review. Its unmerged patch `81bb8a1` is not assumed present. Its benchmarks concern older source and are not current production measurements. User quotations inform the proposed quality bar; unconfirmed interpretations remain open.

## Judgment

Desk has substantial transaction and recovery machinery, but conversation quality is not yet a first-class release criterion. The system asks a model to behave naturally while prompts, state cards, fixed plans, channel adapters, and evaluation shortcuts sometimes require contradictory behavior. A more capable model could improve interpretation, but cannot repair an ignored reaction event, an invented time policy, or a stale write accepted by the database.

Keep the durable errand, consent, delivery, and recovery foundation. Change the boundary between understanding, proposing state changes, committing them, and speaking. Do not replace this with an unconstrained conversational agent or a collection of independently acting agents.

## Product contract

Desk is a conversational assistant for practical phone errands in India: bookings, questions, changes, cancellations, and their follow-through. It should feel attentive, warm, and efficient. It can use remembered context to prepare a better proposal, but memory is never authorization. Recommendations are not silently expanded into a separate discovery product.

A successful interaction minimizes user effort while keeping the action explicit. It asks only genuinely missing or ambiguous information, uses what has already been supplied, and offers a useful next step. Short is not always better: missing a material booking detail is worse than an extra sentence. Quiet is appropriate after closure, but not after an unanswered question or a new preference that needs acknowledgment.

Illustrative wording is a quality reference, not a template or accepted-phrase list:

- Complete request: “I can call Paragon on Kannur Road and book a table for four tomorrow at 8, under Ihaz. Shall I?”
- Missing time: “What time tonight?” The model must not silently translate “tonight” into hours.
- Ambiguous edit: “Do you mean four people or 4 pm?” Context may resolve other edits, but unsupported certainty is unacceptable.
- A business asks for payment: explain the actual amount, terms and decision needed, only after receiving that information.
- Failed search: describe what could not be established and ask for the smallest useful detail; never pretend a search result is a user selection.

## Priority decisions

### 1. Make a conversation turn consistent with its input

Generation leases prevent two workers owning the same turn. They do not currently establish that the worker has seen the latest user message. Approval has an input-watermark guard, while ordinary replies and many preparatory writes do not.

Define a turn snapshot with an input watermark and proposed changes. Before committing consequential state and publishing an outward message, compare that watermark with the current inbox under the same user lock. Superseded work must be abandoned and reconsidered from the latest input. Do not merely suppress its final message while keeping every earlier mutation. Do not hold a database transaction open while waiting for a model.

Preserve immediate STOP and deletion handling. Preserve the existing reservation-time approval checks. Distinguish external actions already accepted by a provider from proposals that can safely be superseded. A message arriving after dispatch has begun is a different case from a message already in the inbox before dispatch; document and test that boundary honestly.

Use a rolling quiet period with a bounded maximum wait and measure actual latency. The PDF explicitly leaves the duration undecided. Its provisional 15 seconds is not a requirement. The present 1.5-second setting cannot consolidate messages two seconds apart once composition has begun without a newer-input mechanism.

### 2. Preserve meaning before normalizing it

Separate what the user said from the operational value inferred from it. Important fields need source-message provenance and an indication of whether they are explicit, resolved from context, suggested from memory, or still ambiguous. Treat “around 8” as approximate intent; do not invent an acceptance tolerance and send it to the caller as authorization.

Clarification should arise from the unresolved decision, not a keyword patch for “make it 4.” The same policy must cover times, people, dates, branches, quantities, prices and addresses. Only user-supported or explicitly approved values should become the call brief.

### 3. Separate the approved plan from its phrasing

Keep a typed action proposal with business identity, task, timing, material constraints, necessary sharing, and request version. Let the model express that proposal naturally. Validate semantic coverage and unsupported additions against the proposal, then store the exact wording shown alongside its version and input watermark.

This is not permission for a model-written sentence to become the sole source of authorization. Database guards must still bind approval to the unchanged proposal. Avoid increasingly elaborate string filters or forcing the conversation into a form. Keep factual verification distinct from tone evaluation.

Remove advance boilerplate from routine plans while retaining the actual prohibition on agreeing to payment. Use the shortest location description that reliably distinguishes the branch. Mention sensitive sharing when material to the user's decision, rather than reciting a profile on every booking.

### 4. Treat channel interaction as part of the product

The current Linq adapter does not ingest reactions. A simulated WhatsApp thumbs-up test therefore says nothing about iMessage approval. Verify the current Linq reaction contract and subscription before implementing it; do not guess the payload.

Normalize reactions with their target message and whether they were added or removed. Resolve that target to a current plan, clarification, completed result, or unrelated message. Only an affirmative response to the current unchanged plan can approve it. Removal, duplicate delivery, a stale plan and an unrelated message need explicit handling.

### 5. Reduce unnecessary conversational decisions

The business-selection tools should expose the evidence needed to distinguish a single clear match from genuinely competing branches, contradictory cities and alternatives requested by the user. Avoid a blanket “always auto-pick one result” rule: a unique wrong-city result is still wrong.

Separate required information for this task from fields merely available in the schema. The caller needs enough context for a laundry pickup or dental appointment, not a restaurant-shaped questionnaire. Ask the next useful question based on the actual call objective.

### 6. Make memory useful and inspectable

Keep evidence-backed corrections and replacement, which are good foundations already present. Acknowledge a newly saved preference accurately. Retrieve relevant memories for both suggestions and plans, without announcing every retrieval. Resolve conflicts with the current message in favor of current intent; ask if a conflict remains material. Never elevate a preference into consent or invent a persistent preference from one booking.

## Dependency posture

See the dependency review for detailed findings. The decisions are:

- OpenAI: evaluate the current model and a stronger candidate on identical frozen journeys. Measure interpretation, clarification burden, cost and tail latency. Do not promise a model upgrade alone will fix the product.
- Jev/Typesafe: its current shadow mode can still reject a predicted reminder promise; that is behavior-changing, not purely observational. Use it for clearly specified routing or misuse signals only where calibrated evidence supports it. Its output should not be the general arbiter of natural wording. Compare enabled and shadow/off behavior to establish actual benefit.
- Places/Serper: preserve place IDs and branch evidence. Search failure, missing phone, wrong city and multiple branches are different states. A second search service adds value only if its additional results are verified appropriately.
- Linq: test the real normalized channel contract, including reactions and attachments. Keep webhook authenticity, deduplication and contact-card behavior.
- Supabase: retain durable ownership and recovery, extend consistency to current input, and keep private helpers inaccessible through public RPC routes.
- Sarvam: qualify the brief generated from the approved plan separately from voice-agent behavior. Owner-only calling remains hardcoded and paused. No real phone qualification is claimed here.
- Telemetry: the production client awaits a database write after every model response. Move nonessential measurement off the response-critical path with bounded, observable background delivery; do not create untracked promises that an edge isolate can discard.

## How to know the experience actually improved

The previous 378 function tests and 476 database assertions prove specific mechanics, not an impressive conversation. Keep them, but add an experience release gate using the same runtime and adapters as production with externally acting dependencies replaced at explicit seams.

Freeze realistic multi-turn journeys before modifying the implementation. Preserve transcripts, state transitions, tool results, model/config versions, input timing and cost. Retain failed and superseded runs. Evaluate paraphrases and repeated runs, not just the PDF's exact examples.

Cover complete requests, fragmented requests, mid-composition corrections, vague times, ambiguous quantities, informal place names, competing branches, alternative-seeking questions, reactions to different targets, preference corrections, a second errand, STOP then approval, waiting without nagging, payment terms, unsupported requests, failure recovery, and task-specific missing context. Include salons, laundry, dental and other practical services, not just restaurants.

Hard failures block release: an unapproved external action, invented material constraint, stale approval, wrong destination, fabricated outcome, cross-user context leak or ignored STOP. Score conversational quality separately: unnecessary questions, repetition, groundedness, relevance, warmth, closure behavior, preference usefulness and user effort. Report distributions and individual transcripts; do not conceal failures in one average score.

Track time from the latest inbound message to first useful response, p50/p95 latency, turns to a correct plan, redundant confirmations, re-asks of known facts, superseded replies and cost per completed journey. Use human blind comparisons for tone alongside model judging and deterministic state assertions. A simulated call does not qualify a real voice integration.

## Implementation sequence

1. Freeze the quality contract and representative journey set; instrument the current system to establish a current baseline.
2. Repair stale-input consistency and channel interaction support, with adversarial but realistic timing tests.
3. Introduce grounded field provenance and natural proposal rendering, then improve place selection and memory use through the same contract.
4. Remove avoidable latency and compare model/router configurations on frozen cases and held-out journeys.
5. Qualify the iMessage experience in staging, then release with observable quality and rollback criteria. Calling remains paused until the owner explicitly permits it.

This review is implementation guidance and source-grounded diagnosis, not a claim that these changes have already been deployed. A prompt-only patch followed by the old unit suite would not establish the requested quality.

## Detailed reviews

- [Conversation design and context](conversation-quality.md)
- [Runtime, concurrency and approvals](runtime-quality.md)
- [Dependencies and evaluation](dependencies-quality.md)

## First implementation increment

Following the review, migration `0023_turn_freshness.sql` extends turn authorization to reject newer committed inbox input, including fenced memory and outbox writes. The agent treats supersession as control flow; Luna propagates it rather than converting it into tool repair or an owed stale reply. A successor claims the original message and correction together. Earlier committed state is retained, not rolled back. Full staged proposals and the unavoidable external-send dispatch boundary remain separate work.

The conversation evaluation now recognizes a plan from the persisted prompt/send trace and message ID, rather than a mandatory English closing phrase. This removes a measurement constraint before changing proposal wording.

Validation: 380 function tests passed; formatting, lint and type checks passed. Seven PostgreSQL assertions passed in a hosted rollback-only transaction, covering current ownership, freshness rejection, stale memory/outbox rejection, successor claiming, batching and completion. No production migration or function deployment has been performed for this increment, and no fresh live-model quality result is claimed. The remaining design findings still require implementation and experience qualification.
