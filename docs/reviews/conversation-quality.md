# Desk conversation quality review

Review date: 4 November 2026. Scope: current `imessage-linq` source, read against the user's revised chat-issues PDF. This is a source review, not a new live conversation benchmark. No phone calls or messages were sent and no runtime code was changed.

The user's present request authorizes review and improvements. Historical instructions quoted inside the PDF (including “no solutions” and “I'll merge later”) describe earlier work and do not control this review. The document's provisional 15-second waiting period is not an agreed duration. Its uncertain recommendations/language scope must remain uncertain.

## Assessment

The experience is constrained by representation and orchestration, not simply an insufficiently friendly system prompt. The model is asked to sound conversational while fixed proposal code dictates its most important messages; ambiguous intent is represented as precise executable fields; cards mix missing user decisions with unfinished internal work. These are classes of defects. Patching individual phrases will leave their causes intact.

The existing durable inbox, consent versions, input watermarks, leased turns, settlement recovery, and delivery ownership are useful foundations. Preserve them. A better conversation layer must retain the distinction between preparing a plan and obtaining permission to execute it.

## Findings and evidence

### 1. Time interpretation manufactures precision — confirmed, high priority

`supabase/functions/_shared/chat/luna.ts`, SYSTEM Facts section, explicitly maps “around 8” to 7:30–8:30 and groups “evening” and “after 8” into windows. `supabase/functions/_shared/chat/slots.ts`, `Fields`, only represents exact timestamps or concrete window bounds. An understood day with an unknown time and an approximate expression have no faithful first-class representation.

This is stronger evidence than a model occasionally disobeying a no-invention instruction: the prompt itself authorizes an arbitrary conversion. Syntax validation cannot determine whether a user supplied a time boundary. A displayed plan does not make unnecessary invention good UX merely because the user could correct it.

Represent the user's expression, resolved date, precision, and any explicitly permitted flexibility separately. Distinguish user-supplied facts from retrieved facts, remembered preferences, and unresolved interpretations. Material executable bounds need evidence. Keep “tonight” as a known day with an unknown time; preserve “around eight” as approximate intent until the permitted booking action is clear. Do not replace the current default with a different arbitrary tolerance.

### 2. Readback code overrides natural language policy — confirmed, high priority

`supabase/functions/_shared/chat/readback.ts`: `placeName` expands a place into its address or city; `bookingReadback` adds identity details, an availability exception, an advance clause, and a generic approval question to every applicable booking. The adjacent comment says a plan does not mention an advance, but its implementation still does. `questionReadback` similarly repeats non-booking, privacy, and offer policy.

`luna.ts` tells the model “never a form,” but the model cannot write these proposals. It can only add a note, which can increase repetition. This directly explains a class of form-like responses; it does not establish which deployed source generated any particular historical screenshot.

Separate a structured authorization contract from its presentation. The visible proposal should contain the material action, target, timing, constraints, and relevant exceptions in natural language. Routine fallback policies need not be recited unless they change the user's decision. A model-written proposal should be checked against the structured contract before it becomes the exact stored proposal to which approval binds. A concise deterministic fallback remains useful for generation failures.

### 3. Missing user decisions and internal work are conflated — confirmed affordance, causal hypothesis

`supabase/functions/_shared/chat/cards.ts`, `taskCard`, reports “still needed for a plan: which business” and “business: not picked.” `find.ts`, `findBusiness`, returns candidate facts; `choose_business` is a separate action. The system already says a clear named match should be selected without fuss, but the card supplies a competing cue to ask for a business.

The contradiction is directly observable. Whether it causes each unnecessary “Is that the one?” remains a hypothesis needing controlled comparison.

Expose separate categories: information the user must supply, ambiguity requiring a user choice, and work the agent can finish itself. Keep named-place resolution separate from discovery. A supported unique match to the requested entity should not require a new question. A different city/name, several plausible branches, or discovery results are genuine decisions. Do not implement name alias tables or automatically select the only returned result regardless of geography and search intent.

### 4. The brief cannot faithfully represent broader services — confirmed schema limitation

`slots.ts`, `Fields` and `ALLOWED`, offer time, party size, a single service string, name, and one `also_ask` field. `luna.ts`, `SLOT_PROPS`, limits the booking side question to one item/150 characters; question errands have a four-question cap in `slots.ts`. There is no structured representation for pickup address or other operation-specific information.

