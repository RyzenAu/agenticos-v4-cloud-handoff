# Round 7 acceptance: the 11 BLOCKED rows and 1 NOT RUN row, reconciled (3 Oct 2026)

Source rows: `scripts/acceptance/r7/results/candidate-e8d04d69/` on `r7/h-acceptance-20261003` (`9ef47f94`), synthetic hub, no computer host,
no owner accounts. Each row below links its replacement evidence with the exact commit and environment. **Environments are kept apart:**
"local WSL" = this PC's WSL `kali-linux` with a synthetic hub; "real accounts" = the owner's Claude Max 2 subscription on a disposable repo
with a synthetic hub on this PC; neither is the Ryzen production hub or the installed desktop app.

| Row | Replacement evidence | Commit | Environment | Status |
|---|---|---|---|---|
| D: screen-truth layers on a real computer | C's real-computer journey: blank detected, VNC killed and diagnosed, not restarted while held, display back in ~6 s; re-run after review: blank with a viewer stays blank, no hub restart (`R7-C-COMPUTERS.md` §journey, §6) | `7876c37d`, `bc910631` | local WSL `:41`, synthetic hub 8123 | **PASS (local WSL)**; Ryzen: owner/hardware |
| D: takeover pauses agent input | C's journey (paused at the safe point, 7.6 s) and the final-UI run (paused at the next boundary, "You have the controls") | `7876c37d`; `e8d04d69` (`f12d1864` evidence) | local WSL | **PASS (local WSL)** |
| D: release resumes the SAME job, no replay | C's journey (0.3 s, later steps ran once) and the final-UI run (same job finished all 5 steps) | `7876c37d`; `e8d04d69` | local WSL | **PASS (local WSL)** |
| D: Stop cancels real computer work, later steps never run | C's journey (cancelled in 544 ms, later step never ran, no leftover file) | `7876c37d` | local WSL | **PASS (local WSL)**; not re-run on `e8d04d69` |
| D: a program cannot take or use the lease | Unit/route tests (computers suite, `shared-session.test.ts`, takeover refusals) in the gate; no real-host run | `e8d04d69` gate | tests only | **Covered by tests; real-host OUTSTANDING** |
| E: change a bot's computer, reload, persisted | Unit tests (`bot-management.test.ts`, setup tests); no host with two computers | `e8d04d69` gate | tests only | **Covered by tests; real-host OUTSTANDING** |
| F: a small real job on the selected account and model | D's four real jobs (`20e9c2f8`, `0b0d6d47`, `98ec7520`, `ba30449b`): Claude Max 2, Sonnet 5.5 builds, Opus 5.5 reviews; requested = responding model in every receipt (`CODING-RELIABILITY-R7.md`, `evidence/r7-coding/`) | pre-review D commits (before `dcc2e50f`) | real accounts, disposable repo, synthetic hub 8124 | **PASS (pre-review code)**; not re-run on `e8d04d69` |
| F: receipts, reviewer independence, approval to apply | Same jobs: receipts per role; reviewer a different model; the merge approval was asked once and rejected while the hub was down, settled on start-up | pre-review D commits | real accounts | **PARTIAL**: approval was never answered live (needs the owner's spoken yes or Telegram code) |
| F: provider-limit recovery, Resume continues the same sessions | Synthetic tests only (fallback/pin tests); no real limit was hit | `e8d04d69` gate | tests only | **OUTSTANDING (real)** |
| F: no duplicate execution (double Start, hub restart mid-run) | `ba30449b` showed the timed-out check re-run once with one builder run; double-Start and restart-mid-run covered by tests only | pre-review D commits; gate | real accounts + tests | **PARTIAL** |
| ISO-2: both founders on a shared bot computer by name | Unit tests (shared results open for both founders, `shared-session.test.ts`); no second founder session on a real host | `e8d04d69` gate | tests only | **OUTSTANDING (owner: Mehroz's login)** |
| J (NOT RUN): a clock routine crossing 07:30 with the hub stopped, once | `scripts/triggers/engine.test.ts` (offline run-once policy); B's routine journey proved duplicate/restart once-only for event routines | `e8d04d69` gate | tests only | **NOT RUN (real clock)** |

**Not covered anywhere yet (owner/hardware):** the installed desktop app into the Ryzen hub; pairing in the real WebView over Tailscale (match code,
console code); Ryzen's real bot computers; a coding job from the live UI; a live merge approval; the physical microphone; Dot's cloud-browser gateway
checklist; Mehroz's PC and the Ryzen desktop isolation with process/filesystem evidence.
