# Round 7, worker C: bot computers tell the truth (3 Oct 2026)

Worker C (Claude Sonnet 5.5), branch `r7/c-computers-20261003`, base `491b8ee0`. Scope: `scripts/computers/**`, `src/components/agents/computer/**`,
`src/components/computers/**`, `src/lib/computers*.ts`, plus two small files that belong to no other worker (`companion/linux/{cdp,main}.ts`,
`deploy/computers/linux/computer-ctl.sh`; flagged for the lead below). Proposals for other owners: `R7-C-PROPOSALS.md`.

## 1. Diagnosis: "online while its screen is disconnected or blank"

The boundaries, and what each really told the UI before this round:

| Boundary | What the hub knew | Defect found |
|---|---|---|
| Host (WSL / SSH) | `probe.hostUp` | not shown anywhere; an unreachable host read as "offline" only after the start-grace |
| Computer process | companion heartbeat | fine (this was the whole of "online") |
| Display (Xvfb), VNC server | `probe.displayAlive`, `probe.vncAlive` | used only to offer the live viewer; never to say the screen was not working |
| Browser | `probe.browserAlive` | **always false on a real host**: a computer's processes are recognised by an owner key in their environment, and a running Chromium rewrites `/proc/<pid>/environ` (its process title), so the probe could not see its own browser. Its memory figure also left the browser out (94 MB reported for a 521 MB computer) |
| Idle desktop | nothing | **the browser was only started by the first page step**, so a freshly started, "ready" desktop showed a black Xvfb: online, usable, and blank. This is the owner's observation, reproduced on a real local computer |
| Viewer transport (upgrade, RFB handshake, frames) | nothing | a refused upgrade, a failed handshake or a connected-but-silent stream all read "The screen disconnected. It reconnects when you reopen the preview."; the hub recorded nothing |
| Job state | the job service | see section 2 |

Also found by running it for real: the screen evidence from before a Stop/Start still counted afterwards (Online and "ready" half a second after Start), and an
automatic recovery (companion died) could restart a computer under a person or a job that held it.

### What changed

* `scripts/computers/screen.ts` (new, pure): `diagnoseScreen` names the failing layer (`host`, `computer`, `display`, `vnc`, `blank`, `viewer`, `frame`), the reason,
  when, and the next action (**Check host**, **Restart display**, **Reconnect**). A screen is **ready only with a recent real frame through the viewer or a screenshot that
  really came back (90 s), and every layer up**; a process existing is never readiness. A screenshot does not clear a viewer failure (it is a picture of the browser, not of
  what the viewer is shown); only a later real frame does. Viewer failures lapse after 120 s.
* `ComputerView.screen` and `.usable` (always sent by the hub; optional in the type so older payloads and fixtures still compile). `state` itself is unchanged (other
  surfaces and tests depend on it); `usable` is `up && screen ready`. `GET /__computers/<name>/screen` probes the layers and takes a real screenshot now (cached 2 s).
  `POST /<name>/screen-report` (a person only): what the viewer drew; an all-black frame, twice in a row, is a blank screen.