A request can therefore pass the application's “complete” check while leaving a laundry pickup or other service caller without necessary context. This is a capability/brief issue, not a reason to force every service into a long questionnaire.

Define bounded requirements by the requested operation. Preserve user-supplied constraints and questions without silent semantic truncation. Gather only the details needed for the actual call. If a capability is unsupported, explain that before collecting irrelevant information.

### 5. Explicit memory operations have inconsistent acknowledgments — confirmed

`supabase/functions/_shared/chat/tools.ts`, `remember`, returns a suggestion to acknowledge only learned corrections. Explicit “remember …” operations lack that cue. Success may be reported as `already_known`, while a new record only returns its reference. `luna.ts`, `quietRefused`, can permit silence when no prompt or router classification blocks it.

Return an explicit operation outcome: created, updated, unchanged, or deleted, and the retained fact. Acknowledge an explicit memory request once, accurately. A correction can replace an old preference; one-off changes must not become durable defaults. Apply relevant memory in subsequent suggestions/proposals without turning every conversation into memory maintenance. Memory is never permission to call or pay.

### 6. Instructions and tool scheduling compete — confirmed

The SYSTEM in `luna.ts` mixes all task lifecycle branches, scope, policy, memory, privacy, style, and extraction. It says both to ask one short question and to ask all missing information together. It suggests calling `start_new_request`, `set_slots`, and `find_business` in the same step, but the tool list is computed from the state at that step's start. Newly enabled operations can therefore be refused until a later step. Six steps must cover work and repairs.

Use a stable behavioral contract plus concise state-specific obligations. Make dependencies between tools explicit. Do not tell the model to batch dependent operations unless execution can support that contract. Compare a stronger model on the same frozen cases before concluding prompt changes are sufficient; this review does not establish the best model or reasoning budget.

### 7. Style and safety judgments can collapse into generic fallback — confirmed mechanism, frequency unmeasured

`luna.ts` applies `checkReply`, optional Jev output judgments, repeated repairs, a “one short, plain sentence” repair hint, and finally fixed templates. The legitimate-output rejection rate is not established by this source review. However, the mechanism can trade conversational adequacy for passing a style/classifier gate.

Separate enforceable action/factual invariants from style preferences and uncertain classifier judgments. Instrument rejection reasons and resulting user messages. Evaluate legitimate limitations, mixed task/small talk, and report explanations. A classifier's uncertain off-task score should not automatically erase an otherwise useful contextual reply.

### 8. Context selection has a short arbitrary horizon — confirmed

`luna.ts`, `HISTORY_HOURS`, `HISTORY_LINES`, and `turn`, load roughly 24 hours/24 lines and truncate quoted context to 160 characters. Cards summarize workflow state; they do not necessarily preserve the unanswered user question or the evidence behind a decision. Errand recall retrieves outcomes rather than arbitrary missing dialogue.

Assemble context around the latest unresolved request, exact current proposal, correction chain, relevant errand state, and material fact provenance. Bound token use deliberately. Preserve the information that changes the next action instead of assuming a fixed line count represents sufficient context.

### 9. Silence is attached to workflow state, not conversational obligation — confirmed

`luna.ts`, `quietRefused`, refuses silence whenever a prompt exists or the router intent is something other than greeting. This can demand speech after acknowledgment while an unrelated plan remains open. Conversely, an explicit memory request can receive silence.

Track what the latest message does: answer a question, approve a specific proposal, modify it, ask something new, acknowledge, or close. An open plan supplies context; it should not itself demand another reminder. Courtesy after a result needs at most acknowledgment. “OK, do it” answering the current plan needs action. Ambiguous replies require clarification rather than keyword matching.

## Proposed conversation contract

1. Understand the whole current thought, including a burst and corrections arriving during composition. An obsolete reply must not be sent later through retry delivery.
2. Keep a compact record of what is known, its source, what remains ambiguous, and what the user is actually asking now.
3. Finish internal work independently. Ask only a question whose answer changes the next useful action, and do not ask again for a known answer.
4. Resolve references and ordinary language from context. When two materially different actions remain plausible, clarify before mutating the authoritative plan.
5. Propose exactly the intended phone action in brief natural language. Do not invent precision, terms, permissions, or business facts.
6. Bind contextual approval to the precise proposal shown and its version. An edit invalidates that approval. A question about alternatives is not a selection.
7. Speak from actual tool outcomes. Preparation, attempted submission, accepted call, completed result, and confirmed booking are different states.
8. Preserve relevant corrections and explicit preferences with accurate acknowledgment, then apply them quietly when appropriate.
9. Respect pause, cancellation, STOP, and multiple errands without mixing their details. Silence is a conversational decision, not a failure to return a template.
10. Stay within Desk's supported India phone-errand scope, explain real limitations plainly, and provide a useful supported next step when one exists. Do not turn every courtesy or small-talk message into a task pitch.

