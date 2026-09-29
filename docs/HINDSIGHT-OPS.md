# Hindsight operations (repair of 28 Sep 2026, revision 3)

Hindsight is the local memory engine: `hindsight-api-slim` 0.10.1 with a Postgres 18 that the supervisor runs itself (`pg_ctl`, data under `D:\hindsight\db`) and an in-process worker, installed at `D:\hindsight`. This page covers how it is run, secured, connected and verified.

- Governing briefs: `MU-Workspace/memory/master-v3/V5-UPDATE.md` §1 and `V7-DECISIONS.md` (Hindsight section).
- Investigation: `HINDSIGHT.md`. Independent reviews: `REVIEW-HINDSIGHT.md` (round 1) and `REVIEW-HINDSIGHT-R2.md` (round 2).
- Revision 2 fixed every round-1 finding (§14) and added the client proxy (§5), the multi-provider model chain (§12) and the client wiring (§13).
- **Revision 3** fixes the three round-2 blockers and the hardening list (§16): proxy path canonicalisation, the Codex sandbox re-grant, reflect log text, no bank delete or clear through the proxy, a separate rate-limited document-delete secret, supervisor-managed Postgres with a non-superuser app role, nightly SYSTEM backups and a daily restart cap.

**Where things live**
- **Source of truth:** this repo, `scripts/hindsight/`. The branch is `d/hindsight-ops-20260928`.
- **Deployed copy:** `D:\hindsight\service\`, put there by `hindsightctl.ps1 deploy`. Never edit the deployed copy directly. `D:\hindsight` has no git.
- **Backups** (`D:\hindsight\_backups\<timestamp>\`): every file changed on `D:` was copied first.
  - `20260927-234149`: the original service files, provider file and `Startup\Hindsight.vbs`.
  - One folder per later deploy, each with `SHA256SUMS.txt`.
  - `20260928-003905-acl`: the ACLs of `D:\hindsight` before hardening (`icacls /restore` format).

## 1. Commands

Run each command with `powershell -NoProfile -ExecutionPolicy Bypass -File D:\hindsight\service\hindsightctl.ps1 <command>`.

| Command | What it does |
|---|---|
| `deploy` | Backs up, copies the scripts to `D:\hindsight\service`, and patches the claude-code provider to v3 (§4). Creates any missing API key or document-delete secret. Starts nothing. |
| `harden-acl` | Restricts `D:\hindsight` (DB, service scripts, venv, logs) to Usman + SYSTEM and removes inheritance from `D:\`. Saves the old ACLs first. |
| `supervisor.py harden-db --profile p` | Separate random passwords for the `postgres` superuser (operator only) and the app role, and makes the app role **non-superuser** (§5.2). |
| `supervisor.py admin --profile p --action delete-bank\|clear-bank --bank B --confirm B` | **Operator-only**, on this console, straight to the API. Bank delete and clear are never reachable through the proxy. |
| `install-backup-task.ps1` | **Elevated, once:** the nightly SYSTEM backup task (§15). |
| `start [-Profile p]` | Launches the supervisor through WMI, so it never lives inside an agent or Claude session job. |
| `stop [-Profile p]` | Clean shutdown in this order: proxy, then API, then Postgres. |
| `status [-Profile p]` | Sanitised JSON status. |
| `writes -State on\|off\|show [-Profile p]` | Memory writes through the proxy. The default is **OFF**. This is the lead's switch. |
| `init-key [-Profile p]` | Random API key and document-delete secret into user-only files. Nothing is printed. |
| `scrub-logs` | Scrubs credentials and query text from logs written before 28 Sep. |
| `clear-alert [-Profile p]` | Removes the crash-loop lock once you have investigated. |
| `install-watchdog` | **Not installed** (lead decision). Kept for later. |

**Autostart**
- `Startup\Hindsight.vbs` still runs `D:\hindsight\service\hindsight.ps1 start`.
- That file is now a shim that starts the supervisor through `hindsight.vbs` (pilot profile).

**Profiles** (`hindsight.profiles.json`, no secrets)

| Profile | API port | Proxy port | Database (data dir, port) | Purpose |
|---|---|---|---|---|
| `pilot` | 8888 | **8878** | `D:\hindsight\db\hindsight-mu`, 5432 | The shared pool (`mu-shared`) and the pilot bank `mu-pilot` |
| `synth` | 8889 | 8879 | `D:\hindsight\db\hindsight-synth`, 5433 | Every functional test. Own data, keys and DB password |
| `synth-crash` | 8890 | none | none | Crash-loop test only |
| `synth-hang` | 8891 | none | none | Startup-hang test only (`tests/hang_sim.py`) |

## 2. Root cause of the "~30 s exit" (27 Sep, 20:42:22)

This section is unchanged from revision 1 and was independently corroborated by the review.

**When it died**
- Postgres logged `could not receive data from client: An existing connection was forcibly closed` on all five pool connections at **20:42:22.161**. That is the moment the API vanished, about 55 s after `Application startup complete`.
- There was no shutdown line, no traceback and no crash report.

**It was killed from outside**
- The old launch chain was:
  `Startup VBS → hidden powershell → hindsight-api.exe` (pip launcher) `→ venv python.exe` (redirector) `→ python.exe` (server).
- Both launchers hold their child in a **kill-on-close job object**.
- **Reproduced at 23:48:54:** killing only `hindsight-api.exe` killed the server with no log line and orphaned Postgres, with the identical "forcibly closed" signature.
- The reviewer independently saw the same job behaviour when killing a supervisor redirector.

**It is not Hindsight itself**
- The same launcher, started outside the boot window, ran healthy for 5.5 minutes.
- AgenticOS's first server instance also died in the same boot minute (the AgenticOS supervisor log shows it up at 20:40:48 and "not listening" at 20:42:49).
- **Not identified:** which process sent the kill. There is no process-exit auditing (Security 4689 and Sysmon are off), and every event log for 20:42:10–35 holds only Wi-Fi and DeviceSetupManager entries.

**Why it stayed down**
- Nothing supervised it.
- The exit code was discarded.
- Every start overwrote the logs.
- The orphaned Postgres was left running.

**Fix:** the supervisor (§3). An external kill now costs one recorded restart, for example `0xFFFFFFFF` "terminated externally", instead of a silent outage.

## 3. The supervisor (`scripts/hindsight/supervisor.py`)

It uses only the standard library and ctypes, and runs under the venv's `python.exe` with a hidden console.

**Single instance per resource**
- **Two** named mutexes, one per API port and one per database directory (`Local\MU-Hindsight-Supervisor-port<N>` and `…-db-<hash of the data dir>`).
- Two profiles that share either the port or the database can never supervise side by side (round-1 D3, round-2 item 6).
- The crash-test profile now has its own port and instance.

**Start-up order**
1. Crash-loop lock.
2. Temp sweep (§4).
3. **Provider-patch check.** It refuses to start if the claude-code provider is not v3, for example after a pip upgrade.
4. Key resolution.
5. Port inspection:
   - adopt its own earlier API;
   - replace an unmanaged Hindsight;
   - refuse a foreign process.
6. **Start Postgres** if it is not running (`pg_ctl start`, 127.0.0.1/::1 only, fsync **on**: pg0 had run it with `-F`, fsync off). Postgres is reused across API restarts.
7. Launch the API through `api_launch.py` (§7.3). A failed Postgres start counts as a failed launch against the bounds.
8. Once the API is healthy, launch the **client proxy** (§5.1). The proxy is supervised too: it restarts at most 5 times in 10 minutes and never takes the API down.

**Health checks and restart bounds** (fixes review D1)
- **Liveness:** `/health` every 10 s.
- **Startup timeout:** 240 s. An API that is not healthy by then is **killed** and counted as a failed launch.
- **Hang:** 6 consecutive health failures after start-up.
- **Bind check:** every 60 s.
- **Three bounds.** Hitting any of them stops the service, writes `crashloop.lock` and `ALERT.json`, and exits with code 3. Later launches refuse to start until `clear-alert`.
  - **rate:** 5 restarts in any 10 minutes;
  - **consecutive:** 5 failed launches in a row. The count resets only after 15 minutes of stable uptime. This catches the 240 s startup hang, which the rate window missed.
  - **total:** 8 restarts in any rolling hour;
  - **daily:** 12 restarts in any 24 hours. This catches crashes after long uptimes, which reset the consecutive count (round-2 item 5). The daily history is per supervisor run.
- **Proof:** the unit test simulates 240 s hang cycles and stops after 5 restarts in under an hour. The live `synth-hang` run is in §10.

**Diagnostics**
- These are sanitised: timestamps, PIDs, exit code and hex, exit class, exception **class name** only, and provider/model **names**.
- Files: `run\<profile>\{events.jsonl,status.json,api.json,ALERT.json}`.
- `events.jsonl` rotates at 5 MB.
- `clear-alert` also resets the recorded state.

**Clean shutdown**
- The order is: proxy, then API (CTRL_BREAK, uvicorn shuts down gracefully), then Postgres (`pg_ctl stop -m fast`), then the per-launch temp directory.
- A shutdown **lock** makes a second caller wait instead of exiting half-way through (review D2 race).
- **Logoff/shutdown** (review D2):
  - The supervisor loads user32, so console logoff events never arrive.
  - A hidden top-level window now receives `WM_QUERYENDSESSION`/`WM_ENDSESSION` and runs a fast shutdown (3 s API, 5 s Postgres).
  - It was exercised with a synthetic `WM_ENDSESSION` (§10). A real logoff has not been tested.

**Environment.** The API gets an allowlisted environment only: system paths, profile settings, the key and the LLM member keys. Keys for other tools in the user environment are not inherited.

## 4. Credentials

**The provider patch, v3**
- `patch_provider.py` replaced the 25 Sep patch, which copied `~/.claude/.credentials.json` into `%TEMP%` and never deleted it.
- **Nothing credential-bearing is copied or written.**
- The claude-code provider authenticates only with `CLAUDE_CODE_OAUTH_TOKEN`, passed by reference from `MU_HINDSIGHT_CLAUDE_OAUTH_TOKEN`, and only if that provider is selected.
- **It fails closed:**
  - the isolation directory is created **only** under `HINDSIGHT_CLAUDE_ISOLATION_ROOT` (the supervisor's per-launch, user-only temp directory);
  - without that variable the provider **raises** instead of falling back to `%TEMP%` (the review found v2 fell back silently);
  - the directory is removed at exit and swept by the supervisor after a kill.
- The supervisor refuses to start if the deployed file is not v3.

**The claude-code route is not used.** It is not in the model chain (§12). Anthropic's terms say subscription credentials must not be intermediated by third-party developers.

**The owner's kept folder**
- `%TEMP%\hindsight-claude-code-7kjduif8` is **kept, as the owner decided**.
- It is never read, never deleted and never scanned by any script here.
- The startup guard checks only the supervisor's own `run\<profile>\tmp`, so that folder can never block a start.
- **Proven:**
  - `test_owner_temp_folders_never_block_or_get_touched` uses synthetic folders of the same name pattern, held open, in a fake `%TEMP%` and in the real one;
  - the live pilot has started repeatedly with the owner's folder present.

**Test with a synthetic fixture** (`tests/cred_fixture_test.py`, ALL PASS)
- **Success, failure and kill:** no credential copy anywhere (the marker exists only in the fixture), no isolation directory left, no new folder in `%TEMP%`.
- **TEMP is not the isolation root:** the directory was created under the root, not under TEMP (the review's aliasing gap).
- **No root:** the provider refuses and creates nothing anywhere.

**The Codex route**
- It reads and **writes back** `C:\Users\Nebula PC\.codex\auth.json` on token refresh.
- That file is shared with the Codex CLI, with no cross-process lock on Windows.
- Codex is now the **last** failover member (§12), so it is used rarely.

## 5. Security

### 5.1 The client proxy: the only client-facing route (`scripts/hindsight/proxy.py`)

Clients (the AgenticOS connector and Jarvis, Claude Code, Hermes, hindsight-ask) call `http://127.0.0.1:8878` with **no key**.

