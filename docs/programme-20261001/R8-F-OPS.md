# Round 8, track F: operations and release recovery on the Ryzen hub

Track F, model `claude-opus-5-5`, 3 Oct 2026. Worktree `D:\AgenticOS-r8-f-ops`, branch `r8/f-ops-20261003`, base `74ace895`.

**What was touched on Ryzen:** three read-only probe scripts copied to `C:\mu-hub\ops-check\` and run once each, between 13:38 and 13:42 AEST,
before the round 8 release. Nothing was stopped, started, restarted or run from Task Scheduler; no file outside `ops-check` was written; no git
state was changed (`git --no-optional-locks`, read commands only); no browser was paired and no code minted. No env file, credential file or
environment value was read or printed: the env file was checked for existence, size and date only. `devices.json` was not opened (size and date only).
The one program run from the production checkout was `backup-cli.ts verify`, which only reads a backup folder.

Evidence: `docs/programme-20261001/evidence/r8-f-ops/` (`probe1.ps1`..`probe3.ps1` and their `.out`). In `probe1.out` the section headers were
restored by hand: the script's header function was named `H`, which PowerShell resolves to `Get-History`, so each header printed an error instead.
The data lines are as captured. The copy of `probe1.ps1` in the evidence folder has the function renamed.

## Verdict

The hub is healthy and recoverable. Nothing found needs action before the release. Four defects were fixed in code (below); the rest are
steps for the lead or the owner, listed at the end.

| # | Area | Verdict |
|---|---|---|
| 1 | Health and supervisor | **OK.** Hub up 11.7 h on `5fc21c05`, supervisor attached, 5 failures ever, all recovered. One defect fixed (crash output erased). |
| 2 | Backups | **OK.** Nightly ran 03:15, all 4 backups re-verified today. Two defects fixed (prune before verify, wrong role label). |
| 3 | Rollback | **Tag exists and is an ancestor of HEAD, but the next release will move it.** Six gaps in `release.ps1`, none blocking. |
| 4 | Sessions across restart | **Preserved.** On disk, in the backup. One defect fixed (an unreadable store could be overwritten empty). |
| 5 | Preview and exposure | **OK.** `:8443` and `:8445` tailnet only; Funnel only on 443 to 8096. Confirmed from the public ingress. |
| 6 | Dependencies | **All up.** Hindsight and Dot's staging gateway are running outside any task: neither is proven to come back after a reboot. |
| 7 | Capacity | **No pressure.** C: 82% free, D: ~100% free, logs under 12 KB, hub 0.9 GB working set. |

## 1. Health endpoints and supervisor

```
http://127.0.0.1:8081/__version -> HTTP 200 in 19 ms   body: {"ok":true}
http://127.0.0.1:8081/__health  -> HTTP 401
https://ryzen-pc.tailnet-name.ts.net:8443/__version -> 200 from the main PC over the tailnet:
    {"version":"3.6.1","gitSha":"5fc21c0","dirty":true,"buildTime":"2026-10-02T16:00:31.084Z"}
