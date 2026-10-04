# Round 9, ops: unattended operation of the Ryzen hub

Model `claude-opus-5-5`, 3 Oct 2026. Worktree `D:\AgenticOS-r9-ops`, branch `r9/ops-20261003`, base `fe283571`. Follows R8-F-OPS.md
(steps P4, P6 and P7).

**What was touched on Ryzen:** two read-only probe scripts and four read-only copies of this branch's scripts in `C:\mu-hub\ops-check\`
(`probe-r9-1.ps1`, `probe-r9-2.ps1`, `probe-r9-3.ps1`, `r9\*.ps1`), run once each between 18:37 and 19:30 AEST. Nothing was installed, registered, started,
stopped or restarted; no file outside `ops-check` was written; git was read with `--no-optional-locks`. `hub.env` was checked for existence
only (by `Install-MuHub.ps1 -WhatIf`, `Test-Path`); `devices.json` and every secret file were never opened (size and date only). No message
was sent. Evidence: `docs/programme-20261001/evidence/r9-ops/` (`probe-r9-1`, `probe-r9-2`, `probe-r9-3`: `.ps1` and `.out`).

## Verdict

| # | Outcome | State |
|---|---|---|
| 1 | Hindsight starts on boot and is restarted if it dies | **Built, not installed.** `Install-MuHindsightTask.ps1` replaces the never-run `\Hindsight\Hindsight pilot supervisor` with a boot trigger plus a 5-minute watchdog. |
| 2 | Every dependency's health visible in one place | **Built, not installed.** `\MU\MU Health Check` (every 5 min) writes facts; `/__health` gains a `host` component; System lists every service in plain words. |
| 3 | Failures alert | **Built, not installed.** Page (Home and System), Windows Event Log (source `MU Hub`), owner's Telegram through the existing `hermes send` path, deduped, switchable. |
| 4 | Reboot verification procedure | **Prepared, not run.** `verify-after-reboot.ps1` (`-Snapshot` before, check after) and the runbook below. |
| 5 | P4 command | **Prepared.** Below. It does not restart the hub. |

## 1. Hindsight on boot

**Why the current task can't be trusted.** `\Hindsight\Hindsight pilot supervisor` (S4U, `wscript.exe "D:\hindsight\service\hindsight.vbs" pilot`,
boot trigger only) shows last result `0x41303` "has not run" because it was registered on 2 Oct, after the last boot (1 Oct 20:20). The running
supervisor (pids 18632 -> 21292, session 0, started 2 Oct 17:59:52, parent 8716 = the WMI launch) was started by hand. Even after a reboot the old
task would start it once: `wscript` exits at once, so Task Scheduler forgets it, and no "restart on failure" or repeat brings it back if it exits.

**The new definition** (`deploy/windows/Install-MuHindsightTask.ps1`, same folder, name, account and logon type):

| | |
|---|---|
| Action | `D:\hindsight\venv\Scripts\python.exe "D:\hindsight\service\supervisor.py" run --profile pilot` (cwd `D:\hindsight\service`). Python directly, so the task stays **Running** while the supervisor runs and the reboot check can prove the supervisor came from the task. The supervisor allocates its own hidden console for CTRL_BREAK. |
| Triggers | at startup +30 s (Postgres is started by the supervisor itself; the hub follows at +45 s and queues memory saves until Hindsight answers) and a repeating trigger every 5 min |
| Settings | one instance at a time, no time limit, no restart-on-failure (the repeat is the watchdog), hidden, runs on battery, start when available |
| Account | the hub's account, S4U, limited. SYSTEM is refused: the proxy accepts memory writes only from `bun.exe` on 127.0.0.1:8081 under the same account |

