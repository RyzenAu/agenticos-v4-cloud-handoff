# Deploying the hub to a Linux VM

Design and reasoning: `docs/programme-20261001/CLOUD-ARCHITECTURE.md`. Ordered activation path and the owner decision: `docs/programme-20261001/CLOUD-ACTIVATION.md`. This page is the reference.

**Why systemd and not Docker.** The hub is one long-lived process that is the single SQLite writer on local disk and
asks the host's `tailscaled` who a caller is (Tailscale Serve headers). systemd gives that with no container network, no
socket mounts and no image registry: a pinned Bun, a release folder per git SHA, a symlink to switch, `systemctl restart`.
Docker would add a layer without removing a step. (If the owner later picks Fly.io, a Dockerfile is a new piece of work.)

**What is never in this folder or in a release:** `.env` files, `.operator-data`, tokens, provider keys, backups.
Releases are made with `git archive <sha>`, which contains tracked files only. Secrets live in `/etc/mu-hub/<instance>.env`
(written by hand on the VM) and data in `/var/lib/mu-hub/<instance>`.

## Layout

| Path on the VM | What |
|---|---|
| `/opt/mu-hub/bun/bin/bun` | pinned Bun (`BUN_VERSION`, default 1.4.2) |
| `/opt/mu-hub/repo.git` | bare mirror of the repo that rollouts read (you create it once) |
| `/opt/mu-hub/releases/<sha>/` | one unpacked release per commit (kept for rollback) |
| `/opt/mu-hub/<instance>/current`, `previous`, `current.sha` | symlinks and the running SHA |
| `/etc/mu-hub/<instance>.env` | settings + secrets, mode 0640 root:muhub |
| `/var/lib/mu-hub/<instance>/` | `MU_DATA_DIR` for that instance |
| `/var/backups/mu-hub/<instance>/` | nightly backups, mode 0700 |

| Instance | Port (loopback) | Tailscale Serve | Data dir | Purpose |
|---|---|---|---|---|
| `production` | 8081 | `https://<vm>.<tailnet>.ts.net:8443` | `/var/lib/mu-hub/production` | the real hub |
| `staging` | 8082 | `https://<vm>.<tailnet>.ts.net:8444` | `/var/lib/mu-hub/staging` | release candidate on a restored copy |

## First-time setup (owner-gated steps marked)

1. Owner creates the VM (Debian 12 or Ubuntu 24.04, Sydney). **Owner decision, not done here.**
2. As root on the VM: clone the repo somewhere, then `deploy/bin/install.sh`. It creates the `muhub` user and folders,
   installs the pinned Bun, installs the systemd units and copies the env examples into `/etc/mu-hub/`.
3. **Owner** installs Tailscale on the VM and signs in (`tailscale up`). **Not done here.**
4. Edit `/etc/mu-hub/staging.env` and `production.env`: review the settings, add any secret by hand. Never paste a
   secret into a chat, a ticket or git.
5. Create the mirror once: `git clone --mirror <repo url or path> /opt/mu-hub/repo.git`; refresh it with
   `git -C /opt/mu-hub/repo.git fetch --prune` before each rollout.
6. Staging first: `deploy/bin/rollout.sh staging <sha>` then `deploy/tailscale/serve.sh staging`.

## Release package (round 3): build once on a trusted machine, copy three files, roll out from them

```
bun run cloud:package -- --sha <full-sha> --out D:\release      # on the PC; prints "Verified"
#   mu-hub-<sha12>.tar.gz   mu-hub-<sha12>.manifest.json   SHA256SUMS
bun scripts/cloud/release-package.ts verify --package D:\release\mu-hub-<sha12>.tar.gz
# copy all three to the VM over the tailnet, then on the VM as root:
deploy/bin/rollout.sh staging <sha> --package /srv/incoming/mu-hub-<sha12>.tar.gz
```

The package is `git archive` of that commit (no Git history, no working-tree edits, no untracked file) minus a deny list
(`.env*`, `.operator-data`, keys, `*.sqlite`, logs, screenshots and docs media, `node_modules`, `dist`), with a sha256 for every file,
a secret scan that refuses the build on a hit, and execute bits kept. `rollout.sh --package` checks `SHA256SUMS` before it unpacks and
refuses a package whose commit is not the SHA you named. **Frozen install:** the VM runs `bun install --frozen-lockfile` against the
`bun.lock` inside (Bun pinned by `BUN_VERSION` in `install.sh`, 1.4.2); a lockfile change makes the install fail rather than drift.

## Service, data, network, companions, in one place

