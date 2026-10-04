# Hub on an always-on Windows PC (boot-time, no logon)

Runs the AgenticOS hub, a WSL keep-alive, SearXNG and a nightly verified backup on a Windows 11 PC, started **at boot by
Scheduled Tasks in the `\MU\` folder**. Nobody has to log in and there is no Windows auto-login.
Written for the Ryzen-PC layout; every path is a parameter.

| Piece | Script | Task (under `\MU\`) | Trigger |
|---|---|---|---|
| Hub | `mu-hub-supervisor.ps1` | `MU Hub Supervisor` | at startup, +45 s |
| WSL | `mu-wsl-keepalive.ps1` | `MU WSL KeepAlive` | at startup |
| SearXNG | `mu-searxng.ps1` | `MU SearXNG` | at startup, +60 s |
| Backup | `mu-hub-backup.ps1` | `MU Hub Backup` | daily 03:15, and as soon as possible after a missed run |
| Health and alerts (R9) | `mu-health-check.ps1` | `MU Health Check` | at startup +3 min, then every 5 min (read-only checks; alerts to the System/Home page, the Event Log source `MU Hub`, and the owner's Telegram) |

Hindsight's boot task is separate, in `\Hindsight\`: `Install-MuHindsightTask.ps1` registers `Hindsight pilot supervisor` (at startup
+30 s and a 5-minute watchdog). After a reboot, `verify-after-reboot.ps1` checks that everything came back (`-Snapshot` before the reboot
records what must survive). Install steps, alert rules and the reboot runbook: `docs/programme-20261001/R9-OPS.md`.

Shared helpers are in `mu-common.ps1`. Everything is Windows PowerShell 5.1 and ASCII-only.
This does **not** replace `scripts/windows/*` (main PC, per-user Startup items) or `deploy/systemd/*` (Linux).

## Defaults (Ryzen-PC)

| Parameter | Default |
|---|---|
| `-RepoRoot` | `C:\mu-hub\AgenticOS-v4` |
| `-BunPath` | `C:\mu-hub\bin\bun.exe` |
| `-DataDir` (`MU_DATA_DIR`) | `C:\mu-hub\data\production` |
| `-LogDir` | `C:\mu-hub\logs` |
| `-BackupDir` | `D:\mu-hub-backups\production` (a different physical disk) |
| `-Port` | `8081` (the supervisor binds `127.0.0.1` only; Tailscale Serve fronts it) |
| `-EnvFile` | none. Optional `KEY=VALUE` file for secrets, e.g. `C:\mu-hub\secrets\hub.env` |
| `-Distro` | `kali-linux` |

## S4U or Password: pick one

Scheduled Tasks can run with nobody logged in in two ways. `Install-MuHub.ps1 -LogonType S4U|Password` (default `S4U`).

**S4U (Service-for-User), no stored password.** Windows builds a token for your user without your credentials.
- Cannot: use network credentials (no authenticated SMB shares or other "as me" network logons), and cannot unlock
  DPAPI user secrets (Windows Credential Manager, anything stored with CryptProtectData: some browsers' saved data, some
  credential helpers).
- Can: run local code as your user with your profile files readable. Credential **files** in the profile such as
  `~\.claude\...` and `~\.codex\...` are plain files and should work, but **that is an assumption to prove**, see test 3.
  A CLI that keeps its login in Credential Manager or a DPAPI blob will find it locked.
- Tailscale is a Windows service and does not depend on either choice.

**Password.** The task is stored with your password, typed by **you** at an interactive `Get-Credential` prompt when you run
the installer. The script has no password parameter and never writes it to disk or a log (it checks the password is
correct first, because a wrong one registers fine and then silently never runs). The task then gets a normal batch logon:
network credentials and DPAPI work. Costs: Windows keeps the password as an LSA secret (readable by SYSTEM/admins), and
every task silently stops working when you change that password until you re-run the installer. A Microsoft-account login
needs the account password, not the PIN.

**Recommendation: install with S4U first, run the three tests below, and switch to `-LogonType Password` only if test 2 or
test 3 fails.** S4U stores no secret and covers everything the hub needs unless a CLI login lives in DPAPI. Re-running the
installer with the other type simply replaces the tasks.

SYSTEM was rejected: the WSL distro, the bot desktops and the CLI logins all belong to one user profile.

## Install order (owner only)

Do these as the Windows user who owns the WSL distro (`mkhan`), in an **elevated** PowerShell.

1. Check the layout exists: the repo, `bun.exe`, the data dir, `D:` and `wsl -l -v` (distro `kali-linux` present).
2. Preview, which changes nothing:
   ```powershell
   cd C:\mu-hub\AgenticOS-v4\deploy\windows
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MuHub.ps1 -WhatIf
   ```
   Add `-EnvFile C:\mu-hub\secrets\hub.env` if you use one. Read the four task lines and any `PROBLEM:` lines (it warns if
   the backup disk is the data disk).
3. Dry-run each script (prints the plan, starts nothing):
   ```powershell
   $s = 'C:\mu-hub\AgenticOS-v4\deploy\windows'
   powershell -NoProfile -ExecutionPolicy Bypass -File $s\mu-hub-supervisor.ps1 -RepoRoot C:\mu-hub\AgenticOS-v4 -BunPath C:\mu-hub\bin\bun.exe -DataDir C:\mu-hub\data\production -LogDir C:\mu-hub\logs -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File $s\mu-wsl-keepalive.ps1 -LogDir C:\mu-hub\logs -DryRun
   powershell -NoProfile -ExecutionPolicy Bypass -File $s\mu-searxng.ps1 -LogDir C:\mu-hub\logs -DryRun
   ```
4. **Stop whatever already runs the hub on 8081** (an old Startup item, a manual console, the old
   `WSL keep-alive (kali-linux)` logon task is fine to leave). The supervisor refuses to start (exit 3, logged) if the port is taken.
5. Install:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MuHub.ps1 -StartNow          # S4U
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-MuHub.ps1 -LogonType Password -StartNow   # prompts for your password
   ```
6. Run the backup once by hand (as yourself, so the first run's problems show on screen):
   `Start-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Backup'`, then check `last-backup.json` (below).
7. Run the boot tests.

## Prove it: three tests to run on the real host

1. **Tasks and hub.** `Get-ScheduledTask -TaskPath '\MU\' | Get-ScheduledTaskInfo` shows `LastTaskResult 267009` (running)
   for the three boot tasks. `Invoke-RestMethod http://127.0.0.1:8081/__health` and `/__version` answer.
2. **Boot with no logon (the one that matters for WSL).** Reboot and **do not log in at the PC**. From another device on the
   tailnet, wait up to ~5 minutes and open the hub's Tailscale URL, `/__health`. Then log in locally and compare times:
   the first lines of `C:\mu-hub\logs\mu-wsl-keepalive.log` ("started wsl.exe keep-alive") and `mu-hub-supervisor.log`
   ("hub is up") must be **earlier than your logon time** (`Get-WinEvent -FilterHashtable @{LogName='Security';Id=4624} -MaxEvents 5`
   for the interactive logon, or just note the clock). Also check `wsl -l -v` shows `kali-linux Running` and
   `Invoke-WebRequest http://127.0.0.1:18888/ -UseBasicParsing` returns 200.
   **Whether WSL2 starts from a non-interactive boot task is not proven here and must be proven on the real host.** If
   `mu-wsl-keepalive.log` shows repeated "keep-alive exited" / "distro probe failed" and then GIVING UP: (a) try
   `-LogonType Password`; (b) run `wsl --status` in a task as the same user to read the actual error; (c) confirm the user is
   in the Hyper-V Administrators / Virtual Machine Platform is enabled; (d) fall back to the logon-based
   `deploy\computers\windows\Install-WslKeepAlive.ps1` plus a single auto-logon, which this design is trying to avoid.
3. **CLI logins under the task's logon type.** Create a test task or use the hub itself to run `claude -p "Reply: ok"` and the
   Codex equivalent as that user, with nobody logged in. If either says "not logged in", the login is held by DPAPI /
   Credential Manager, so use `-LogonType Password` (or re-login the CLI with file-based credential storage).

## How to check each task

| Question | Command |
|---|---|
| State and last result | `Get-ScheduledTask -TaskPath '\MU\' \| Get-ScheduledTaskInfo` |
| Hub alive | `Invoke-RestMethod http://127.0.0.1:8081/__health`, and `/__version` |
| Supervisor log | `Get-Content C:\mu-hub\logs\mu-hub-supervisor.log -Tail 40` |
| Hub output | `C:\mu-hub\logs\hub-stdout.log`, `hub-stderr.log` |
| WSL | `C:\mu-hub\logs\mu-wsl-keepalive.log`, `wsl -l -v` |
| SearXNG | `C:\mu-hub\logs\mu-searxng.log`, `Invoke-WebRequest http://127.0.0.1:18888/ -UseBasicParsing` |
| Last backup | `Get-Content C:\mu-hub\logs\last-backup.json` (`ok`, `verified`, `path`, `files`, `time`) and `mu-hub-backup.log` |
| Host health (R9) | `C:\mu-hub\data\production\ops\host-health.json` (facts), `host-alerts.json` (active alerts), `C:\mu-hub\logs\mu-health-check.log`; Event Viewer, Application log, source `MU Hub` |

Logs rotate at 5 MB (hub output 10 MB), keeping three old files.

Log lines to know: `FAILURE: ...` then `restarting in Ns` is a normal bounded restart (2, 5, 15, then 60 s).
`GIVING UP: 6 failures within 10 minutes` means it stopped on purpose; fix the cause, then
`Start-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Supervisor'`. (The task also retries every 5 minutes, 10 times,
because a give-up exits non-zero.) `REFUSING TO START: port 8081 is already in use` means another process holds the port.

## Backups

- Runs `bun scripts/cloud/backup-cli.ts backup --data-dir ... --out D:\mu-hub-backups\production --keep 14`, then `verify` on the new
  folder. Any failure exits non-zero (1 backup, 2 verify, 3 refused, 4 bad parameters) and writes `ok: false` to `last-backup.json`.
- **It refuses to run when the backup folder and the data dir share a physical disk** (disk numbers via `Get-Partition`) or
  when it cannot tell (UNC path, mount-point folder). `-AllowSameDisk` exists for tests only.
- The backup folder's permissions are cut down to the running user, SYSTEM and Administrators, because backups contain credentials.

### Restore into an isolated folder

Never restore over the live data dir. Restore to an empty folder and inspect:

```powershell
cd C:\mu-hub\AgenticOS-v4
C:\mu-hub\bin\bun.exe scripts/cloud/backup-cli.ts verify  --from D:\mu-hub-backups\production\backup-<stamp>
C:\mu-hub\bin\bun.exe scripts/cloud/backup-cli.ts restore --from D:\mu-hub-backups\production\backup-<stamp> --to C:\mu-hub\restore-test --fresh-sessions
```

It checks checksums and per-store row counts against the manifest, and one session option is required: `--fresh-sessions` signs everyone out of the copy (test restores, or a restore onto another machine); `--keep-sessions` leaves every login as in the backup and is the one for a production rollback. Without either the command refuses. To run a hub on it (port other than 8081, role not `pc`):
`$env:MU_DATA_DIR='C:\mu-hub\restore-test'; $env:HINDSIGHT_URL='off'; $env:MU_MEMORY_WRITES='off'; $env:AGENTIC_OS_NO_BACKGROUND='1'; C:\mu-hub\bin\bun.exe --bun run dev --port 8123 --strictPort --host 127.0.0.1`.
To go live from a backup: stop `MU Hub Supervisor`, move the old data dir aside (do not delete it), restore into the
data dir's parent as a new empty folder with the same name, start the task.

## Rollback and uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-MuHub.ps1 -WhatIf   # preview
powershell -NoProfile -ExecutionPolicy Bypass -File .\Uninstall-MuHub.ps1
```

Removes exactly the five named tasks in `\MU\`, ending their processes (Task Scheduler runs them in a job, so ending the task
ends the hub). It never touches other tasks, logs, backups, the data dir or the repo. To stop only the hub for a while:
`Stop-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Supervisor'` (it will start again at next boot; use
`Disable-ScheduledTask` to prevent that). If a hub process survives a stop, find it with
`Get-NetTCPConnection -LocalPort 8081 -State Listen` and end that PID's tree with `taskkill /PID <pid> /T /F`.

## Tests (run on any Windows machine, no admin, nothing installed)

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuHubWindows.ps1
```

and, for the R9 ops scripts (health check with fake services and the real alert evaluator in `--no-send` mode, the Hindsight task
installer in `-WhatIf`, the reboot check against a scratch baseline):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuOpsWindows.ps1
```

Exit code is the number of failures. It uses a fake `bun` and a fake hub on a free port, registers no task, and cleans up its
scratch folder under `%TEMP%`. `-SkipSlow` skips the two supervisor integration runs (about 25 s).

## Known limits

- Hub restarts rely on `bun --bun run dev` (vite dev server), as on the main PC. `dev` runs `seed:data` first.
- The Jarvis desktop app's mutex handshake (`Local\JarvisAppServer-<port>`) is not used: this host is headless.
- The supervisor kills only the process tree it started. A hub started by hand is not adopted; it is refused (exit 3).
- Backup disk detection works on drive-letter paths. A folder mounted into another drive letter is judged by that letter.
- Do not pass `-BackoffSchedule 2,5` through `powershell -File`: it arrives as one string. Use `-Command` or set it in-session.
