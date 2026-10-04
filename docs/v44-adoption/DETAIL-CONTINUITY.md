# Detail continuity — 30 September 2026

## Changes

- The lead sheet opens with its next action, contact details and key facts. Five sections: Overview, Call, Deal, Research and History.
- Secondary sections mount when first opened. They then stay mounted while hidden, so tab changes preserve unfinished call notes and deal edits. A different lead starts a fresh session.
- Both lead entry points use the same drawer. Its header and section navigation remain visible while its body scrolls. It is 720px wide on desktop and fills a phone.
- The shared detail layout supplies readable 15px body text, 17px section titles, consistent dividers, spacing and form controls. Memory dialogs, coding jobs and right-side sheets use it.
- Old 9–12px declarations in the legacy operator stylesheet follow the 13px metadata token. The small wordmark is a brand treatment, not running text.
- Deal price breakdowns, stage history, objection responses, follow-up drafts and agent configuration open on demand. Product evidence, provenance and unapproved setup terms remain accessible.
- Lead Escape/close returns focus to the control that opened it. Tabs support arrows, Home and End. Contact restrictions and founder confirmations remain intact.

The synthetic populated overview exposes 71 words, compared with 591 in the previous single stack. This measures the fixture's default view, not every business record.

## Verification

- Focused existing checks: 575 passed, zero failures.
- Actual Chrome at 1440px and 390px: tab edits retained, contact-note save intercepted successfully, keyboard sections, Escape and opener focus, do-not-contact and exclusion restrictions, zero horizontal overflow or JavaScript errors.
- All 13 main routes rendered at desktop and phone widths without overflow or browser errors. Memory detail prose computes to 15px. Every review record is fabricated; no real CRM records, memory text or transcripts were inspected.
- One mechanical design scan was attempted against the changed UI files. The command returned zero but also warned about unsupported output arguments; no JSON scan receipt is claimed. Bounded visual inspection and the functional browser checks supply the UI evidence.
- Final frozen-source gate: 9674 pass; 13 skip; 0 fail; Ran 9687 tests across 557 files. [574.13s]. Typecheck and build exit zero. All source and browser-fixture hashes stayed unchanged during the gate.

## Reproduce the browser check

From the source repository, start `bun run scripts/leads/detail-continuity.preview.ts`, then run `bun run scripts/leads/detail-continuity.acceptance.ts` in another terminal. The preview binds only to 127.0.0.1:4398, sets `envFile: false` and loads no production backend. All mutation requests are intercepted by the acceptance runner. Remote requests are aborted. Stop the preview when finished.

This change concerns interface continuity. It is not live voice, desktop-control, real provider, receptionist or billing acceptance. No agent was started and no public deployment was made.

Clean-source verification: frozen-lockfile dependency install, typecheck and build all exit zero in a separate unconfigured copy. Private state, credentials, recordings and private graphs were excluded. Populated coding job details also pass actual Chrome at desktop and phone widths, including the agent configuration disclosure.