**Who may call**
- The proxy looks up the calling process from the TCP table and compares its Windows **account SID** with its own.
- Processes of any other account (for example `CodexSandboxOffline` or `CodexSandboxOnline`) get **403**, even on loopback.
- Tested: a SYSTEM process's SID does not match.

**The key**
- The proxy reads the Hindsight key from the user-only key file and adds it upstream.
- The key is **never** in the user environment, `~/.claude.json` or the Hermes config. `set-connector-key` was **removed**.

**Allowlist**
- health;
- list and get (banks, stats, memories, documents, tags, operations);
- recall and reflect;
- the per-save **receipts** (`llm-requests`);
- retain, **forced synchronous**;
- single-memory correction (`PATCH /memories/{id}`);
- MCP, whose tool list is already restricted server-side.

**Writes**
- Writes are **OFF** unless `run\<profile>\WRITES_ENABLED` exists (`hindsightctl writes -State on`).
- They are allowed only to write banks: `mu-shared` on the pilot.
- MCP write tools (`sync_retain`, `update_memory`, `invalidate_memory`) are gated the same way.
- Read banks on the pilot: `mu-shared` and `mu-pilot`.

**Deletion**
- **Bank delete and clear are not exposed at all** (round-2 hardening). They exist only as the operator command `supervisor.py admin … --confirm <bank>` on this console.
- A **document** delete (`DELETE /v1/default/banks/{bank}/documents/{doc}`) needs:
  - writes ON and a write bank;
  - an `X-MU-Approval` token: an HMAC over `approval_id|expiry|METHOD|path`, keyed by its **own** secret `secrets\pilot-docdelete.key`, valid at most 1 hour, **single use**;
  - and it is **rate-limited to 20 an hour**.
