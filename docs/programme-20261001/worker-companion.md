# Companion worker: wire contract, desktop executors, autostart (Agent B, 1 Oct 2026)

Usman's PC becomes a companion like Mehroz's: it connects OUT to the hub, pairs with a code, and runs a short
allow-list of executors on its own desktop. The hub (a cloud VM) never acts on a screen itself.

Code: `companion/` (worker, ledger, executors, session, autostart scripts), `scripts/devices/` (dispatcher, service,
registry), `scripts/executors/` (windows.ts, desktop.ts), `scripts/jarvis-command/` (service.ts `remoteRun`).

## The wire command

Every command the hub hands a companion carries:

| field | meaning |
|---|---|
| `id` | the hub's record id |
| `jobId`, `stepId` | the Jarvis job and step it belongs to (absent for a one-off command) |
| `deviceId` | the device it is for (the companion checks nothing else is asked of it) |
| `commandKey` | idempotency key, unique per intended action: `<jobId>/<stepId>`, else `c:<id>` |
| `expiresAt` | hub clock, ms epoch (enqueue time + the step's timeout) |

Rules, each with a test:

- **Expired**: a companion refuses a command past `expiresAt`, judged on the HUB's clock (learned from the heartbeat's
  `serverTime`, so a wrong PC clock does not matter). The hub also never hands out an expired command (it fails
  "nothing ran"). `companion/wire.test.ts`, `scripts/devices/wire-contract.test.ts`.
