# Hermes on Ryzen-PC: staged, inert, ready for cutover

Prepared 2 October 2026 by the migration operator. Status: **staged, not started.** No gateway, scheduler, service, scheduled task or Startup item exists for Hermes on Ryzen. The gateway on the main PC was not touched.

Companion files (same folder): `pathfix.py` (path rewriter, safe to re-run), `Register-HermesGateway-Ryzen.ps1` (cutover-only boot task, dry run by default), `path-fix-run1.tsv`, `path-fix-run2.tsv`, `path-fix-final.tsv` (raw file:line reports).

## 1. What was installed

| Item | Main PC | Ryzen-PC |
|---|---|---|
| `hermes --version` | `Hermes Agent v0.21.3 (2026.9.14) · upstream cdceca42`, install method git | identical first line: `Hermes Agent v0.21.3 (2026.9.14) · upstream cdceca42`, install method git, "Update available: 10463 commits behind" |
| Commit | `cdceca42e107f0e51ab9ff50e1cc881ad76b577e`, branch `main` | same SHA, branch `main`, `origin/main` = same SHA |
| Home | `C:\Users\Nebula PC\AppData\Local\hermes` (`~\.hermes` is a junction to it) | `C:\Users\mkhan\AppData\Local\hermes`; **`C:\Users\mkhan\.hermes` is a junction (`mklink /J`) to it** |
| Python | 3.11.16 (uv-managed, `.hermes-runtime`) | 3.11.17 (uv-managed; uv fetched the current 3.11 patch). Same OpenAI SDK 2.24.0 |
| Node deps | `node_modules` 781 top-level entries | 781 (identical count) |
| Launcher | `...\hermes\bin\hermes.exe` | same path under `mkhan`; `hermes\bin` added to mkhan's user PATH |

**How it was installed (supported way).** Hermes' own installer `scripts/install.ps1`, taken from this PC's checkout (same commit, sha256 `5a9190cf...beacfa2`), run stage by stage with `-Stage <name> -NonInteractive -Commit cdceca42e107f0e51ab9ff50e1cc881ad76b577e -ForceCommit -SkipComputerUse`. Stages run: `uv, git, node, repository, python, venv, dependencies, node-deps, path, config-templates, platform-sdks, bootstrap-marker`.

**Deliberately not run (so nothing auto-starts):** `gateway` (the stage that offers to start the gateway), `configure` (setup wizard), `desktop`, and `system-packages` (ripgrep and ffmpeg via winget, skipped because another agent was using winget). Consequence: no `rg` or `ffmpeg` on Ryzen; Hermes falls back to slower search, and TTS audio conversion is unavailable (voice is out of scope anyway).

The installer did **not** register a gateway service, scheduled task or Startup item (checked, section 4).

