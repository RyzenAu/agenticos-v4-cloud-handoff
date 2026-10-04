# Cloud hub activation runbook (1 Oct 2026)

One ordered path from "nothing bought" to a running, backed-up, monitored, rollback-able cloud hub, ending in **one owner decision**.
Design: `CLOUD-ARCHITECTURE.md`. Per-file detail: `deploy/README.md`. Nothing here has been bought, created, signed up for or deployed.

## What is already proven (local evidence, this PC)

| Claim | Evidence |
|---|---|
| The cloud role runs as the unit runs it (own data dir, loopback, no PC-only control) | `scripts/cloud/role-proof.ts` check/seed/after, `docs/programme-20261001/cloud-role-round3/` |
| Backup of a live hub, restore into a wiped copy, hub restarts healthy, **a seeded job and a pairing code survive, the owner session survives**, a tampered backup is refused | `docs/cloud-ops-20261001/restore-rehearsal-transcript.txt` (1 Oct 2026, 6 SQLite stores, 10 files, row counts matched; reproduce with `bun scripts/cloud/restore-rehearsal.ts`) |
| Health watch: ok, bad (unreachable), stale backup, low disk, alert only on change | `scripts/cloud/health-watch.test.ts`; dry run against the live hub (GET only) said ok |
| Release package, frozen install, SHA gate | `scripts/cloud/release-package.test.ts`, `deploy/README.md` |
| **Not proven (needs the VM):** systemd units on a real Debian/Ubuntu host, Tailscale Serve on it, a real off-box copy, Hindsight on the VM, a remote companion. The `.sh` and unit files are syntax-checked and content-tested only. |

## Price (re-checked 1 Oct 2026 16:15 AEST on binarylane.com.au/vps-hosting/linux-vps)

Sydney NVMe, **4 vCPU / 8 GB / 100 GB: A$39.20 a month ex GST = A$43.12 incl GST**, billed hourly in arrears. Backups A$0.05 per GB per backup
(100 GB disk: A$5.00 per retained provider backup). Page said prices are ex GST in AUD. Live prices can change; confirm on the order screen.
Planning figure A$43 to A$55 a month with two provider backups kept.

## Storage layout (on the VM)

| Path | What | Mode |
|---|---|---|
| `/opt/mu-hub/releases/<sha>/` | one unpacked release per commit (kept for rollback) | muhub |
| `/opt/mu-hub/<instance>/{current,previous,current.sha}` | symlinks to switch releases | root |
| `/var/lib/mu-hub/<instance>/` | `MU_DATA_DIR`: all SQLite stores and hub files, local disk, single writer | 0700 muhub |
| `/var/lib/mu-hub/<instance>-home/`, `-vault/` | hub HOME (also holds `health-watch.json`), the one memory vault | 0700 muhub |
| `/var/backups/mu-hub/<instance>/backup-<stamp>/` | nightly backups with `manifest.json` (sha256, row counts), newest 14 kept | 0700 muhub |
| `/etc/mu-hub/<instance>.env` | settings and secrets, entered by hand on the VM | 0640 root:muhub |

Disk sizing: data (run `du -sh .operator-data` on the PC once) times 4 (live + 14 nightly snapshots compress poorly, so reserve; the VM's
100 GB has room), and the watch alerts below 5 GB free.

## The ordered runbook

Steps marked **OWNER** are account or money actions this repo never takes.

1. **OWNER: decision (end of this page).** Then buy the VM in BinaryLane's panel: Sydney, Debian 12 or Ubuntu 24.04, 4 vCPU / 8 GB. Add your
   SSH public key at creation. Do not enable a public service port beyond SSH.
2. **First login, as root:** `apt-get update && apt-get -y upgrade`, `timedatectl set-timezone Australia/Sydney`, `ufw default deny incoming;
   ufw allow OpenSSH; ufw enable` (the hub binds loopback; Tailscale Serve is the only way in).
3. **Get the code onto the VM** (no Git history needed): on the PC `bun run cloud:package -- --sha <full-sha> --out D:\release` (prints
   "Verified"), copy `mu-hub-<sha12>.tar.gz`, `.manifest.json`, `SHA256SUMS` to the VM (scp). Also copy the repo's `deploy/` folder (or clone
   once) to run `install.sh` from.
4. **Host setup, root:** `deploy/bin/install.sh` (creates `muhub`, folders, pinned Bun 1.4.2, systemd units including backup and watch,
   env examples).
5. **OWNER: Tailscale on the VM:** install, `tailscale up` (no flags), approve in the browser. Needs the PC's Tailscale fixed first
   (`docs/cloud-ops-20261001/TAILSCALE-NOSTATE-20261001.md`) only if you want to reach the VM from this PC.
6. **Secrets by hand:** edit `/etc/mu-hub/staging.env` and `production.env`. Staging gets test keys or none. For alerts add
   `MU_ALERT_TELEGRAM_CHAT_ID=<your chat id>` and `TELEGRAM_BOT_TOKEN` (the same bot the OS already uses; typed on the VM, never pasted into chat).
   Memory: `MU_MEMORY_WRITES=off` until step 11.
7. **Staging first:** `deploy/bin/rollout.sh staging <sha> --package /srv/incoming/mu-hub-<sha12>.tar.gz`, then `deploy/bin/smoke.sh staging`
   and `deploy/tailscale/serve.sh staging`. `tailscale funnel status` must be empty.