* Viewer transport diagnosed in `viewer.ts`: refused tunnel, failed handshake (with the gate's reason), no picture within 8 s of connecting (`frame`), a real frame counts
  as live while that viewer is open (`RfbGate.openBytes`). The viewer page samples its canvas, reports blank, and on disconnect asks the hub why.
* **Bounded automatic restarts** (`screenTick`): only a layer that was seen working and died (`display`, `vnc` after review; see section 6), at most 3 tries with growing pauses (20, 60, 180 s after round 1 review, see section 6), only
  with `autoRecover` on, and **never while a job or a person holds the computer** (also: a crashed companion is not restarted under a holder; manual Restart display is
  refused with who holds it unless forced). A layer that never worked is reported, not restarted in a loop. Evidence is cleared on stop/start/suspend/recover.
* Root fixes: the companion opens its browser at boot and a 15 s watchdog reopens it on a display computer (`keepBrowserOpen`; `ensureBrowser` is single-flight so the boot,
  the watchdog and the first page step cannot delete each other's profile locks); `computer-ctl.sh probe` finds the browser by its profile on the command line
  (`browser_pids`) and counts it in the resource figures.
* UI: the state chip never says plain "Online" for a computer whose screen is failing ("Online, screen blank", "Busy, screen unavailable", "Online, checking the screen"); the idle
  panel says "is online, but its screen isn't ready" with the sentence; Take over is not offered blind; **Restart display** is offered where Take over would be; a screen that a
  reconnect cannot fix (dead display, host down) is not retried in a loop but names its action; "connected, but blank" is its own state.

## 2. Results: saved output is reachable, openable, downloadable, and the job settles

| Path | Finding | Fix |
|---|---|---|
| Open | already correct: `GET /artifacts/<jobId>[/f/<file>]`, owner only, right type, sandboxed HTML | covered by a new test |
| **Download** | none existed (no `Content-Disposition`) | `?download=1` serves the file as a named attachment (header-safe file name), a Download link per file on the result page |
| **Never settles** | the conversation delivery after a workflow was awaited without a bound: a stuck conversation store left a finished job "working" and the computer's lease held | delivery is bounded (20 s, configurable) and a throw or a hang never fails or holds the job |
| **Success but not reachable** | research whose result the hub could not keep (`artifact` save failed or threw) was still called `complete` | it is now `partial` and says "could not be kept as a saved result" |
| Outside my files | see proposals: Files is per-person and per-computer-name; a headline in `lib/agent-workspace.ts` still says "ready for work" | proposed |

## 3. Control, on a REAL local test computer (this PC's WSL kali-linux, display :41 only, computer `r7c-alpha`, synthetic hub on 8123)

Hub: `D:\AgenticOS-r7-data\c` seeded with `seed-gate-hub.ts --host local-wsl`, cloud role, `HINDSIGHT_URL=off`, `MU_MEMORY_WRITES=off`, `MU_TRIGGERS=off`, own computers folder
(`~/mu-computers-r7c`), a disposable uncommitted Vite wrapper (`c-vite.config.ts`) that lets the computers and companion routes through the quiet-copy guard. **Not run with
`AGENTIC_OS_NO_BACKGROUND=1` after its first attempt**: in quiet mode the job store is read-only, so no job can start (found: "The job and approval stores aren't created yet");
the journey needs jobs, so the hub ran as the jobs owner (as `r6-hub.ps1` does), with the other switches above. Two confirmed browser sessions of the same person were used (agent-browser
confirmed with a one-time code made by the first).

| Check | Result |
|---|---|
| Create a local computer, live viewer shows its real desktop | **PASS** (`01-ready-after.png`: Chromium on `Xvfb :41` through noVNC, "Screen live"); |
| Blank screen detected (browser killed on a held computer) | **PASS** (`02-blank-after.png`: "Its screen isn't ready ... Next: Restart display"; before: "Screen live, you can act" over a black screen) |
| VNC server killed: disconnected, diagnosed, not restarted under the holder | **PASS** (`03-disconnected-after.png`: "Busy, screen unavailable"; no `screen-restart` while held) |
| After Return, the display is restarted automatically and comes back | **PASS** (`starting` then `online`, screen ready in about 6 s; the lease-free restart is attempt 1 of 3). `03b-disconnected-idle-after.png` is the idle moment before it |
| Takeover pauses the agent at a safe point | **PASS** (job: wait 10 s, write, write. Takeover `pending`; the wait finished (7.6 s later), "paused before step 2"; the working folder was empty) |
| The person's input works | **PASS** (`/input file.write person.txt`, written and read back, 42 bytes). Mouse and keyboard through noVNC itself were proven in round 3 and not re-driven this round |
| Return to agent resumes the same job | **PASS** (0.3 s; "re-reading the computer" first; `after1.txt`, `after2.txt` written once; job `succeeded`). `05-takeover-paused-after.png` |
| Stop cancels the actual work, later steps never run | **PASS** (job `cancelled` 544 ms after Stop; "step 2 file.write not run: it was stopped first"; `never.txt` absent 6 s later; computer offline; Start brings it back) `07-stopped-after.png` |
| A second controller cannot take over while one holds the lease | **PASS** with a second confirmed session of the same person: takeover 409, input 409, return 409, `intruder.txt` not written |
| The other founder (Mehroz) cannot take over | **BLOCKED on the real hub** (needs his Tailscale identity); proven on real HTTP and WebSocket in `viewer.test.ts` and `computers.test.ts` (unchanged and passing). `06-held-by-other-after.png` is the real card with the hub's controller rewritten to `mehroz` in the page (labelled; not a second person) |
| Personal desktops stay owner-only | **BLOCKED on the real hub** (no personal PC paired to a synthetic hub); the ownership tests in `computers.test.ts` and the identity matrix pass |
| A real workflow job's result is listed, opens and downloads | **PASS** (`bizprep` on `r7c-alpha`: `succeeded` in 7 s; listed with 3 files; markdown opens; `?download=1` is `attachment; filename="comparison.md"`; lease freed; seeded results also open: `08-result-opened-after.png`) |
| Recovering state screenshot | **not captured** (the state lasts about 2 s; `03b` shows the idle failing moment instead) |

Teardown: `r7c-alpha` destroyed through the API (owned cleanup); no process of the r7c home, no Xvfb `:41`-`:44`, no x11vnc; `~/mu-computers-r7c` and the probe test folders removed; hub (8123) stopped;
both browsers closed. No contact with Ryzen, 8081, production data or the production computers.

### "Before" screenshots

The old UI is the same code reading a payload without `screen` (an older hub): `02-blank-before.png` and `03-disconnected-before.png` apply exactly that (the page's `fetch` strips
`screen`/`usable` from `/__computers`). They show the defect: "Online / ready for work / Screen live, you can act" over a black screen, and "Online" over a dead viewer.

## 4. Regression tests (each fails without its fix)

| Boundary | Test |
|---|---|
| diagnosis, every layer, freshness, fault clearing, retry policy | `scripts/computers/screen.test.ts` (pure, 8) |
| through the real hub: not usable until a real screenshot; VNC, blank, host, frame failures; stale evidence after restart; viewer refused; real frame; no picture; failed handshake; blank report; bounded restarts; never under a person or job; manual restart refused while held | `screen.test.ts` (19) |
| the probe finds Chromium without the owner key (real WSL) | `scripts/computers/probe-browser.test.ts` |
| browser opened at boot and kept open | `companion/linux/keep-browser.test.ts` |
| download, type, identity gate, header safety, outlives the computer, job settles with a stuck or throwing conversation, unkept result is partial | `scripts/computers/results-r7.test.ts` (7) |
| UI: chip, panel, controls, viewer status, no retry loop against an unfixable layer | `src/components/agents/computer/screen-truth.test.ts` (15) |

Runs: `bun test scripts/computers src/components/agents/computer src/components/computers companion/linux` 323 pass, 0 fail; `scripts/l10-format.test.ts`, `scripts/os-shell.test.ts`, `scripts/computers-page-r3.test.tsx`,
`scripts/agents-workspace-shell.test.tsx`, `scripts/ui-round2.test.tsx` pass; `typecheck` and `typecheck:scripts` clean.

## 5. Files outside the owned paths (for the lead)

`companion/linux/cdp.ts`, `companion/linux/main.ts`, `companion/linux/keep-browser.test.ts`, `deploy/computers/linux/computer-ctl.sh`: no other worker owns them. The running Ryzen computers keep their
old bundle until a computer is started again (the bundle is rebuilt on first use after a hub start); the probe fix is in the script the hub reads at start, so it takes effect when the hub restarts.

## 6. Review round 1 (Opus, on 7876c37d): nine findings, all fixed

| # | Finding | Fix | Regression test |
|---|---|---|---|
| 1 HIGH | the "never restart under a holder" check covered every automatic `recover()`, so a crashed companion was not restarted while anyone held the computer (and never with a viewer renewing); a manual restart of a failed computer got 409 | the check moved to the SCREEN restart only; crash recovery is exactly as before; a FAILED computer is restarted by hand whoever holds it | `screen.test.ts`: crashed companion restarted under a person and under a renewing viewer; failed computer restarted by hand |
| 2 HIGH | the 15 s watchdog could miss a busy browser (800 ms), delete the Singleton locks and start a second Chromium on the profile; reopened a browser the person closed; ran during steps | before touching locks the pid in `SingletonLock` is read and a live one is waited for (never a second browser); the watchdog needs two misses at 3 s each, and is paused while a person holds the computer (the hub writes a `hold` marker in the computer's config folder through the new `hold` action, kept in step with the lease) and while any job step is in flight | `keep-browser.test.ts` (lock pid alive / dead / answers late; two misses; paused; holder taken mid-wait), `screen.test.ts` (companion told hold on/off) |
| 3 MED | a live viewer's frame hid a fresh blank report; a stale blank could drive a restart | a blank report is not cleared by a frame (a black screen is a frame): only by a drawn-picture report or by lapsing (30 s, re-reported while it lasts); the hub believes the second report only; the page needs two IDENTICAL near-black samples; blank never triggers an automatic restart; Xvfb starts with `-s 0` (no screensaver blanking) | `screen.test.ts` (pure and through the hub) |
| 4 MED | "Restart display" and the automatic restart did the full `recover()`; first try immediate; allowance reset after 60 s; shared the crash streak | only the display layers (`restartLayers`: `start` starts only what is not running; the companion and its browser are left alone), no crash recovery counted; first automatic try 20 s after the layer was first seen down; delays 20/60/180 s; allowance refills only after 10 minutes ready; at most 6 restarts a day; only `display` and `vnc` | `screen.test.ts` (calls: one `start`, no `stop`, no `recover`, `recoveries` 0; pure policy) |
| 5 MED | `state` stayed online during a screen restart so a job could take the computer | `starting` while a restart or recovery runs | `screen.test.ts` (job refused "starting, so nothing ran") |
| 6 | the page's blank check threw every 3 s before the first draw | `sample()` returns null and `check()` returns | covered by the page change (no browser harness) |
| 7 | RFC 5987 | `' ( ) *` escaped; the name is trimmed by characters before encoding | `results-r7.test.ts` |
| 8 | a late delivery contradicted the job's note | a late landing amends the note (state untouched); a delivery that never lands is retried once after 60 s (the conversation key makes it harmless) | `results-r7.test.ts` (late landing; one retry) |
| 9 | ERE metacharacters in the computers path | `+ ? ( ) { } | . [ ] * ^ $ \` escaped | `probe-browser.test.ts` (path with `+ ( ) \| .`) |

`Restart display` on a healthy computer with display or VNC down now restarts only those; a jarvis test that used it to bring up a new companion now uses stop and start.

### Re-run on the real local WSL computer (`r7c-alpha`, display :41, synthetic hub 8123)

| Case | Result |
|---|---|
| Takeover, the person closes the browser, the watchdog leaves it closed | **PASS**: `hold` marker present; browser killed; 50 s later (three watchdog intervals) still closed; no restart events; screen reads `blank`. After Return the marker is gone and the browser is reopened by the watchdog in about 46 s |
| Blank with a viewer open | **PASS**: the viewer reported black twice, the hub recorded `screen-fault blank` while the viewer's frames were fresh (age 3 ms) and the screen stayed `blank`, `usable` false; no hub restart (`recoveries` 0, no `screen-restart`); after Return the watchdog restored it, screen ready |
| Teardown | destroyed through the API; no process, Xvfb or x11vnc left; `~/mu-computers-r7c` removed; hub stopped; browser closed |

Not re-driven: the first automatic display restart after 20 s on the real host (covered by the harness tests; the 20 s wait is the same code path as the one run live in round 1 with a 5 s wait).

### Review round 2 (finding 2a): the hold marker can no longer be left behind

The hub treated "unknown" as "off", so after a hub restart (or a failed hold-off) the marker that pauses the browser watchdog could stay for ever. Now: the first sync per computer sends the actual state; a failed send is retried on later ticks (at most 5 times per state); the script's `start` and `stop` (so also a recovery) remove `cfg/hold` and the hub re-sends "on" if a person still holds it; and the companion clears a stale marker at boot. `recover` on a healthy computer restarting only the screen layers is documented in `COMPUTERS-ARCHITECTURE.md` section 10. Tests: hub restart, failed-off retry, bounded retries (`screen.test.ts`), boot clear (`keep-browser.test.ts`), marker written, cleared by off and by stop (`probe-browser.test.ts`, real WSL).

## 7. Follow-ups after merging `r7/candidate-20261003`

* **A shared bot's result opens for both founders.** `/__computers/artifacts/<id>` (page, `/f/<file>`, `?download=1`, and the `/artifacts` list) is allowed to a confirmed founder (loopback owner or paired session) when the job that made it has a `bot` (the job service records it). A personal, non-bot result stays its owner's; a bare Tailscale login, a gateway or a routine principal is refused; the path checks are unchanged. Tests: `shared-session.test.ts` (Mehroz opens Research's result; is refused Usman's personal one in every form; an unpaired browser is refused).
* **Second window of the same person.** `/viewer-state` returns `heldByThisSession` and `heldByYouElsewhere` (and `GET /__computers` rows carry them for a browser session). `control-state.ts` says "You have the controls in another window", offers **Take them here** (new `POST /:name/take-here`: only the person's OWN controls, a new epoch, an event `controls-moved`; the other founder, a free computer, an agent's computer and a program are refused) and hides Return to agent there. The chat status line (`workspace/status.ts`, A's) reads the same row field: one line changed.
* Found while running the identity suite: a viewer refusal failed with a 500 when the stub hub had no `screenFault`; recording why a viewer was refused can no longer change the answer (`viewer.ts`).

## 8. Audit items (candidate 253eaed5)

* **Add a shared computer (audit 2, S17).** With no host the Add control is one plain sentence (no heading, no isolation note, no form) that says how a computer is added; with a host it is the real form, unchanged. The empty state points at "Add a shared computer above" only when a host exists to add one on.
* **Reconnect (audit 1, F-06).** `reconnectComputer(computer | null, name)` in `computers-client.ts` always ends in a message: not on this hub (nothing is sent, says to pick one in Setup or add one in Computers); starting; online (checks the screen now and reports it); failed or stopped (runs the real start). The computer panel's Reconnect button now shows "Reconnecting…" and its outcome. **For A/B (not changed by me):** the chat banner's Reconnect (`chat/bot-chat.tsx`, `onReconnect` from the workspace shell) should call `reconnectComputer(computer, bot.computer)` and show its message, and not render for an archived bot or a bot with no computer.
* **Viewer height.** The live view is capped at the viewport height minus the panel's chrome (`max-h-[max(220px,min(78vh,calc(100dvh-21rem)))]`; the side panel uses 24rem), so it fits at 900 px tall without expanding the panel. Nothing needed from A.
* **Builder naming.** A model that answered `pricing-card` for a request that is not about pricing now gets the title's name, or one made from the request ("opening-hours"), and its class prefix follows (`componentName` in `workflows/builder.ts`).

Tests: `computers-page.test.ts` and `add-computer.test.tsx` (item 1), `reconnect.test.ts` (item 2), `builder-name.test.ts` (naming).
