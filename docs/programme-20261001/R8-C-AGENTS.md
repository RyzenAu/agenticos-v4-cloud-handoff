# Round 8, track C: Agents workspace and desktop reliability (3 Oct 2026)

Track C (Claude Opus 5.5), branch `r8/c-agents-20261003` (worktree `D:\AgenticOS-r8-c-agents`, base `74ace895`). The lead released the
candidate as **`3bc6f9e0`** (review fixes on top of `74ace895`) before this run, so every candidate result below is for
`D:\AgenticOS-r7-candidate` @ `3bc6f9e0` (head checked at the start and end of the run, unchanged; the candidate was never edited).

## Environments (kept distinct)

| Code | What | Where |
|---|---|---|
| SYN | synthetic hub, `--host none`, pc role, serving the frozen candidate | `127.0.0.1:8140`, data `D:\AgenticOS-r8-data\c\hub`, results `D:\AgenticOS-r8-data\c\out` |
| WSL | synthetic hub, `--host local-wsl`, serving the frozen candidate, one REAL local computer `research` (this PC's WSL kali-linux, display `:41`, folder `/home/ryzen/mu-computers-r8c`) | `127.0.0.1:8141`, data `D:\AgenticOS-r8-data\c\wsl`, results `D:\AgenticOS-r8-data\c\out-wsl` |
| WSL-FIX | the same journey against THIS branch (display `:45`, folder `/home/ryzen/mu-computers-r8cf`) | `127.0.0.1:8143`, data `D:\AgenticOS-r8-data\c\wsl-fix`, results `D:\AgenticOS-r8-data\c\out-wsl-fix` |
| RYZEN / HW | the production hub and the installed desktop shell | **not run** (lead's; see section 5) |

All hubs: `MU_SYNTHETIC_HUB=1`, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, `MU_TRIGGERS=off` (journey J turns triggers on for itself), the failing
`vercel` stub first on PATH, credential-named variables removed by name. One browser at a time. No production access, no pairing on production.
Teardown: both computers destroyed through the API, no Xvfb, x11vnc or companion process of this run left in WSL, both computers folders removed, all
three hubs stopped.

## 1. The acceptance matrix on the candidate (SYN)

`bun scripts/acceptance/r7/run-all.ts --hub http://127.0.0.1:8140 --data D:\AgenticOS-r8-data\c\hub --out D:\AgenticOS-r8-data\c\out --repo D:\AgenticOS-r7-candidate --restore-port 8142 --label candidate-3bc6f9e0`.
Raw results: `scripts/acceptance/r7/results/candidate-3bc6f9e0/` (copied from the output folder).

| Journey | Result | vs `e8d04d69` |
|---|---|---|
| routes sweep | PASS 342 · **FAIL 2** | was 344 PASS: finding C-7 below (not in track C's files) |
| B session | PASS 14 · OUT OF SCOPE 1 | the first run FAILED on the script, not the product (see R-4); re-run with the fixed script |
| E bots | PASS 22 · BLOCKED 1 (computer assignment, host-less hub) | same; the BLOCKED row PASSES on WSL (section 2) |
| G CRM | PASS 21 | same |
| F coding | PASS 6 · BLOCKED 4 (needs the owner's coding accounts) | same |
| D stop | PASS 7 · BLOCKED 5 (need a computer) | same; all five PASS on WSL (section 2) |
| I Vercel | PASS 2 | same |
| isolation | PASS 4 · BLOCKED 1 (ISO-2) · OUT OF SCOPE 4 | same |
| J routine | PASS 6 · NOT RUN 1 (07:30 clock) | same |
| L restore | PASS 9 · OUT OF SCOPE 1 | same |
| **Total** | **433 PASS · 2 FAIL · 11 BLOCKED · 1 NOT RUN · 6 OUT OF SCOPE** | 434 / 0 / 11 / 1 / 6 |

## 2. The connected journey on a real local computer (WSL, then WSL-FIX)

`scripts/acceptance/r7/journey-c-computer.ts` (new). Every PASS is a persisted effect read back through the hub's own APIs, a reload, a second tab
or a file on the computer. Candidate: **27 PASS · 2 FAIL** (`results-journey-c-computer-wsl.json`); this branch: **31 PASS · 0 FAIL**
(`results-journey-c-computer-wsl-fix-r8c.json`, which also counts the create and teardown rows).

| # | Check | Candidate (WSL) | Branch (WSL-FIX) | Evidence |
|---|---|---|---|---|
| 1 | Computer created; online only once a real screenshot came back | PASS | PASS | `state online, usable true, lastShotAt` |
| 2 | Conversation: a typed request starts a REAL job on the bot's computer (ack + card) | PASS | PASS | business preparation job, ack text |
| 3 | Progress lands in the conversation; card ends Done; job service `succeeded` | PASS | PASS | five progress entries read from `/__agents/bots/research/thread` |
| 4 | Saved result: the card's Open result serves the artifact | PASS | PASS | `after-fix/c-1-conversation-done.png` |
| 5 | Live computer beside the chat, view-only until Take over | PASS | PASS | `after-fix/c-2-viewer-live.png` |
| 6 | Take over mid-job (audit of the local fixture): the agent pauses at its next safe step | PASS | PASS | step "paused before the next move of step 1" |
| 7 | Card says paused for you; the panel takes your input | PASS | PASS | `data-input=yours` |
| 8 | **Copy while you hold the controls** (said once, second person, bot named) | **FAIL** (C-1 to C-4) | PASS | `before-candidate/c-3-takeover-held.png` vs `after-fix/c-3-takeover-held.png` |
| 9 | Takeover pauses agent input: another agent job 409, a program's input 403, no steps added in 8 s, the person's own input written and read back | PASS | PASS | 15 steps held, 15 after 8 s |
| 10 | Return resumes the SAME job without replay (no sub-goal done twice) and it finishes | PASS | PASS | 5 sub-goals, 0 duplicates, "control returned ... re-read" |
| 11 | After the job the computer is free | PASS | PASS | controller null |
| 12 | Stop from the conversation cancels the real job; nothing ran after it; no result claimed; computer up and free | PASS | PASS | `after-fix/c-5-stop-chat.png`, artifact 404 |
| 13 | Stop from the computer panel (confirmed) cancels the job; the later step never runs | PASS | PASS | `ls` of the computer's work folder: `r8c-never.txt` ABSENT |
| 14 | Start brings it back with a working screen | PASS | PASS | |
| 15 | Viewer: closing the tab that held the controls gives the computer back | PASS | PASS | released 5.1 s after the close (grace), lease events listed |
| 16 | Viewer: a new tab reconnects live, view-only, Take over offered | PASS | PASS | `after-fix/c-7-reconnected.png` |
| 17 | Same browser, two tabs: closing the one that took the controls keeps them while the other watches (one session, by design) and that tab says so | PASS | PASS | controller still `person` after 12 s |
| 18 | **Header while the screen is down** | **FAIL** (C-5: plain "Ready") | PASS | `before-candidate/c-8-recovery-screen-down.png` vs `after-fix/c-8-recovery-screen-down.png` |
| 19 | Recovery: a killed VNC server is named (layer, reason) and Restart display offered | PASS | PASS | panel mode `screen-down` |
| 20 | Recovery: Restart display / the bounded automatic restart brings it back; the viewer reconnects | PASS | PASS | |
| 21 | Recovery: a stopped computer shows Offline in the conversation; Reconnect says what it did and brings it back | PASS | PASS | `after-fix/c-10-reconnect-chat.png` |
| 22 | Model preference stays pinned after reload (page and API) | PASS | PASS | `auto` to `free-only`, read back after reload |
| 23 | Computer assignment: change, reload, API (the BLOCKED E row) | PASS | PASS | none, then back to `research` |
| 24 | After a refresh the conversation and every card keep their true end state | PASS | PASS | done / done / stopped = succeeded / succeeded / cancelled |
| 25 | After a refresh the saved result opens from its card (real click, new tab) | PASS | PASS | `after-fix/c-11-result-opened.png` |
| 26 | Tasks tab words match the job service's end states | PASS | PASS | Finished / Stopped |
| 27 | No page errors or failed requests besides the journey's own deliberate refusals | PASS | PASS | only its 409 (agent job while held) and 404 (stopped job's result) |

The five D rows BLOCKED on SYN are covered here on WSL: screen-truth layer (19, 20), takeover pauses agent input (9), Return resumes the same job (10),
Stop cancels and later steps never run (12, 13), a program cannot use the lease (9: its input is refused; taking the lease as a program is covered by
`scripts/computers/computers.test.ts` and was not re-driven). Terminal job status was checked three ways (card, `/__jobs`, Tasks).

## 3. Defects fixed on this branch (each with a regression test)

| # | Defect (seen live on the candidate) | Fix | Test |
|---|---|---|---|
| C-1 | The holder's card read "Paused while you have the controls" twice: the title, then the hub's sentence starting with the same words | `withoutTitle()`: a recovery body keeps only what it adds to its title (falls back to a non-repeating default) | `src/components/agents/journey-r8.test.tsx` 1-2; `terminal-state-r7.test.tsx` now asserts the phrase appears once |
| C-2 | The card's top line repeated the pause as "Paused: usman is taking control ..." (the reader by id, third person) above the notice | the pause line is left out while the take-over notice is shown (other running cards keep their newest step) | `journey-r8.test.tsx` 1-2 |
| C-3 | The side panel added the same take-over notice a third time under its own "You have the controls" | `PanelContext heldByPerson`: no take-over notice while a person holds the computer; other blockers still shown; `Recovery.kind` added | `journey-r8.test.tsx` 3 |
| C-4 | Panel and header named the paused job by the bot's id: "research's job is paused" | `computerPanel({ agentName })`, `ComputerTab botId`, `status.ts agentName()` (this bot, a bot sharing the computer, else capitalised) | `journey-r8.test.tsx` 4 |
| C-5 | Header said plain "Ready" while the panel beside it said the computer's screen was not working | still `ready` (work without a screen runs) but warn: "Ready, but its computer's screen isn't working. Show computer to fix it"; the rail says "Ready, screen not working" | `journey-r8.test.tsx` 5 |
| C-6 | The viewer said "It reconnects when you reopen the preview" while it was reconnecting by itself, and again once it had given up and showed Reconnect | `viewerStatusText({ retrying })`: "Reconnecting by itself…" / "didn't come back. Press Reconnect"; diagnosed layers keep their sentence; older callers unchanged | `journey-r8.test.tsx` 6 |

Acceptance tooling (the runner could not drive a later round's hub as shipped):

| # | Defect | Fix | Test |
|---|---|---|---|
| R-1 | `run-all.ts` never forwarded `--out`: journeys wrote to the default folder and every tally read back null | forwards `--hub --data --out --repo --restore-port` (`hub-env.ts forwardArgs`) | `scripts/acceptance/r7/hub-env.test.ts` |
| R-2 | journeys J and L restarted the DEFAULT hub (8128, `D:\AgenticOS-r7-data\h`), not their own; G read the seed marker from the default folder | `hubArgs()` (port, data, served tree) on every hub.ts call; G uses `DATA` | `hub-env.test.ts` |
| R-3 | `hub.ts` refused any data folder outside `AgenticOS-r7-data`, could only serve its own tree, did not set `MU_SYNTHETIC_HUB=1`, passed no computer host, and `start` opened the owner browser on 8128 whatever `--port` said | `--repo` (serve a frozen candidate), `AgenticOS-r<N>-data`, `MU_SYNTHETIC_HUB=1`, `--host local-wsl` seeding and `--computers-home` / `--display-base` (only `MU_COMPUTERS_*` names from `gate-host.json`; a shared or Git-Bash-mangled folder is refused), owner browser on the right port | `hub-env.test.ts` |
| R-4 | journey B failed on a box that is MEANT to be off (audit-1: a bot with no usable computer has its box off) | records that honest state as a check and continues with Builder | re-run: 14 PASS |
| R-5 | new `journey-c-computer.ts` | the WSL journey above, re-runnable (`--only`, `--computers-home`, `--display`) | itself |

## 4. Second round (lead's go-ahead, after merging `r8/next-20261003` @ `38b7a0df`)

| # | Defect | Cause and fix | Test |
|---|---|---|---|
| C-7 | A navigation click within about 450 ms of the previous one was ignored (seen as "a click right after arriving on `/automations`"; the routes-sweep FAIL pair) | Not Automations: the sidebar's double-click guard (`src/components/shell/double-click.ts`, added after `e8d04d69` in `a6ae67d2`, audit S2) ignored ANY second link click inside 450 ms. It now ignores only the second click of a real double-click (`event.detail >= 2`, the browser's own click count); a deliberate single click (detail 1) and a link opened from the keyboard (detail 0) always go through. A real double-click on Work, Memory and Finance still lands once on that destination (checked in the browser) | `src/components/shell/double-click.test.ts`; routes sweep on this branch **344 PASS · 0 FAIL** (`scripts/acceptance/r7/results/r8-c-branch/results-routes-sweep.json`) |
| C-8 | The step history said "Paused: usman is taking control of the computer" to Usman himself | `threads.ts`: `pausedHolder(step)` reads who from the step; `pauseLine(holder, reader)`: "Paused: you took the controls of the computer. The job waits until you return them." for the conversation's owner, "Paused: Mehroz took the controls ... until they hand them back." otherwise; the blocker no longer parses the worded line | `scripts/jarvis-command/pause-line-r8.test.ts`; research-loop, continuity-r6 and research-loop e2e updated |
| C-9 | The Computers page said "research's job is paused" / "Paused: research's job is waiting" | `computerSummary(..., agentName)` and `doingText(c, agentName)`: the bot's name from the bots list, else the id capitalised (`agentDisplay`) | `src/components/agents/journey-r8b.test.tsx` |
| C-10 | The Stop question said "Stop this computer?" for about 2 s after a job started from outside the page | busy (or a paused job) with no named job: "Stop this computer and what's running on it?"; opening the confirmation re-reads the computers so the job's name follows | `journey-r8b.test.tsx` |
| C-11 | `Badge` dropped `data-testid` (the Computer tab's `computer-state` chip was never in the DOM) | forwarded | `journey-r8b.test.tsx` |
* `scripts/ui-round2.test.tsx` "round 3: coding job summary" fails at this branch's base `74ace895` and passes on `3bc6f9e0` (the candidate's gate
  fixes changed the test); untouched by this branch, and no file this branch changes was changed between `74ace895` and `3bc6f9e0`.

## 5. Still needs the lead (real host and installed desktop)

* RYZEN: the same journey on a Ryzen bot computer (`research` / `builder` over `ryzen-bots`): takeover, Return, Stop, viewer reconnect over Tailscale,
  and the recovery restart under the server role.
* RYZEN: the other founder (Mehroz) cannot take over or send input while Usman holds the controls (needs his identity); a second founder reads the
  bot's saved result.
* RYZEN: ISO-2 (a shared bot computer by name and by id), ISO-1/3/4 and the run-as user isolation proof.
* HW: the installed Tauri desktop shell opening the agents workspace, the viewer inside WebView2 (keyboard and mouse through noVNC, Escape out of the
  full-screen computer), and the viewer reconnect after the app window is closed.
* F: a real coding job on a pinned account and model (receipts, reviewer, apply approval, limit fallback); this branch only checked that the bot's
  model preference and computer assignment stay pinned after a reload.

## 6. Checks run in this worktree

`bun test src/components/agents src/components/computers scripts/agents/continuity-r7.test.ts scripts/agents-workspace-shell.test.tsx
scripts/computers/lease.test.ts scripts/hermes/hermes-customise-ui.test.tsx scripts/computers-page-r3.test.tsx scripts/ui-round2.test.tsx
scripts/acceptance/r7/hub-env.test.ts`: 462 pass, 1 fail (the `ui-round2` coding-summary test, failing at the base and fixed on the candidate; section 4).
Second round, after the merge: `bun test src/components/agents src/components/computers src/components/shell scripts/computers-page-r3.test.tsx
scripts/agents-workspace-shell.test.tsx scripts/ui-round2.test.tsx` 435 pass, 0 fail; `bun test scripts/jarvis-command scripts/agents
scripts/computers/computers.test.ts` 557 pass, 0 fail; both typechecks clean. `bun run typecheck` and
`bun run typecheck:scripts` clean.
