# Cloud hub: architecture, migration and hosting

Programme 1 Oct 2026, Agent A. Status: built and tested locally; **not deployed**. Nothing here buys, signs in to or
changes anything. The owner approves the VM and the Tailscale sign-in (section 9).

## 1. Decision in one paragraph

Run the existing hub, unchanged in shape, as **one persistent Bun process on a Sydney Linux VM** with SQLite on the VM's
local disk (single writer), reachable **only over the tailnet through Tailscale Serve**, which keeps the identity model the
PC hub already uses (Serve headers, `people.json`, pairing). Both PCs become **companions**: they dial out to the hub and
run the things only a PC can run. No new database product. The one concrete reason to look twice at that rule (SQLite
single-writer, section 3) is answered by design, not by a migration.

What shipped for it:

| Piece | Where |
|---|---|
| `MU_DATA_DIR` (default unchanged = `<repo>/.operator-data`), honoured by every store | `scripts/cloud/data-dir.ts`, 114 files re-pointed |
| `MU_HUB_ROLE=pc\|cloud` (default `pc`) and the PC-only route gate | `scripts/cloud/hub-role.ts` |
| `GET /__health` (per-component status, recovery hints, no secrets) | `scripts/cloud/health.ts` |
| Online backup, verify, isolated restore | `scripts/cloud/backup.ts`, `backup-cli.ts` (`bun run cloud:backup` / `cloud:restore`) |
| systemd units, install, rollout by SHA, rollback, Tailscale Serve, env examples | `deploy/` (runbook: `deploy/README.md`) |

## 2. Entity ownership (cloud mode)

"Authoritative" means: the one place a write is accepted. Everything else is a copy, a cache or a view.