Why a 5-minute repeat is safe, from `scripts/hindsight/supervisor.py`:
- A supervisor already running holds two named mutexes (`Local\MU-Hindsight-Supervisor-port8888` and `-db-<hash>`); a second one prints
  "already running" and exits 0 (`EXIT_ALREADY = 0`). The hand-started supervisor and an S4U task both run in session 0 (probe 1), where `Local\`
  is one namespace, so they do collide as intended.
- After its own restart bound the supervisor writes `run\pilot\crashloop.lock` and `ALERT.json` and exits 3; every later start refuses (exit 3)
  until a person runs `supervisor.py clear-alert`. The installer never passes `--clear-alert`. A crash loop therefore costs one quick refused
  start every 5 minutes, and the health check raises "Memory (Hindsight) is down" at once.

Operating notes (also in the script's help):
- **Stop and status only over ssh, or by disabling the task; never from a window on Ryzen's desktop.** The supervisor's mutexes and its stop
  event are `Local\` names, and `Local\` is per Windows session. The task (and today's hand-started supervisor) runs in **session 0**; an ssh
  login is also session 0, but a desktop PowerShell window is session 1. From the desktop, `supervisor.py status` cannot see the mutex and says
  nothing is running, `supervisor.py stop` signals a stop event nobody listens to, and `supervisor.py run` (or `hindsight.vbs`) starts a
  **second** supervisor that does not collide with the first and fights it for ports 8888/8878/5432. (`hindsightctl.ps1 start` is the
  exception: it launches through WMI, which lands in session 0.)
  Over ssh: `D:\hindsight\venv\Scripts\python.exe D:\hindsight\service\supervisor.py status --profile pilot` / `... stop --profile pilot`.
  Without ssh: `Disable-ScheduledTask -TaskPath '\Hindsight\' -TaskName 'Hindsight pilot supervisor'` stops the watchdog from restarting it.
- Never stop it by ending the task: that kills the supervisor without its proxy -> API -> Postgres shutdown. To keep it down, disable the
  task first, then `stop` over ssh.

## 2. Dependency health in one place

`deploy/windows/mu-health-check.ps1` gathers the facts only Windows can see, read-only and bounded (5 s per probe, 20 s for `wsl -l`):

