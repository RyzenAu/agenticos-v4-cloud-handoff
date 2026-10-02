# Ryzen-PC hub migration: checklist, state and cutover runbook (2 Oct 2026)

Goal: Ryzen-PC is the one authoritative hub; the main PC and Mehroz's PC become clients with personal companions.
Words: **verified** = checked on the real machine; **built** = code + tests, not yet run on Ryzen; **owner** = human-only step.

**Cutover status is recorded at the bottom (section 9). Until it says done, the authoritative hub is the main PC, `127.0.0.1:8081`.**

## 1. State at start (verified)

- Main PC: `jarvis-voice` `6607e4f7`, `/__version` `6607e4f` dirty, role `pc`, 13 stores, 35 uncommitted owner entries (Aldergate preview work under
  `scripts/lead-sites/`, docs, skills) preserved untouched. 12 jobs, none active. LAN `192.168.1.103`/`.122` (not `.130`).
- Rollback tag `rollback/pre-r6b-20261002`; historical backups `D:\AgenticOS-backups\backup-20261002T005024Z` and `backup-20261002T021459Z` (main PC).
- Ryzen-PC: `RYZEN-PC`, user `mkhan` (admin), Windows 11 Pro, 15.9 GB RAM, `192.168.1.120`, Tailscale `ryzen-pc.tail572fa0.ts.net` (100.103.119.46),
  ssh ed25519 `SHA256:FPJlvT3Ow9+feqIyVBE+xAA6p/oLzCEHPoRxHrhatwk`. WSL2 `kali-linux`, mirrored networking, 12 GB, 6 threads.

## 2. Code (branch `ryzen/migration-20261002`, worktree `D:\AgenticOS-ryzen-migration`; not merged into `jarvis-voice`)

| Piece | Branch / commit | Tests | Review |
|---|---|---|---|
| Photo index accepts `MU_DATA_DIR` outside the repo (a `pc` hub with relocated data would not start) | `f9cadcaa`, `8cb3d1c8` | photo-index 10 pass | independent review: sound; follow-ups applied |
| Windows boot tasks: supervisor, WSL keep-alive, SearXNG, verified backups to another disk (`deploy/windows/`) | `ryzen/ops-20261002` `1539f869` + `faa2d2f0`, `5c6075b9` | 97 pass (PS 5.1) | lead-tested on Ryzen |
| Desktop app remote-hub mode (`hubUrl`; never starts a local hub; broken config fails closed) | `ryzen/desktop-20261002` `28cf46b7`, `2d72cc9c` | cargo 44 pass | independent review; 7 fixes applied |
| Remote previews through an authenticated second Serve origin (`:8445`), `/__lead-sites` for founders | `ryzen/previews-20261002` `263a9280` | lead-sites 81 pass | review in progress |
| `MU_HUB_ROLE=server`: founders (paired browser) get hub-side features, console-only set, hub is nobody's desktop | `ryzen/server-role-20261002` `282c7041` | 378 related, full suite 11,873/0 | review in progress; loopback-proof follow-up in progress |
| Hermes staging record + scripts | `4aade986` | n/a | n/a |

Every worktree's `node_modules` is a directory JUNCTION to the canonical checkout: never delete one recursively.

## 3. Ryzen-PC as it stands (verified unless marked)