- The token binds the exact canonical path; the route has no query string. A token for another request, a forged or replayed token, or a path containing `.`/`..`/encoding is refused.
- Mint one with `supervisor.py mint-approval --method DELETE --path <exact path> --approval-id <id>` (refuses anything but a document delete), or compute the HMAC in the approval system.

**Browsers and DNS rebinding (R3 re-check).** Clients are CLIs and servers, never browsers. Before routing, the proxy refuses with 403 (`decision: reject_browser`):
- any `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (a DNS-rebinding page on `evil.example` runs as the same Windows user and would otherwise pass the identity check);
- any request carrying `Origin` or `Sec-Fetch-Site`;
- HTTP/1.0 without a Host.
Measured client headers (28 Sep): Bun (AgenticOS, Claude Code), curl and httpx (Hermes) send none of these; Node's server-side `fetch` sends only `Sec-Fetch-Mode: cors`, which is therefore allowed on its own. Tested live on the pilot and synthetic proxies (`browser-check-8878.json`, `-8879.json`: 10/10 each), and the clients still work.

**Canonical paths (round-2 B1).** The proxy looks at the **raw** request path before anything else:
- refused with **400** (`decision: reject_noncanonical` in the audit log) if it contains any `%`-encoding, a `.` or `..` (or any dots-only) segment, `//`, a backslash, or any character outside `[A-Za-z0-9_-.:/]`;
- matched against exact route templates (MCP is exactly `/mcp/{bank}/`, GET/POST/DELETE only; query strings only on list routes and only `[A-Za-z0-9_.,=&-]`);
- forwarded by rebuilding the upstream URL from that same checked path, and refused if the HTTP library's raw path differs by even one byte.

**Everything else gets 403**, including export, import, clone, transfers, bulk operations, bank config, operation delete, bank delete, clear, `/docs`, `/metrics` and `/openapi.json`. The 19 traversal variants from the review, plus others, are regression tests (§10).

**Honest limit.** The API key, the DB passwords, the document-delete secret, the writes flag and the replay list are files that **any process running as Usman** can read or change. Claude Code, Hermes (`control_pc`) and Jarvis all have shell access as Usman. So for them the proxy is a guard rail, not a boundary. It is a boundary against **other accounts** (the Codex sandbox users). Recovery for the same-user case is the nightly backup that Usman's account cannot delete (§15). The real fix, later, is a dedicated service account that owns the key, the secrets and the database.

**Audit.** `run\<profile>\proxy.jsonl` records method, route kind, bank, tool name, client PID and executable, decision, and status. No bodies and no content.

### 5.2 Database: managed Postgres, passwords and roles (round-1 issue 1, round-2 B2 and item 4)

**Postgres is no longer run through pg0.**
- The data directories moved (a rename on D:, no copy, 1,463 files / 70.5 MB verified identical) from `D:\hindsight\pg0-home\.pg0\instances\…\data` to `D:\hindsight\db\hindsight-mu` and `D:\hindsight\db\hindsight-synth`.
- The supervisor starts and stops Postgres itself with `pg_ctl` (binaries copied to `D:\hindsight\pgsql\18.1.0`), on 127.0.0.1/::1 only, fsync **on**.
- pg0's `instance.json` files, which held the DB password in plain text, are **deleted**. Nothing on disk holds a DB password except the two user-only secret files.
- Hindsight gets `postgresql://hindsight:<pw>@127.0.0.1:<port>/hindsight` in memory; `api_launch.py` scrubs it from every log line.
- The pg0 start-output temp file that held a URI with the password (round-2 item 3) no longer exists: pg0 is not called any more.

**Two roles, two passwords** (`supervisor.py harden-db`):
- `postgres` (superuser): its own random password in `secrets\<profile>-pgadmin.db`, used only by operator commands.
- `hindsight` (the app role): random password in `secrets\<profile>.db`, now **NOSUPERUSER NOCREATEROLE NOREPLICATION**, and it still owns its database and every table (0 tables owned by anyone else). So the app password no longer gives `COPY … PROGRAM` code execution (round-2 item 4).
- Only SCRAM-SHA-256 verifiers are sent (`ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'`).
- Hindsight 0.10.1 runs as the non-superuser: synthetic acceptance 45/45 and proxy acceptance 64/64 ran on it, and the pilot started on it.

**Remaining exposure:** the API process's environment holds the URL (readable by Usman's processes and administrators); the secret files are readable by Usman's processes.

### 5.3 ACLs and the Codex sandbox (round-1 issues 1–2, round-2 B2)