| Fact | Source |
|---|---|
| hub | `127.0.0.1:8081/__version` answers; the supervisor log has `GIVING UP` after its last `supervisor started`; `\MU\MU Hub Supervisor` state |
| Hindsight | `8888/health` and proxy `8878/health` (200); `run\pilot\status.json` state; `crashloop.lock`; the `\Hindsight\` task state |
| SearXNG, Hermes | `18888/healthz`, `8642/health` (200) |
| WSL | `wsl.exe -l --running` lists `kali-linux`; `\MU\MU WSL KeepAlive` state |
| Dot's staging | `8096/` and `8086/__version` answer (report only: never an alert) |
| backup | `C:\mu-hub\logs\last-backup.json`: ok, verified, age, error line |
| disks | free GB and % on C: and D: |
| sign-in records | `devices.json` opens and is a sign-in record (the same check the supervisor makes; contents never kept or printed) |

It writes `C:\mu-hub\data\production\ops\host-health.json`. Words, conditions and thresholds live in one TypeScript module,
`scripts/ops/host-health.ts`, used by `/__health`, the page, the Event Log text and the Telegram text:

- **`/__health` -> `components.host`**: the plain checks, the active alerts, when it last ran and whether Telegram is on. Status `ok`, or
  `degraded` for an active alert or a report older than 15 minutes; never `failed` (the hub itself works). On a PC hub (no report) it says the
  check isn't set up there and stays `ok`. `/__health` is READ_SHARED, so any signed-in founder sees it.
- **System page**: a "Hub computer (RYZEN-PC)" card listing each service with a dot and one plain line, e.g. "Memory (Hindsight): Answering on
  port 8888." / "Last backup: Verified, 0.2 h ago." / "Dot's staging gateway: Report only: ...".
- **Home and System**: a danger notice per active alert in **plain words only** ("Hub computer: The hub supervisor gave up. The hub stopped
  restarting itself after repeated failures. Someone needs to check the hub computer and start it again. Since ... The steps to fix it went to
  the owner's Telegram."), one line if the report is stale, and one line "the health report can't be read" if `host-health.json` is corrupt.
  No Windows paths, task commands, script or document names appear on the pages (tested); those stay in the Event Log and Telegram text, where
  the person fixing it needs them. Nothing shows when all is well.

Not duplicated: the hub's own dependency monitor (`scripts/ops/dependencies.ts`, SearXNG, Hindsight, companions, model routes) stays as it is;
the host check adds what the hub cannot see about itself (it can't report its own death or a supervisor give-up).

## 3. Alerts: what goes where

| Condition | When it alerts |
|---|---|
| Hub supervisor gave up (6 failures in 10 min) | at once (the log line after the last start) |
| Hub not answering on 8081 | after 10 min (covers a task that never started; a normal restart takes under 2 min) |
| Hindsight down (8888 not answering) | after 10 min; a crash-loop lock at once |
| Backup failed, not verified, missing, or newest older than 26 h | at once |
| Disk C: or D: below 10% or 20 GB free | at once; clears only above 12% **and** 25 GB (margin, so free space hovering at the limit doesn't flap) |
| Sign-in records unreadable | at once |

Each condition alerts **once** and reminds **every 6 hours** while it lasts. Once alerted it must be absent for **3 runs in a row** (15
minutes) before one **resolved**; if it comes back inside that window it is the same alert, not a new one (tested with a disk and a backup
flapping). One that clears inside its 10-minute grace says nothing. State: `C:\mu-hub\data\production\ops\host-alerts.json`, saved before
sending. A corrupt or wrong-shape state file is cleaned rather than trusted: the worst case is one repeated alert, never a crash (tested).

| Channel | What | Off switch |
|---|---|---|
| (a) Page | Home and System notices for any signed-in founder; System card | none needed |
| (b) Windows Event Log | Application log, source `MU Hub`: 4101 alert (Error), 4102 reminder (Warning), 4103 resolved (Information), 4199 the evaluator itself failed (at most once per 6 h) | none |
| (c) Telegram | **one DM per run** with that run's events, to the **owner only** | the command line, on Ryzen from `C:\mu-hub\AgenticOS-v4`: `C:\mu-hub\bin\bun.exe --no-env-file scripts/ops/host-alerts.ts telegram off --data-dir C:\mu-hub\data\production` (`on` / `show` likewise). It writes `ops\alert-settings.json`, which the scheduled task reads. Putting `MU_OPS_ALERTS_TELEGRAM=off` in `hub.env` does **not** work: the health-check task never loads `hub.env` (the variable only affects a hand run). |

**A failed Telegram send is not retried.** The alert is recorded before sending, so a send that fails (Hermes down, network) is logged in
`mu-health-check.log` as `telegram: failed` and the next DM for that condition is its 6-hourly reminder. The Event Log entry and the page
notice are written regardless, so the alert is never lost, only the DM.

**The owner path used, and nothing new:** away mode's `hermesNotifier(() => ownerTelegram(root))` (`scripts/away-mode/notify.ts`): `hermes send
--to telegram:<id>` with the text on stdin, reusing the Hermes gateway's own credentials (this code reads no token). `<id>` is the people.json
person whose role says owner, else the existing default. `ownerTelegram` moved from `away-mode/service.ts` to `notify.ts` (re-exported, same
body) so the CLI need not load away mode. No recipient, number or channel was added; a test asserts the CLI has exactly one notifier and no
hard-coded chat id. On Ryzen `%LOCALAPPDATA%\hermes\bin\hermes.exe` and `C:\mu-hub\data\production\people.json` exist (probe 1, existence only).

## 4. Reboot verification (runbook; do not reboot without the owner)

`deploy/windows/verify-after-reboot.ps1`, read-only apart from its own baseline file. Exit code = number of FAILs.

1. **Before** (any time on the day): from `C:\mu-hub\AgenticOS-v4\deploy\windows` on Ryzen,
   `powershell -NoProfile -ExecutionPolicy Bypass -File .\verify-after-reboot.ps1 -Snapshot`
   -> `C:\mu-hub\ops-check\pre-reboot-baseline.json`: commit (tailnet `/__version` gitSha and HEAD), sign-in session **count**, `devices-secret`
   size and date, Hindsight writes switch, newest backups. Optional: run the `\MU\MU Hub Backup` task first so the baseline has a fresh backup.
2. **Tell the owner**, then reboot Ryzen (`Restart-Computer` from his session or ssh). Tailscale, sshd and the boot tasks need no logon.
3. **About 5 minutes after** it answers on ssh (the health check fires at +3 min, then every 5): `.\verify-after-reboot.ps1`. It checks:
   - each boot task ran after this boot; Hub Supervisor, WSL KeepAlive, SearXNG and Hindsight pilot supervisor are **Running**; Hermes Gateway,
     Vault Autocommit and Health Check ran with result 0; the backups' next runs are listed;
   - the hub supervisor and the Hindsight supervisor processes started after the boot with parent `svchost` (Task Scheduler), not by hand;
   - ports: 8081 `/__version`, 8888 and 8878 `/health` 200, 5432 listening, 18888 `/healthz`, 8642 `/health`; 8096/8086 reported only;
   - the tailnet `/__version` gitSha = checkout HEAD = baseline;
   - Hindsight `status.json` running, no crash-loop lock, writes switch unchanged;
   - last hub backup ok + verified + < 26 h; newest Hindsight dump < 26 h;
   - sessions now vs before (FAIL only if all were lost; fewer is INFO: some may have expired); `devices-secret` unchanged;
   - the health report was written since the boot; active alerts and `MU Hub` events since boot are listed.
4. **If something FAILs:** the hub: `Get-Content C:\mu-hub\logs\mu-hub-supervisor.log -Tail 40`, then `Start-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Supervisor'`.
   Hindsight, **over ssh** (session 0, see section 1): `D:\hindsight\venv\Scripts\python.exe D:\hindsight\service\supervisor.py status --profile pilot`; `Start-ScheduledTask -TaskPath '\Hindsight\' -TaskName 'Hindsight pilot supervisor'`.
   Hermes: `Start-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hermes Gateway'`. Dot's staging gateway has no task (P8): after a reboot its Funnel
   on 443 points at a dead port until Dot's lane starts it.