```

`dirty:true` is the owner's overlay (35 entries in `git status`, counted, not listed). On loopback in the server role `/__version` answers only
`{"ok":true}` and `/__health` wants a session, so from the hub itself there is no unauthenticated way to read which commit is serving
(matters for `release.ps1`, section 3).

Process chain (probe 2): `services -> svchost (Schedule) -> powershell [mu-hub-supervisor] pid 16124 -> bun pid 17480 -> bun pid 18508 (listens 8081 and 8091)`,
all started 02:00:25 to 02:00:26 on 3 Oct, i.e. by the last release.

Task definitions (`probe1.out`, "scheduled tasks"):

| Task | Trigger | Logon | Restart on failure | Time limit | Last run / result |
|---|---|---|---|---|---|
| `\MU\MU Hub Supervisor` | boot +45 s | S4U, limited | 10 x 5 min | none | 3 Oct 02:00:25, `0x41301` (running) |
| `\MU\MU Hub Backup` | daily 03:15 (+10:00) | S4U | 2 x 30 min | 3 h | 3 Oct 03:15:01, `0x0` |
| `\MU\MU WSL KeepAlive` | boot | S4U | 10 x 5 min | none | 2 Oct 12:53, running |
| `\MU\MU SearXNG` | boot +60 s | S4U | 10 x 5 min | none | 2 Oct 12:54, running |
| `\MU\MU Vault Autocommit` | boot +60 s and every 10 min | S4U | none | 10 min | 3 Oct 13:28, `0x0` |
| `\MU\MU Hermes Gateway` | boot +90 s | S4U | 999 x 1 min | none | 2 Oct 18:06, `0x0` (launcher exits, gateway stays) |
| `\Hindsight\Hindsight pilot supervisor` | boot | S4U | none | none | **never run** (`0x41303`) |
| `\Hindsight\Hindsight nightly backup` | daily 03:30 (+10:00) | service account, highest | none | 30 min | 3 Oct 03:30:01, `0x0` |

All are `MultipleInstances=IgnoreNew`. The supervisor's action is
`mu-hub-supervisor.ps1 -RepoRoot C:\mu-hub\AgenticOS-v4 -BunPath C:\mu-hub\bin\bun.exe -Port 8081 -DataDir C:\mu-hub\data\production -LogDir C:\mu-hub\logs -EnvFile C:\mu-hub\config\hub.env -HubRole server`.
The deployed `deploy\windows\*.ps1` are unmodified from the checkout's commit (`git status -- deploy scripts/cloud` = 0 entries).

**What the supervisor does if the hub dies** (from `deploy/windows/mu-hub-supervisor.ps1`, not by killing it):

- Probes `/__version` every 15 s (10 s timeout). The hub process exiting, or 5 failed probes in a row (about 75 s to 2 min of a hung hub), counts as a failure.
- On a failure it kills the hub's process tree, waits up to 20 s for the port, then restarts after 2, 5, 15, 60, 60... s. The counter resets after 300 s healthy.
- 6 failures inside 10 minutes: it logs `GIVING UP`, exits 2 and does not restart. Whether Task Scheduler's "restart on failure" then re-runs it is
  **not proven**: it has never happened here (0 `GIVING UP` lines) and Windows applies that setting to failed starts more reliably than to non-zero exits. Treat a give-up as "the hub stays down until someone starts the task".
- A second supervisor exits 0 on the mutex. A start with 8081 already taken logs `REFUSING TO START` and exits 3.
- When the task is *ended* by Task Scheduler the process is terminated, so its `finally` (which would stop the hub) does not run and the hub is left
  holding 8081. `release.ps1` covers this by killing the listeners itself.
- Nothing tells a person. There is no alert on give-up, on a failed backup or on low disk (`scripts/cloud/health-watch.ts` does this for the Linux
  layout; nothing runs it on Ryzen). See proposed step P6.

History (`mu-hub-supervisor.log`, 25 lines in total): 4 supervisor starts; 5 `FAILURE` lines, 0 `GIVING UP`, 0 `REFUSING`.

```
2026-10-02 18:09:03 FAILURE: hub exited (code 255)
2026-10-02 18:09:04 restarting in 2s (consecutive failure 1)
2026-10-02 18:09:15 hub is up on port 8081 after 10s (pid 10232)
2026-10-02 18:10:01 FAILURE: hub exited (code 255)
2026-10-02 18:10:16 hub is up on port 8081 after 11s (pid 19056)
2026-10-02 18:15:17 hub stable for 300s; failure counter reset
```

**Defect F1 (fixed): the reason for those two exits is gone.** The supervisor starts the hub with `Start-Process -RedirectStandardOutput/-Error`, which
truncates both files, and it rotated them only above 10 MB. So each restart erased the output of the hub that had just died. On Ryzen there is no
`hub-stderr.log.1` and the current files hold 813 and 260 bytes from the 02:00 start only (`probe3.out`). Fix: any non-empty file is rotated before every
start (`.1` is the previous run, up to `.5`), and the failure line says where the output is.

## 2. Backups

```
last-backup.json: ok true, verified true, 2026-10-03T03:15:16+10:00, D:\mu-hub-backups\production\backup-20261002T171507Z, 6109 files

