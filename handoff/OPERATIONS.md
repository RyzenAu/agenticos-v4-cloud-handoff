# Operations: deployment, backup, rollback

For the always-on Windows hub (Ryzen-PC). Sources: `deploy/windows/README.md`, `deploy/windows/release-ryzen.ps1`,
`docs/programme-20261001/R9-OPS.md`, `R8-F-OPS.md`, `RYZEN-MIGRATION.md`, `GATE-RESULT.md`. Where a fact comes from the
release lead and is not in the tree, it says so.

## Production shape

| Item | Value |
|---|---|
| Revision | `8aeb6311` (frontend-only delta on `82d6962d`; see README) |
| Role | `MU_HUB_ROLE=server` (headless; nobody's desktop; founders arrive through Tailscale Serve) |
| Process | The Vite dev hub, `bun --bun run dev`, bound to `127.0.0.1:8081`, kept up by the supervisor task |
| Front | Tailscale Serve on port 8443, tailnet only. No public exposure |
| Checkout | `C:\mu-hub\AgenticOS-v4` |
| Data | `C:\mu-hub\data\production` (`MU_DATA_DIR`) |
| Config | `hub.env`, a `KEY=VALUE` file the supervisor loads. The release script's default path is `C:\mu-hub\config\hub.env` |
| Logs | `C:\mu-hub\logs` |
| Runtime | `C:\mu-hub\bin\bun.exe` |

## Rules

1. **One release owner at a time.** Nobody else stops, starts or updates the hub during a release.
2. **Never restart the main-PC hub.** The owner's main PC runs its own hub and other work. Releases touch Ryzen only.
3. **Never commit, move or overwrite the owner's local files in the Ryzen checkout.** The lead reports 11 such files at
   this handoff (earlier releases recorded 35 overlay entries in `GATE-RESULT.md`). The release script refuses a release
   that touches them and hash-checks every one after the fast-forward.
4. **`hub.env` has no trailing newline.** Anything that appends to it must add a line break first. A release once
   appended a variable onto the last line and corrupted that setting (`GATE-RESULT.md`); the script now checks, but any
   hand edit or new script must do the same.
5. **Never restore over the live data dir.** Restore into an empty folder, inspect, then swap.
6. **Never delete recursively through a junction.** `node_modules` on test hubs and the coding registry's
   `source\repos` path are junctions.
7. **A fresh `-TagName` for every release.** The script's default tag is reused and `git tag -f` would move it.
8. Deploy committed code only. The health check and alert tasks read no env file and print no environment value.

## Release procedure

The lead's procedure, as given for this handoff:

1. Build a git bundle of the target commit and copy it to the hub as `C:\mu-hub\incoming\aos.bundle`.
2. On the hub, in the checkout, run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\release-ryzen.ps1 -Target <sha> -TagName rollback/pre-<name>-<yyyymmdd>
   ```

What `deploy/windows/release-ryzen.ps1` does (read from the copy in this tree, a reference copy dated 3 October):

| Phase | Steps |
|---|---|
| Pre-update | Checks the checkout is on the expected branch. Fetches the candidate from `origin` and requires its head to match `-Target`. Requires a fast-forward. Refuses if the release touches any owner-overlay path. Tags the current head with `-TagName`. Copies `hub.env` to `hub.env.pre-release-<stamp>` |
| Stop and back up | Stops the supervisor task and the hub's process tree on the port. Runs the backup task **with the hub stopped** and requires `last-backup.json` to show `ok`, `verified` and a fresh time |
| Update | `git merge --ff-only`. Adds `MU_DESIGN_PROJECTS_DIR` to `hub.env` if missing (with a line break first). Requires the overlay status to be unchanged and every owner file's hash to be identical |
| Optional | `-MigrateCrm`: dry-run, then `scripts/crm/migrate.ts --apply --backup`, then validation (original rows unchanged, no foreign-key violations). `-AdoptCommit <sha>`: adopts owner files a commit now tracks, only if byte-identical |
| Start and settle | Starts the supervisor, waits for `/__version` (200 or 401), waits **75 s**, checks again |
| Receipt | Writes `C:\mu-hub\logs\release-<stamp>.json`: old head, new head, rollback tag, backup path, the `hub.env` copy |
| Auto-rollback | Failure before the code changed: the old hub is restarted and checked. Failure after: `git reset --keep` to the old head (owner files kept), `hub.env` restored from its copy, and, if the new code had started, the data dir replaced from the backup just taken with `restore --keep-sessions` (the failed data kept aside as `<name>.failed-<stamp>`). Then the old hub is restarted and checked |

Notes on the reference copy: its `-Branch` default and the ref it fetches are from the 2 October migration
(`ryzen/migration-20261002`, `ws/integration-20261002`). The lead's working copy on the hub is the one that is run; treat
the in-tree copy as documentation and pass or update those values rather than assuming the defaults.
`-FailAfterStart` is for the staging rehearsal only and is refused against production.

## Rollback

- **Automatic**: as above, inside the release script.
- **Manual, code only**: stop the supervisor task, `git reset --keep <rollback tag>`, restore `hub.env` from the
  pre-release copy, start the task, check `/__version`.
- **Manual, with data**: additionally restore the pre-release backup into a new empty folder with
  `bun scripts/cloud/backup-cli.ts restore --from <backup> --to <folder> --keep-sessions`, move the current data dir
  aside (do not delete it) and rename the restored folder into place.
- **Rollback tags used so far** (named in `docs/programme-20261001/`): `rollback/pre-agents-20261002`,
  `rollback/pre-r5-20261002`, `rollback/pre-r6-20261002`, `rollback/pre-r6b-20261002`, `rollback/pre-r7-20261003`,
  `rollback/pre-r8-20261003`, and `rollback/staging-rehearsal-20261003`. Tags for later releases exist only in the hub's
  checkout; ask the lead for the current one. The receipt of each release names its tag and backup.

## Backups

| What | Where (by description) | How |
|---|---|---|
| Hub data | A folder on a **different physical disk** from the data dir (the installer default is `D:\mu-hub-backups\production`), 14 kept | `\MU\MU Hub Backup`, daily 03:15 and after a missed run: `backup-cli.ts backup`, then `verify`. Refuses to run when backup and data share a disk. Status in `C:\mu-hub\logs\last-backup.json` (`ok`, `verified`, `path`, `files`, `time`) |
| Pre-release | The same backup task, run by the release script with the hub stopped | See the release receipt |
| CRM pre-migration copy | Beside the hub backups, named with the release stamp | Only with `-MigrateCrm` |
| `hub.env` pre-release copy | Beside `hub.env` | Every release |
| Hindsight | Its own nightly dump under the Hindsight service's folder (`\Hindsight\Hindsight nightly backup`) | `scripts/hindsight/backup.ps1`, `docs/HINDSIGHT-OPS.md` |
| Vault | A git repository on the hub, committed every 10 minutes | `\MU\MU Vault Autocommit`, `deploy/windows/vault/README.md` |

Backups contain credentials and session records. The backup folder's permissions are cut down to the running user,
SYSTEM and Administrators. Do not copy a backup off the hub.

Restore test into an isolated folder:

```powershell
C:\mu-hub\bin\bun.exe scripts/cloud/backup-cli.ts verify  --from <backup folder>
C:\mu-hub\bin\bun.exe scripts/cloud/backup-cli.ts restore --from <backup folder> --to C:\mu-hub\restore-test --fresh-sessions
```

`--fresh-sessions` signs everyone out of the copy (tests, another machine). `--keep-sessions` is for a production
rollback. One of the two is required.

## Scheduled tasks

| Task | Script | Trigger |
|---|---|---|
| `\MU\MU Hub Supervisor` | `deploy/windows/mu-hub-supervisor.ps1` | At startup +45 s. Restarts with back-off (2, 5, 15, then 60 s); gives up after 6 failures in 10 minutes; refuses to start if the port is taken |
| `\MU\MU Hub Backup` | `deploy/windows/mu-hub-backup.ps1` | Daily 03:15, and as soon as possible after a missed run |
| `\MU\MU WSL KeepAlive` | `deploy/windows/mu-wsl-keepalive.ps1` | At startup. Keeps the bot computers' WSL distro running |
| `\MU\MU SearXNG` | `deploy/windows/mu-searxng.ps1` | At startup +60 s. Local search on `127.0.0.1:18888` |
| `\MU\MU Vault Autocommit` | `deploy/windows/vault/Install-VaultAutocommit.ps1` registers it | At startup +60 s, then every 10 minutes |
| `\MU\MU Health Check` | `deploy/windows/mu-health-check.ps1` | At startup +3 min, then every 5 minutes |
| Hermes Gateway | Named by the lead as a scheduled task on the hub. **Not documented in this tree**: `docs/programme-20261001/ryzen-hermes/RYZEN-HERMES.md` records Hermes as staged with no task at that time. The health check probes it on port 8642. Confirm its definition on the hub |
| `\Hindsight\Hindsight pilot supervisor` | `deploy/windows/Install-MuHindsightTask.ps1` | At startup +30 s and a 5-minute watchdog (separate task folder) |

`Install-MuHub.ps1` registers the `\MU\` tasks (S4U by default, no stored password); `Uninstall-MuHub.ps1` removes exactly
those. `verify-after-reboot.ps1` checks everything came back after a reboot (`-Snapshot` before the reboot).

## Health check

`mu-health-check.ps1` gathers read-only facts every 5 minutes, writes `<data>\ops\host-health.json`, and runs
`bun --no-env-file scripts\ops\host-alerts.ts evaluate`.

| Checked | How |
|---|---|
| Hub | `/__version` on the hub port; the supervisor log's last state; task state |
| Hindsight | Its health endpoints, status file, crash-loop lock, task state |
| SearXNG, Hermes gateway | Their local health endpoints |
| WSL | The distro is running; keep-alive task state |
| Backup | `last-backup.json`: ok, verified, age |
| Disks | Free space |
| Sign-in | `<data>\devices.json` opens and is a sign-in record (contents never printed) |
| Staging | Dot's gateway and staging hub ports: reported only, never alerted |

Alerts: supervisor gave up (at once), hub down more than 10 minutes, Hindsight down more than 10 minutes, backup failed
or older than 26 hours, disk below 10% or 20 GB, sign-in records unreadable. One alert per condition, a reminder every 6
hours, one "resolved". They go to the System and Home pages (`GET /__health`), the Windows Application log (source
`MU Hub`, events 4101 to 4103, 4199) and one Telegram message per run to the owner only. Switch Telegram with
`bun scripts\ops\host-alerts.ts telegram on|off`; setting `MU_OPS_ALERTS_TELEGRAM` in `hub.env` does not affect the task.

Quick checks:

```powershell
Get-ScheduledTask -TaskPath '\MU\' | Get-ScheduledTaskInfo
Invoke-RestMethod http://127.0.0.1:8081/__health
Invoke-RestMethod http://127.0.0.1:8081/__version
Get-Content C:\mu-hub\logs\mu-hub-supervisor.log -Tail 40
Get-Content C:\mu-hub\logs\last-backup.json
```

## Linux (cloud role)

A separate path exists and is not in use: `deploy/README.md`, `deploy/bin/{install,rollout,rollback,smoke,restore-data}.sh`,
`deploy/systemd/*`, `deploy/env/*.example`, `deploy/tailscale/serve.sh`. The owner has not approved a paid cloud host.

## Known operational gaps

See `BACKEND-BACKLOG.md` Part 2: the unidentified holder of `conversations.json` (EPERM, 503), Stop not yet
demonstrated on production, and the restart-before-job dedupe gap.
