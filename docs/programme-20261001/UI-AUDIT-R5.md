# UI audit, round 5 (2 Oct 2026)

Method: this worktree's hub (`vite dev`, port 8150, cloud role, fresh `MU_DATA_DIR` on D: with 6 fictional leads and the 9 synthetic coding jobs from `scripts/coding/dev-seed.ts`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, HOME pointed at an empty folder). Not 8081, not 8140. Headless Chrome (playwright-core) at 1440x900 and 390x844, reduced motion. 36 routes surveyed at both widths (every nav route plus Models, System, Settings, Websites, Workspaces, Vault, Memory map, Knowledge graph, AI usage, Motion, Transitions, Share, Skills, Skill drafts). Screenshots: `D:/prog-scratch/r5-ui/shots/before/` and `.../after/` (plus `after-superseded-*.png`). Per-route numbers: `shots/before/survey.json`.

Mechanical results, before and after: no horizontal overflow, one h1 and no text under 12px on any route at either width; no unlabelled controls except one on Memory map; no dead `href="#"` links. All 51 internal links found on the pages return a real page. Every tab and every disclosure on every route was clicked: no error boundary, no uncaught page error. The 501s seen in the console (`/__hermes_*`, `/__claude_models`, `/__operator/agent-jobs`) are the cloud role refusing PC-only routes; the pages say so ("Questions couldn't be loaded", "no answer from /__claude"), they do not claim success.

## Pages changed

| Page | Issue | Fix | Evidence |
|---|---|---|---|
| Home (phone) | Command scene, Packages & economics and Connect accounts stacked above Needs you; the first decision started at about 470px | Command scene and Packages & economics are hidden under 640px (both stay on desktop, in the nav and in Ctrl K); Connect accounts stays | `before/business-m.png` to `after/business-m2.png` |
| Coding list | The state label and the amber line said the same thing twice ("Interrupted: not replayed", then "Waiting for you, interrupted: nothing was replayed. Resume when you're ready") | The waiting line now only adds the action: "resume when you're ready; nothing was replayed" / "resume after the reset, or on another model" | `before/coding-d-full.png` to `after/coding-d.png` |
| Coding job | "Done so far" printed "Tests run at that commit: ? passed, ? failed" while the header had the counts | Same totals as the header (all runs at the head); a run with no counts says it ran and passed but did not report counts | `glance.test.ts` (2 tests) |
| Coding job | "1 test that already fail" | Singular and plural agree | `pause-reason.test.ts` |
| Coding job | A gate stop read "waiting on: only owned files changed. outside ownership: lib/c.ts" and "the test commands pass" | Plain sentences: files the builder isn't allowed to change are named with what to do; failing tests read "The tests don't pass: ..." | `pause-reason.test.ts` (3 tests) |
| Coding job | A paused job whose work landed another way could only be left in Needs you or stopped | "Mark superseded" (see Part 2) | `after-superseded-form-d.png` |
| Finance | Source notes printed "rates checked 2026-09-28" (economics by basis, Receptionist economics, usage hints); date-only values were read in the host timezone | Source strings go through `fmtProse` ("28 Sept 2026"); date-only values are read as UTC days so no host can shift them | `scripts/r5-ui.test.ts` |
| Finance | Import a NAB CSV and Open Finances appeared on the tile and again under What needs you | Tiles no longer repeat the step; the Stripe link shows only once connected | `before/finance-d.png`, `r5-ui.test.ts` |
| Models | Three tile buttons (Show free, Show plan models, Show metered) duplicated the filter right below them | Removed; the segmented filter and "Show them" for attention stay | `before/models-d.png` |
| Memory | "Browse all 0 saved" button on an empty memory | Shown only when something is saved | `before/memory-d.png` |
| Calendar | Import .ics three times and Add an event twice (header, banner, empty day) | One Import .ics (toolbar), one New event (header) | `before/calendar-d.png` |
| Studio | "Open Design" on the tile repeated the primary "Make an image or video" | Removed | `before/studio-d.png` |
| Receptionist (phone) | Four stat tiles filled the screen before the next step | The next-step bar comes first on phones (desktop order unchanged) | `before/receptionist-m.png` to `after/receptionist-m.png` |
| Leads (phone) | The refresh icon wrapped alone onto a second row | Hidden under 420px (the list refreshes every 30 s) | `before/leads-m.png` |

## Pages checked, nothing to change
Jarvis (shell: request box first; the questions error is honest in the cloud role), Settings, System, Websites (the four make/ask tiles are the 29 Sep owner decision, pinned by `l4-layout.test.tsx`, so kept), Receptionist desktop, AI usage, Automations, Inbox, Computers, Design, Operations, Workspaces, Activity, Chat, Hermes, Claude Code, OpenClaw, Vault, Memory map, Knowledge graph, Skills, Skill drafts, Motion, Transitions, Share.