backup-20261002T080759Z: gitSha 317c5e6 role pc files 6105 sqlite 13 bytes 249,146,797   verify: exit 0 in 5.5s : verified: 6105 files match the manifest
backup-20261002T145436Z: gitSha 317c5e6 role pc files 6107 sqlite 13 bytes 249,230,224   verify: exit 0 in 3.6s : verified: 6107 files match the manifest
backup-20261002T160012Z: gitSha 1eeb96c role pc files 6109 sqlite 13 bytes 249,236,227   verify: exit 0 in 3.4s : verified: 6109 files match the manifest
backup-20261002T171507Z: gitSha 5fc21c0 role pc files 6109 sqlite 13 bytes 249,237,025   verify: exit 0 in 3.5s : verified: 6109 files match the manifest
```

- **Verification today:** every production backup re-verified with the existing command, `bun --no-env-file scripts/cloud/backup-cli.ts verify --from <folder>`
  (recomputes every size and sha256 against the manifest; reads only). All four pass. This proves the files are intact, not that a hub starts on them:
  the last restore rehearsal is R7 journey L (synthetic data) and the staging rollback rehearsal of 3 Oct.
- **Runs:** four so far: the cutover (2 Oct 18:08), two taken by releases with the hub stopped (00:54 and 02:00) and one nightly (03:15). The nightly has run once.
- **Size and growth:** 239 MB each. Data dir is 243 MB in 6,123 files (`workspace.json` 56 MB, `lead-sites` 66 MB, `vault` 52 MB, `uploads` 40 MB).
  Retention is the newest 14 folders, so about 3.3 GB at today's size on a disk with 928.7 GB free. `D:\mu-hub-backups` holds 2.55 GB in all
  (production 956 MB, `cutover-20261002` 1.39 GB, `from-main-pc` 203 MB).
- **Separate disk:** C: is physical disk 1, D: (`MU-BACKUP`) is disk 0. The backup folder's ACL is the owner account, SYSTEM and Administrators only, inheritance cut.
- **Retention counts folders, not days.** A release takes a backup too, so two releases a day halve the days covered. With one nightly plus the odd release it is about two weeks.
- **Daylight saving:** the trigger is stored as `03:15+10:00`, so from Sunday 4 Oct it fires at 04:15 local (`nextRun=2026-10-04T04:15:00`); Hindsight's
  moves to 04:30 the same way, so the order holds. Harmless, noted so the new time is not read as a fault.
- **Hindsight:** `D:\hindsight-backups\pilot` holds two dumps of 0.8 MB (2 Oct 19:51, 3 Oct 03:30), keep 14 days. Not restore-tested by this track.

**Defect F2 (fixed): retention ran before verification.** `backup-cli.ts backup --keep N` pruned to the newest N as soon as the new folder was written;
`mu-hub-backup.ps1` verified afterwards. A backup that fails verification still pushed the oldest good one out, so 14 bad nights in a row would leave no
verified backup. Fix: the CLI verifies the new folder against its own manifest first and prunes only if it passes; otherwise it exits 1 and removes nothing.

**Defect F3 (fixed): every manifest says `role pc` on a server-role hub.** The backup task never passed the role and the script defaulted `MU_HUB_ROLE` to `pc`.
It is a label only (restore does not read it), but it is wrong on the one field that says what kind of hub the backup came from. Fix: `mu-hub-backup.ps1 -HubRole`,
and the installer passes it to the backup task as it already did for the supervisor. Takes effect on Ryzen only when the task is re-registered (P4).

## 3. Recovery and rollback

```
HEAD: 5fc21c05608d6516eced742883a4e82eda90f981   branch: ryzen/migration-20261002
  rollback/pre-agents-20261002       -> 1eeb96ca  (tagged 3 Oct 00:31)   ancestor of HEAD: yes
  rollback/pre-r6b-20261002          -> 166313ec
  rollback/staging-rehearsal-20261003 -> 317c5e6a