- **Deduped by `commandKey`**: the same key is never run twice. A redelivery gets the recorded report re-sent, not a
  rerun. The ledger (`command-ledger.json` in the companion's config folder, mode 0600, 200 entries / 2 h) is written
  BEFORE the action starts.
- **Cancel**: a cancel stops a running step; a cancel that arrives first means the command never starts; a step that had
  already finished and verified when the cancel landed is reported as done (what happened), not hidden.
- **Device pinning**: the job pins its steps to the device it started on (`pinDeviceId`). If the person's target now
  resolves elsewhere, the step is refused ("device changed ... I did not move it") and nothing is queued anywhere.
  An offline pinned device fails "nothing ran"; it never falls back to another device or the hub.
- **Delivered then lost = uncertain**, never done and never "it didn't run". A command that was never delivered to an
  offline device is `notRun`. The dispatcher result carries `uncertain` / `notRun` / `observed`.
- **Lost ack = observe, not repeat.** If the wait runs out while the device is still online, the hub asks the companion
  "what happened to `<commandKey>`?" (`observe` item). The companion answers from its ledger via
  `POST /__devices/companion/observation`: `done` (with the result), `running`, `interrupted` (it was killed mid-step and
  restarted), `cancelled`, or `unknown` (no record: it never received it). The hub then adopts a verified `done`,
  treats `unknown` as "nothing ran", and calls silence, `running` and `interrupted` uncertain (asking a still-running step
  to stop). The action is never sent again.
- **Reconnect**: when a companion comes back, the hub asks about anything it was holding when it dropped and only
  annotates the record (`observed`). An uncertain step stays uncertain; nothing is replayed or moved.
- A result whose POST was lost is kept and re-sent on the next good heartbeat. The hub answers 409 if it already settled
  the command; the companion then stops sending it.

## What the hub knows about a companion

The heartbeat reports `version` (the running worker's own, `COMPANION_VERSION`), `capabilities` (its executors),
`interactive` (true unlocked desktop, false locked or at sign-in, null cannot tell; Windows: `LogonUI.exe` running means
locked) and `busy`/`micOwned`. `GET /__devices/devices` returns each device with `workerVersion`, `capabilities`,
`interactive`, `mine` (owner is the viewer) and the UI wording hook **`displayLabel`**: `"Offline"` when not online, else
`"This PC"` for the viewer's own device, else its label. While locked, desktop executors (`NEEDS_DESKTOP`) are refused
honestly; `echo`, `wait`, `notify` still run.

## Executors (all return an ExecutorResult whose `verified` is its own post-action check)

| executor | verification |
|---|---|
| `app.open` | a NEW window of the app appeared (existing) |
| `app.focus {name}` | launches if not running, focuses, then reads back that the app's window (process + handle) is the FOREGROUND window |
| `open-url` | default browser; verified only if a window shows the page's own title (existing) |
| `browser.navigate {url, where?, expectTitle?}` | new tab (or this one) in Jarvis Chrome through the existing agent-browser hands (same money/secret gates); confirms the tab is at that site with the page's REAL live title (not the address shown while loading; the tab list's title is stale), steady on two reads, and changed from before |
| `observe.window {app?}` | read-only: foreground process, handle and title (and a named app's windows). No screenshot is taken or kept. A bank or broker window's title is withheld |
| `screen.goal {goal}` / `{resume, yes}` | the SAME Jarvis entry + screen loop the PC hub runs, on this PC: sub-steps stream to the hub as job steps; done only with the loop own checks; a question comes back as `ask` data; a hub-approved yes resumes it on this device |
| `deck.blank` | PowerPoint COM read-back; an unlicensed Office is an honest failure (existing) |
| `file.open`, `notepad.type`, `echo`, `wait`, `notify` | unchanged |

`browser.navigate` needs `agent-browser` and Chrome. It drives "Jarvis Chrome" (a separate profile; port 9222 by default,
profile `%LOCALAPPDATA%\Jarvis Chrome`), starting it if nothing is listening. `companion.json` may set
`"browser": {"port": 9333, "profileDir": "D:\\..."}`.

## Jarvis instruction to job with steps

`CommandBody.steps` (route: `parseSteps`) is a typed plan for the requester's own companion: at most 6 steps, only
companion executors, each dispatched in order with `jobId`/`stepId`, checked before the next, and recorded as a job step.
A failed, unverified, cancelled or uncertain step ends the job; later steps are recorded as `skipped` and never
dispatched. One executor named in plain words ("open notepad") is the same thing with one step. A plan never runs on the
hub's own screen. Ending states: done `ok`; `outcome: "unverified"`; `stopped`; `outcome: "uncertain"` (job note
"... can't say whether it happened ...", the step outcome is `unknown`).

## Cloud role (`MU_HUB_ROLE=cloud`)

`createDevicesService` takes `hubRole` (default from `MU_HUB_ROLE`). In the cloud role the hub is **not a device**:
not listed, not online, not a target, not anyone's fallback. Usman's PC is his paired companion. "here" / "this pc"
resolves to the requester's own companion, or fails honestly ("device offline" / "no device registered for usman").
`createLiveCommandService` passes `hubDeviceId: ""` in that role so even a loopback-owner request at the server gets no
"hub screen". Default (`pc`) behaviour is unchanged. Test: `scripts/jarvis-command/remote-steps.test.ts`.

## Run at logon (per user, no admin)

```
powershell -NoProfile -ExecutionPolicy Bypass -File companion\install-autostart.ps1 -DryRun   # say what it would do
powershell -NoProfile -ExecutionPolicy Bypass -File companion\install-autostart.ps1            # do it
powershell -NoProfile -ExecutionPolicy Bypass -File companion\uninstall-autostart.ps1 [-Stop]
```

Pair first: `bun companion\main.ts pair --hub <url> --code <code>`. The installer writes two files, nothing machine-wide and
no scheduled task or service: `%LOCALAPPDATA%\mu-companion\run-companion.cmd` (restarts the companion after a crash;
stops for good on exit code 3, a revoked pairing; logs to `companion.log`, rotated at 1 MB) and
`<your Startup folder>\MU Companion.vbs` (starts that launcher hidden at your logon). It resolves the real `bun.exe`
(npm's `bun.cmd` shim cannot be started from a hidden launcher). `-ConfigDir`, `-StartupDir`, `-Repo`, `-Bun` override the
defaults (the tests point them at temp folders). The uninstaller removes those two files only; it never touches
`companion.json` (the pairing) or the ledger. `-Stop` also ends a running companion (launcher first).
Tests: `companion/autostart.test.ts`. **It has NOT been registered on this PC.**

## screen.goal (compound and open-ended goals)

See worker-evidence.md part 2. The hub sends a goal no typed executor names (or a compound one the rules refuse) to screen.goal when the device reports it; money, bank and secret goals are refused at the hub first. POST /__devices/companion/progress carries each sub-step (intent, executor, outcome, verification, ms), bounded at 300 per command and accepted only from the device the command went to while it is delivered. A question the loop asks puts the job in awaiting-approval; the hub redeems the person spoken yes on its own ledger before sending {resume, yes:true} to the same device; a typed yes never approves. Packaging for another PC: companion/build-exe.ts and docs/MEHROZ-ENROL.md.

## Not covered here

Reboot and real logon start; Mehroz's PC; Tailscale transport; the UI showing `displayLabel` (Agent C); the job service
ending such a job in state `unknown` rather than `failed` (see evidence file, recommendation).
