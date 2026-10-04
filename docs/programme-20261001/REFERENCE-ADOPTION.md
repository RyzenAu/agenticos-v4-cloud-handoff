# Reference adoption (programme 1 Oct 2026)

One record for the owner's selected references. Columns: existing capability · reference component · intended improvement · integration point · evidence · decision (adopted / adapted / deferred / unnecessary). Sections by builder.

## BROWSER AND DESKTOP (Agent B: Cua Driver, agent-browser)


One table, adopt only with evidence. Agent B rows; other agents append theirs. Evidence files: `worker-evidence.md` (Part 4), `scripts/devices/cua-compare.ts`,
`scripts/devices/agent-browser-probe.ts`, `scripts/devices/real-goal-proof.ts journeys`.

**Pins.** Cua Driver: repo `trycua/cua`, release tag `cua-driver-rs-v0.31.0` (tag ref `5272e492d61b96caf08e3bf434d91126c1f3dccc`), asset
`cua-driver-rs-0.31.0-windows-x86_64.zip` sha256 `0c091deff7aa153e69f94c8a19039aaa62f34c9d0c86a23474fe3ea5c3d3b7d1`, run from a scratch folder on D: (not
the installer: its fixed paths are on C:). An older `cua-driver 0.28.2` was already installed on this PC (Sep 18) with a daemon running; it was not touched.
agent-browser: `vercel-labs/agent-browser`, installed **0.37.1**, latest on npm **0.38.1** (0.38.1 also unpacked to D: scratch for the probe only).
**Licences of the exact components.** Cua Driver 0.31.0: MIT (`LICENSE` inside the zip, "Copyright (c) 2025 Cua AI, Inc."). agent-browser 0.37.1 and 0.38.1: Apache-2.0
(`package.json`). Nothing from either was copied into this repo; Cua is only ever run as a separate program.

