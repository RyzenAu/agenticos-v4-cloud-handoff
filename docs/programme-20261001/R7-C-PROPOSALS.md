# R7-C proposals (changes outside worker C's files; none made)

Worker C owns `scripts/computers/**`, `src/components/agents/computer/**`, `src/components/computers/**`, `src/lib/computers*.ts`. Each item below is a change someone else
should make. Evidence: `R7-C-COMPUTERS.md`.

## A: workspace / layout (`src/components/agents/workspace/**`, `workspace-parts.tsx`, `src/lib/agent-workspace.ts`)

1. **Headline still says "ready for work"** over a computer whose screen is down. `computerSummary` (`src/lib/agent-workspace.ts`) builds it from `state` alone; the Computers page now
   overrides it with `screenFailing(c)` (`@/lib/computers-client`), the workspace should do the same: use `c.usable === false` or `screenFailing(c)` and say "online, but its screen isn't ready".
2. `workspace-parts.tsx:44` (`idle = c.state === "online" && c.controller.kind === null`) and `AssignForm` offer work on a computer whose screen is down. Use `usable`
   (the Computers page already withholds "Assign work" when `screenFailing(c)`).
3. `STATE_WORD[c.state]` is used directly in several places; use `stateChip(c).word` so an online computer with a failing screen is never plain "Online".
4. Fixtures (`setup-fixtures.ts`, `chat-computer-layout.test.tsx`) have no `screen`/`usable`; they still type-check (both are optional) but should add them so tests cover the new states.

## B: chat / agents service (`scripts/agents/**`)

1. **`readiness.ts` treats an unknown or online state as ready** (`case "online": default:`). Add: `online` and `c.usable === false` (or `c.screen.applicable && !c.screen.ok && !c.screen.checking`) is
   `offline`/`needs-you` with the screen's reason and next action (`c.screen.reason`, `c.screen.nextLabel`). `ComputerView` already carries both.
2. **Files are per person and per computer name** (`service.files`: `artifacts(personId)` and `a.computer !== bot.computer`). The other founder cannot see a result the bot produced for the first, and a
   bot reassigned to another computer loses its history from Files. Consider listing by the job's `bot` first (the job service already records it) and by owner or shared-ness second.
3. A second session of the SAME person shows "You have the controls" while input is refused (the lease is per person and session; the UI compares person ids). Expose "held by this session" in
   `/viewer-state` (it already returns `canControl`) and have the chat side panel read it.

## D: tasks (`src/components/agents/tasks/**`)

1. `tasks.ts` `computerTask`: `state === "finished" && !artifact` says "No saved result: it did its steps on the computer only." After this round a research result the hub could not keep is
   `partial` with the note "could not be kept as a saved result"; show that note (the job `note`) rather than the generic line. A Download link can use `?download=1` on
   `fileHref(id, name)` (`/__computers/artifacts/<id>/f/<file>?download=1`).

## Lead: identity / shared files

1. **A local program reads artifacts as the owner.** On a loopback hub a program (no session) passes `caller()` for GETs as `usman` (the loopback owner), so it can list and download Usman's saved results.
   Writes and control need a confirmed person, reads do not. This is the existing contract; stating it so nobody assumes artifacts are session-gated.
2. `scripts/jobs` quiet mode: `AGENTIC_OS_NO_BACKGROUND=1` makes the job store read-only, so a quiet verification hub can never start a computer job. The round-6 seed header says to start with it; a
   `MU_JOBS_OWNER=1`-style opt-in would let a verifier run jobs without turning every scheduler on.
3. The Ryzen computers run the bundle built at their last start. The browser-at-boot fix and the probe fix need a computer restart (Start, or a hub release) to reach them.
4. `docs/IDENTITY-ROUTES.md` / `scripts/identity/route-matrix.test.ts`: `GET /__computers/<name>/screen` and `POST .../screen-report` are new routes under the already-classified `/__computers` prefix; no matrix row needed, but please confirm.