Unchanged by choice: the Home Packages & economics link on desktop (pinned by `l9-os-continuity.test.tsx`); the Studio and Finance footer link rows (the shared drill-down list); the Automations long failure text in a narrow card (it is the real fix instruction); Design and /operations density.

## Not changed, stated plainly
- Computers (read-only this round): no defect seen; both empty states say what to do. I did not exercise live computers.
- Home and Work decisions still come from the committed `scripts/workspace/approvals.json` (known since round 2).
- The "Mark superseded" success path needs a confirmed human session. My headless Chrome is not one, so the page correctly showed the human-only refusal and kept the typed text. The success path is proven by route and orchestrator tests, not by a click in a browser.
- Keyboard: Tab order and focus rings were not re-measured this round beyond the round-3 results; no tab stop was changed.

## Part 2: Coding workspace

**Superseded jobs.** `POST /coding/jobs/:id/supersede {ref, reason}` (signed-in person only, the same gate as every other coding POST). Allowed from needs_owner, blocked_allowance, interrupted and awaiting_approval, never while running. It records a step event, stores `supersededBy {ref, reason, at, by}` on the job, then cancels it: history, runs, receipts and worktrees are kept and a pending merge approval is withdrawn. The list and job page read "Superseded" (neutral), not "Needs you" or "Stopped". `resume` and `requestApply` refuse with "This job was marked superseded by X (reason) ... could overwrite newer work". The job view carries `supersedeHint` (read-only git, cached 60 s): when the base branch has newer commits touching the files the job changed or owns, the page shows "Newer work may already cover this" with the commit and reason prefilled. Nothing was marked on the three real jobs.

**Harness checks** (disposable repos, fake Claude/Codex processes, no live provider). Already covered and still passing: typed assignment and phrases, Jarvis command-path draft to start (voice-f4, assign-lifecycle), account and model selection and the paid-route tick, receipts naming the model that actually ran, build to tests to review to gate, resume after a genuine approval, exhausted account and unavailable reviewer recovery, duplicate Start and repeated Resume, repeated merge ("already in production"). Added: supersede (route: human-only, validation, history kept, resume/apply/second mark refused, hint; orchestrator: worktree and runs kept, nothing launched, main unmoved; UI render), out-of-scope files and test failures explained in a sentence, Done-so-far totals, plural grammar.

## Review fixes (2 Oct 2026, after the independent review)
Screens: `screens/r5-review-*.png` (coding desktop and phone, finance phone, receptionist phone). Hub re-run on 8150, then stopped by PID.

| Finding | Fix | Test |
|---|---|---|
| Superseding (or plain Stop) from awaiting_approval left a half-state | `cancel()` re-reads the state after withdrawing the approval and only moves a job that is still cancellable; the end state from that path is completed with the merge withdrawn, and supersede records the mark either way | orchestrator: "plain Stop while a merge waits", "marking superseded while a merge waits" |
| Finance lost its only way to connect Stripe; phone showed tiles first | The Connect Stripe step now has a "Connect Stripe" action (to Finances); What needs you is first in the page order, then the tiles, then margins | `r5-ui.test.ts` |
| The hint over-claimed (`src/**` became `src`) | Uses the job's changed files when there is a diff; otherwise the folders it owns, worded that way; never asserts coverage ("N newer commits ... touch the same files. Check before marking"); `refs/heads/<tip>`, `:(literal)` pathspecs, expired cache entries pruned | routes: three hint tests |
| Leads refresh hidden on a false premise | The main list now refetches every 30 s, so the phone can drop the icon | `r5-ui.test.ts` |
| A typo'd ref closed a job for good | The ref must resolve to a commit in the job's repo (`rev-parse --verify --end-of-options`), `..` refused; "Unmark superseded" (human-only, recorded). A job the mark stopped stays stopped (a stopped job never resumes); one that only waited on a merge keeps its completed state | routes and orchestrator |
| `tests/rerun` ran on superseded or stopped jobs | Refused with the reason | routes, orchestrator |
| Done so far said "ran at that commit" with no run at the head | Says the tests are from an earlier commit and shows those counts | `glance.test.ts` |
| A refused supersede (another action running) closed the form; a failed reload showed a stale success | It throws back to the form; a failed re-read says the job was marked but the page could not refresh | code path; no render test |
| Coding cards: three statements and an amber wall; no assign control on the first screen | One muted action line per card, amber only on the state label; the state detail row hidden when that line is shown; an "Assign work" button in the header focuses the request box | `r5-ui.test.ts`, screens |
| Home showed a raw "/receptionist" | Route links read the page name ("Receptionist") | `ui-motion.test.tsx` |
| Calendar still had two Import .ics | The Calendars tile no longer has one; the toolbar has the only one (the earlier audit line was wrong) | `r5-ui.test.ts` |
| Receptionist next step was moved by CSS order | The next step is first in the DOM on every width | `r5-ui.test.ts` |