## 5. P4: re-register the `\MU\` tasks with `-HubRole server`

Exact command, from an **elevated** PowerShell on Ryzen as `mkhan`, after this branch is on Ryzen (the checkout must contain
`deploy\windows\mu-health-check.ps1`; probe 2 shows `-WhatIf` reporting it missing today):

```powershell
cd C:\mu-hub\AgenticOS-v4\deploy\windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MuHub.ps1 -HubRole server -EnvFile C:\mu-hub\config\hub.env -SearxngWslUser searx -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MuHub.ps1 -HubRole server -EnvFile C:\mu-hub\config\hub.env -SearxngWslUser searx
```

`-SearxngWslUser searx` is needed: the live `MU SearXNG` task has `-WslUser searx` (probe 1). The installer now guards this: before
re-registering it compares each planned task's arguments with the live task's and **refuses** (a PROBLEM in `-WhatIf`, an error in a real
run) when a live `-WslUser`, `-HubRole` or `-EnvFile` would be dropped or changed, unless `-Force` is given. Probe 3 ran both lines on Ryzen
with `-WhatIf`: the P4 line raises no such problem; the bare line is refused for `-HubRole server`, `-EnvFile` and `-WslUser searx`.
Everything else is the installer's default and matches the live tasks. Probe 2 ran the `-WhatIf` on Ryzen: the five planned actions match the
live ones except the intended changes (backup gains `-HubRole server`; `MU Health Check` is new).

**Does it restart the hub?** No. Without `-StartNow` the installer only calls `Register-ScheduledTask -Force`, which updates the definitions;
a running instance (the supervisor, the keep-alive, SearXNG) keeps running under its old definition until it next starts. The new backup
arguments apply from the next 03:15 (04:15 after daylight saving) run. Check afterwards that the supervisor pid is unchanged
(`Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ? CommandLine -match 'mu-hub-supervisor' | select ProcessId, CreationDate`).
It leaves `MU Hermes Gateway` and `MU Vault Autocommit` alone (not in its plan) and registers the Event Log source `MU Hub`.

## Install steps for the lead (next release window)