| Need | Where |
|---|---|
| systemd service (one per instance), restart on failure, hardened | `deploy/systemd/mu-hub@.service` |
| Persistent data dirs (local disk, single writer), `0700` | `/var/lib/mu-hub/<instance>` (`MU_DATA_DIR`), home `/var/lib/mu-hub/<instance>-home`, vault `.../<instance>-vault`, backups `/var/backups/mu-hub/<instance>` |
| Tailscale-private only (Serve, never Funnel) | `deploy/tailscale/serve.sh`; `tailscale funnel status` must be empty |
| Authenticated hub access | the tailnet login (Serve headers verified by the VM's own `tailscaled`) mapped by `people.json`, or a paired browser session; unpaired callers get 401 |
| A PC (companion) connects OUT to the hub | on the PC: `bun companion/main.ts pair --hub https://<vm>.<tailnet>.ts.net:<port> --code <code from Profile>`, then `run` (autostart: `companion/install-autostart.ps1`); no inbound port opens on the PC |
| Backup and restore | "Backups and restore" above; monthly drill |
| Health and alerts | `deploy/bin/smoke.sh`, `/__health`, `mu-hub-watch@<instance>.timer` (every 2 min; Telegram on change; `scripts/cloud/health-watch.ts`) |
| Rollback | `deploy/bin/rollback.sh` (code); `deploy/bin/restore-data.sh <instance> <backup>` (data, keeps the old folder) |
| Staging acceptance | `deploy/STAGING-ACCEPTANCE.md` |
| Local rehearsal of the cloud role (isolated data, port 8113) | `deploy/local/cloud-rehearsal.ps1` and `scripts/cloud/role-proof.ts` |

## Rollout (controlled, by git SHA)

```
git -C /opt/mu-hub/repo.git fetch --prune
deploy/bin/rollout.sh staging    <sha>     # backup, unpack that SHA, bun install --frozen-lockfile, switch, restart, health gate
deploy/bin/smoke.sh   staging
deploy/bin/rollout.sh production <sha>     # the SAME sha that passed on staging
```

A rollout takes a backup first, unpacks exactly that commit, installs with the lockfile frozen, repoints `current`,
restarts and waits up to 90 seconds for `/__health` to be `ok` or `degraded`. If it is not, it puts `previous` back
and restarts by itself, and exits non-zero. Branch names are refused: a SHA is what makes a rollout repeatable.
`/__health` and `/__version` both show the running `gitSha` (from `RELEASE_SHA`, written at unpack time).

## Rollback

* Code only: `deploy/bin/rollback.sh production` (previous release; run it twice to undo itself). Data is untouched.
* If the newer release changed a store's schema and the old code will not open it: restore the pre-rollout backup
  (next section) into a fresh folder and point the instance at it.

## Backups and restore

Nightly at 03:15 Sydney time, per instance:

```
systemctl enable --now mu-hub-backup@production.timer
systemctl start mu-hub-backup@production.service          # on demand
```

It runs `backup-cli.ts backup --out /var/backups/mu-hub/<instance> --keep 14`: a consistent online snapshot of every
SQLite store (`VACUUM INTO`, hub keeps running) plus every other file in the data directory, a `manifest.json` with
per-file sha256 and per-table row counts. Caches, browser profiles and agent work folders are excluded.

**A backup contains credentials** (OAuth tokens, pairing secrets). Keep it 0700 on the VM; when you copy it off the VM
(to the owner's PC or other storage) it goes over the tailnet and is stored encrypted. Also dump Hindsight's Postgres
beside it once that runs on the VM (`pg_dump -Fc`).

Restore (always into an EMPTY, separate folder, never over a live one):

```
bun scripts/cloud/backup-cli.ts verify  --from /var/backups/mu-hub/production/backup-<stamp>
bun scripts/cloud/backup-cli.ts restore --from /var/backups/mu-hub/production/backup-<stamp> --to /var/lib/mu-hub/production-restored
# it verifies checksums, copies, re-verifies, opens every store and compares row counts with the manifest
systemctl stop mu-hub@production
# point MU_DATA_DIR at the restored folder (edit the unit override) or rename folders, then:
systemctl start mu-hub@production && deploy/bin/smoke.sh production
```

**Restore drill.** Do this monthly on staging: restore last night's production backup into the staging data dir, start
staging, `smoke.sh staging`, compare row counts. A backup that has not been restored is not a backup.

## Health

`curl -s http://127.0.0.1:8081/__health` (the identity gate accepts the local loopback owner; no secrets in the answer)
shows per component: `dataDir`, `stores`, `jobsWorker`, `hindsight`, `companions`, plus `hubRole`, `version`, `gitSha`.
`status` is `ok`, `degraded` (Hindsight down, read-only worker: the hub works, something needs attention) or `failed`
(HTTP 503: a store will not open or the data dir is not writable). Each problem carries a `recovery` line.

## Troubleshooting

| Symptom | Look at | Likely fix |
|---|---|---|
| `status: failed`, `dataDir` | `ls -ld /var/lib/mu-hub/<instance>`, `df -h` | ownership must be `muhub`, free the disk, restart |
| `failed`, `stores` | the store named in `detail` | stop, restore the last backup into a fresh folder (above) |
| `degraded`, `hindsight` | `systemctl status` for Hindsight; `HINDSIGHT_URL` | start it, or set `HINDSIGHT_URL=off` until it exists |
| Serve URL unreachable | `tailscale serve status`, `tailscale status` | re-run `deploy/tailscale/serve.sh <instance>` |
| FTS5 or SQLite crash at start | `journalctl -u mu-hub@<instance>` | the unit must use `bun --bun` (it does); do not run under Node |
| Port in use | `ss -ltnp` | another instance on the same port; staging is 8082 |

Publish only with Serve. Never Funnel, never a public firewall port: `tailscale funnel status` must be empty.