| # | Existing capability | Reference component | Intended improvement | Integration point | Evidence | Decision |
|---|---|---|---|---|---|---|
| 1 | Platform | Cua `platform-support` page | Does it run on Windows desktops at all? | (gate before any work) | Page: Windows "Supported" (UIA, native input, window messages; Electron/Tauri/WPF/WinUI 3/WebView2 covered); elevated-integrity boundaries unproven. Ran for real on this PC. | Proceeded |
| 2 | Open/launch an app with a verified window (`app.open`, 1.4-1.5 s, new window appeared, handle read back) | Cua `launch_app` | Launch without stealing focus | `scripts/executors/windows.ts` | Notepad: Cua 7.1-11.5 s (vs 1.4-1.5 s), reported `active:false` yet Notepad was the foreground window afterwards; result has a window id but no post-action check | Unnecessary (slower; no check) |
| 3 | Exact window targeting (EnumWindows handles; `app.focus` reads back process and handle) | Cua `list_windows` + `window_id`/`pid` | Address one exact window | `target.focus`/`app.focus` | Same 9 Notepad windows listed by both, identical ids; Cua 117-153 ms | Unnecessary (parity) |
| 4 | Type into Notepad (`notepad.type`: new empty tab, UIA read-back exact, ~2.8 s, takes the foreground by design) | Cua `type_text`/`set_value` with `element_token` (UIA ValuePattern, background) | Type without moving focus | companion executor interface | Worked: 1.1 s, read-back matched exactly, foreground unchanged. But it needs a per-call `session` label and a fresh snapshot (a stale token is refused), `hotkey ctrl+t` cannot be delivered to modern XAML Notepad in the background (so no new-tab), and `verify_state` answered `unknown (untrusted_source)` | **Deferred.** The only concrete gain is background typing; ours is verified and fast enough. Revisit if a task must not steal focus |
| 5 | Structured failures (`{ok, verified, said, data:{refused,...}}`) | Cua refusals: `{code, effect:"refused", candidates}` e.g. `window_target_not_found`, `stale_element_token`, `browser_tab_not_found` | Machine-readable reason | `ExecutorResult.data` | Observed on real calls | **Adapted:** `data.recovery` codes (`tab-closed`, `tab-not-active`) added to our results (round 4) |
| 6 | Observation freshness (`editorText`, 12-24 ms) | Cua `get_window_state` (`capture_id` per capture, stale-token refusal) | Know an observation is current | - | 370-430 ms per capture vs 12-24 ms; the stale-token refusal is a real safety property | Unnecessary (ours is read immediately before use) |
| 7 | Background vs foreground | Cua `delivery_mode` background-first, explicit escalation | Never foreground without a signal | - | Honoured for UIA paths; hotkeys on XAML fail rather than escalate | Deferred (with #4) |
| 8 | Browser tab targeting (agent-browser via CDP) | Cua `browser_prepare`/`get_browser_state`/`browser_navigate` ("exactly-bound tab") | Exact tab binding | `browser.navigate` | Works: navigating with an unknown `tab_id` returns `browser_tab_not_found` (status refused). It launches a driver-owned Chromium with its profile under `%LOCALAPPDATA%\CuaDriver` on C: regardless of the home override (60 MB, removed) | **Adapted (idea only):** strict binding done on agent-browser (row 12) |
| 9 | Screen loop (`screen.goal`: Jev-first, observe, decide, act, verify) | Cua "Jev use" recipe: observe, candidates, Jev choose/delegate, execute, re-observe, verify | Same pattern on Cua's tools | `scripts/screen-hands/**`, `jev-command.ts` | Our loop already is this recipe (Jev picks; code gates; re-read and verify). Cua's tool list would be another executor behind it, not a new loop | Unnecessary as a rewrite; pattern already present |
| 10 | Install footprint | Cua installer | Install without system changes | - | Installer: fixed dirs on C:, User PATH edit, autostart scheduled task (RunLevel Highest) by default; telemetry on by default (disabled here with env). Avoided by running the zip from D: | **Overall: deferred** (a second daemon + per-machine install for one optional gain) |
| 11 | agent-browser version | `agent-browser` 0.37.1 installed vs 0.38.1 latest | Stay current | `scripts/j2/agent-browser.ts` | Both run the same probe with the same outcomes; 0.38.1 only rewords the closed-tab error (`label` for `id`). Our code matches nothing in that text | **Deferred** (no reason to upgrade globally; pin 0.37.1; 0.38.1 verified compatible) |
| 12 | Strict tab binding | agent-browser `tab <id>` (refuses a closed id) | An operation on tab X must not act on a neighbour | `scripts/executors/desktop.ts` (`browser.navigate {tabId}`, `target.focus`) | Probe: `tab <closed id>` fails cleanly, but a following `open` navigates the neighbouring tab (example.org became example.net) in BOTH versions, so the guard has to be ours | **Adopted:** id is that tab or nothing; closed gives `data.recovery:"tab-closed"`, "That tab was closed"; the target is forgotten; tests + real journey |
| 13 | Sessions and persistent profiles per bot/computer | agent-browser `--session`; our Chrome `--user-data-dir` | One session and one profile per companion, outside source, never logged | `companion/config.ts`, `main.ts`, `liveBrowserDeps` | Session `companion-<deviceId>` (real `session list` shows it); `browser.profileDir` must be absolute and outside the checkout (else dropped); the profile path is never printed. The default profile stays "Jarvis Chrome" (existing logins) | **Adopted** |


## VOICE (Agent G; LiveKit Agents `d251b89`, Apache-2.0; patterns only)

| Existing capability | Reference component | Intended improvement | Integration point | Evidence | Decision |
|---|---|---|---|---|---|
| Fixed 800 ms VAD end | min/max endpointing delay | 650 ms floor plus transcript-aware hold (filler, connector, comma), 2.6 s cap | `src/lib/voice-turns.ts` `endpointHoldMs`; `free-voice-client.ts` | `scripts/voice-turns.test.ts`; client test "pause after a trailing and" | Adopted (synthetic; owner mic test owed) |
| None | Turn-detector model | Audio+text end-of-turn model | n/a | n/a | Not adopted: new dependency, no real-speech evidence yet; heuristic used |
| Continuation lost the first half | Continue after false end of turn | Unsubmitted utterance merges into the next | `handleCaptureFrame` "end", `handleUtterance` | client merge test; mutation check fails without it | Adopted |
| Interrupt killed reply and running job at 350 ms | Interruption min duration | Pause at barge-in start, cancel speech and queued TTS at 500 ms voiced; task untouched | `pauseSpeech`, `confirmInterruption`, `stopSpeech` | client interruption test (pause by 300 ms, cancel by 0.9 s) | Adopted |
| None | False-interruption resume | Noise/echo/blip resumes playback in place (AudioContext suspend/resume), 2 s window | `resumeSpeech` | three client tests | Adopted (real Chrome suspend feel owed) |
| Reflex (act while speaking) | Preemptive generation | Speculative brain call | n/a | n/a | Not extended: double model spend, side-effect risk; reflex stays |
| Mic never recovered | Session resilience | Reconnect after ended track / mute / devicechange, bounded, no new session | `createMicReconnector` | 5 pure + 4 client tests | Adopted (physical unplug owed) |
| Bare stop dropped; talking killed jobs | (own design) | Stop speech vs stop task vs ask "Stop the task too?" | `classifyStop`, `cancelTask` via existing abort path | pure + 6 client tests | Adopted |
| No brain-path duplicate guard | (own design) | Same words within 5 s = one command; command service dedupe stays authority | `createDuplicateGuard` | pure + 2 client tests | Adopted |

## SHARED CLOUD COMPUTERS (Agent F: OpenMausBot, Kasm images, noVNC, E2B Desktop)

Full reasoning and numbers: `COMPUTERS-REFERENCES.md` (this round), `OPENMAUSBOT-ADOPTION.md` (16 patterns), `COMPUTERS-ARCHITECTURE.md`, evidence in `COMPUTERS-EVIDENCE.md`.

**Pins.** noVNC `@novnc/novnc` **1.7.0** (exact in `package.json`; MPL-2.0; served by the hub from `node_modules`, never copied). Kasm: repo `kasmtech/workspaces-images` (MIT, Kasm Technologies Inc 2022), compared image `kasmweb/chrome:1.19.0@sha256:25389cc8eafa94981f7177bf2195f930bc1f761bedfe566b40f238154f33f965` (1,410,948,831 bytes compressed, updated 2026-06-11; Docker Hub API). E2B: SDK in `e2b-dev/E2B` `packages/desktop-js` and `packages/desktop-python` (the `e2b-dev/desktop` repo now holds the template and examples); Apache-2.0 per the repo page.

| # | Existing capability | Reference component | Intended improvement | Integration point | Evidence | Decision |
|---|---|---|---|---|---|---|
| F1 | One controller, takeover, return (our lease) | OpenMausBot `computer-control.ts`, `local-vm-lease.ts` | Refuse-not-queue, renewable fence | `scripts/computers/lease.ts` | `lease.test.ts` (9), `computers.test.ts` (25) | Adapted (idea; fencing epoch and safe-boundary pause added) |
| F2 | Our own viewer path (RFB filter on the hub WebSocket) | noVNC 1.7.0 client | Real desktop viewer in the Computers page | `/__computers/<name>/viewer`, `scripts/computers/novnc.ts` | `novnc.test.ts`: real Chrome, real noVNC, through the hub proxy to a fake RFB server: sees the frame, view-only until the lease, input lands only while held, stops on return | **Adopted** (npm dependency; control stays in our lease) |
| F3 | Our own Linux desktop (Xvfb + Chromium + x11vnc + our companion) vs a Kasm image | `kasmweb/chrome:1.19.0@sha256:2538...` | Less OS and browser maintenance | (comparison) | Documented only; Docker is not installed here, so no image was run | **Deferred** (keep ours; reasons and the audio/upload/download finding in COMPUTERS-REFERENCES.md) |
| F4 | Isolation and limits beyond a WSL distro | Docker container per computer (Kasm's model, OpenMausBot's hardened container) | cap-drop, no published ports, limits, volume per computer | `scripts/computers/docker.ts`, `deploy/computers/docker/Dockerfile` | `docker.test.ts` (6) against a fake docker CLI only; **not run** | Adapted (adapter built, unproven on real Docker) |
| F5 | Our own provisioning and persistence (WSL now, VPS later) | E2B Desktop Sandbox (hosted) | Managed desktops with memory-preserving pause | none | Doc-only assessment in COMPUTERS-REFERENCES.md; no account, no code | **Deferred** (third-party cloud, account and card, no Australian region information, about US$121 a month per always-on 2 vCPU / 4 GiB desktop) |

## ACCEPTANCE (Agent D; OSWorld `b138d348256078fa634fc3b73567a7337c793e6b`, Apache-2.0; idea only, nothing vendored)

Pin: `xlang-ai/OSWorld` main at `b138d348256078fa634fc3b73567a7337c793e6b` (14 Sep 2026, "mm_agents: recover code from replies truncated before the closing fence (#582)"), licence Apache-2.0 (GitHub metadata). Read: the design and one sample task file (`evaluation_examples/examples/libreoffice_impress/…json`: `instruction`, `config` setup steps, `evaluator` with `postconfig`, `func`, `expected`). No code, task, file cache or VM image was downloaded, installed or run.

| Existing capability | Reference component | Intended improvement | Integration point | Evidence | Decision |
|---|---|---|---|---|---|
| Drivers that print evidence (`real-local-proof.ts`, `computers/journey.ts`, `coding/live-smoke.ts`) and unit tests, each read by a person | Task = data: `instruction` + `config` (initial state) + `evaluator` that reads the OBSERVED result | One command that judges twelve outcomes from observed state, never from an agent's "done"; every result labelled by how real it was | `scripts/acceptance/` (`tasks.ts`, `evaluators.ts`, `probes.ts`, `run.ts`); results in `ACCEPTANCE-RESULTS.md/.json` | `evaluators.test.ts`: each evaluator fails a "said done, state wrong" observation; the run itself (see ACCEPTANCE-RESULTS.md) | **Adapted** (the task/evaluator shape, `postconfig`-style settle, expected-vs-observed comparison) |
| Clean machine per task | OSWorld VM snapshot reset (VMware/VirtualBox/cloud image) | Isolation between tasks | none | WSL distros and real processes here, not snapshots | **Not taken**: instead each task lists what it creates and cleanup removes only that (scratch folder, the hub and companion it started, the one presentation it opened by its unique title) |
| Agent actions | `pyautogui` action layer and model agents | Drive the desktop | none | our executors and agents already exist; the run only observes their results | **Not taken** |
| Pass/fail | Numeric score averaged over tasks | One number | none | a half-verified run should say what is missing | **Not taken**: pass / partial / fail / blocked / owed, each with the exact blocker |
| Task corpus and file cache | OSWorld tasks + Hugging Face files | Ready-made tasks | none | irrelevant to M&U work; not ours to redistribute | **Not taken**: synthetic M&U fixtures instead (`SYNTHETIC-ACCEPT-*`: a fake lead, a client note, a deck title) |

Licence note: Apache-2.0 would allow adaptation; nothing is copied, so no NOTICE text is carried. If any OSWorld file is ever vendored, keep its header and add the attribution.

## R5 reconciliation (2 Oct 2026)

Every row above was compared with the code on `af45e77`: see `ADOPTION-RECONCILIATION-R5.md`. Result: no row claims code that is absent. The test suites named for LiveKit (voice turns), OSWorld (acceptance evaluators), noVNC (viewer), the lease, the Docker adapter, agent-browser tab binding and the profile config all pass when run now. Evidence that cannot be re-run here (real Windows/Cua timings, real Chrome journeys, Docker, real x11vnc, owner microphone) is unchanged and still labelled as owed or earlier evidence. `BOARD.md` still lists OSWorld as "in progress"; the OSWorld work is in fact present (`scripts/acceptance/**`, `ACCEPTANCE-RESULTS.md`). OpenShell appears in `BOARD.md` as "adopt with NOTICE" but is **not** in `af45e77`; it lives on branch `prog/os-openshell-20261001` (`92d80569`, not merged).