| Entity | Authoritative location | Store / format | Who writes | Notes |
|---|---|---|---|---|
| Leads and CRM (activities, goals, kickoff, coaching) | Cloud hub | `crm.sqlite` | Hub only (founders through the UI; lead-engine CLIs run **on the VM**) | The PC CLIs must not open a copy. |
| Jobs and steps | Cloud hub | `jobs.sqlite` (WAL) | Hub only | Job state for PC-bound work is `queued` until a companion claims it (Agent B's contract). |
| Approvals | Cloud hub | `approvals.sqlite` (WAL) | Hub only | Approval codes and Telegram answers terminate at the hub. |
| Decisions and workspace state | Cloud hub | `workspace.json`, `workspace-decisions.json` | Hub only | `workspace.json` is one file, rewritten whole on each save: see limits, section 3. |
| Devices, sessions, pairing | Cloud hub | `devices.json`, `devices-secret` | Hub only | Companion presence is in memory and rebuilds from heartbeats after a restart. |
| People and identity map | Cloud hub | `people.json` | Owner edits on the VM | Identity still comes from Tailscale Serve headers verified by the VM's own `tailscaled`. |
| Memory: lasting knowledge | **One vault** (see section 6) | Markdown in a git repo | Hub (`save_to_vault`) and founders (Obsidian) | Authoritative copy = the bare repo on the VM. |
| Memory: search index | Hindsight on the VM (Postgres 18) | Postgres | Hub's memory connector only (single writer) | A derived index over the vault plus saved facts; dumped nightly. |
| Pricing catalogue (699/1099/1999 ex GST, per-second billing) | Source code: `src/lib/receptionist-packages.ts`, exported to `docs/receptionist-package-catalogue.json` (`scripts/export-receptionist-catalogue.ts`); guarded by `scripts/price-contract.test.ts` | TypeScript + JSON export, in git | Founders approve; changed only by reviewed commits | One catalogue. Proposals, decks, call packs, Finance and the receptionist dashboard must read this, never a copy. (Lead correction 1 Oct: Agent A's first draft missed this file.) |
| Finance (NAB CSV imports, Stripe rollups) | Cloud hub | `finance.sqlite`, `finance-manual.sqlite` | Hub only | Research and records only: the hub never trades or moves money. Finance grants stay as in `people.json`. |
| Mail archive, inbox triage | Cloud hub | `mail-archive.sqlite`, `inbox-triage.sqlite` | Hub sync jobs | Largest store; size the disk from it (section 3). |
| Receptionist feed | **mu-receptionist** (Vercel + Neon, Sydney) | Neon Postgres | The receptionist app | The hub only reads the token-protected `/api/agency/feed`. Never copied into a hub table as authoritative. |
| Audit and control logs | Cloud hub | `audit/*.jsonl`, `away-audit/` | Hub | Away-mode's audit folder moves inside `MU_DATA_DIR` when it is set. |
| Coding jobs, repo registry | Cloud hub metadata; the code itself on the PC | `coding/coding.sqlite`, `coding/repos.json` | Hub | Repos live on the PCs; the VM holds only job records. |
| Provider keys and tokens | The VM's `/etc/mu-hub/<instance>.env`, or hub OAuth files in the data dir | Files, mode 0600/0640 | Owner by hand | Never in git, never in a backup that leaves the owner's control unencrypted. |
| Files on a PC (documents, Desktop, local repos) | That PC | n/a | That PC | Only a companion can touch them. |

## 3. SQLite write ownership and limits

**Rule: one writer process per data directory, on local disk.** The hub process is that writer for every store. A
second writer is allowed only for short, deliberate jobs run on the same VM against the same local disk (the backup
script, a lead CLI), and only because every store opens in WAL with a `busy_timeout`.

Hard limits, stated plainly:

1. **Never** put a data directory on NFS, SMB, a synced folder, or a network block device shared by two hosts. SQLite
   locking is not safe there. A provider block volume attached to *one* VM is local disk and fine.
2. **Never** run two hubs on one data directory, and never run the PC hub and the cloud hub on copies of the same data at
   the same time (two sources of truth; the later restore silently loses writes). Cutover (section 5) stops one first.
3. **Never** copy `*.sqlite` files by hand while the hub runs. The backup uses `VACUUM INTO`, which gives a consistent
   snapshot of each store without stopping anything. Copying a live file with `cp`/`rsync` can tear a WAL.
4. Each store is snapshotted on its own, so a backup is consistent *per store*, not one atomic cut across stores. A
   job names an approval by id, so a few seconds of skew between `jobs.sqlite` and `approvals.sqlite` is possible;
   `jobs.recover()` already handles interrupted work at start-up. Restore drills (section 5) are how that is proven.
5. `workspace.json` is a single JSON file the hub parses and rewrites whole (tens of MB on the PC today, already cached
   for reads). It is the one place write cost grows with data size. If it passes roughly 50 MB, move it to SQLite
   before adding users; that is a code change, not an ops one.
6. Disk: size from the PC's `.operator-data` (owner runs `du -sh` there once), then add 3x for backups kept on the VM
   and 2x headroom. `mail-archive.sqlite` and `uploads/` dominate.
7. Throughput is not the limit: the write rate of a two-founder business (leads, jobs, approvals) is orders of
   magnitude below what one SQLite writer on SSD does. Concurrency between founders is handled by the single process.

**Why not Postgres for the hub stores:** nothing above requires it, and changing 30-odd stores' SQL is the most
expensive way to get the same guarantee. The trigger that would change this is a second *writer host* (a real
multi-region or multi-hub design). That is not in scope and not needed to keep the workspace up when a PC sleeps.

## 4. What changes in the code, and how the PC stays unchanged

* `MU_DATA_DIR` unset gives exactly the old path. `dataDirFor(root)` is the one function; the rest of the code keeps
  passing its `root`. A test asserts the default paths for the CRM, jobs, approvals, memory state and device store.
* `MU_HUB_ROLE` unset or anything but `cloud` is `pc`, and the gate middleware is not even mounted. A test proves the PC
  role passes every request through untouched.
* In `cloud` role these routes answer **501** with `{ ok: false, status: "needs-companion", error: "This runs on your PC
  and needs the companion. It isn't available on the cloud hub." }` (never a success shape):
  native PC control (`/__operator/screen/*`, `/pc/act`, `/cad/act`, `/open-url`, `/vision/describe`), the agent browser
  (`/__operator/browser/act`), the local Claude / Codex / Hermes / Cline command-line agents (`/__claude*`,
  `/__hermes*`, `/__cline`, `/__operator/agent-jobs`, `/__operator/hermes/task`, dream engines, permission and question
  routes), and the machine's voice stack (`/__start_voice`, `/__fish_tts`). The list is one table,
  `PC_ONLY_CAPABILITIES`, shown on `/__health` as `pcOnly`.
* The gate sits **after** the identity gate, so a caller who is not signed in still gets 401 first.

### Known gaps (not hidden)

* **Hub device identity.** `scripts/devices/registry.ts` still advertises the hub as "Usman's PC" (`usman-pc`, "always
  online while this server runs"). In cloud role that is false. Agent B owns it: in cloud role the hub must not be a
  fallback target, and device commands must resolve to companions only.
* **Owner admin on the VM.** "local-owner" routes (hub keys, config, approvals of hub actions) need the loopback
  owner. Over Tailscale, Usman is `tailnet-person`, not local-owner. Plan: admin through `ssh -L 8081:127.0.0.1:8081`
  (a forwarded loopback connection is the loopback owner). **Not verified here**; verify on staging before relying on it.
* **Windows-shaped schedulers.** Reminder tasks (`scripts/windows/reminder-tasks.ts`, Task Scheduler), the dream cron,
  NotebookLM keepalive, the SearXNG launcher and the lead-engine crons are Windows or PC-profile jobs. In cloud role
  they do nothing until ported to systemd timers. This is a follow-up, listed in section 9.
* **Hindsight on Linux.** The supervisor and proxy are Windows scripts (`scripts/hindsight`, `D:\hindsight`). The hub's
  client accepts only a loopback Hindsight URL, so in cloud mode Hindsight must run **on the VM**. Until that install is
  done and verified, run the cloud hub with `HINDSIGHT_URL=off` (vault and local index only); `/__health` shows it.
* **Not run on Linux yet.** All tests ran on Windows. The shell scripts pass `bash -n`; the systemd units were not
  loaded. Staging is where that gets proven.

## 5. Migration plan: PC to cloud (reversible)

Preconditions: VM exists, Tailscale is signed in on it by the owner, `deploy/bin/install.sh` has run, the staging
instance passes `smoke.sh`, and the owner has chosen a cutover window (nothing is running that matters).

1. **Rehearse on staging.** On the PC, with the hub still running: `bun run cloud:backup --out D:\backups\mu-hub`
   (online, consistent, secrets inside: keep it private). Copy the folder to the VM over the tailnet (`scp`/`rsync`
   through Tailscale SSH), restore into `/var/lib/mu-hub/staging` (an empty folder), start `mu-hub@staging`, run
   `deploy/bin/smoke.sh staging`. Compare the row counts the restore prints with the PC's. Repeat until boring.
2. **Stop PC hub writes.** Stop the PC hub and its autostart supervisor. Confirm the PC's port 8081 no longer answers.
   From here the PC's `.operator-data` is **frozen and never modified again** (that is the rollback).
3. **Final backup** of the now-quiet PC data, with the same command. It prints per-store row counts.
4. **Copy** to the VM; `backup-cli verify` checks every sha256 against the manifest before anything is written.
5. **Restore** into an **empty** `/var/lib/mu-hub/production` (the restore refuses a non-empty folder). It re-verifies
   checksums, opens each store read-only and compares row counts with the manifest.
6. **Start** `mu-hub@production`, run `smoke.sh production`, publish with `deploy/tailscale/serve.sh production`.
7. **Flip the PCs to companions**: point each companion at the cloud hub's tailnet address. The PC hub service stays off.
8. **Watch 48 hours.** Keep the PC's frozen data folder and the final backup untouched.

**Rollback.**
* *Before the cloud hub accepted any write:* stop `mu-hub@production`, `serve.sh off production`, start the PC hub on
  its own untouched data. Nothing to restore.
* *After cloud writes exist:* take a cloud backup (`systemctl start mu-hub-backup@production`), restore that backup
  into a **fresh** folder on the PC with `bun run cloud:restore --from <backup> --to <empty dir>`, start the PC hub
  against it (`MU_DATA_DIR` or by placing it as `.operator-data`), and only then stop the cloud. The frozen original
  stays as a second fallback.
* *Code-only problem after a rollout:* `deploy/bin/rollback.sh production` (previous release, data untouched). If the
  new release changed a store's schema, restore the pre-rollout backup the rollout took.

## 6. Memory in cloud mode: one vault, one Hindsight

* **Vault.** `mu-ventures-obsidian-wiki` today is a git repo on the PC with **no remote**. In cloud mode the
  authoritative copy is a **bare repo on the VM** (`/var/lib/mu-hub/mu-wiki.git`). The hub's working clone
  (`MU_WIKI_ROOT=/var/lib/mu-hub/production-vault`) commits `save_to_vault` writes and pushes to the bare repo. Each PC
  keeps a clone for Obsidian and syncs with `git pull --rebase` and `git push` over **Tailscale SSH**. No third-party
  host, no new account. Conflicts are ordinary git conflicts in markdown; the wiki schema already keeps `raw/` append-only,
  which makes them rare. The personal Obsidian vault is **never** merged into this one.
* **Hindsight.** Runs on the VM next to the hub, loopback only, Postgres 18 on the VM's local disk, one writer (the
  hub's memory connector, `MU_MEMORY_WRITES=on` only in production). The PC's Hindsight is retired after cutover, not
  run in parallel: two writers to one pool is the failure the connector's single-writer guard exists to prevent.
  Seed it once with `pg_dump` from the PC and `pg_restore` on the VM (or rebuild from the vault, slower and lossy for
  facts saved only as memories). Nightly: `pg_dump -Fc` into the same backup folder as `backup-cli`.
* Staging never writes memory (`MU_MEMORY_WRITES=off`, `HINDSIGHT_URL=off`).

## 7. What works while a PC is offline

| Capability | Usman's PC asleep | Mehroz's PC asleep | Both asleep |
|---|---|---|---|
| Open the workspace from a phone or laptop on the tailnet | Yes | Yes | Yes |
| Leads, CRM, goals, call lists, pipeline | Yes | Yes | Yes |
| Jobs and approvals (view, approve, reject, cancel) | Yes (approve from any signed-in founder or Telegram code) | Yes | Yes |
| Decisions, business brief, pricing catalogue (read), finance records, NAB CSV import | Yes | Yes | Yes |
| Memory recall and save (Hindsight + vault on the VM) | Yes | Yes | Yes (once Hindsight runs on the VM) |
| Receptionist dashboard (feed from Vercel/Neon) | Yes | Yes | Yes |
| Chat with API models, design generation with provider keys on the VM | Yes | Yes | Yes |
| Telegram notifications and code answers | Yes | Yes | Yes |
| Native PC control, agent browser, local files, this PC's apps | No: "runs on your PC, needs the companion" | No, for his PC only | No |
| Claude / Codex / Hermes jobs that run **on a PC** | Queued until the companion is online, or refused with that line (Agent B decides queue vs refuse) | Same for his | Queued |
| Voice and wake word on a PC | No | No | No |
| Anything on a PC that is awake | Yes, through that PC's companion | Yes | n/a |

The hub reports `companions: { online, total }` on `/__health`; "a PC is asleep" is normal, not a failure.

## 8. Hosting assessment (Sydney)

All prices are **estimates, check at purchase**. AUD at about 0.65 USD. Sizing: 2 vCPU, 4 GB RAM, 80 GB SSD runs the hub
and staging; add memory (8 GB) when Hindsight and its models move onto the VM.

| | A. Sydney VPS (BinaryLane, DigitalOcean SYD1, Vultr Sydney) | B. Fly.io `syd` with a volume | C. Keep the PC hub + an always-on mini-PC |
|---|---|---|---|
| Monthly, estimate, check at purchase | **A$35 to 60**: VM A$25 to 45 (4 GB) or A$45 to 75 (8 GB), plus provider snapshots A$5 to 10, plus off-box backup storage A$2 to 5 | **A$35 to 65**: one `shared-cpu-2x` machine with 4 GB, a 40 GB volume (about A$8), snapshots, plus egress | **A$5 to 10** running (power about 10 W, plus nothing else); A$350 to 700 once for an N100/N150 mini-PC with 16 GB, about A$10 to 20 a month over three years |
| Fit to the current code | Best: the hub is a long-lived process with local-disk SQLite; `systemd` fits | Workable: needs a Dockerfile and Tailscale inside the container (userspace networking) for Serve identity headers; one machine only (no scale-out with SQLite) | Zero porting: it is today's Windows hub on a machine that never sleeps. Every Windows-only feature keeps working |
| Keeps PC-only features at the hub | No (companions do them) | No | **Yes** |
| Durability | Provider snapshots + nightly `backup-cli` off-box | Volume is tied to one host; daily snapshots; restore = new volume | Home disk: needs the same nightly backup to somewhere else |
| Availability | Datacentre power and network; a provider incident is the risk | Same; machine restarts on host maintenance | Residential NBN and power in Mount Druitt; a router or power cut is an outage |
| Tailscale identity | Plain: tailscaled on the host, Serve to loopback | Extra moving part (sidecar or in-container) | Already working today |
| Setup effort (this repo) | Done: `deploy/` | Dockerfile + fly.toml + volume + Tailscale in container (new) | Move the Windows install to the mini-PC (existing docs) |
| Main risk | Hindsight on Linux is a real install job | Container and Tailscale complexity for a single-writer app | The "PC sleeps" problem is solved, the "home outage" problem is not |

**Recommendation: A, a Sydney VPS.** It is the smallest step from what exists: no container, no new database, a
five-file deploy folder that is already written, billing in AUD, data in Australia. Start at 4 GB with Hindsight off
(vault-only memory), prove staging, cut over, then move Hindsight and resize to 8 GB. Choose BinaryLane if AUD billing
and an Australian company matter most, Vultr or DigitalOcean if hourly billing and easy snapshots matter more; all
three are interchangeable for this design. Option C is the honest fallback **if** the Windows-only features must stay
hub-side; it is cheaper but leaves the availability problem at home.

### Checked price (lead, 1 Oct 2026, binarylane.com.au/vps-hosting/linux-vps)

BinaryLane Linux NVMe, Sydney (NextDC S1), billed hourly in arrears, **ex GST**: Advanced 2 vCPU / 4 GB / 60 GB = **A$19.60/mo**; Professional 4 vCPU / 8 GB / 100 GB = **A$39.20/mo** (A$43.12 incl GST). Backups A$0.05 per GB per backup. **Proposed:** Professional (8 GB) from the start so Hindsight and staging fit without a resize: about **A$43 incl GST plus roughly A$3–6 for backups ≈ A$50/month**. This is a new monthly charge and needs the owner's yes; nothing has been bought.

## 9. Owner decisions still open

1. **Buy the VM** (provider, size, region Sydney). Nothing was purchased or created.
2. **Install and sign in Tailscale on the VM**, and enable Tailscale SSH for the vault sync. An account action the repo
   never takes.
3. **Hindsight on the VM**: approve the Linux install as its own workstream, or run vault-only memory first.
4. **Subscription CLIs** (Claude, Codex) on the VM: default is **no**; they stay on the PCs behind companions.
5. **Cutover window** and who is online for it.
6. Follow-ups for other agents or the lead: hub-device identity in cloud role (Agent B), systemd ports of the Windows
   timers, and the owner-admin path over SSH (verify on staging).

## 10. Round 3 (1 Oct 2026, Track E): hosting prices re-verified, release package, local cloud-role proof

Nothing was bought, created, signed in to or deployed.

### BinaryLane Sydney, re-read on 1 Oct 2026 (binarylane.com.au/vps-hosting/linux-vps)

Billed in arrears, hourly; Sydney facility NextDC S1; **prices are ex GST** (add 10%). NVMe plans:

| Plan (BinaryLane name) | vCPU | RAM | NVMe | Transfer | Monthly ex GST | incl GST |
|---|---|---|---|---|---|---|
| Entry | 1 | 1 GB | 20 GB | 1000 GB | A$4.90 | A$5.39 |
| Basic | 1 | 2 GB | 40 GB | 2000 GB | A$9.80 | A$10.78 |
| Standard | 2 | 4 GB | 60 GB | 3000 GB | A$19.60 | A$21.56 |
| **Professional** | **4** | **8 GB** | **100 GB** | 4000 GB | **A$39.20** | **A$43.12** |
| Advanced | 6 | 16 GB | 180 GB | 5000 GB | A$78.40 | A$86.24 |
| Enterprise | 8 | 32 GB | 340 GB | 6000 GB | A$156.80 | A$172.48 |

Provider backups: A$0.05 per GB per backup (a 100 GB disk is A$5.00 per retained backup). The page lists no hourly rate figure; monthly price is the cap. (The earlier note in section 8 used Standard/Professional correctly; BinaryLane's plan names differ from the lead's shorthand.)

**Purchase recommendation (not executed): Professional, 4 vCPU / 8 GB / 100 GB, Sydney, Debian 12 or Ubuntu 24.04. A$43.12 a month incl GST.** Reasons: Hindsight (Postgres 18 and its models) and staging both fit without a resize; 100 GB covers `.operator-data` growth plus local backups once the owner has run `du -sh` on the PC data (section 3.6); Sydney keeps data in Australia. Backups: keep the nightly `backup-cli` copy to the owner's PC over the tailnet (free) and take one provider backup before each cutover or rollout (A$5.00 each, keep two: about A$10 a month at most). **Planning figure: about A$43 to A$55 a month.** If the owner wants to start smaller, Standard (A$21.56 incl GST) runs the hub and staging with Hindsight off, and resizes up later; that is a second step, not a saving worth the extra migration.

### What was added

| Piece | Where |
|---|---|
| Release package: `git archive` of one SHA, deny list, per-file sha256 manifest, secret scan, `SHA256SUMS`, deterministic bytes, verify | `scripts/cloud/release-package.ts` (+ test), `bun run cloud:package` |
| Rollout straight from the package (checksums verified before anything unpacks, SHA must match) | `deploy/bin/rollout.sh <instance> <sha> --package <tar.gz>` |
| Execute bit on the deploy scripts (they were mode 644 in git, so `deploy/bin/rollout.sh` would not run on the VM) | git index change |
| Local cloud-role proof against the real OS server on port 8113 with isolated data, incl. restarts | `scripts/cloud/role-proof.ts`, `deploy/local/cloud-rehearsal.ps1` |
| Staging acceptance checklist | `deploy/STAGING-ACCEPTANCE.md` |

### Local cloud-role proof (port 8113, `MU_HUB_ROLE=cloud`, `MU_DATA_DIR` on D:, real Vite server, confirmed browser session via headless Chrome)

Results are in `cloud-role-round3/*.json` (22 checks, all pass):

* `/__health` says `hubRole: cloud`, the data folder is the isolated one, companions 0 online.
* The device list has no hub device and nothing called "Usman's PC" (`usman-pc` absent).
* "open Chrome" with no companion: not ok, "no device registered for usman. Nothing ran on any other machine." The native PC route (`/__operator/pc/act`) and the agent browser route answer 501 `needs-companion`.
* A shared computer named `research` that does not exist: 404 `No computer called "research".`; provisioning with no host: `No computer host is configured on this hub.`
* Restart (the hub killed and started again on the same data): the same job ids and states are listed (nothing re-run, nothing lost); the pairing code made before the restart still redeems; the companion it paired is still in the device list after a second restart; the owner's session cookie still works.
* No replay after uncertainty: the in-process suites for it pass (`scripts/devices/*.test.ts`, `scripts/jobs/*.test.ts`, `RECOVERY-EVIDENCE.md`: hub kill gives "unknown, not re-run"); this run adds that a restart never re-runs a not-run job.
* Not covered here (needs the real VM): Linux systemd, Tailscale Serve identity, a real companion dialling in from a PC.

### Package built for review (1 Oct 2026)

`D:/prog-scratch/release/` (scratch, not committed): `mu-hub-1839af264409.tar.gz` for commit `1839af264409e003662caa8e40c41112e73d5633`, 2,891 files / 137.1 MiB unpacked, 112,913,050 bytes, sha256 `<sha256 withheld>`; 552 tracked files left out (screenshots 19, `screens` 67, docs media 466); secret scan 0 hits (16 in test fixtures, which hold deliberate fakes); verified by the tool and independently (`sha256sum -c`, `tar -t`: no `.env`, `.operator-data`, sqlite, key, credential, log or screenshot paths; deploy scripts mode 755 with LF endings). Later commits on this branch change docs only; rebuild for the SHA that is rolled out.