1. Release this branch to Ryzen with the usual `release.ps1` (that restart is the release's, not these steps'). It brings the `/__health`
   `host` component, the page notices and the scripts.
2. Telegram off for the first run: `cd C:\mu-hub\AgenticOS-v4; C:\mu-hub\bin\bun.exe --no-env-file scripts/ops/host-alerts.ts telegram off --data-dir C:\mu-hub\data\production`
3. Elevated: the P4 line above (`-WhatIf` first). Registers `MU Health Check` (first run about a minute later) and the `MU Hub` event source.
4. Elevated: `powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MuHindsightTask.ps1 -WhatIf`, then without `-WhatIf` (no `-StartNow`).
   Within 5 minutes the watchdog fires; with the hand-started supervisor running it must exit 0 at once. Check:
   `Get-ScheduledTask -TaskPath '\Hindsight\' | Get-ScheduledTaskInfo` (last result `0x0`) and that the supervisor pids are still 18632/21292
   (or whatever they are at the time) with no second pair.
5. After 5-10 minutes: `C:\mu-hub\data\production\ops\host-health.json` exists, `C:\mu-hub\logs\mu-health-check.log` has no "evaluator failed",
   the System page shows the "Hub computer" card, and `Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='MU Hub'}` works.
6. Telegram on: the same command as step 2 with `on`. From then on, alerts DM the owner.
7. At the owner's chosen time: the reboot runbook (section 4). Until that reboot the Hindsight supervisor is still the hand-started one; the
   watchdog takes over only if it exits.

## Evidence from the read-only probes (3 Oct, 18:37-19:00)

- **Boot:** last boot 1 Oct 20:20:29; nothing has been tested across a reboot since the migration.
- **Tasks:** as in R8-F-OPS.md section 1, plus: `MU Hub Supervisor` Running since the 16:19:33 release (pid 5500); `MU Hub Backup` action has
  **no `-HubRole`** (P4 still needed); `MU SearXNG` carries `-WslUser searx`; `\Hindsight\Hindsight pilot supervisor` never run (`0x41303`,
  last run 1999), action `wscript.exe ... hindsight.vbs pilot`, no repeat, no restart; `\Hindsight\Hindsight nightly backup` SYSTEM, ran 03:30 `0x0`.
- **Processes:** every MU task process, the Hindsight supervisor tree, Postgres and both Hermes gateway processes are in **session 0**.
  Dot's staging hub (8086) and gateway (8096) run from 1 Oct 01:13 with no task.
- **Ports and answers:** 8081 `/__version` 200 (13 ms), `/__health` 401 (needs a session), 8888 200, 8878 200, 18888 200, 8642 200,
  8086 200, 8096 421 (answering; wants its own host name). All listeners on 127.0.0.1 (5432 also on ::1).
