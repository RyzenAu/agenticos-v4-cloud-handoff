# Round 8, Track E: interface polish

Base: released 3bc6f9e0 merged into `r8/e-polish-20261003` (frozen candidate 74ace895 before that). Method: synthetic hub on port 8150
(gate seed, `--host none`), one browser, owner session, reduced motion for the sweep. The sweep covered 30 routes at 1440 and 390
(health, clipping, duplicated controls, leaked names, tap targets, 30-press Tab walk, animation-frame callbacks, running CSS loops);
the two round-7 audits were re-checked through it. Round 7 had already fixed most of what they listed; the defects below are what was
still present. Screenshots are under `docs/programme-20261001/evidence/r8-polish/`.

## Fixed

| # | Page | What was wrong | Fix | Evidence |
|---|---|---|---|---|
| E1 | Jarvis > Hermes (`/agents/hermes`) | A refused read (403 needs-human-session, an unconfirmed browser) left status empty, so the page said "Install Hermes." under "Installed, not verified", and polled every 4 s. | One shared helper (`src/lib/needs-confirm.ts`, `NeedsConfirmNote`): one calm line, no install card, no tabs, no status word, no retry or poll. | `after-needsconfirm-hermes-1440.png` |
| E2 | Jarvis home, Agent questions | "Questions couldn't be loaded. Retry". | Same line, no Retry. | `after-needsconfirm-jarvis-questions-1440.png` |
| E3 | CRM > Companies, saved views | "Saved views could not load. Try again", retried by react-query. | Same line; retries stop on this answer. | `after-needsconfirm-crm-companies-1440.png` |
| E4 | Work > Owner approvals | A bare tailnet login (via tailnet-person, not pending) saw active Record decision buttons the server refuses. | `useBrowserPending` now counts a bare tailnet login as unconfirmed: buttons disabled with the reason, and the pairing banner shows. | `after-needsconfirm-work-1440.png` (all three buttons disabled) |
| E5 | Every page with a canvas loop | `requestAnimationFrame` loops ignored reduced motion and off-screen state: the plasma core, the orb's idle drive (60 callbacks a second on every page), the Memory Map camera. | `src/lib/frame-gate.ts`: loops run only on screen, in a foreground tab and with motion allowed. Reduced motion: 0 callbacks a second on every page tested (motion allowed: ~60, from the kept orb loop). | `raf-after.txt` |
| E6 | Websites, Make a site, 390 | The steps column was 394 px wide inside a 356 px card (grid item min-content), so the first segmented control ran past the edge. | Single grid column is `minmax(0,1fr)`. | `before-websites-390.png` / `after-websites-390.png` (measure: `sweep-before.json` vs `sweep-after.json`, clipped list empty) |
| E7 | Memory, note box | Focus showed only a 1 px gold border. | 2 px ring on the composer when the box has keyboard focus. | `before-focus-memory-1440.png` |
| E8 | Models | "NOT CONFIGURED (no KIE_API_KEY)." printed a key variable name. | `plainLimits`: "Not set up (no key added yet)." | `sweep-after.json` (no leak on /models) |
| E9 | Coding > rules | "own git worktree", ".env files". | Plain words. | `sweep-after.json` |
| E10 | Inbox triage, local site, free voice (merged onto base wording), motion handoff | A `bun scripts/...` command, `bun run dev`, a key name and a home-folder path on pages. | Plain sentences. | source diff |

## Left alone, with reason

- `/coding` Technical detail still holds the one-time `bun scripts/coding/codex-isolation.ts` command: it sits behind a "Technical detail" disclosure, which round 7 chose.
- `/agents/hermes` install card shows the install command when Hermes isn't installed: that is the card's purpose.
- Inbox and Design provider rows run past 390 px: they are horizontal scrollers by design.
- Round 7 orb idle loop: nothing reads the `--oracle-idle-level` variable it writes. Kept (and gated) on the coordinator's instruction. A kit piece does not apply; deleting the loop would save the remaining ~60 callbacks a second.
- Agent pages (Track C): no defects found in the sweep.

## Tests

`scripts/r8-needs-confirm.test.tsx` (403 fixture through Hermes status, Agent questions, CRM transport, decision row, unconfirmed rule) and
`scripts/r8-frame-gate.test.ts`. `bun test src` plus the house-rule, format, continuity and touched-file tests: 1138 pass, 0 fail.
`bun run typecheck` clean.

## Review fixes (on 26bfc775)

- **A.** `brain-graph-3d.tsx` now pauses the renderer only when the map is off screen or the tab is hidden. Reduced motion stops only the auto-rotation, so the Memory Map stays draggable and zoomable. Browser check under reduced motion: the map settles and holds still, a drag changes the view, a wheel zoom changes it (`after-memorymap-reduced-1.png`, `after-memorymap-reduced-2-dragged-zoomed.png`).
- **B.** `watchFrameGate` also subscribes to the motion controller (`subscribeMotion`), and its callback now says why (`onScreen`, `hidden`, `reduced`).
- **C.** The plasma core repaints once from its resize observer while paused.
- **Tests.** A `watchFrameGate` test with a fake IntersectionObserver (inactive, active, inactive; `stop()` removes the listeners; a reduced-motion change reports reduced while on screen), and a negative case: the console-only 403 is not needs-confirm. `decision-row.tsx` uses `isNeedsConfirm` for its message.