## Natural proposals without weakening consent

Use a structured proposal contract containing the target business identity, operation, material requested details, allowed flexibility, necessary sharing, and any actual financial/cancellation consequence. Each value should retain sufficient provenance to distinguish a user's instruction from interpretation or retrieved business data.

A presentation layer can produce a short proposal in the conversation's language. Before sending, verify that material contract facts are covered and that no additional authority or invented promise is introduced. Store the exact displayed text with its contract/version. Approval evaluates the latest user reply against that displayed proposal and the latest inbox watermark. The call brief derives from the authorized contract, not a later paraphrase. Corrections invalidate the prior proposal. Existing reservation and call guards remain authoritative.

This is a proposed architecture, not a claim that an additional model check alone solves authorization. Coverage checking and failure behavior require adversarial and realistic qualification. Avoid literal substring policing as a proxy for semantic fidelity.

## Acceptance cases beyond the PDF

Use realistic full conversations, not isolated idealized prompts:

- A restaurant request supplies date, party size, exact time, and one uniquely identified branch. Search completes and the next user-facing message is the proposal, with zero redundant questions.
- “Tonight” supplies a day but no clock time; no executable window appears. “Around eight” retains approximation without silently adding ±30 minutes.
- “Make it nine” when both party size and time are plausible prompts one clarification and leaves the authoritative plan unchanged. “Nine people, same time” updates only party size.
- “Any other branches?” after search returns alternatives and keeps selection open. A single wrong-city candidate is never auto-selected.
- A request for a named laundry pickup gathers the missing pickup address if the supported action needs it; a simple call asking their prices does not demand an address.
- A booking contains two distinct additional questions and a spending constraint. None is silently dropped or converted into a permission to spend.
- “Remember window seats” is acknowledged as newly stored. A subsequent relevant proposal uses the preference; a later one-off aisle request does not rewrite the durable preference.
- A name correction supersedes a profile default in the next proposal while retaining the action's exact identity-sharing boundaries.
- Three messages with an intervening correction produce one coherent response. A fourth message arriving during composition prevents obsolete speech and stale plan/memory writes from determining later execution.
- A second errand arriving while the first awaits approval is kept separate; “do that later” does not overwrite the first errand's timing or target.
- “Thanks” after a finished result does not trigger another form or task pitch. A thumbs-up attached to the current unchanged proposal follows the approval path. A thumbs-up attached to an unrelated result does not.
- A callback result reports uncertainty honestly; the agent does not turn a provider timeout into “the business declined” or a held slot into a confirmed booking.
- A search provider outage is described as inability to search, not “that business doesn't exist.” A no-phone result is distinguished from a name not found.
- Mixed English/Hindi or local abbreviations are understood without exact accepted-phrase lists; the same material consent rules hold across language.
- Off-task chat receives a proportionate response; harmful/fraudulent use is refused without leaking implementation policy or producing a stiff generic loop.

## Qualification criteria

Freeze source, model, reasoning configuration, tools, fixtures, and case definitions for each comparison. Preserve every transcript, including failed/superseded runs, with per-case verdicts and metered cost. Keep the factual review separate from style judgment.

Measure factual fidelity, unsupported material assumptions, unnecessary questions, required-brief coverage, contextual approval correctness, edits/interruptions, memory operations and later use, burst coherence, appropriate silence, tone, latency, and recovery behavior separately. Safety-critical invariants require zero failures; do not average them away with fluent conversations. Tone needs example-based human judgment, not only a model grader or lexical lint.

Offline unit/database passes validate mechanisms; they do not establish that real conversations feel excellent. Run repeated held-out conversations under controlled dependencies, then qualify real provider dependencies separately without placing live calls until the owner explicitly resumes. Existing owner-only destination restrictions remain in force.