- **Hindsight:** `status.json` state running, no `crashloop.lock`, no `ALERT.json`, writes switch present (since 2 Oct 18:01).
- **Backups:** `last-backup.json` ok + verified (16:16 then 18:48 in probe 2); six production folders, each with a manifest.
- **Supervisor log:** 7 starts, 5 FAILURE, 0 GIVING UP, 0 REFUSING.
- **Disks:** C: 383.9 GB free (83%), D: 928.2 GB free.
- **Event Log:** source `MU Hub` not registered yet (the installer registers it).
- **Probe 2** (this branch's scripts, read-only modes): `mu-health-check.ps1 -DryRun -SkipSessionStore` produced the full facts with every
  service answering and no condition present; `Install-MuHindsightTask.ps1 -WhatIf` showed the plan and the task it replaces;
  `Install-MuHub.ps1 -WhatIf` with the P4 arguments showed the five tasks and named the missing `mu-health-check.ps1` as the only problem.

## Files on this branch

| File | What |
|---|---|
| `deploy/windows/mu-health-check.ps1` | the 5-minute check: facts -> report -> evaluator -> Event Log |
| `deploy/windows/Install-MuHindsightTask.ps1` | Hindsight boot task + watchdog (replaces the cutover's task) |
| `deploy/windows/verify-after-reboot.ps1` | reboot check, `-Snapshot` baseline |
| `deploy/windows/mu-common.ps1`, `Install-MuHub.ps1`, `Uninstall-MuHub.ps1`, `README.md` | `MU Health Check` in the task plan; Event Log source |
| `scripts/ops/host-health.ts` | wording, conditions, thresholds, dedupe, `/__health` component |
| `scripts/ops/host-alerts.ts` | CLI: `evaluate` (dedupe + owner Telegram + events JSON), `telegram on|off|show` |
| `scripts/cloud/health.ts` | `components.host` |
| `scripts/away-mode/notify.ts`, `service.ts` | `ownerTelegram` moved to `notify.ts`, re-exported (no behaviour change) |
| `src/lib/host-health.ts`, `src/components/shell/pages/host-health-notice.tsx`, `system-page.tsx`, `src/routes/business.tsx` | Home and System notices, System card |

## Tests run (main PC)

```
powershell -File deploy\windows\tests\Test-MuOpsWindows.ps1     passed: 59  failed: 0   (fake services; real bun evaluator with --no-send; no task, no event written)
powershell -File deploy\windows\tests\Test-MuHubWindows.ps1     passed: 172 failed: 0   (full run, slow section included)
bun test scripts/ops/host-health.test.ts scripts/host-health-notice.test.tsx                  40 pass, 0 fail
bun test scripts/away-mode scripts/cloud scripts/ops scripts/session-store-notice.test.tsx scripts/approvals   416 pass, 0 fail
bun run typecheck; bun run typecheck:scripts                                                   no errors
```

Not run: the whole repository suite; the UI in a browser (render tests cover the markup; the card and notices appear only where the host
report exists, i.e. on Ryzen after install); anything on Ryzen beyond the read-only probes.

## Open questions

1. **Clean shutdown on reboot.** The supervisor stops proxy, API and Postgres on `WM_ENDSESSION`. Whether a session-0 S4U process gets that
   at shutdown is not proven (same as today's hand-started one). Worst case Postgres does WAL crash recovery at the next start, which is safe;
   the reboot check's Hindsight lines show whether it came back.
2. **Supervisor give-up and Task Scheduler.** Still unproven whether "restart on failure" re-runs `MU Hub Supervisor` after its exit 2. It no
   longer matters for noticing it: the give-up alerts at once on all three channels.
3. **Telegram default.** It is on unless switched off. Step 2 turns it off for the first run; say if the owner wants it off by default instead.
4. **Dot's staging gateway (P8)** is reported, never alerted, and has no task; after a reboot the public Funnel on 443 points at nothing until
   Dot's lane starts it.
5. **Task priority.** Task Scheduler starts every MU task, and now the Hindsight supervisor, at its default below-normal priority. Same as the
   hub today; noted in case Hindsight latency matters under load.
6. **The main PC's own C: drive has about 1.6 GB free** (seen when the health check's disk fact was first run here during testing). Not this
   track's machine, but builds on this PC will fail when it fills.

## Bot computer terminal: trust boundary (round 10)

**What it is:** a command log and input line on a bot computer (output is shown as plain text, colour and cursor codes stripped), not a full interactive terminal; full-screen programs such as editors will not display. **Not for other users:** shared WSL services are not isolated between bot computers on one host, so this setup must not be extended to unrelated users or to Dot until each bot runs with its own loopback isolation or VM.

The terminal opens only for a confirmed person who holds that bot computer's control lease, runs as that computer's own Linux user
(`mu-…`), logs every typed command line (secrets masked) to the computer and the paused job, and closes when the lease moves or expires,
on Stop, sleep, recover, destroy, after 10 idle minutes and at hub shutdown. It never reaches the hub or a personal companion.

Limit to know: bot computers on one host share one WSL VM, and their loopback services (Chromium debugging port, VNC, the X display, the
hub bridge) are reachable by every user on that VM. Someone holding computer A's terminal could therefore reach computer B's browser or
screen without B's lease. Both founders are trusted and the agents' own processes already had this reach; the terminal makes it
interactive, and terminal output is not logged (only typed command lines). Before running several computers for different people on one
host, add a per-user loopback firewall (iptables owner match) or separate VMs.