```

The tag exists and points at `1eeb96ca` ("Gate fixes: Setup save time goes through format.ts..."), the build before the agents release. The matching
data is `backup-20261002T160012Z` (gitSha `1eeb96c`, taken with the hub stopped at 02:00, verified above).

`release.ps1`'s rollback path, as written: a failure before the code changes restarts the unchanged hub. A failure after: stop the hub, `git reset --keep`
to the old head (owner files kept), put `hub.env` back from the copy, and if the new code (or the CRM migration) ran, restore the pre-release backup into
`production.restore-<stamp>`, rename the live folder to `production.failed-<stamp>` and the restored one into place, then start the old hub.

Checked: the restore runs *after* the reset, so it runs the old commit's `backup-cli.ts`. At `5fc21c05` that CLI has no `--keep-sessions` flag, but it
ignores unknown flags and copies the store byte for byte, which is what "keep sessions" means. From the next release on the flag is required and is passed. No gap there.

Gaps, in order of weight:

1. **The rollback tag is reused.** `git tag -f $TagName $before` with the default name moves `rollback/pre-agents-20261002` to whatever was running. After
   the round 8 release it will point at `5fc21c05` and the name will be wrong; the present rollback point `1eeb96ca` loses its name. Pass a fresh name per
   release (P1).
2. **No rollback once the script has printed RELEASED.** A fault found an hour later has no scripted path, and the three things needed are only in the
   console scroll: the old head, the backup folder and the env copy. `last-backup.json` is overwritten by the 03:15 backup. Write a receipt (P2).
3. **"Answering" is the only health test.** Success is one `200` or `401` from `/__version`, which on loopback is `{"ok":true}` whatever commit is running.
   It does not show the new commit is the one serving, and a hub that boots and dies 30 s later is released. Add a settle check (P3).
4. **The folder swap can fail with the hub down.** `Rename-Item` on the data dir fails if anything has a file open under it. If it does, the script
   prints `RECOVERY FAILED` and stops with the hub stopped, the code already reset and the restored copy sitting beside the live folder. The hub's own tree
   is killed first, but two helper PowerShell processes are children of the hub (pids 18220, 22404) and other tools may read the folder. Not observed to fail;
   the staging rehearsal passed. The manual finish is two renames and `Start-ScheduledTask`.
5. **`hub.env` copies pile up.** Each run leaves `hub.env.pre-release-<stamp>`; `C:\mu-hub\config` now holds three copies plus `hub.env.broken-20261003`.
   The folder ACL is tight (owner, SYSTEM, Administrators) but they are full copies of the secrets file and nothing removes them (P5).
6. **Cosmetic:** a failure before the hub was stopped (wrong branch, not a fast-forward) still goes through "start and wait" and prints `ROLLED BACK`
   although nothing was touched.

Also: the task brief gives the env file as `C:\mu-hub\hub.env`. That path does not exist; the file is `C:\mu-hub\config\hub.env`, as `release.ps1` and the task have it.

## 4. Session preservation across a restart

From the code (`scripts/devices/store.ts`, `scripts/identity/principal.ts`):

- Browser sessions, companions, pairing codes, policy and the hub-trust marker are all in `<data dir>\devices.json`; the cookie signing key is
  `<data dir>\devices-secret`. Nothing about a session lives only in memory. Each write goes to a temp file and is renamed into place.
- The cookie is `mu_session`, 30 days, and only its hash is stored. A restart changes neither file, so **a restart does not drop a paired browser**.
  A *pending* (unconfirmed) session survives too. An unused pairing code survives but still expires after 10 minutes.
- Both files are in every backup (`session store files in backup: devices-secret, devices.json`), so a rollback with `--keep-sessions` keeps logins as of the
  backup. Sessions paired between the backup and the rollback are lost; in a release that window is the few minutes the new hub ran.

Evidence on Ryzen: `devices.json` 118,954 bytes, last written 2 Oct 19:22; `devices-secret` 32 bytes, 28 Sep. Neither changed across the three restarts
of 3 Oct (00:54, 00:55, 02:00). No leftover `devices.json.*.tmp`. I did not test a browser across a restart (read-only brief).

**Defect F4 (fixed): one unreadable moment could sign everyone out for good.** `read()` returns an empty state for *any* error, and every write is
read, change, save. If the file existed but could not be read at that instant (on Windows a scanner or the backup holding it; or a file that does not
parse), the next write saved the empty state over the real one: every session and companion gone, and the hub-trust marker with them. Found by reading the
code; not seen in production. Fix: a write starts from empty only when the file is absent; otherwise it retries for about 0.6 s and then refuses, leaving
the file untouched. Reads still fail closed (nobody signed in). This is `scripts/devices/store.ts`, outside `scripts/identity/**`, but it is the session
store: the lead should look at the diff.

**Review fixes to F4 (F5).** The first version parsed the file and then called `read()`, which read it a *second* time and still turned any failure into an
empty store, so a lock between the two reads saved an empty store over the real one. Now a write reads and parses exactly once and builds its state from that
parsed object (`stateFromParsed`, shared with `read()`). Valid JSON of the wrong shape (`null`, `[]`, `{}`, `sessions` not a list) is now "unreadable",
not "empty". Who can do what is unchanged.

**When the sign-in records can't be read** (the hub refuses to overwrite them, so every pairing, sign-in, confirm and companion write fails, and nobody is
recognised as signed in):

- `/__health` reports `components.sessionStore` as `failed` (HTTP 503), detail "Sign-in records can't be read (...): nothing will be overwritten.", with
  the recovery below.
- The System page shows a danger notice "Sign-in records can't be read — nothing will be overwritten" with the same detail and recovery.
- The supervisor logs `WARNING: sign-in records can't be read: <reason> ...` before each hub start.
- Limit: in the **server role** (Ryzen) `/__health` and the System page need a signed-in browser, and while the records can't be read there is none.
  On Ryzen the signal you can actually see is the supervisor log line. None of these shows the file's contents, only the condition.

**Owner recovery** (on the hub, in a normal PowerShell; never edit the file in place):

1. Stop the hub: `Stop-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Supervisor'`, then make sure nothing listens on 8081.
2. Move the damaged file aside: `Rename-Item C:\mu-hub\data\production\devices.json "devices.json.corrupt-$(Get-Date -Format yyyyMMddTHHmmss)"`.
3. Either **restore** from the newest verified backup, which keeps every sign-in as of that backup (`last-backup.json` names it; check it first with
   `bun scripts/cloud/backup-cli.ts verify --from <folder>`): `Copy-Item <folder>\devices.json C:\mu-hub\data\production\`;
   or **start empty** by doing nothing more: every browser and companion pairs again. The signing key (`devices-secret`) is untouched either way.
4. Start the hub: `Start-ScheduledTask -TaskPath '\MU\' -TaskName 'MU Hub Supervisor'`. Keep the `.corrupt-<time>` file until sign-in works, then delete it.

## 5. Private preview (:8445) and exposure

```
https://ryzen-pc.tailnet-name.ts.net        (Funnel on)     |-- / proxy http://127.0.0.1:8096
https://ryzen-pc.tailnet-name.ts.net:8443   (tailnet only)  |-- / proxy http://127.0.0.1:8081
https://ryzen-pc.tailnet-name.ts.net:8445   (tailnet only)  |-- / proxy http://127.0.0.1:8081
```

`tailscale serve status` and `funnel status` print the same three lines. The only Funnel is 443 to 8096, Dot's staging gateway, as approved.

From the public side (this PC, forcing the name to its public Funnel address `43.245.48.174`, so the request does not use the tailnet):

```
public-ingress port 443:  http=401                       (Dot's gateway, wants its own auth)
public-ingress port 8443: http=000 TLS handshake refused
public-ingress port 8445: http=000 connection timed out
```

From the tailnet: `:8443/__version` 200; `:8445/__version` 404 and `:8445/_mu-preview/open/x` 404. The preview origin serves nothing of the hub
(`scripts/lead-sites/preview-origin.ts` answers every request on that Host itself, after the identity check) and an unknown preview name is refused.
Generated previews and their files are reachable only through `:8445` or the hub on `:8443`; the local preview listener 8091 is bound to `127.0.0.1`.

Listeners: every application port is on `127.0.0.1` (8081, 8086, 8090, 8091, 8096, 8642, 8878, 8888, 5432). The only user-process listener on all
interfaces is `sshd` on 22. `tailscaled` holds 443, 8443 and 8445 on the tailnet addresses.

## 6. Service dependencies

| Service | Port | State | Supervised by | Comes back after a reboot? |
|---|---|---|---|---|
| Hub | 127.0.0.1:8081 (+8091 previews) | up, 200 | `\MU\MU Hub Supervisor` | yes (boot task; ran from the task) |
| SearXNG (in WSL) | 127.0.0.1:18888 | up, 200 | `\MU\MU SearXNG` | yes; recovered itself once, 2 Oct 13:26 |
| WSL `kali-linux` | n/a | Running (v2) | `\MU\MU WSL KeepAlive` | yes; keep-alive restarted once, 2 Oct 13:26 |
| Hermes gateway | 127.0.0.1:8642 (`/health` 200), 8090 | up since 2 Oct 18:06 | `\MU\MU Hermes Gateway` | started by the task once; not boot-tested |
| Hindsight pilot | 127.0.0.1:8888 (`/health` 200), second listener 8878, Postgres 5432 | up since 2 Oct 17:59 | its own Python supervisor, **started by hand** | **unproven**: the boot task has never run |
| Dot's staging gateway | 127.0.0.1:8096 (public via Funnel), 8086 | up since 3 Oct 01:13 | **nothing** (`cmd.exe`, parent gone) | **no** task: after a reboot the Funnel points at a dead port |
| Vault autocommit | n/a | every 10 min, `0x0` | task | yes |

The machine has not rebooted since 1 Oct 20:20, before most of this was installed, so "comes back after a reboot" is by reading the tasks. It has not happened yet.

## 7. Capacity

```
C: size 464.7 GB free 382.8 GB (82% free)      D: [MU-BACKUP] size 931.5 GB free 928.7 GB
memory: total 15.9 GB free 4.7 GB ; cpu load 6%
hub pid 18508: WS 891 MB private 1,406 MB cpu 1,268 s handles 4,824   (after 11 h 41 min)
```

- **Hub:** 1,268 CPU-seconds in 11.7 h is about 3% of one core. Working set went 859, 885, 891 MB across the four minutes of probing. That is one
  sample of a hub that is being used, not a trend; take the same reading after the release and a day later before calling it growth.
- **Other large processes:** Hindsight 1,172 MB, WSL VM 1,120 MB, Dot's staging hub (8086) 499 MB. 4.7 GB free of 15.9 GB.
- **Logs:** `C:\mu-hub\logs` is 8 files, under 12 KB in all. The hub's own stdout and stderr are 260 and 813 bytes. Explorer and `dir` show them as
  0 bytes while the hub holds them open (the directory entry is stale); `probe3.ps1` reads the true size. Hermes logs 0.6 MB.
- **Backups:** section 2. About 239 MB a night until 14 are kept.
- **Space that can go when someone decides:** `C:\mu-hub\dot-gateway-staging` 2.1 GB, `incoming` 1.4 GB, `crm-migration-rehearsal` 550 MB, `staging` 361 MB,
  `D:\mu-hub-backups\cutover-20261002` 1.39 GB. None of it matters at 82% free.

## Fixes on this branch

| | Defect | Files | Test |
|---|---|---|---|
| F1 | A restart erased the dead hub's output | `deploy/windows/mu-hub-supervisor.ps1` | `Test-MuHubWindows.ps1`: kills a fake hub, checks `hub-stdout.log.1` holds its output |
| F2 | Retention pruned before verification | `scripts/cloud/backup.ts`, `backup-cli.ts` | `scripts/cloud/backup-prune.test.ts` |
| F3 | Backups labelled `role pc` on a server hub | `deploy/windows/mu-hub-backup.ps1`, `Install-MuHub.ps1` | `Test-MuHubWindows.ps1`: role reaches the backup command and the task plan |
| F4 | An unreadable session store was overwritten empty | `scripts/devices/store.ts` | `scripts/devices/store.test.ts` |
| F5 | Review of F4: second read, wrong-shape JSON, silent failure | `scripts/devices/store.ts`, `scripts/cloud/health.ts`, `src/lib/session-store-health.ts`, `src/components/shell/pages/session-store-notice.tsx`, `system-page.tsx`, `deploy/windows/mu-common.ps1`, `mu-hub-supervisor.ps1` | `store.test.ts` (a reader that fails from the second call; null, [], {}), `scripts/cloud/health-session-store.test.ts`, `scripts/session-store-notice.test.tsx`, `Test-MuHubWindows.ps1` (helper, and a supervisor run with a damaged file) |
| ref | The release script, as a reviewed reference copy | `deploy/windows/release-ryzen.ps1` | `deploy/windows/tests/Test-ReleaseRyzen.ps1` (static: parses, settle, receipt, rollback flags; never runs it) |

Run on the main PC after merging `3bc6f9e0`:

```
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuHubWindows.ps1      passed: 151   failed: 0   (full run, slow section included)
powershell -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-ReleaseRyzen.ps1      passed: 28    failed: 0
bun test store, health-session-store, session-store-notice, backup-prune, cloud, restore-sessions     54 pass, 0 fail
bun test scripts/devices scripts/identity                                                           467 pass, 0 fail
tsc -p tsconfig.scripts.json and tsc --noEmit                                                       no errors in the touched files
```

Not run: the whole repository suite (kept to this track's files, as asked). None of the fixes is live on Ryzen; F1 and F2 arrive with the release that carries
this branch (F1 from the next supervisor start), F3 needs P4.

## Proposed steps for the lead (nothing here was done)

- **P1, this release:** run `release.ps1` with `-TagName rollback/pre-r8-20261003`, so `rollback/pre-agents-20261002` keeps pointing at `1eeb96ca`.
  The default is still the old name.
- **P2, done in the lead's script:** it writes `C:\mu-hub\logs\release-<stamp>.json` (old head, new head, tag, backup, env copy, CRM migration).
- **P3, partly done:** the lead's script now waits 75 s and requires a second answer and a live listener. Not yet: checking `mu-hub-supervisor.log` for a
  `FAILURE` line since the start (a hub the supervisor restarted inside the 75 s still passes), and proving the commit through `:8443/__version`.
- **P10, the lead's working copy of `release.ps1`** (the reference copy `deploy/windows/release-ryzen.ps1` has (a) and (b) fixed):
  (a) `-AdoptCommit` runs `git ls-files --error-unmatch -- $p 2>$null` under `$ErrorActionPreference = 'Stop'`. In Windows PowerShell 5.1 that
  **throws** when git writes to stderr (checked here: `RemoteException`), so adopting any *untracked* overlay file fails the release in pre-update.
  That failure is safe: the adopted files are put back. Use `[bool](git ls-files -- $p)`.
  (b) The RELEASED line holds a carriage-return character where `\r` of `$LogDir\release-...` was meant (cosmetic: a mangled path on screen).
  (c) Untested risk: adoption checks out or deletes files in the checkout **while the hub is still running** (the hub is stopped afterwards), and the
  dev server watches that folder. Moving the adoption to after `Stop-Hub` avoids a live hub reloading half-changed files. The working copy also mixes a
  BOM with LF endings; the reference copy is ASCII with CRLF.
- **P4, after this branch is on Ryzen:** re-register the tasks from an elevated PowerShell so the backup records the right role: the same
  `Install-MuHub.ps1` line as at cutover, with `-HubRole server`. It replaces the same `\MU\` tasks; the hub is not restarted unless `-StartNow` is given.
- **P5, owner's call (it deletes files):** remove `hub.env.broken-20261003` and the older `hub.env.pre-release-*` copies in `C:\mu-hub\config`, keeping the newest.
- **P6:** no alert exists for a supervisor give-up, a failed backup or low disk. The smallest version is a 10-minute task that reads `last-backup.json`
  and the supervisor log and sends the existing Telegram DM on a change of state. Needs a build; not started.
- **P7, at the next planned reboot:** check that Hindsight (8888), Hermes (8642), SearXNG (18888) and the hub come back unaided. Hindsight is the one with no evidence.
- **P8, Dot's lane:** the staging gateway on 8096 and 8086 has no task and no supervisor while a public Funnel points at it.
- **P9, tidy:** `C:\mu-hub\ops-check\` holds only this track's three probe scripts and can be deleted.