- `D:\hindsight`: Usman + SYSTEM full control, inheritance from `D:\` removed, **plus an explicit inheritable DENY for `CodexSandboxUsers`** (verified with `Get-Acl`: `Deny FullControl ContainerInherit, ObjectInherit`).
- **Root cause of the re-grant:** Codex's elevated sandbox grants its users read on items in the profile root, and `C:\Users\Nebula PC\.pg0` was a junction into `D:\hindsight\pg0-home\.pg0`. That junction is **removed** (the link only, with `rmdir`; nothing was deleted through it), and nothing under the profile root points into `D:\hindsight` any more.
- **Tested (28 Sep 02:17):** four `codex sandbox -- …` commands, running as `desktop-d8qctmg\codexsandboxoffline`:
  - `whoami` → `codexsandboxoffline`;
  - `dir D:\hindsight\db\hindsight-mu` → **Access is denied**;
  - `type …\PG_VERSION` → **Access is denied**;
  - `dir D:\hindsight\service\secrets` → **Access is denied**;
  - afterwards, **0** directories under `D:\hindsight` carry a CodexSandbox allow entry.
- The backup folder `D:\hindsight-backups` gets the same deny when it is installed (§15). Usman's account cannot change its ACL at all, so a Codex session cannot add a grant there.

**Codex workspaces inside `D:\hindsight` (R3 re-check finding).** When Codex uses a folder as its workspace it adds an **explicit** allow on that folder, which beats a deny inherited from a parent.
- Reproduced on a scratch folder `D:\hindsight\codex-ws-test` with one `codex exec -s workspace-write -C …` turn: Codex added `Allow(E)` on the workspace and the sandbox user could write `probe.txt` there. The `secrets` subfolder, which carried its **own explicit** deny, stayed denied (`type` and `dir` both "Access is denied").
- **Fix 1: explicit denies on every protected folder**, not only on `D:\hindsight`: `db`, `service`, `service\secrets`, `service\run`, `_backups`, `logs`, `venv`, `pgsql`, `home`, `pg0-home`, `onnx-cache`. An explicit deny and an explicit allow on the same folder: the deny wins.
- **Fix 2: a guard** (`supervisor.py acl-guard`, also run by the supervisor at start and every 30 minutes in the background): it finds every object under `D:\hindsight` with an explicit allow for `CodexSandboxUsers`, removes those allow entries, re-adds any missing explicit deny, and records an `acl_guard` event with the paths.
  - On the scratch reproduction it found and removed the workspace allow; afterwards the sandbox could neither write nor list the folder.
  - On the live tree: 0 allow entries found; the explicit denies were added to the 11 folders.
- **Rule:** never use any folder under `D:\hindsight` as a Codex workspace. If it happens, the guard undoes the grant within 30 minutes (or immediately with `hindsightctl acl-guard`).
- The scratch folder was deleted afterwards.
- **Hermes home: FINDING ONLY, not changed (owner decides).** `%LOCALAPPDATA%\hermes` inherits `CodexSandboxUsers:(RX)` from `AppData` (Codex grants read on every item in the profile root, including `AppData`). So a Codex sandbox session can read Hermes' `.env`, `auth.json` and `config.yaml` (re-checked 28 Sep 03:55: `.env` readable).
  - Context for the decision: Hermes does not use the Codex sandbox (its `openai-codex` route is a direct HTTPS client; 0 app-server lines in its logs), so a deny on that folder would not break Hermes.
  - History: a deny was applied at 02:30 and then **reverted on instruction** (the owner does not want live Hermes changes made on an agent's initiative). The removal of the deny re-propagated inheritance, so every item's DACL was then restored **exactly** from the `icacls /save` taken first (`D:\hindsight\_backups\20260928-022906-hermes-acl\hermes-acls.txt`), item by item with `SetFileSecurity` (no elevation needed as the owner; junction objects via their own handle). Verified with a fresh `icacls /save`: 155,244 of 155,244 surviving items identical, 0 different, 0 deny entries; 25 files created since the save inherit from the restored parents. `hermes chat -Q` answered "ok"; the gateway (started 20:40) was never restarted.
  - Also on that folder, not changed: an inherited `S-1-15-3-3557520199-…` capability SID (an app-container package) with FullControl on the folder.
- **Other secret-looking files the Codex sandbox group can read (names only, from ACLs; no file opened; `%TEMP%` not scanned):** `~\.claude\.credentials.json`, `~\.claude\daemon\control.key`, `pipe.key`, `~\.codex\auth.json`, `~\.codex\secrets\mcp_oauth.age`, `~\.cache\huggingface\token` and `stored_tokens`, `~\.changedetection\secret.txt`, `~\.claude-os\dev-token`, `~\.dsh\.credentials.yaml`, `~\.fcc\.env`, `~\.local\share\opencode\auth.json`, `~\.modal.toml`, `~\.notebooklm\profiles\default\storage_state.json`, `~\.npmrc`, `~\.openclaw\openclaw.json`, `~\.openclaw-node-pilot\identity\device-auth.json`, `~\.pi\agent\auth.json`, `~\.conda\aau_token`, `~\.emulator_console_auth_token`, `AppData\Roaming\GitHub CLI\hosts.yml`, `AppData\Roaming\com.vercel.cli\Data\auth.json` and `AppData\Roaming\xdg.data\com.vercel.cli\auth.json`, `AppData\Roaming\Claude\buddy-tokens.json`, `AppData\Roaming\Hermes\secure-token-storage.json`, `AppData\Local\vitest\.vitest-secret-token`, `~\.claude\uploads\…\*-tokenharbour.txt`, `~\Downloads\tokenharbour.txt`, `~\Downloads\ses-smtp-user…smtp_credentials.csv`, two `~\Downloads\…client_secret_….apps.googleusercontent.com.json`, and `.env`/`.env.local` files under `~\Documents\New folder\itqan-*` and `salah-goals`. Many Chromium `Trust Tokens`/`Vpn Tokens` stores are also readable (browser state; DPAPI-protected cookies are not readable to another account). `~\.config\agentic-os.env` and `~\.claude.json` were **not** readable at the time of the check (Codex grants on some items per run). **Not changed:** these are outside my ownership; routed to the lead.

### 5.4 Other facts

- The API and the proxy bind `127.0.0.1` only. Postgres binds `127.0.0.1` and `::1`.
- Direct API calls without the key still get 401 (REST and MCP).
- **Open without auth on the API port** (review issue 9): `/health`, `/health/ready`, `/health/live`, `/version`, `/docs`, `/openapi.json`, `/metrics`.
  - These give liveness, the API schema and counters: provider and model labels, latencies. There are no bank ids and no content.
  - Through the proxy only `/health` is reachable.
- The MCP tool allowlist excludes `delete_bank`, `clear_memories`, `delete_document`, `clear_mental_model`, the other delete and create tools, and **`retain`** (async; its payload outlived a forget).
- **Retain upsert** (same `document_id`, `replace`) overwrites a document without approval. That is the correction mechanism; a runaway loop is recoverable from the nightly backup (§15).

## 6. Enablement settings for AgenticOS (connector and Jarvis)

| Name | Value |
|---|---|
| `HINDSIGHT_ENABLED` | `1` |
| `HINDSIGHT_URL` | `http://127.0.0.1:8878` (the proxy) |
| `HINDSIGHT_API_KEY` | **Not needed** and should stay unset. The proxy authenticates the AgenticOS process by its Windows account. |
| `HINDSIGHT_BANK` | `mu-shared`, the one shared pool (the connector's default) |
| `MEMORY_WRITES` | `1` only when the lead enables writes, together with `hindsightctl writes -State on -Profile pilot` |

**Contract**
- Retain one note or memory per document (`document_id` = `wiki_ref` or `mem_ref`). The proxy forces `async:false`.
- Forget with `DELETE /v1/default/banks/mu-shared/documents/{id}` plus header `X-MU-Approval`, issued by the approval path for that exact request with the **document-delete** secret. At most 20 an hour. Treat 404 as already gone.
- Show "which model processed this save" from `GET /v1/default/banks/mu-shared/llm-requests`. Rows carry provider, model, status, tokens and time; prompt and response are cut to one character.

## 7. Retention, logs and deletion

### 7.1 Settings

| Setting | Value | Effect |
|---|---|---|
| `LLM_TRACE_ENABLED` / `LLM_TRACE_MAX_CHARS` | `true` / `1` | **Receipts, not traces.** Every LLM call records provider, model, status, tokens and duration. Input and output are truncated to 1 character. Verified: no canary text in any `llm_requests` column. |
| `LLM_TRACE_RETENTION_DAYS` | `30` | Receipts are swept after 30 days, or removed with their bank. |
| `AUDIT_LOG_ENABLED` | `false` | The default. |
| `OPERATION_RETENTION_DAYS` | `1` | Operation rows and payloads are pruned after a day. |
| `ENABLE_AUTO_CONSOLIDATION` | `false` | Unchanged guard. |

### 7.2 Deletion (synthetic, SQL counts)

- **Document delete** removes the document, chunks, facts and embeddings, links, entity links and entities. `GET` then gives 404 and recall is empty.
- **Single memory:** stored as its own document and deleted with `DELETE /documents/{mem_ref}` through the approval path. The facts are gone.
- **Bank delete:** 0 rows in 22 tables, and no canary anywhere.
- **Per-fact `PATCH state=invalidated`** is soft: the text is kept until its document is deleted.
- **Async payloads:** closed on every client route. The proxy forces synchronous retains, and MCP `retain` is no longer exposed.

### 7.3 Logs (review issue 5)

- The API runs through `api_launch.py`. Before Hindsight imports anything, it scrubs every log record and every stdout/stderr write:
  - secret values from the environment;
  - credentials in URIs;
  - recall and reflect **query previews**, and every `query='…'` in the reflect agent's tool calls;
  - the reflect agent's INFO/DEBUG lines as a whole (replaced by `[agent detail suppressed: may contain memory text]`, round-2 B3);
  - the mission-merge response preview.
- Logs rotate by count (10 launches) **and age (14 days)**.
- `scrub-logs` cleaned the pre-existing logs.
- The proxy and supervisor logs never contain bodies or content.
- A leak scan of the API logs, proxy log and events found no key, no DB password and no canary text (§10).

## 8. Tool access

- **Capture, recall, update and correction** are available to all clients, through the proxy.
- **Bank delete and clear** are unreachable through ordinary memory access: they are not exposed by the proxy at all (operator command only). Document deletes need an approval token and are rate-limited.

## 9. Owner and lead actions

**Lead**
1. **Enable writes after re-review.** Run `hindsightctl writes -State on -Profile pilot`, then set `MEMORY_WRITES=1` and `HINDSIGHT_ENABLED=1` with `HINDSIGHT_URL=http://127.0.0.1:8878` (no key) in AgenticOS, then restart the OS once.
2. **Connector change** (d-memory, not my file). In `hindsight-client.ts`, `deleteDocument` must send `X-MU-Approval`, signed with `secrets\pilot-docdelete.key` (§6, §13). Without it, forget returns 403 through the proxy.
2a. **Install the backup task** from an elevated PowerShell: `powershell -NoProfile -ExecutionPolicy Bypass -File D:\hindsight\service\install-backup-task.ps1` (§15). I cannot register a SYSTEM task from this non-elevated session.
3. **Apply the Claude Code and skill wiring:**
   - `scripts/hindsight/clients/connect-clients.ps1 -Client claude -Apply`
   - `scripts/hindsight/clients/connect-clients.ps1 -Client skill -Apply`
   The diffs are in §13. I did not edit Claude Code's own configuration or skills on an agent's instruction.
4. **Hermes gateway** picks up its already-edited MCP entry on `/reload-mcp` or on its next restart. I did not restart it (Telegram). The comment above that entry, which says recall-only until a Pinecone comparison, is now stale.

**Owner**
- None required. The kept `%TEMP%` folder stays exactly as it is.

## 10. Tests and evidence

Evidence lives in `docs/hindsight-evidence/`.

| Test | Command | Result |
|---|---|---|
| Unit | `python -m unittest discover -s scripts/hindsight/tests -p "test_*.py"` | **30 pass** (rev 3): adds canonical-path rejection of 15 traversal forms, strict routes (no bank delete/clear), daily cap, two mutexes, managed-Postgres URL, reflect scrubbing |
| Credentials (synthetic fixture) | `python scripts/hindsight/tests/cred_fixture_test.py` | **ALL PASS**: success, failure, kill and no-root |
| API acceptance (8889) | `python scripts/hindsight/tests/synthetic_acceptance.py` | **45/45**: 401s, loopback, receipts without text, document/memory/bank deletion by SQL counts |
| Proxy acceptance (8879) | `python scripts/hindsight/tests/proxy_acceptance.py` | **64/64** (rev 3): key-less clients, SID check, forced sync, correction, approval-only document deletes, bank delete/clear not exposed even with a signed token, 19 raw traversal requests refused with no effect (victim bank intact, no clear, no hidden bank, no payload), rejections logged as `reject_noncanonical`, reflect, writes switch, 403 allowlist, MCP, operator bank delete, leak scan incl. reflect |
| Route evaluation | `python scripts/hindsight/tests/route_eval.py` | §12 |
| Startup-hang bound (live) | profile `synth-hang` | **Stopped at the bound.** 1 start + 5 restarts, each killed at the 240 s startup timeout; `crashloop_stopped` ("6 failed launches in a row") after 25.5 min, while the rate window held only 2 (`synth-hang-events.jsonl`) |
| Session end (synthetic `WM_ENDSESSION`) | `python scripts/hindsight/tests/session_end_check.py` | **Pass** (rev 3): proxy, API, then Postgres (`pg_ctl`) stopped in 4.8 s, in that order; Postgres log "fast shutdown … shut down"; nothing left running |
| Backup + restore (synthetic) | `python scripts/hindsight/tests/restore_test.py` | **PASS**: `backup.ps1` dump of the synthetic DB (seeded with a synthetic bank), restored into a throw-away cluster as the non-superuser role; all 10 table counts identical |
| Codex sandbox | `codex sandbox -- …` (§5.3) | **Denied** for the DB, `PG_VERSION` and `secrets`; 0 CodexSandbox allow entries under `D:\hindsight` afterwards |
| Connector through the proxy | d-memory `connector.live.test.ts` with `tests/approval_fetch_shim.ts` | **9/9** on the rev-3 synthetic proxy |
| Clients | `python scripts/hindsight/tests/client_check.py --client … --target …` | §13 |
| Pilot, read-only | `python scripts/hindsight/tests/pilot_check.py` | **Pass** (rev 3, after the data move): 401 without key; proxy read-only recall 200; proxy write while OFF 403; bank delete 403; counts unchanged (below). Plus 3 raw traversal requests to the pilot proxy, all **400** before routing (`reject_noncanonical`) |

**Pilot counts (`mu-pilot`, SQL)**

| | banks | documents | chunks | facts (with embedding) | links | entities | unit_entities | llm_requests |
|---|---|---|---|---|---|---|---|---|
| 27 Sep 23:44 (before any change) | 1 | 1 | 17 | 31 (31) | 979 | 85 | 123 | 0 |
| 28 Sep 01:16 (after revision 2) | 1 | 1 | 17 | 31 (31) | 979 | 85 | 123 | 0 |
| 28 Sep 02:16 (after revision 3: data moved, roles hardened) | 1 | 1 | 17 | 31 (31) | 979 | 85 | 123 | 0 |

**Incident during the pilot DB-password rotation (28 Sep 01:10–01:16, recovered, no data touched)**
- My first rotation changed only the app role. Two things then went wrong:
  - I wrote a stale postmaster pid back into pg0's `instance.json`;
  - pg0 re-connects as the bootstrap superuser `postgres` at every start.
- pg0 then failed its start-up login and deleted `instance.json` (twice). The supervisor's first pilot start on the new code failed 1 launch, then was stopped.
- **Recovery:**
  - started Postgres directly with `pg_ctl`;
  - gave both login roles (`postgres`, `hindsight`, both superusers) the new SCRAM password;
  - confirmed that the old default no longer logs in for either role;
  - restored `instance.json` from its backup with the new password.
- Revision 3 replaced `rotate-db-password` with `harden-db` on the supervisor-managed Postgres (no pg0 metadata any more).
- The data directory was never modified. The counts above are unchanged.

## 11. Rollback

1. `hindsightctl stop`.
2. Restore `D:\hindsight\_backups\<ts>\service\*` and the provider file.
3. Restore the ACLs with `icacls D:\ /restore D:\hindsight\_backups\20260928-003905-acl\hindsight-acls.txt`.
4. Revision 3 moved the data directories to `D:\hindsight\db`. Going back to pg0 means moving them back, recreating the `C:\Users\Nebula PC\.pg0` junction and pg0's `instance.json`. Not recommended.

This is not recommended.

## 12. Memory-processing model: evaluation and choice

**Method**
- Synthetic instance, the real Hindsight extraction pipeline and the real supervisor.
- 6 synthetic business notes × 2 rounds = 12 synchronous retains per route.
- A checklist of 25 expected facts, plus forbidden hallucinations.
- Receipts come from `llm_requests`.
- Evidence: `route-eval.json` (round 1), `route-eval-2.json` (round 2, after configuration fixes) and `route-eval-hermes.json`.

| Route (model) | Saves OK | Checklist quality (all saves / successful saves) | Median / max latency | Cost for 12 saves | Data handling (sources: sub-agent research, 28 Sep) |
|---|---|---|---|---|---|
| **OpenRouter** `deepseek/deepseek-v4.1-flash`, ZDR + `data_collection: deny` (round 2) | **12/12** | **100% / 100%**, 0 hallucinations | **4.3 s** / 15.8 s | **US$0.0021** (metered) | OpenRouter keeps no prompts by default; ZDR endpoints retain nothing and do not train; DeepSeek's own endpoint is excluded ([OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr), [data collection](https://openrouter.ai/docs/guides/privacy/data-collection)) |
| OpenRouter, same model, `deny` only (round 1) | 12/12 | 100% / 100% | 7.5 s / **117.5 s** (one slow provider) | US$0.0022 | Same, without the ZDR filter. This slow tail is why the chosen route has a 60 s member timeout |
| DeepSeek direct `deepseek-flash` | 12/12 | 100% / 100% | 5.1 s / 19.1 s | US$0.0073 (metered, prepaid) | Stored in China; used to train by default, opt-out by email ([privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)) |
| Codex `gpt-6-astra` (ChatGPT subscription) | 12/12 | 100% / 100% | 7.8 s / 12.8 s | Plan allowance (not free) | Consumer ChatGPT; training follows "Improve the model for everyone"; shares the owner's Codex login (`auth.json`) |
| Groq free `openai/gpt-oss-120b` (round 2, `service_tier=on_demand`) | 2/12 | 16% / 89% | 2.9 s / 3.0 s | Free | No training; logs up to 30 days ([Groq your data](https://console.groq.com/docs/your-data)). Free tier is **8k tokens/min**: about 2 saves a minute, then 429 |
| Groq, round 1 | 0/12 | 0% | n/a | Free | Hindsight sent `service_tier=auto`, which the free tier refuses. Fixed with `HINDSIGHT_API_LLM_GROQ_SERVICE_TIER=on_demand` |
| Gemini free `gemini-3.8-flash` | 7/12 then 0/12 | 56% / 100%, then 0% | 15.3 s / 53.3 s | Free | Trains and allows human review on the unpaid tier; Australia gets unpaid terms ([Gemini API terms](https://ai.google.dev/gemini-api/terms)). 429s: context-cache limit 0 in round 1, daily quota exhausted in round 2 |
| Hermes API server (`hermes-agent`, 1 save) | 1/1 | 80% | 8.2 s | Hermes' Codex allowance | A full agent run of about 16.6k input tokens per call (4x the others), and it stores every prompt in Hermes' session DB. **Not suitable** |
| **Failover proof** (production chain with the primary given a synthetic invalid key) | **6/6** | 96% / 96% | 5.1 s / 12.3 s | Free and subscription | Receipts show each save's real model: 3 by Groq, then 3 by Codex once Groq hit its per-minute limit; 6 recorded primary failures |

**Choice (written down, not asked)**
- **Default:** OpenRouter `deepseek/deepseek-v4.1-flash`, with `provider: {zdr: true, data_collection: "deny"}`.
  - 100% of expected facts, 0 errors and median 4.3 s in round 2.
  - About US$0.0002 per save, metered.
  - OpenRouter keeps no prompts. ZDR endpoints keep none and do not train. DeepSeek's own China-hosted endpoint is excluded by these flags.
- **Fallback 1:** Groq `openai/gpt-oss-120b`, the free eligible model (V7: paid unavailable → free).
  - No training, logs up to 30 days.
  - The free tier's 8k tokens/min limits it to about 2 saves a minute, so it is a fallback, not a default.
- **Fallback 2:** Codex `gpt-6-astra` on the ChatGPT subscription.
  - 100% quality in round 1.
  - Last because it shares the owner's Codex login and allowance, and training follows the consumer "Improve the model" setting.
- **Not used:**
  - **DeepSeek direct:** 100% and fastest, but data is stored in China and used for training by default.
  - **Gemini free:** it trains on data and uses human review, and it failed with 429s in round 1.
  - **Hermes:** an agent run of about 16.6k input tokens per call; it stores every prompt in its own session DB.
  - **claude-code:** Anthropic's terms bar third-party use of subscription credentials.
- **Automatic fallback:** Hindsight's `HINDSIGHT_API_LLM_STRATEGY={"mode":"failover"}` with members 1 and 2. A member whose key reference is unset is skipped by name.
- **Which model actually processed each save** is recorded per call in `llm_requests` (receipts) and readable through the proxy.

## 13. Client wiring

**Configuration.** Every client uses the proxy on 127.0.0.1:8878 and bank `mu-shared`. There is no key and no header in any client config. `scripts/hindsight/clients/connect-clients.ps1` backs up each file and applies the change.

| Client | Change (redacted diff) | Applied? | Real save + recall (synthetic proxy 8879, bank `mu-shared`) | Read-only on the pilot (proxy 8878) |
|---|---|---|---|---|
| **Hermes** `%LOCALAPPDATA%\hermes\config.yaml` | `- url: http://127.0.0.1:8888/mcp/mu-pilot/` becomes `+ url: http://127.0.0.1:8878/mcp/mu-shared/`; the include list gains `sync_retain`, `update_memory` and `invalidate_memory` (no delete or clear tools) | **Yes.** Backups: `config.yaml.bak-hindsight-20260928-010929` (original) and `…-011035`. The gateway picks it up on `/reload-mcp` or its next restart (not done) | **Pass.** A `hermes chat -Q` one-shot saved and recalled "The Kestrelb8f0d1 test garage opens at 9am." The proxy log shows `python.exe sync_retain allow 200` and `recall allow 200` | Recall on `mu-shared`: 0 results (the pool is empty until writes are enabled) |
| **Claude Code** `~/.claude.json` `mcpServers.hindsight` | `- "url": "http://127.0.0.1:8888/mcp/mu-pilot/"` becomes `+ "url": "http://127.0.0.1:8878/mcp/mu-shared/"`. `type: http` stays; no headers | **No: lead to apply** (`connect-clients.ps1 -Client claude -Apply`). I do not change Claude Code's own configuration on an agent's instruction | **Pass.** `claude -p` with the identical entry via `--mcp-config` saved and recalled "The Kestrel607420 test clinic opens at 7am." The proxy log shows `claude.exe sync_retain` and `recall`, both allowed | Recall on `mu-pilot`: 200 |
| **hindsight-ask** `~/.claude/skills/hindsight-ask/SKILL.md` | The curl URL and health URL change to `127.0.0.1:8878/.../mu-shared/`, and the start hint to `hindsightctl.ps1 start` | **No: lead to apply** (`-Client skill -Apply`), for the same reason | **Pass.** The documented curl form: save HTTP 200, recall found "Kestrelc6ac44" | Recall on `mu-pilot`: 9 results |
| **AgenticOS connector / Jarvis** (d-memory) | `HINDSIGHT_URL=http://127.0.0.1:8878`, no `HINDSIGHT_API_KEY` (§6) | Lead | **9/9** of the connector's own `connector.live.test.ts` through the synthetic proxy with no key: health, sync + remember + save to vault + recall with sources, restart, Obsidian edit, correction retracts the old document, rename keeps one document, the three forget kinds, wrong-key fails closed, usage receipts | n/a |

**About the connector result**
- Without an approval header the connector passes 7/9. Correction-retract and forget are refused (15 `DELETE … deny: approval token required` in the proxy log).
- The 9/9 run used a **test-only preload** (`tests/approval_fetch_shim.ts`). It adds exactly the `X-MU-Approval` header the connector patch in §9 must send.
- So the OS flow is proven end to end **once that one-function patch lands** in `hindsight-client.ts`. This is the connector owner's file.
- The observed outputs (save, recall, correction suppressing the old fact, single-memory deletion) are in `connector-live-via-proxy.txt` and `proxy-acceptance.json`.

**Connector patch** (d-memory `scripts/memory/hindsight-client.ts`; not applied, not my file)

```ts
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
const APPROVAL_SECRET_FILE = process.env.HINDSIGHT_APPROVAL_SECRET_FILE ?? "D:\\hindsight\\service\\secrets\\pilot-docdelete.key";
/** Only for deletes the connector's approval path has decided: routine retracts (correction, a note
 *  removed from the vault) and owner-approved forgets. Never bulk. */
function approvalHeader(method: string, path: string): string {
  const id = `ap-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const secret = readFileSync(APPROVAL_SECRET_FILE).toString().trim();
  return `${id}.${expiry}.${createHmac("sha256", secret).update(`${id}|${expiry}|${method}|${path}`).digest("hex")}`;
}
// in deleteDocument(id): headers["X-MU-Approval"] = approvalHeader("DELETE", `/v1/default/banks/${bank}/documents/${id}`);
// (sign the DECODED path: the proxy verifies against the path it receives, percent-decoded)
```

## 14. Review findings: status

| # | Finding | Fix | Evidence |
|---|---|---|---|
| 1 | Default DB password, logged; DB world-writable | Random password (SCRAM), scrubbed logs, ACL Usman + SYSTEM | §5.2, §5.3, leak scan |
| 2 | Scripts and venv writable by other accounts | Same ACL fix | `icacls` in §5.3 |
| 3 | Restart bound only rate-limited | Consecutive and total caps, plus startup-timeout kill | Unit test, live `synth-hang` |
| 4 | One all-powerful key, spread to clients | Client proxy with SID check and allowlist; deletes need an approval token; the key stays in files read by proxy and supervisor only | Proxy acceptance |
| 5 | Query text in logs; async MCP payloads | `api_launch.py` scrubber, age rotation; MCP `retain` removed; forced sync | Leak scan |
| 6 | Logoff handler unreachable, and a race | Hidden `WM_ENDSESSION` window and shutdown lock | Session-end check |
| 7 | Two profiles sharing one port and DB | Mutex per resource; separate crash profile | Unit test and profiles |
| 8 | Credential guard: silent `%TEMP%` fallback, aliased test, pip upgrade | v3 fails closed; test separates TEMP and root; start-up `--check` | Credential test |
| 9 | Open endpoints understated | Documented; only `/health` through the proxy | §5.4 |
| 10 | Account id in the old world-readable log | ACL fix and `scrub-logs` | §5.3 |
| 11 | Small defects | LoudError stops an adopted API; `clear-alert` updates status; events rotate | Code |

## 15. Nightly backups (round-2 item 2)

- `backup.ps1` runs `pg_dump -Fc` of the pilot database as the app role, verifies the dump with `pg_restore --list`, keeps **14 days**, and writes a secret-free `last-backup.json`. If Postgres is not running it records "skipped". The password is read into that process's environment only.
- **Install** (elevated, once): `install-backup-task.ps1`. It creates `D:\hindsight-backups` with SYSTEM + Administrators full control, **Usman read-only** (cannot change or delete), and a deny for `CodexSandboxUsers`; copies `backup.ps1` and the Postgres client tools into its protected `bin` (so SYSTEM never runs a file Usman can modify); and registers `\MU\Hindsight nightly backup` as SYSTEM, daily 03:30, run-when-missed.
- **Installed 28 Sep 02:52** by the lead from an elevated PowerShell (owner's UAC click). The first run failed: `failed: UnauthorizedAccessException`.
  - **Cause:** `secrets\pilot.db` was Usman-only (the supervisor's `restrict_acl` removed inheritance and granted only the user), so SYSTEM could not read the app password.
  - **Fix (no elevation needed):** SYSTEM now has access to the secrets folder and files, and `restrict_acl` always grants Usman **and SYSTEM** (the Codex deny stays).
  - `backup.ps1` now records the failing **step and path** (never a value) and who it ran as; the installer is idempotent, re-copies the current `backup.ps1`, waits up to 5 minutes and prints OK/FAILED instead of throwing.
  - The protected copy in `D:\hindsight-backups\bin` is still the first version (it needs elevation to replace); it works now that the ACL is fixed. Re-running the installer once, elevated, updates it to the step-logging version.
- **First scheduled SYSTEM run: OK** (28 Sep 03:34, `hindsight-20260928-033405.dump`, 175,126 bytes, 178 entries). `tests/restore_from_dump.py` restored that real file into a throw-away cluster as the non-superuser role: all 10 table counts identical to the live pilot (read-only); scratch cluster deleted (`docs/hindsight-evidence/restore-from-system-backup-033405.txt`). The first attempt of the test failed with "scratch cluster did not start" (not reproducible; the startup log is now kept outside the cluster and printed on failure).
- **Self-test (as Usman, scratch folder):** the new `backup.ps1` dumped the live pilot (175,126 bytes, 178 entries); `tests/restore_from_dump.py` restored that file into a throw-away cluster as the non-superuser role and all 10 table counts matched the live database (read-only); the scratch cluster and the scratch dump were deleted.
- **Restore** (tested on synthetic data, `tests/restore_test.py`): create the role and database, create the `vector` and `pg_trgm` extensions as `postgres`, then `pg_restore --no-owner --no-comments --role=hindsight --exit-on-error <dump>`, so every object is owned by the non-superuser app role.

## 16. Round-2 review findings: status (`REVIEW-HINDSIGHT-R2.md`)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| B1 | Proxy allowlist bypassed with `..` / `%2e` / `%2F` segments; approved `DELETE …/documents/..` deleted the bank | Raw path must be canonical before matching (400 `reject_noncanonical` otherwise); strict templates; MCP exactly `/mcp/{bank}/`; upstream URL rebuilt from the checked path and compared byte-for-byte; route template logged | Unit test (15 forms); proxy acceptance 19 raw attacks with no effect; pilot proxy 3 read-only probes → 400 |
| B2 | Codex sandbox re-granted read on the pilot DB through the `.pg0` junction; `instance.json` held the password | Junction removed; data moved to `D:\hindsight\db` and run by the supervisor with `pg_ctl`; `instance.json` deleted; explicit inheritable DENY for `CodexSandboxUsers` on `D:\hindsight` | `codex sandbox` reads denied; 0 allow entries afterwards; secret-value scan of 7,406 files: 0 hits |
| B3 | Reflect logged its question and tool queries | `query='…'` scrubbed; reflect-agent INFO/DEBUG lines replaced entirely | Unit test; proxy acceptance leak scan after a live reflect: 0 canary lines |
| 1 | One secret for all destructive routes; bank delete/clear via approval | Bank delete and clear removed from the proxy (operator CLI only); separate document-delete secret; 20 an hour | Proxy acceptance |
| 2 | Same-user limit wider than stated; no recovery | Stated honestly (§5.1); nightly SYSTEM backup Usman cannot delete | §15, restore test |
| 3 | DB password in a pilot run temp file | pg0 no longer used; old launch dirs swept; scan 0 hits | Secret scan |
| 4 | Both DB roles superusers | App role NOSUPERUSER; separate admin password | `harden-db`: superuser=f, 0 foreign-owned tables; pilot runs on it |
| 5 | Crash after 15+ min restarts forever | Daily cap: 12 restarts per 24 h | Unit test |
| 6 | Mutex one combined string | Two mutexes (port, database) | Unit test |
| 7 | Retain upsert overwrites without approval | Kept (it is the correction path); recoverable from backup | §5.4 |
| 8 | Groq "free" only if the org has no billing | Unverified; receipts record provider and model per call | §12 |
| 9 | Client notes | Hermes applied, not reloaded; `.claude.json`: apply with Claude Code closed or via `claude mcp`; proxy saves bypass AgenticOS's own ledger (owner's call) | §13 |
| 10 | Doc corrections | §5.1, §5.2, §5.3 and §7.3 rewritten | This document |
| R3-a | Codex workspace inside `D:\hindsight` overrides the inherited deny | Explicit deny on 11 protected folders; `acl-guard` at start, every 30 min and on demand | Scratch reproduction with `codex exec`: workspace allow found and removed, secrets stayed denied |
| R3-b | Proxy did not validate `Host` (DNS rebinding) | `Host` must be `127.0.0.1:<port>`/`localhost:<port>`; `Origin` or `Sec-Fetch-Site` → 403 | Unit test; `browser_check.py` 10/10 on pilot and synth proxies; clients still work |
| R3-c | Hermes home readable by the Codex sandbox | **Not fixed: reported for the owner.** A deny was applied, then reverted on instruction; ACLs restored exactly from the saved copy | Fresh `icacls /save`: all surviving items identical to the saved copy; Hermes CLI answers |