**Things that went sideways, and what I did**
1. First run failed at `repository`: the fresh clone showed three `website/` files as modified (Windows line endings), which blocked `git checkout <sha>`. Fixed with `git checkout --detach -f <sha>`; re-ran from `repository`. This is the same "dirty website/ files" state the main PC shows.
2. A fresh clone's `origin/main` is today's upstream tip (`5bba024d`), so `--version` printed `upstream 5bba024d · local cdceca42 (+36686 carried commits)`. To make the build identical to the main PC I set `refs/remotes/origin/main` to `cdceca42` and `git checkout -B main cdceca42`. This is cosmetic: HEAD was already `cdceca42`. Because of it, `hermes update` on Ryzen would behave exactly as on the main PC (do not run it).
3. The installer printed "Browser tools / TUI npm install failed -- exit code" (empty exit code, with npm's own "Node dependencies installed" line). The `node_modules` trees are present and match the main PC's entry counts, so I treat it as a false alarm in the installer's exit-code check. `browser` tooling is **not verified**.
4. The installer changed mkhan's **user** environment: `Path` (+`...\hermes\bin`), `HERMES_HOME`, `HERMES_GIT_BASH_PATH`. No machine-level change.
5. Running read-only commands (`hermes auth list`, `hermes cron list`) made Hermes create an empty `auth.json` (683 bytes, Ryzen's own, env-pool entry for the OpenRouter key only; never opened) and an empty `cron/executions.db` (deleted again). Nothing was copied from the main PC's `auth.json`.

## 2. What was copied (tar + scp + sha256)

One tar of the non-credential state: `hermes-state.tar`, 122,695,680 bytes (117.0 MiB), 2,059 entries, sha256 `028aebc2c918f9643bd8651dc84622fff2096516d0436eac2a18c4008c0bdf95`. **Checksum matched on Ryzen before extraction.** The tar was deleted from Ryzen afterwards.

| Item | On Ryzen now | Notes |
|---|---|---|
| `config.yaml` | 10,080 bytes | Unchanged. It contains no this-PC absolute paths (all endpoints are `127.0.0.1` URLs). It does hold one literal 64-character `api_key` at `auxiliary.approval` (line 106, the hub `/__jev` bearer). Value not displayed. See section 5 risk 4. |
| `SOUL.md` | 5,012 bytes | Persona file; two path lines rewritten (table 1). |
| `skills` | 944 files, 61.92 MB | Excluded: `skills/.curator_backups` (2.4 MB of old cron backups) and lock files. |
| `plugins` | 4 files | Includes the hub's **away-mode plugin** (`plugins/away-mode`, enabled in config). `relay.json` rewritten. `__pycache__` excluded. |
| `profiles` | 555 files, 53.55 MB | One profile, `mu-sales`. Config, SOUL, skills, README, memories, hooks copied. Its `.env` was copied under the same rules as the main `.env` (below). Not copied: its `auth.json`, `state.db` (328 KB), `sessions`, `cache`, `logs`, `backups`, `runtime`, `cron/executions.db`, `cron/output`, model-list caches. |
| `pantheon` | 3 files | |
| `prompt-library` | 37 files | |
| `hooks` | empty | Empty on the main PC too. |
| `scripts` | 29 files | Excluded: three `*.bak*` files and `__pycache__`. |
| `memories` | `MEMORY.md`, `USER.md` | |
| `cron/jobs.json` | 39,143 bytes, 14 jobs (12 enabled) | **Definitions only.** Nothing executes them; no scheduler exists. Not copied: `executions.db` (history), `output/`, `notepad.db`, `usage_audit.jsonl`, `.fire-*` locks, `jobs.json.bak-*`. |
| `kanban` | empty folder | The folder holds only a lock on the main PC. `kanban.db` (118,784 bytes) is **not** copied (live SQLite; see "not copied"). |
| `.env` | 28,862 bytes | `scp` straight to `C:\Users\mkhan\AppData\Local\hermes\.env`. sha256 `3a5145d8dfd71a06caef74627bf47c2fc6d8efeb22222468f9267323609c4108` matches the source. Never displayed or parsed. |
| `profiles\mu-sales\.env` | 27,856 bytes | Same method. sha256 `180991c203b4405c596d9ff6701b5e6eb2624c3f82de8722766835550b6503fa` matches. This one was not named in the brief; it is the same class of file and the `mu-sales` profile cannot run without it. Delete it if you disagree. |
| `.env.bak-20260926-or` | not copied | As instructed. |

**ACLs (both `.env` files):** inheritance removed, access for exactly `RYZEN-PC\mkhan`, `NT AUTHORITY\SYSTEM`, `BUILTIN\Administrators` (Full), verified with `icacls`.

**`.env` key names (names only, from a command that prints group 1 of `^([A-Z0-9_]+)=`)**, 29 keys:
`TERMINAL_MODAL_IMAGE TERMINAL_TIMEOUT TERMINAL_LIFETIME_SECONDS BROWSERBASE_PROXIES BROWSERBASE_ADVANCED_STEALTH BROWSER_SESSION_TIMEOUT BROWSER_INACTIVITY_TIMEOUT WEB_TOOLS_DEBUG VISION_TOOLS_DEBUG MOA_TOOLS_DEBUG IMAGE_TOOLS_DEBUG WHATSAPP_MODE WHATSAPP_ALLOWED_USERS WHATSAPP_CLOUD_PHONE_NUMBER_ID WHATSAPP_CLOUD_ACCESS_TOKEN WHATSAPP_CLOUD_APP_ID WHATSAPP_CLOUD_WABA_ID WHATSAPP_CLOUD_ALLOWED_USERS WHATSAPP_CLOUD_VERIFY_TOKEN WHATSAPP_CLOUD_APP_SECRET TELEGRAM_REQUIRE_MENTION TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS OBSIDIAN_VAULT_PATH WHATSAPP_CLOUD_WEBHOOK_HOST GROQ_API_KEY API_SERVER_KEY API_SERVER_HOST API_SERVER_PORT OPENROUTER_API_KEY`
Profile `.env`: the 11 terminal/browser/debug keys plus `OBSIDIAN_VAULT_PATH` and `GROQ_API_KEY`.
`hermes config check` on Ryzen confirms `OPENROUTER_API_KEY` is seen. Two keys name a this-PC thing: `OBSIDIAN_VAULT_PATH` (a vault path; the wiki is not on Ryzen) and `WHATSAPP_CLOUD_WEBHOOK_HOST` (a host). I did not look at or edit their values.

Verification that the originals survived the path fix: for every file the fixer changed it kept `<file>.pre-ryzen`; after the first pass, 40 of the 41 `.pre-ryzen` files hash-matched the live main-PC file. The one difference is `cron/jobs.json`, which the running gateway keeps rewriting (it ticks every few minutes). Its `.pre-ryzen` is the snapshot that was in the tar.

### Not copied (and whether cutover needs it)

| Item | Size / what it is | Needed at cutover? |
|---|---|---|
| `auth.json`, `auth.lock` | OAuth logins for the pooled ChatGPT/Codex accounts | **Never copied, never opened.** Owner signs in fresh on Ryzen (section 5a). |
| `sessions/` | 8 files, 0.6 MB (`request_dump_*.json` plus `sessions.json`) | Not needed. Private request dumps. |
| `state.db` (+`-wal`) | **124,502,016 bytes (118.7 MiB)** + 2.8 MB WAL. This is the real conversation/session store with full-text index: private transcripts | **Owner decision.** Without it Ryzen starts with empty chat history (skills, memory files and config still work). If wanted, copy after the main gateway is stopped, with the WAL merged (see 5b step 7). |
| `shared-state.db` 152 KB, `projects.db` 44 KB, `response_store.db` 20 KB, `runs_idempotency.db` 16 KB, `kanban.db` 116 KB | Runtime databases | No. `kanban.db` only if the owner wants the current board (copy while stopped). |
| `cache` 10.5 MB (1,534 files), `logs` 18.8 MB, `backups` 56.2 MB (602 files), `.curator_backups` 0.06 MB, `audio_cache`, `image_cache`, `sandboxes`, `pending_messages` (all empty) | Caches, logs, backups | No. |
| `state/` (4 files, 7 KB: `gateway.heartbeat`, `gateway.lifecycle.json`, `gateway.start-attestation.json`, `dashboard_clients.heartbeat`) | I checked key names: only PIDs, create/start times, phase, heartbeat timestamps, a loopback tick port and a start "via" tag. **No credentials.** | **No, and copying would be wrong:** they describe the main PC's live gateway process. A stale copy could make Ryzen think a gateway already runs. |
| `gateway_state.json`, `gateway.pid`, `gateway.lock`, `gateway-starts.log`, `runtime/` | Live-process state of the main PC's gateway (platforms in use: `telegram`, `whatsapp_cloud`, `api_server`; profiles served: `default`, `mu-sales`) | No. Recreated at first start. |
| `platforms/pairing/` (`telegram-approved.json` 95 B = one approved Telegram user id; `telegram-pending.json`; `_rate_limits.json`) | DM-pairing approvals | **Probably not.** `TELEGRAM_ALLOWED_USERS` is in `.env` (copied) and config has `allow_all_users: false`. If the first inbound test is refused, copy `telegram-approved.json` (see 5b step 7). |
| `pairing/` | Empty | No. |
| `whatsapp/` | Empty (the Baileys bridge session store; this install uses WhatsApp Cloud API) | No. |
| `bot_relay/roster.json` | Peer-bot roster, 0 agents | No. |
| `gateway-service/` (`Hermes_Gateway.cmd`, `.vbs`) | Launchers with hard-coded `C:\Users\Nebula PC\...` paths | No. `Register-HermesGateway-Ryzen.ps1` writes a Ryzen version at cutover. |
| `desktop-plugins`, `lsp`, `assets`, `reports` (1 file, a dental brief), `channel_directory.json`, `context_length_cache.yaml`, `*_cache.json`, `.skills_prompt_snapshot.json`, `config.yaml.bak-*` | Desktop/app extras and regenerable caches | No. |

Credential-pattern scan of the tar contents (key prefixes such as `sk-`, `AIza`, `ghp_`, `gsk_`, Telegram-token shape): only vendored documentation and catalog files matched (`skills/.hub/index-cache/*.json`, `hermes-agent` reference docs, two ui-ux-pro-max stack CSVs). I did not read the matches; they are example/placeholder text in upstream files. The one real exception is `config.yaml` line 106 above.

## 3. Path-fix tables

Method: `pathfix.py` rewrote only the rules below, kept `<file>.pre-ryzen` for each changed file, skipped history/log files, and wrote the remaining main-PC references to the report. Result: **61 references rewritten across 10 rules; 111 references left alone** (plus 2 `.hermes` references in the receptionist skill, kept as-is on purpose). `cron/jobs.json` and `plugins/away-mode/relay.json` still parse as JSON, and all 10 `scripts/*.py` still parse (checked on Ryzen with Hermes' own Python, in memory).

`%LOCALAPPDATA%\hermes\...` and `~/.hermes/...` forms (README, lead-hunt.py, memory notes) are already valid on Ryzen and were left unchanged.

### Table 1: rewritten for Ryzen

| # | Original (main PC) | Now on Ryzen | Refers to | Where (file:line) |
|---|---|---|---|---|
| 1 | `C:\Users\Nebula PC\source\repos\AgenticOS-v4` | `C:\mu-hub\AgenticOS-v4` | AgenticOS hub checkout (42 refs) | `SOUL.md:21`, `cron/jobs.json:315,369,519,573`, `profiles/mu-sales/skills/business/call-outcome/SKILL.md:16`, `profiles/mu-sales/skills/business/follow-up-desk/SKILL.md:17`, `profiles/mu-sales/skills/business/mu-call-coach/SKILL.md:19`, `profiles/mu-sales/skills/business/mu-clients/SKILL.md:41` (+30 more files) |
| 2 | `C:\Users\Nebula PC\source\repos\AgenticOS-v4\.operator-data` | `C:\mu-hub\data\production` | hub data dir (.operator-data == MU_DATA_DIR on Ryzen) (4 refs) | `plugins/away-mode/relay.json:3`, `profiles/mu-sales/skills/jarvis-capabilities/SKILL.md:168`, `skills/jarvis-capabilities/SKILL.md:216`, `skills/jarvis-capabilities/SKILL.md.37256.tmp:171` |
| 3 | `C:\Users\Nebula PC\.hermes` | `C:\Users\mkhan\.hermes` | Hermes home via junction (junction created on Ryzen) (4 refs) | `profiles/mu-sales/skills/creative/website-studio/SKILL.md:13`, `profiles/mu-sales/skills/productivity/meta-prompting/SKILL.md:63`, `skills/creative/website-studio/SKILL.md:13`, `skills/productivity/meta-prompting/SKILL.md:63` |
| 4 | `C:\Users\Nebula PC\AppData\Local\hermes` | `C:\Users\mkhan\AppData\Local\hermes` | Hermes home (3 refs) | `cron/jobs.json:315,369`, `prompt-library/business-dream.md:9` |
| 5 | `C:\Users\Nebula PC\source\repos\AgenticOS-v4\.operator-data\supervisor.log` | `C:\mu-hub\logs\mu-hub-supervisor.log` | hub supervisor log (Ryzen supervisor LogDir, per deploy/windows/mu-hub-supervisor.ps1) (2 refs) | `cron/jobs.json:57`, `scripts/jarvis-watchdog.py:17` |
| 6 | `C:\Users\Nebula PC\AppData\Local\claude-bridge` | `C:\Users\mkhan\AppData\Local\claude-bridge` | Claude Code bridge install (exists on Ryzen; claude.exe verified present) (2 refs) | `skills/jarvis-capabilities/SKILL.md:58`, `skills/jarvis-capabilities/SKILL.md.37256.tmp:57` |
| 7 | `C:\Users\Nebula PC\source\repos\muv-demo-dental` | `C:\mu-hub\repos\muv-demo-dental` | client site repo (1 refs) | `scripts/founders-weekly.py:49` |
| 8 | `C:\Users\Nebula PC\source\repos\muv-demo-conveyancing` | `C:\mu-hub\repos\muv-demo-conveyancing` | client site repo (1 refs) | `scripts/founders-weekly.py:50` |
| 9 | `C:\Users\Nebula PC\source\repos\aldergate` | `C:\mu-hub\repos\aldergate` | client site repo (1 refs) | `scripts/founders-weekly.py:51` |
| 10 | `C:\Users\Nebula PC\source\repos\muv-marketing` | `C:\mu-hub\repos\muv-marketing` | client site repo (1 refs) | `scripts/founders-weekly.py:52` |

The `.operator-data` mapping rests on `scripts/cloud/data-dir.ts`: when `MU_DATA_DIR` is set, the hub's data lives there instead of under the repo; the Ryzen installer uses `C:\mu-hub\data\production`. The away-mode `relay.json` therefore points at `C:\mu-hub\data\production\away-mode\relay.token`, which **the hub creates**; it does not exist yet. The supervisor-log mapping comes from `deploy/windows/mu-hub-supervisor.ps1` (`mu-hub-supervisor.log` in the LogDir); I have not seen that file on Ryzen because the hub supervisor has not run.

### Table 2: left alone ("needs something not yet on Ryzen", or out of scope, or informational)

| # | Main-PC path | Count / files | Status on Ryzen | Where (first few) |
|---|---|---|---|---|
| 1 | `C:\Users\Nebula PC\.claude` | 29 refs / 18 files | main-PC Claude Code home (skills source `.claude\skills`, settings). The `claude-skills` sync metadata and a few SKILL.md notes name it. Needs the hub's own skill sync on Ryzen; nothing Hermes executes. | `profiles/mu-sales/skills/note-taking/pinecone-memory/SKILL.md:18`, `skills/claude-skills/agent-browser/INSTALLATION.json:4`, `skills/claude-skills/copywriting/INSTALLATION.json:4` ... |
| 2 | `C:\Users\Nebula PC\Documents` | 13 refs / 13 files | main-PC folder the claude-skills were originally installed from (INSTALLATION.json metadata only). Informational; no action. | `skills/claude-skills/agent-browser/INSTALLATION.json:5`, `skills/claude-skills/copywriting/INSTALLATION.json:5`, `skills/claude-skills/cro/INSTALLATION.json:5` ... |
| 3 | `C:\Users\Nebula PC\Desktop\Business - M&U Ventures` | 11 refs / 6 files | main-PC Desktop tracking notes (calls vs target, deal docs). NOT on Ryzen. Jobs business-dream and meeting-sync read it; they will find no files until a synced copy exists. | `cron/jobs.json:315,519,573`, `profiles/mu-sales/skills/business/deal-proposal/SKILL.md:21,29`, `profiles/mu-sales/skills/productivity/deal-proposal/SKILL.md:21,29` ... |
| 4 | `D:\MU-Receptionist` | 11 refs / 6 files | Receptionist repo on main PC D:. OUT OF SCOPE: copied as-is, linked material not opened. | `profiles/mu-sales/skills/productivity/receptionist-studio/SKILL.md:3,25`, `prompt-library/ai-receptionist-build.md:5,28,200,233`, `prompt-library/ai-receptionist-business-playbook.md:35` ... |
| 5 | `C:\Users\Nebula PC\.claude-os` | 9 refs / 2 files | Dream job output folder (`dreams\latest-summary.txt`, business-ledger). NOT on Ryzen. morning-brief and business-dream read/write it; business-dream would write to a non-existent folder. | `cron/jobs.json:57,315,315,315,369,369`, `prompt-library/business-dream.md:3,22,27` |
| 6 | `C:\Users\Nebula PC\source\repos\mu-ventures-obsidian-wiki` | 5 refs / 5 files | Obsidian wiki vault. NOT on Ryzen. SOUL.md, mu-clients skill and founders-weekly.py reference it (also `OBSIDIAN_VAULT_PATH` in .env). | `SOUL.md:18`, `profiles/mu-sales/skills/business/mu-clients/SKILL.md:43`, `scripts/founders-weekly.py:47` ... |
| 7 | `C:\Users\Nebula PC\source\repos\MU-Workspace` | 4 refs / 3 files | main-PC workspace memory (current-strategy.md, next-actions.md). NOT on Ryzen. business-dream and daily-log read them. | `cron/jobs.json:315,369`, `prompt-library/business-dream.md:11`, `scripts/daily-log.py:20` |
| 8 | `C:\Users\Nebula PC\source\repos\bianca-brown-realty` | 4 refs / 3 files | client repo not on Ryzen. OUT OF SCOPE (bianca): copied as-is. | `profiles/mu-sales/skills/business/mu-clients/SKILL.md:20`, `scripts/founders-weekly.py:61,62`, `skills/business/mu-clients/SKILL.md:20` |
| 9 | `C:\Users\Nebula PC\AppData` | 4 refs / 4 files | main-PC npm global tools: `openclaw` and `agent-browser` under AppData\Roaming\npm. NOT installed on Ryzen (only claude and codex shims exist there). Needs installing if wanted. | `profiles/mu-sales/skills/devops/openclaw-nodes/SKILL.md:23`, `profiles/mu-sales/skills/jarvis-capabilities/SKILL.md:57`, `skills/claude-skills/mu-concept-qa/SKILL.md:12` ... |
| 10 | `C:\Users\Nebula PC\.venvs` | 4 refs / 2 files | book-to-skill Python venv on main PC. NOT on Ryzen. | `profiles/mu-sales/skills/productivity/book-to-skill/SKILL.md:861,863`, `skills/productivity/book-to-skill/SKILL.md:861,863` |
| 11 | `C:\Users\Nebula PC\Downloads` | 4 refs / 4 files | main-PC Downloads (notebooklm / hindsight notes). Informational. | `profiles/mu-sales/skills/research/notebooklm/SKILL.md:67`, `skills/claude-skills/hindsight-ask/SKILL.md:11`, `skills/claude-skills/hindsight-ask/SKILL.md.bak-hindsight-20260928-094222:11` ... |
| 12 | `C:\Users\Nebula PC\source\repos\mu-site-drafts` | 2 refs / 2 files | site draft output folder, not on Ryzen (mu-site-draft skill). | `profiles/mu-sales/skills/business/mu-site-draft/SKILL.md:83`, `skills/business/mu-site-draft/SKILL.md:83` |
| 13 | `C:\Users\Nebula PC\.openclaw-node` | 2 refs / 2 files | OpenClaw node state on main PC (paired iPhone). NOT on Ryzen. | `profiles/mu-sales/skills/devops/openclaw-nodes/SKILL.md:23`, `skills/devops/openclaw-nodes/SKILL.md:23` |
| 14 | `C:\Users\Nebula PC\.notebooklm-venv` | 2 refs / 2 files | NotebookLM venv + signed-in Google session on main PC. NOT on Ryzen. | `profiles/mu-sales/skills/research/notebooklm/SKILL.md:17`, `skills/research/notebooklm/SKILL.md:17` |
| 15 | `D:\hindsight` | 2 refs / 2 files | Hindsight data on main PC D:. Ryzen has `C:\mu-hub\hindsight*` (not touched); hindsight-ask skill text only. | `skills/claude-skills/hindsight-ask/SKILL.md:52`, `skills/claude-skills/hindsight-ask/SKILL.md.bak-hindsight-20260928-094222:52` |
| 16 | `D:\tmp` | 1 refs / 1 files | scratch path in a receptionist playbook. OUT OF SCOPE (receptionist). | `prompt-library/receptionist-operating-playbook-20260925.md:29` |
| 17 | `C:\Users\Nebula PC\source\repos\(generic example)` | 1 refs / 1 files | example path in website-four-systems.md prompt; informational. | `prompt-library/website-four-systems.md:166` |
| 18 | `C:\Users\Nebula PC\Desktop\` | 1 refs / 1 files | example path in csv-memory skill; informational. | `skills/claude-skills/csv-memory/SKILL.md:37` |
| 19 | `/c/Users/Nebula... (doc example)` | 1 refs / 1 files | example path in csv-memory skill; informational. | `skills/claude-skills/csv-memory/SKILL.md:66` |
| 20 | `C:\Users\Nebula PC\.local` | 1 refs / 1 files | mu-video-reference video venv (`.local\share\mu-tools\video-venv`) on main PC. NOT on Ryzen. | `skills/claude-skills/mu-video-reference/SKILL.md:13` |

Skipped as history, not rewritten and not listed above: `skills/.curator_ledger.jsonl`, `skills/.curator_state`, `skills/.hub/`, `skills/claude-skills/.agentic-os-*.json` (they record what happened on the main PC).

**Code that rewriting the path does not fully fix** (the path is now right but the data is elsewhere on Ryzen):
- `scripts/founders-weekly.py:40-41` builds `<AgenticOS>\.operator-data\finance.sqlite` and `invoices.json`; on Ryzen the hub data is in `C:\mu-hub\data\production`. I did not edit code. Fix by pointing those two lines at `MU_DATA_DIR` before enabling that job.
- `scripts/os-refresh.py`, `lead-hunt.py`, `lead-calls.py`, `call_coach.py`, `inbox-triage.py` find `bun` with `shutil.which("bun")`, `%APPDATA%\npm\node_modules\bun\bin\bun.exe` or `%USERPROFILE%\.bun\bin\bun.exe`. Ryzen's bun is `C:\mu-hub\bin\bun.exe`, which is on none of those. `Register-HermesGateway-Ryzen.ps1` prepends `C:\mu-hub\bin` to the gateway's PATH, which fixes it for cron-launched scripts.

**Cron jobs and what they need on Ryzen** (14 defined, 12 enabled; every one delivers to the owner's Telegram chat or is local):

| Job | Schedule | Works on Ryzen after cutover? |
|---|---|---|
| jarvis-watchdog | every 15 min | Yes once the hub runs; it reads the supervisor log (rewritten) and probes `:8081` |
| site-monitor | every 30 min | Yes (HTTP checks only) |
| inbox-triage, os-refresh | every 10 / 30 min | Yes if `bun` is on PATH and hub is up (see above) |
| lead-hunt (01:30), lead-calls (08:30 Mon-Sat) | daily | Yes if `bun` and the hub CRM are up; lead discovery also needs the SearXNG task (already running on Ryzen) |
| call-coach-usman | 11:00, 14:00, 16:00 weekdays | Probably; needs the Retell/hub pieces, not verified |
| morning-brief (07:30) | daily | Partly: reads `.claude-os\dreams\latest-summary.txt` (missing) |
| business-dream (05:30) | daily | **No**: reads and writes `.claude-os\dreams`, `Desktop\Business - M&U Ventures\tracking`, `MU-Workspace\memory` (none on Ryzen) |
| meeting-sync (21:00) | daily | **No** for the tracking-notes part (Desktop folder missing) |
| daily-log (20:30) | daily | **No**: appends to `MU-Workspace\memory\next-actions.md` |
| founders-weekly (Mon 08:00) | weekly | Partly: finance data path (above), Obsidian wiki, receptionist and client repos missing |
| business-dream-test, meeting-sync-test | disabled | n/a |

`cron.catch_up_missed: true` in `config.yaml`. See risk 2 in section 5.

## 4. Inert checks (run on Ryzen after everything above)

```
hermes processes (CIM, command line matching 'hermes'):   none
Get-Process hermes,pythonw:                               none
Listening on 8642 / 8443:                                 nothing
Startup folders (user + all users):                       desktop.ini, desktop.ini, Tailscale.lnk   (no Hermes item)
Run keys HKCU/HKLM mentioning hermes:                     none
Scheduled tasks named or acting on 'hermes' (all paths):  none
\MU\ tasks (not touched): MU Hub Backup Disabled, MU Hub Supervisor Disabled, MU SearXNG Running, MU WSL KeepAlive Running
Services named hermes:                                    none
gateway-service dir / gateway.pid / gateway.lock:         False / False / False
hermes cron status:      "Gateway is not running -- cron jobs will NOT fire", 12 active job(s)
hermes gateway status:   "Gateway is not running"
```

Commands that succeeded on Ryzen: `hermes --version` (v0.21.3, upstream cdceca42); `hermes config path`; `hermes config check` (config version 45 current; `OPENROUTER_API_KEY` present; prints variable names only); `hermes cron list` (jobs listed; `cron status` counts 12 active); `hermes cron status`; `hermes gateway status`; `hermes auth list`.

**Deliberately not run:** `hermes doctor` (without `--live` it still calls provider endpoints, e.g. `httpx.get` against OpenRouter with the key, per `doctor_connectivity.py`), `hermes doctor --live`, `hermes status --deep`, `hermes gateway run/start/install`, `hermes cron tick/run`, any chat/one-shot prompt. `hermes config check` is the config-validation check that is purely local.

On the main PC I ran only `hermes --version`, file reads, `tar` reads and a `git fetch --dry-run` (no ref update). Its gateway, config, cron files and Startup items were not touched. Main PC state at the time: Startup items `Hermes_Gateway.vbs` and `Agentic OS.vbs` present, no Hermes scheduled task.

## 5. Cutover procedure

Order matters: **main gateway off and unable to restart, then Ryzen on.** Two gateways polling one Telegram bot token conflict (409) and lose messages.

### 5a. Owner sign-ins on Ryzen (do these first, while the main gateway still runs; none of them touch the bot)

Run over SSH (`ssh ryzen-bots`) as `mkhan`. Ryzen is headless, so use `--no-browser` and finish the login on any device that can open the printed URL/code.

| # | Provider | Count | Command | Verify |
|---|---|---|---|---|
| 1 | ChatGPT / Codex (OAuth; primary model `gpt-6-sol` and the MoA aggregator `gpt-6-astra`) | **3 pooled accounts** (count from the owner notes; `config.yaml` does not list pool members and I never opened `auth.json`, so confirm against `hermes auth list` on the main PC) | for each account: `hermes auth add openai-codex --type oauth --no-browser --label codex-1` (then `codex-2`, `codex-3`; `--priority N` to order them) | `hermes auth list` shows the three, plus OpenRouter |
| 2 | OpenRouter (fallbacks `xiaomi/mimo-v2.6-flash`, `-pro`; MoA member `deepseek/deepseek-v4-pro`) | 0 sign-ins | key already in `.env` | `hermes auth list` shows `OPENROUTER_API_KEY` (seen on Ryzen) |
| 3 | Telegram bot, WhatsApp Cloud, Groq (speech-to-text) | 0 sign-ins | tokens/keys already in `.env` | n/a |
| 4 | **Hub-owned, not Hermes commands, but Hermes calls them:** `claude-sub` provider -> hub `/__claude` -> `claude -p` (Claude Code under `C:\Users\mkhan\AppData\Local\claude-bridge`, Claude Max login(s)); `cline-free` -> hub `/__cline` -> Cline CLI (needs Cline login); `jev-latest` (auxiliary approval) -> hub `/__jev` | Claude: as many Max logins as the hub pool uses (owner notes say 2); Cline: 1 | Use the hub's own sign-in procedure on Ryzen; `claude` shim exists in `C:\Users\mkhan\AppData\Roaming\npm` | `curl.exe -s http://127.0.0.1:8081/__health` once the hub is up; then step 5d test 2 |

Total Hermes-native interactive sign-ins: **3** (all ChatGPT/Codex). Hub-side logins: Claude (1-2) and Cline (1).

### 5b. Stop the main PC gateway and make sure nothing restarts it (BEFORE Ryzen starts)

Run on the main PC, in this order. The supervisor must go first: `scripts/windows/agentic-os-supervisor.ps1` runs `hermes gateway start` within about 3 minutes whenever it does not find a gateway (it also starts at login via the Startup item `Agentic OS.vbs`).

1. Stop the supervisor (or, if the main hub must stay up a while longer, restart it with `-NoGateway` instead):
   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agentic-os-supervisor\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
2. Disable both autostarts (rename, so rollback is a rename back):
   ```
   $s = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
   Rename-Item "$s\Hermes_Gateway.vbs" 'Hermes_Gateway.vbs.disabled'
   Rename-Item "$s\Agentic OS.vbs"     'Agentic OS.vbs.disabled'   # or edit it to add -NoGateway if the hub stays on this PC
   ```
   There is no Hermes scheduled task on the main PC (checked). If a Hermes desktop app or `hermes serve` runs there, close it too; either can start a gateway.
3. Stop the gateway: `& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" gateway stop`
4. Verify it is dead and stays dead (wait 4 minutes with the supervisor stopped):
   `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'hermes_cli[.\\/]main(\.py)?"?\s+gateway\s+run' }` returns nothing; `hermes gateway status` says not running; `gateway.pid` is gone.
5. Side effect to expect: the main hub's warm-Hermes calls (`127.0.0.1:8642`, voice tasks) fail from here on. That is correct if the hub cuts over too; if not, schedule the hub cutover with this one.
6. Re-sync the live data that changed since staging (gateway stopped, so files are quiet). From the main PC:
   ```
   $h = "$env:LOCALAPPDATA\hermes"
   scp "$h\cron\jobs.json" ryzen-bots:C:/Users/mkhan/AppData/Local/hermes/cron/jobs.json
   scp "$h\memories\MEMORY.md" "$h\memories\USER.md" ryzen-bots:C:/Users/mkhan/AppData/Local/hermes/memories/
   ssh ryzen-bots "py -3.13 C:\mu-hub\incoming\pathfix.py C:\Users\mkhan\AppData\Local\hermes C:\mu-hub\incoming\path-fix-cutover.tsv --apply"
   ```
   Re-syncing `jobs.json` matters: the staged copy has `next_run_at` and `last_run_at` from 2 October morning. With `catch_up_missed: true`, a stale copy makes jobs that "missed" their slot fire immediately at first start. The fresh copy has correct `next_run_at` values.
7. Optional owner decisions, same quiet window:
   - History: copy `state.db` (118.7 MiB) to `...\hermes\state.db` on Ryzen (the gateway's clean stop merges the WAL; if `state.db-wal` is non-empty, copy it alongside).
   - Pairing, only if the first inbound test is refused: copy `platforms\pairing\telegram-approved.json`.
   - `kanban.db`, if the current board matters.

### 5c. Start and autostart on Ryzen (boot-time, no Windows auto-login)

Hermes' own `hermes gateway install` registers a **LogonTrigger + InteractiveToken** task (`hermes_cli/gateway_windows.py`), with a Startup-folder `.vbs` fallback. Both only fire after someone logs in, so on Ryzen they would leave the bot dead after every reboot until a login. Use the supplied script instead; it registers `\MU\MU Hermes Gateway` with a **BootTrigger (+90 s) and S4U logon**, the same model as the hub's `\MU\` tasks, restart-on-failure every minute, no execution time limit:

```
# On Ryzen, elevated (dry run first; it only prints):
powershell -NoProfile -ExecutionPolicy Bypass -File C:\mu-hub\incoming\Register-HermesGateway-Ryzen.ps1
# Real thing, only after 5a and 5b:
powershell -NoProfile -ExecutionPolicy Bypass -File C:\mu-hub\incoming\Register-HermesGateway-Ryzen.ps1 -Register -MainGatewayStopped -StartNow
```
(First `scp` the script to `C:\mu-hub\incoming\` if it is not there; I left a copy there.) The script refuses to register unless `-MainGatewayStopped` is given, refuses if a gateway is already running on Ryzen, writes `gateway-service\Hermes_Gateway.vbs` (same env as the main PC's launcher: `HERMES_HOME`, `PYTHONIOENCODING`, `HERMES_GATEWAY_DETACHED`, `HERMES_SUPERVISED_CHILD`, `VIRTUAL_ENV`, `PYTHONPATH`; plus `C:\mu-hub\bin` on PATH for `bun`), and warns if `auth.json` lacks the sign-ins.

**Does Hermes work under S4U? Not tested.** I could not test it without starting a gateway. What I know from the code: the gateway reads plain files (`.env`, `auth.json`, `config.yaml`), sets `HERMES_HOME` itself in the launcher, needs outbound network only, and has no UI. S4U sessions have no network credentials and no access to the user's Credential Manager/DPAPI secrets; I found no use of either in the gateway path, but the encrypted autofill vault (`hermes vault`) is DPAPI-style and would not work. If S4U misbehaves, fallbacks are: (1) register the same XML with `/RU mkhan /RP <password>` (owner types the password; "run whether logged on or not"), or (2) turn on auto-login (a system change I was told not to make). The hub supervisor on Ryzen (`deploy/windows/mu-hub-supervisor.ps1`) has **no** Hermes handling, unlike the main PC's supervisor, so the gateway needs this task; Hermes' own crash restart plus the task's restart-on-failure cover crashes.

### 5d. Tests (both must pass before the main PC's `.disabled` files are deleted)

1. **Inbound Telegram.** From the approved Telegram account, DM the bot "ping". Expect a reply. Then on Ryzen: `hermes gateway status` (running) and `Get-Content C:\Users\mkhan\AppData\Local\hermes\logs\gateway.log -Tail 40`: it must show Telegram connected and **no** "409 Conflict / terminated by other getUpdates request" (that means the main gateway is still polling: go back to 5b). If the bot answers with an authorisation/pairing refusal, do the pairing copy in 5b step 7.
2. **Hub bridge.** With the hub up on Ryzen: `curl.exe -s http://127.0.0.1:8081/__health`, then `hermes -z "Reply with exactly: bridge-ok" --provider claude-sub` (one-shot prompt through hub `/__claude` to `claude -p`; check `hermes --help` if the flag has changed). Also confirm the away-mode relay token exists: `Test-Path C:\mu-hub\data\production\away-mode\relay.token` and `hermes plugins list` shows `away-mode` enabled; if the token path or URL differs, run the hub's `scripts/away-mode/install-hermes-plugin.ts` on Ryzen to regenerate `relay.json`.

### 5e. Rollback

1. On Ryzen, elevated: `powershell -File C:\mu-hub\incoming\Register-HermesGateway-Ryzen.ps1 -Unregister`, then `hermes gateway stop`; confirm no `gateway run` process remains.
2. On the main PC: rename the two `.disabled` files back (`Hermes_Gateway.vbs`, `Agentic OS.vbs`), then start the gateway with `wscript.exe "C:\Users\Nebula PC\AppData\Local\hermes\gateway-service\Hermes_Gateway.vbs"` (or restart the supervisor, which starts it within 3 minutes).
3. The main PC still has its own `cron/jobs.json`, `state.db`, `.env` and `auth.json` untouched, so nothing needs restoring there. Caveat: with `catch_up_missed`, jobs that Ryzen ran in the meantime may run again on the main PC; accept one repeat of any missed daily job.
4. Staging on Ryzen can stay as is, or be removed: `hermes\bin`, the `hermes` home, the `C:\Users\mkhan\.hermes` junction. **Remove the junction with `rmdir C:\Users\mkhan\.hermes` (no `/s`, no recursive delete through it), never `rd /s` or `Remove-Item -Recurse`.**

## 6. What will NOT work on Ryzen after cutover

- **Voice and microphone.** No wake word, local mic, or speaker on the Ryzen side for Hermes. Telegram voice notes still work (Groq speech-to-text over the API). `tts.provider: gemini` has no Gemini key in `.env` on either PC, so Hermes TTS is not configured anywhere; ffmpeg is not installed on Ryzen.
- **Desktop control of the owner's own PC.** Hermes' computer-use / `control_pc` / terminal tools act on the machine Hermes runs on. After cutover they control Ryzen, not the owner's PC.
- **Browser tool.** `browser.cdp_url` is `http://127.0.0.1:9222`: the separate Chrome profile launched by the main PC's `jarvis-chrome.ps1`. It does not exist on Ryzen, so browser actions fail until a CDP-enabled Chrome profile is set up there (Chrome appears to be installed; not checked).
- **Tools and data that live only on the main PC:** NotebookLM (`.notebooklm-venv` and the signed-in Google session), OpenClaw (`openclaw` and the paired iPhone node), `agent-browser`, the book-to-skill and video venvs, the Obsidian wiki and `OBSIDIAN_VAULT_PATH`, `MU-Workspace\memory`, `Desktop\Business - M&U Ventures\tracking`, `.claude-os\dreams`, `D:\hindsight` data, `D:\MU-Receptionist` and the bianca repo (out of scope, copied as-is), `.claude\skills` (source of the claude-skills sync). Jobs and skills that reference them will find nothing (table 2, job table in section 3).
- **WhatsApp Cloud.** Credentials are copied, but inbound needs a public webhook (`WHATSAPP_CLOUD_WEBHOOK_HOST`) that points at the main PC today. Parked per owner notes; repoint the funnel/webhook before relying on it.
- **Conversation history** (unless `state.db` is copied, 5b step 7) and the pairing list (unless copied).
- **`hermes update`.** Do not run it on either PC; the builds are intentionally identical and pinned.

## 7. Not verified (be sceptical of these)

- That the gateway actually starts and serves Telegram on Ryzen (not started, by instruction).
- That Hermes runs correctly under an S4U boot-time task (section 5c).
- The Codex pool count of 3 (from owner notes, not from `auth.json`).
- That `config.yaml` line 106's hub bearer matches what the Ryzen hub's `/__jev` expects (value never displayed). If the Ryzen hub issues its own key, edit that one line.
- Provider reachability from Ryzen (no network calls made, including `hermes doctor`).
- The browser/TUI npm components (installer reported failure; trees look complete).
- Any hub-side behaviour (`/__claude`, `/__cline`, `/__jev`, `/__memory/mcp`, `127.0.0.1:8878` Hindsight): the Ryzen hub was not running; loopback URLs in config are unchanged.
- That `C:\mu-hub\data\production\away-mode\relay.token` and `C:\mu-hub\logs\mu-hub-supervisor.log` are the exact files the Ryzen hub will create (derived from the repo's deploy scripts).
- Every cron script's behaviour under Ryzen's environment; only syntax was checked.
- API server port: `API_SERVER_PORT` in `.env` was not read, so I did not check it against the reserved ports (8081/8082/8091/8444/18888/8889/8879/5433). The hub's own code talks to Hermes on `:8642`.

## 8. Footprint on Ryzen outside the Hermes home

- `C:\mu-hub\incoming\`: my helper scripts and logs (`pathfix.py`, `hermes-install.ps1`, `install-driver*.ps1`, `hermes-install*.log`, `path-fix-*.tsv`, `preryzen-hashes.txt`, `Register-HermesGateway-Ryzen.ps1`, and small check scripts). No secrets in them. The tar was removed.
- `C:\Users\mkhan\.hermes`: new junction to the Hermes home.
- mkhan user environment: `Path`, `HERMES_HOME`, `HERMES_GIT_BASH_PATH`.
- Nothing under `C:\mu-hub\AgenticOS-v4`, `data`, `staging`, `hindsight*`, `D:\`, the `\MU\` tasks, Tailscale, firewall, power or WSL was changed.
