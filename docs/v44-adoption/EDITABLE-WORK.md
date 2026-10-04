# Editable work and decisions

30 September 2026. Base: `0c00863`. Local continuation; no provider or production changes.

## What changed

- Lead Overview has **Edit lead**: business name, phone, emails, address, website, area, industry, owner, status and follow-up date. It saves through the authenticated, token-protected operator API to the existing CRM.
- Only changed fields are submitted. Ephemeral Google display data is not copied on save. Founder corrections keep their manual provenance and survive later directory imports.
- A stale editor is refused before writing. Failed saves retain the form; switching tabs retains unfinished edits. Changes have an activity entry without claiming a call happened.
- Opt-outs and exclusions remain in place. Correcting a website resets its opportunity assessment and retires older issue/audit evidence; prepared scripts predating edits are not offered as current. Stored files remain intact.
- Home and Work can record approval, decline or completion with an optional note. Saved decisions can be edited or reopened. Answers live in `.operator-data/workspace-decisions.json`; the tracked source list is not changed. Changed instructions need a new answer. Recording a business answer grants no execution authority.
- Receptionist readiness gates retain their own evidence and sign-off controls. Home links separately to emails, paused agent questions and the complete decision list, matching the sources in its waiting count.
- Jarvis has a focused **Agent questions** surface using the existing per-request answer controls. Opening it starts no agent. An answer refreshes its list and the shared waiting count.

## Verification

Synthetic tests cover API/database reopen, stale edits, invalid-input atomicity, opt-outs, ephemeral fields, refreshed imports, derived evidence, decision amend/reopen/restart, stale instructions and corrupt journal states. Browser checks use actual Chrome at 1440 and 390 widths with intercepted writes: lead edit/recovery/reopen, decision save/edit/reopen, and a paused agent answer. Earlier tab, keyboard, restriction and focus checks also pass. Changed Home, Work and Jarvis routes render without overflow or page errors. The new editor/decision components return no findings from the mechanical design scan.

Final frozen-source gate: 9685 pass; 13 skip; 0 fail; Ran 9698 tests across 559 files. [568.82s]. Typecheck and build exit zero. All reviewed source/fixture hashes stayed unchanged during this gate. Clean-source frozen installation, typecheck and build also exit zero.

No private records were inspected or altered to demonstrate these controls. No agents, calls, messages, bookings, public pushes, financial actions or provider changes were made. This verifies these editable action paths, not every integration in AgenticOS.