| Item | Where / state |
|---|---|
| Bun 1.4.2, Git 2.55, Node 24, Claude Code 2.1.286 (+ pinned 2.1.280 bridge), Codex 0.159.0 | `C:\mu-hub\bin\bun.exe`, machine installs, `%APPDATA%\npm`, `%LOCALAPPDATA%\claude-bridge` |
| Hub checkout | `C:\mu-hub\AgenticOS-v4` on `ryzen/migration-20261002` + the 35-entry owner overlay (hash-checked) |
| Backup disk | `D:` MU-BACKUP (separate 932 GB HDD, owner approved). `D:\mu-hub-backups` ACL mkhan/SYSTEM/Administrators |
| Staging hub (inert) | `http://127.0.0.1:8082`, Serve `https://ryzen-pc.tail572fa0.ts.net:8444` (tailnet only). Restored copy of 2 Oct 02:14 data, `AGENTIC_OS_NO_BACKGROUND=1`, memory/triggers off |
| Remote sign-in proof | from the main PC over tailnet HTTPS: UI rendered signed in as Usman; `/__jobs` 200; plain LAN to 8082/8444 unreachable |
| Scheduled tasks `\MU\` (S4U, boot, no logon needed) | `MU WSL KeepAlive` and `MU SearXNG` **running from session 0**; `MU Hub Supervisor` and `MU Hub Backup` registered **Disabled** until cutover |
| SearXNG | WSL user `searx`, commit `3cd69d3`, fresh secret, 127.0.0.1:18888; real searches return results |
| WSL hardening | `/etc/wsl.conf`: interop off, automount off (backup `/etc/wsl.conf.pre-ryzen-hardening`). Before: any Linux user (bot desktop users included) could run Windows programs as mkhan and read the secrets file. After: blocked, verified |
| Bot control path | loopback-only key `~\.ssh\mu_bots_local_ed25519` (`from="127.0.0.1,::1"`), alias `ryzen-local`, host key pinned after matching the fingerprint; `ssh ryzen-local wsl.exe ... id` → root |
| Repositories | `C:\mu-hub\repos\{muv-marketing, muv-demo-dental, muv-demo-conveyancing, aldergate (9f374eb), muv-flagship-legal}`, all branches, matching SHAs; owners' uncommitted edits stay on the main PC. Compatibility junction `C:\Users\Nebula PC\source\repos` → `C:\mu-hub\repos` (template code hard-codes that path; the owner's dirty `next-templates.ts` is not edited) |
| Secrets file | `C:\Users\mkhan\.config\agentic-os.env` (machine-to-machine copy, hash match, ACL restricted, never opened) |
| Hermes | staged inert, same build `cdceca42`, config/skills/cron definitions copied, `auth.json` NOT copied, no gateway/autostart (`ryzen-hermes/RYZEN-HERMES.md`) |
| Hindsight | staging in progress: real folder `C:\mu-hub\hindsight`, junction `D:\hindsight` → it, synthetic profile only |
| Desktop installer (remote-capable) | built on the main PC: `D:\AgenticOS-ryzen-migration\desktop\src-tauri\target\release\bundle\nsis\Jarvis_0.2.1_x64-setup.exe` |

## 4. Still dependent on the main PC (and why)

- Everything, until cutover (section 6).
- After cutover, by design: the owner's microphone/voice and control of the owner's own desktop (personal companion), local tools not moved
  (OpenClaw, NotebookLM venv, Jarvis Chrome CDP profile, crawl4ai, jev-seo, changedetection, Ollama), the personal Obsidian vault, and the
  owners' uncommitted working trees in the site repos.

## 5. Owner steps (all on Ryzen unless stated)

1. Tailscale tray → **Run unattended** (currently off).
2. `claude` → sign in (Claude Max 1). Then with `CLAUDE_CONFIG_DIR=C:\Users\mkhan\.claude-mu-max-2` → sign in (Claude Max 2).
3. `codex` → confirm/sign in (an older `~\.codex\auth.json` already exists on Ryzen).
4. Hermes: `hermes auth add openai-codex --type oauth --no-browser`, three times (the pooled ChatGPT accounts).
5. After everything works: sleep "Never" on AC (currently 5 h), then one reboot test without logging in.
6. Mehroz: install the desktop app with `-HubUrl` and pair his companion (needs him).

## 6. Cutover runbook (single hub at every moment)

Pre-checks: all branches merged into `ryzen/migration-20261002`; serial release gate passes; reviews have no open blocker; owner steps 2–4 done
(or explicitly accepted as "coding/Hermes wait"); no active job on the main hub.

1. **Quiesce the main PC** (order matters, each step verified):
   rename `Startup\Agentic OS.vbs`, `Hermes_Gateway.vbs`, `Hindsight.vbs` → `*.disabled`; stop the main supervisor (it restarts the hub and the gateway);
   stop the hub (8081/8091 free); `hermes gateway stop`; `hindsightctl stop` (proxy → API → Postgres); main SearXNG may keep running (read-only, harmless).
   The Jarvis desktop app starts a local hub at login: replace it with the remote build (`install-jarvis-desktop.ps1 -SkipBuild -HubUrl https://ryzen-pc.tail572fa0.ts.net:8443`).
2. **Final data** on the main PC: `backup-cli backup` + `verify`; Hindsight `pg_dump -Fc` via `backup.ps1` + `pg_restore --list`; satellite stores
   (`~\.claude-os\design`, `~\source\repos\mu-site-drafts`, `D:\mu-lead-site-builds`, `D:\AgenticOS\away-mode`) as tar + sha256; Hermes `cron\jobs.json` re-sync.
3. **Restore on Ryzen** into an empty `C:\mu-hub\data\production`; rewrite `coding\repos.json` and `coding\accounts.json` paths
   (`C:\Users\Nebula PC\...` → Ryzen paths; AgenticOS → `C:\mu-hub\AgenticOS-v4`); satellites to `C:\Users\mkhan\.claude-os\design`,
   `C:\Users\mkhan\source\repos\mu-site-drafts`, `C:\mu-hub\lead-site-builds` (`MU_LEAD_SITE_BUILDS`); Hindsight pilot restore (RYZEN-HINDSIGHT.md).
4. **Start on Ryzen**: enable + start `\MU\MU Hub Supervisor` (`-HubRole server`) and `\MU\MU Hub Backup`; Serve `--https=8443 → 127.0.0.1:8081` and
   `--https=8445 → 127.0.0.1:8081`; stop staging and remove its Serve 8444; Hindsight supervisor; Hermes gateway (boot task) after the main gateway is confirmed stopped.
5. **Verify**: migrations/health, row counts vs the final manifest, an edit that survives refresh + restart, companions re-paired outbound, acceptance list.
6. **Rollback** (if needed after Ryzen writes exist): stop Ryzen hub → `backup-cli backup` on Ryzen → restore THAT onto the main PC (never the pre-cutover
   snapshot) → re-enable the `.disabled` Startup items → reinstall the desktop app with `-LocalMode`.

## 7. Backups

- Main PC (historical, kept): `D:\AgenticOS-backups\backup-20261002T005024Z`, `backup-20261002T021459Z`; Hindsight nightly `D:\hindsight-backups`.
- Ryzen: `D:\mu-hub-backups\from-main-pc\backup-20261002T021459Z`; after cutover nightly `D:\mu-hub-backups\production` (keep 14) by `\MU\MU Hub Backup`.
- Both PCs are in the same house: a fire/theft takes both. An off-site copy needs an owner decision (no purchase made).

## 8. Known risks / open items

- Loopback = owner on a headless hub (any local process): server-role local-owner proof being built; until it lands, WSL hardening limits who can reach it.
- Two founders' previews share one preview origin's storage (cleared on site switch) — weaker than per-site origins locally.
- `/__operator/agent-jobs` stays loopback-only in server role (inner handler); founders use coding jobs (`/__operator/coding`) instead.
- Reboot-without-logon not yet proven end to end (tasks proven in session 0 while logged on).

## 9. Cutover status

Not started.
