# Chat interface rehearsal

Brief: a functional, white-and-blue iMessage-like local Desk interface, with the
agent's existing workflow and an optional real phone test.

Visual reference: Stageshow `examples/messages` and `examples/imessage`. Borrowed
system typography, blue outgoing / gray incoming hierarchy, rounded composer,
restrained bubble arrival and reduced-motion support. Adapted the composition to
a working desktop app with a narrow phone layout, rather than framing a simulated
iPhone or automating a marketing loop. No React runtime or animation kit was added
to the application: the existing Deno/static-page architecture remains sufficient.

The primary object is the conversation. The supporting panel explains the active
errand and exposes test controls. Raw database state and traces live in a dialog.
Test plans use actual tools and read-backs; calls and model readiness are labelled.
The initial empty state offers actionable prompts rather than invented history.

Verification results and remaining provider limitations are recorded after browser
rehearsal. Screenshots are stored outside the source tree to avoid committing
conversation data or binary artifacts.

## Verified

- Chromium at 1440 × 1000 and 390 × 844 against the actual local Deno server and
  Supabase database, with no page exceptions or horizontal phone overflow.
- Suggested prompt, send, actual tool-driven plan preparation, quoted reply,
  workflow inspector and history after reload.
- Initial, calling-plan, phone chat and phone details screenshots inspected.
- Stageshow messages reference rendered separately using its film script. Its
  still-only framing warning was retained as a reference result; no claim of a
  passing animation-film gate is made for this functional app.
- Fixed a missing arrow glyph after screenshot inspection using the installed
  Lucide icon geometry. Captures after the fix wait for bubble entry to finish.
- Formatting, lint and type checks; 338 existing unit tests and 3 new boundary
  tests pass. The latter check destination restriction, configuration redaction,
  provider prerequisites and foreign-origin/form rejection.
- Found and corrected the existing tracing proxy wrapping synchronous `forTurn`
  in a Promise; a real browser message now completes using its lease-bound store.

## Not verified

Real model approval/reporting and Sarvam phone execution need activated provider
network access. Sarvam organization/workspace/app/connection IDs are still missing,
as are a callback route to the local database and verified caller configuration.
No real call or WhatsApp send was made. The existing eval suite is available after
live model connectivity is configured. No marketing animation loop was authored.
