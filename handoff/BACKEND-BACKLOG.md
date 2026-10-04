# Backend backlog

Two parts. Part 1 is a verbatim copy of `docs/programme-20261001/R11-BACKLOG.md` at `82d6962d`. Part 2 lists known
limitations from the round 10 and round 11 work, **as reported by the release lead on 4 October 2026**. Part 2 items were
not re-verified while packaging this handoff unless a code reference is given; check each against the code and the live
hub before acting on it.

## Part 1: R11 backlog (copied)

- Home: "Set it up", "Goals", "Calendar" and the audience "Link profile" links are 21–28 px tall (pass WCAG 2.2 AA 24 px, not the 44 px target); give them 44 px hit areas in business.tsx / audience components.
- Jarvis page: plain answers to typed requests aren't in the person's conversation, so they don't show on /jarvis (only the companion panel). Needs the companion (voice-companion.tsx, reliability's file) to note typed request + reply into the default thread, or broadcast its turns; the page already renders any user/oracle message in that thread.
- Companion: use the composer's `requestId` (already in the operator:voice-text detail, command-eventId shaped) as the command eventId in launchText → execute, so the identity holds end to end at the hub.
- `src/lib/deferred-overlays.tsx` duplicates shell/late.tsx's capture/replay and seems unused; delete or give it the same cancel (late:cancel-queued) support.
- Coding job page: "Computer: Not reported" row shows on every finished job with no device; hide when nothing was reported.
- Agents header: bot pills + New bot + Show archived + Recent work stack four rows above the bot name on tablet; fold New bot / Show archived into one menu.
- (reliability, staging flows 1–2) /jarvis: "Sent to Jarvis" local echoes from earlier failed sends (jarvis-sent.ts unshownSent) stay pinned at the bottom of the thread, below newer server-saved exchanges, after a reload; they should drop once the server has the request (by requestId) or sort by time.
- (reliability) Staging flows 3–5 need owner setup to run as specified: a long-running job type on a synthetic server hub (Research computer on a local WSL host, or the coding harness), a slow/keyed Jev to Stop "while routing", a second founder identity (Tailscale-only on a server hub), and a signed-in claude:max-2 CLI home for the synthetic hub (its CLI-home guard gives it empty homes).
- (reliability, final review) Stopped event ids are memory-only: a resend after a hub restart runs the command.
- (reliability, final review) Resume doesn't mark the coding job started (voice.ts resume replies carry no `started`), so a resumed job isn't linked as the conversation's running job.
- (reliability, final review) ownJob picks the newest coding job of the person even when it has finished while an older one is still running.
- (reliability, final review) Paused or queue-full companion leaves the /jarvis composer on "Still connecting" with Send disabled.
- (reliability, final review) /voice/free/turn retries carry no request id: a 504 after a server-side coding draft could make a second draft.
- (reliability, final review) appendMessage drops typed messages past 500 in a thread, and save() re-inserts typed messages the person deleted.
- (reliability, final review) A spoken "stop" handled by the server rules (not the jarvis_command tool) doesn't empty the companion's typed queue.
- (reliability, final review) With no recorded owner after a restart, the earliest linker of a job gets its report.

Items marked "(reliability …)" are backend items. The unmarked UI items (Home hit areas, the Agents header, the coding
job "Computer: Not reported" row, `src/lib/deferred-overlays.tsx`) belong to the frontend owner. The Jarvis page and
companion `requestId` items sit on the shared seam (`src/components/operator/voice-companion.tsx`).

## Part 2: known limitations (r10 and r11)

### Reliability

- **Stop before or during execution is not yet demonstrated on production.** The paths exist and are tested on synthetic
  hubs (`cancel { jobId }`, `cancel { eventId }`, Stop words; see `CONTRACTS.md`). Staging flows 3 to 5 in Part 1 need
  owner setup before they can run as specified. Until a production demonstration, treat "Stop reaches execution" as unproven.
- **Stopped event ids are memory-only.** `stoppedEvents` in `scripts/jarvis-command/service.ts` is a process map with a
  30-minute window, so a resend after a hub restart runs the command (also in Part 1).
- **The process that holds `conversations.json` on Ryzen is not identified.** Writes sometimes fail with EPERM and the
  route answers 503. A retry mitigates it; the cause is open. Find the holder (antivirus, indexer, backup, a second
  reader) before changing the store.
- **Restart-before-job dedupe gap.** Event-id idempotency reads the job store (`byRequest`), so it only protects a
  command whose job was created. A hub restart after the request arrived but before its job existed leaves nothing to
  dedupe against, and a resend runs.
- **`/voice/free/turn` retries carry no request id** (Part 1): a 504 after a server-side coding draft can make a second draft.

### Identity and pairing

- **Self-pair in the `pc` and `cloud` roles is not pending.** In the server role a browser that pairs with a bare
  Tailscale login is pending until a confirmed session approves it with the match code (`/sessions/approve` in
  `scripts/devices/service.ts`). The lead reports the other two roles do not hold a self-paired browser as pending.
  Decide whether they should.
- **Mehroz has no confirmed session.** Journeys that need the second founder's own session (acceptance rows 17 and 19 in
  the master brief) are not run.

### Coding

- **Registry commands that resolve to `.cmd` shims cannot be spawned.** On Windows an npm `.cmd` shim is not a spawnable
  executable. Registry commands must resolve to the real `.exe` or script; the registry does not do that yet.
- **The coding registry on Ryzen uses the `sourceepos` junction.** Paths in `<data>/coding/repos.json` go through a
  directory junction. Never delete recursively through it; resolve real paths before any clean-up.
- Part 1 also lists: Resume does not mark the job started; `ownJob` picks the newest coding job; with no recorded owner
  after a restart the earliest linker of a job gets its report.

### Bot computers

- **The terminal is a command log, not a full terminal.** `scripts/computers/terminal.ts` streams output chunks and
  records each Enter as a command for a lease holder. Do not present it as a general interactive terminal.
- **Shared WSL services are not isolated between bots.** Each bot has its own display, browser profile and folder inside
  one WSL distro; services in that distro are shared. Profile folders are not a security boundary between mutually
  untrusted workloads.
- **The companion ships without Playwright.** Browser actions on a companion use what `companion/executors.ts` and
  `companion/linux/*` provide (default browser, CDP); nothing that needs Playwright runs there.

### Business

- **Receptionist launch is on hold.** Do not change receptionist behaviour or launch it.
- **Outreach is unsent.** Drafts and meeting packs exist; nothing is sent without the owner's explicit authorisation.
  Recipient and identity gaps on some prospects remain flagged.
- **Pricing gaps are pending.** A missing price stays pending in quotes and invoices; never fill one in.

### Out of scope here

- The gateway lives on `gw/dot-gateway-20261002`, not on this branch.
- Payments code from the old cloud branches is archive-only (`docs/programme-20261001/CLOUD-RECONCILIATION-R7.md` §2).