8. **Staging acceptance:** `deploy/STAGING-ACCEPTANCE.md`. Run **the restore drill on staging** (below) before touching production data.
9. **Backups on, then watch on (per instance):**
   ```
   systemctl enable --now mu-hub-backup@production.timer     # 03:15 Sydney nightly, keeps 14
   systemctl start mu-hub-backup@production.service          # one now; confirm a folder appears
   systemctl enable --now mu-hub-watch@production.timer      # every 2 minutes
   systemctl start mu-hub-watch@production.service           # first run: expect OK hub, backup, disk
   ```
10. **Cut over data from the PC** (`CLOUD-ARCHITECTURE.md` section "Migration"): final PC backup, copy, `backup-cli verify`, restore into the
    VM's data dir with the hub stopped, start, smoke. Keep the PC's frozen data folder and the final backup untouched for 48 hours.
11. **Production rollout** of the same SHA that passed staging: `rollout.sh production <sha> --package ...`, `serve.sh production`,
    `smoke.sh production`. Then Hindsight on the VM (loopback) and `MU_MEMORY_WRITES=read`, later `on`.
12. **Re-pair people:** Usman's and Mehroz's browsers and companions pair to the cloud hub address (`docs/MEHROZ-ENROL.md`).
13. **Off-box copy (free):** weekly, from the PC over the tailnet: `scp` the newest `backup-*` folder to `D:\backups\mu-hub\`. A backup holds
    credentials: keep that folder on an encrypted volume (BitLocker) and never in cloud sync. Also take one BinaryLane provider backup (about A$5)
    before each cutover or rollout and keep two.

## Backups and retention

| Layer | When | Kept | Cost |
|---|---|---|---|
| `mu-hub-backup@<inst>` (consistent online snapshot per store, files, manifest) | nightly 03:15 Sydney, and automatically before every rollout | newest 14 (`--keep 14`) | free (VM disk) |
| Off-box copy to the PC | weekly (step 13) | latest 8 by hand | free |
| BinaryLane provider backup | before cutover/rollout | 2 | A$0.05/GB, about A$5 each at 100 GB |

**Restore rehearsal (do it on the VM too, monthly, on staging):**
```
bun scripts/cloud/backup-cli.ts verify  --from /var/backups/mu-hub/production/backup-<stamp>
deploy/bin/restore-data.sh staging /var/backups/mu-hub/production/backup-<stamp>   # verifies, restores to a fresh folder, swaps, smoke; swaps back on failure
```
On this PC the same drill is `bun scripts/cloud/restore-rehearsal.ts` (port 8114, scratch data, kills only its own hub by PID).

## Monitoring: free, no new service

| Layer | What it does | Cost |
|---|---|---|
| `/__health` | per-component ok/degraded/failed with a recovery line; 503 when failed | free |
| `mu-hub-watch@<inst>.timer` (new) | every 2 minutes: hub health, newest backup younger than 26 h, free disk at least 5 GB. Exits 1 when bad so `systemctl --failed` and `journalctl -u mu-hub-watch@production -p err` show it | free |
| Alert route 1: journal | always | free |
| Alert route 2: Telegram DM via the bot the OS already has, on **change only** (bad, then recovered) | needs `TELEGRAM_BOT_TOKEN` + `MU_ALERT_TELEGRAM_CHAT_ID` in the env file | free |
| Alert route 3: `/var/lib/mu-hub/<inst>-home/health-watch.json.alert` | last alert line, readable by the OS or a person | free |
| **Dead-man (VM fully down, so it cannot alert):** the PC's existing proactive job polls `https://<vm>.<tailnet>.ts.net:8443/__health` over the tailnet and DMs on failure | free; a job to add on the PC after cutover, not built here |
| Optional: a free external heartbeat service | needs a new account (an OWNER action); not required | free tier |

## Rollback

| Situation | Action |
|---|---|
| New release misbehaves, data fine | `deploy/bin/rollback.sh production` (previous release dir; run twice to undo). Rollout also self-reverts if `/__health` is not ok or degraded within 90 s |
| New release changed a store's schema and the old code will not open it | `deploy/bin/restore-data.sh production <pre-rollout backup>` (the rollout took one first), then `rollback.sh production` |
| Data damaged or wrong | `restore-data.sh production <backup>`: live data is renamed to `<data>.pre-restore-<stamp>`, never deleted; if the restored data is unhealthy it swaps back by itself |
| Whole cutover regretted (first 48 h) | the PC hub and its frozen data are untouched: re-point people to the PC address |
| VM lost | new VM, steps 1 to 6, restore the newest off-box backup, `tailscale up` |

## Pilots that stay separate

OpenShell stays on `prog/os-openshell-20261001` (not merged; needs a Landlock ABI 3+ kernel; cannot carry a Claude login). context-mode stays
off by default. Neither is part of this activation.

## The one owner decision

> **Buy BinaryLane Sydney, 4 vCPU / 8 GB / 100 GB (about A$43.12 a month incl GST, plus about A$5 to A$10 for provider backups): yes or no?**
>
> Yes: do steps 1 to 13 in order; the first six take about an hour of your time, the rest are commands. No: nothing changes; the PC hub keeps
> running, backups can still go to D: with `bun run cloud:backup`, and the cloud files stay ready.
