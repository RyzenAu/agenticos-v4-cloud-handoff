# Hindsight on Ryzen-PC: disposable synthetic install, proof, and the pilot cutover procedure

Written 2 Oct 2026 on branch `ryzen/hindsight-20261002`. Governing reference: `docs/HINDSIGHT-OPS.md` (revision 3).

**State at the end of this work**
- Ryzen-PC has a working Hindsight install. Its **only** instance is the synthetic `synth` profile (API 8889, proxy 8879, Postgres 5433), running under the supervisor, healthy, with its own database and its own keys generated on Ryzen.
- The `pilot` profile is **not** initialised on Ryzen: no data directory, no run or log directory, no secrets, nothing listening on 8888, 8878 or 5432, no Startup entry and no scheduled task.
- The main PC's Hindsight was only read (a `pip freeze`, and a copy of the Postgres binaries and the ONNX cache). Nothing there was stopped, started, deployed or reconfigured.
- The real `pilot` database has **not** been moved. The cutover procedure in section 8 is written and its restore half was rehearsed on synthetic data (section 7).

## 1. What was installed where

| Thing | Ryzen location | Detail |
|---|---|---|
| Real Hindsight folder | `C:\mu-hub\hindsight` (SSD) | Everything below lives here. 1.8 GB. |
| **Junction** | `D:\hindsight` -> `C:\mu-hub\hindsight` | Created with `mklink /J`. The reviewed scripts hard-code `D:\hindsight` (about 55 places) and run unmodified. `D:` is the MU-BACKUP HDD, so the database stays off it. |
| **Second junction** | `D:\tmp` -> `C:\mu-hub\hindsight\tmp` | FlashRank (the reranker) caches its model in `\tmp` on the working directory's drive, which is `D:` through the junction. See finding F4. |
| Python | `C:\Program Files\Python313` | 3.13.9, machine scope, `winget install --id Python.Python.3.13 --version 3.13.9 --scope machine`. Same patch as the main PC. |
| Venv | `D:\hindsight\venv` | 196 packages, **identical** to the main PC's venv (section 2). `hindsight-api-slim` 0.10.1. `pip check`: no broken requirements. |
| Postgres | `D:\hindsight\pgsql\18.1.0` | 18.1 binaries copied from the main PC. Extensions in use: `vector` 0.8.5, `pg_trgm` 1.6. |
| ONNX / HF cache | `D:\hindsight\onnx-cache` | Copied from the main PC. `HF_HUB_OFFLINE=1` is set by the supervisor. |
| Service scripts | `D:\hindsight\service` | Put there by `hindsightctl.ps1 deploy`. Provider patch went `upstream` -> `v3`, and the supervisor's own check accepts it. |
| Test source | `C:\mu-hub\hindsight-src\scripts\hindsight` | A `git archive` of this branch's `scripts/hindsight` at commit `dd5ed983`. Test logs are in `C:\mu-hub\hindsight-src\_results`. |
| Synthetic database | `D:\hindsight\db\hindsight-synth` | Postgres 5433, own bootstrap and app passwords, app role `NOSUPERUSER`. |
| Staging files | `C:\mu-hub\incoming` | Scripts I used, tarballs, requirements file. Safe to delete. |

**Never delete through the junctions.** `D:\hindsight` and `D:\tmp` are directory junctions. Do not run `rmdir /s`, `rd /s` or `Remove-Item -Recurse` on `D:\hindsight` or `D:\tmp` themselves. To remove only a link: `cmd /c rmdir D:\hindsight` (no `/s`). Delete data by its real path under `C:\mu-hub\hindsight\`. A `README-JUNCTION.txt` repeats this inside the folder.

**Copies, with checksums** (SHA-256 computed on the main PC and re-computed on Ryzen after `scp`; all matched)

| File | Bytes | SHA-256 |
|---|---|---|
| `pgsql-18.1.0.tar` | 164,249,600 | `54e34f9c8e47644be284f5134c0c7beb20293ac4be980319c1a547248222b7dd` |
| `onnx-cache.tar` | 492,564,480 | `c3cb32118e3543dd1425141ddfb54f24fdfa14440862d892a21f406c5e1ab106` |
| `requirements-main-pc.txt` | 3,986 | `5bcb19aee13d85ca4a49357f5bacf914ed29bd1dbd0fa7110bc80ed5a99a7d01` |
| `hindsight-src.tar` (branch source) | 348,160 | `97fd20e905c8e292fdb9c04b92883fc3a224d95d8ebb8c2941ede3fe8d3ae189` |

The extracted Postgres tree is 154.4 MB and the cache 469.7 MB, matching the main PC.

## 2. Package parity

`D:\hindsight\venv\Scripts\python.exe -m pip freeze` on the main PC gave 196 lines (no editable or URL installs). They were installed on Ryzen with `pip install -r`. `pip freeze` on Ryzen afterwards is **identical** line for line (sorted diff: no difference). **No package failed to match.** Notable: `hindsight-api-slim==0.10.1`, `onnxruntime==1.20.1`, `FlashRank==0.2.10`, `numpy==2.5.3`, `pywin32==312`, `asyncpg==0.31.0`, `pgvector==0.5.0`, `tokenizers==0.22.2`.

## 3. Code change (the only one)

`hindsight.profiles.json` named one machine's user in the Codex home. Now:
- `scripts/hindsight/hindsight.profiles.json`: `"codex_home": "%USERPROFILE%\\.codex"`.
- `scripts/hindsight/supervisor.py`: new `expand_env_refs()`, used by `_member_env()` for `codex_home`. It expands `%NAME%` from the supervisor's environment (case-insensitive; an explicit env wins, as in tests; an unknown name is left as written). It follows the same idea as `api_key_ref.file`, which is expanded with `os.path.expandvars`.
- `scripts/hindsight/tests/test_supervisor_unit.py`: `test_codex_home_expands_userprofile_per_machine`.

The running main-PC copy in `D:\hindsight\service` is **unchanged** until someone redeploys. The expansion is a no-op for a literal path such as the old value.

## 4. Findings (what behaved differently on Ryzen)

**F1. `USERDOMAIN` under sshd is `WORKGROUP`, the machine is `RYZEN-PC`.** `hindsightctl.ps1 harden-acl` and the supervisor's `restrict_acl()` build `DOMAIN\USER` from `%USERDOMAIN%`. In an ssh session that names a non-existent account, `icacls` prints "No mapping between account names" and the script **still prints success** (it does not check the exit code). The first `harden-acl` run therefore hardened nothing. **Workaround, no code change:** run every operator command (`deploy`, `harden-acl`, `init-key`, `harden-db`) from a shell where `$env:USERDOMAIN = $env:COMPUTERNAME`. A process started through WMI (`hindsightctl start`) gets the correct `Ryzen-PC`, so the running supervisor is fine. Suggested follow-up: use `[Security.Principal.WindowsIdentity]::GetCurrent().Name`.

**F2. `harden-acl` through a junction.** `icacls D:\hindsight /inheritance:r` changed the junction object's view, but `icacls D:\hindsight\* /reset /T` then re-inherited every child from the **real** folder's ACL (`C:\mu-hub\hindsight`, which still granted `Authenticated Users` Modify). The tree was not protected until the same commands were applied to the real path. Done and verified (section 5): `C:\mu-hub\hindsight` is `RYZEN-PC\mkhan` + SYSTEM full control only, inheritance removed, plus an explicit inheritable deny for `CodexSandboxUsers`. **Re-do both steps at any redeploy:** `harden-acl` with the `USERDOMAIN` fix, then the same three `icacls` commands on `C:\mu-hub\hindsight`, then `supervisor.py acl-guard --profile synth`.

**F3. The Codex-sandbox group exists on Ryzen** (`Ryzen-PC\CodexSandboxUsers`), so the deny and the guard behave as on the main PC. `acl-guard`: 59,267 objects carry the (inherited) deny, **0 explicit allow entries**, deny re-asserted on the protected folders that exist (`service`, `service\secrets`, `service\run`, `_backups`, `logs`, `venv`, `pgsql`, `onnx-cache`, `home`). If the group did not exist the guard would quietly do nothing (`icacls /deny` fails and is ignored); `harden-acl` itself never mentions the group.

**F4. FlashRank downloads its reranker on first start, outside the HF offline flag.** `ms-marco-MiniLM-L-12-v2` (34 MB, a zip with `__MACOSX`) was fetched into `\tmp` of the working drive (`D:\tmp`) on the first API start. `HF_HUB_OFFLINE=1` covers the embedding model, which loaded from the copied `onnx-cache` with 0 download mentions in the API logs. The main PC has the same `D:\tmp\ms-marco-MiniLM-L-12-v2`; it is **not** in `onnx-cache`. On Ryzen it was moved to `C:\mu-hub\hindsight\tmp` and `D:\tmp` made a junction to it (service stopped first, then restarted; a recall after the move used the reranker: 2 results, hit). **At cutover, copy the main PC's `D:\tmp\ms-marco-MiniLM-L-12-v2` too**, or accept one 34 MB download at first start.

**F5. `D:\hindsight\home` is not created by `deploy`.** The supervisor uses it as the API's working directory, so the first two starts died silently (traceback only visible by running the supervisor in the foreground: `NotADirectoryError: [WinError 267]`). Created by hand. Add `New-Item -ItemType Directory -Force D:\hindsight\home` to any fresh install.

**F6. `hindsightctl deploy` always creates the pilot key and the document-delete secret** (`init-key --profile pilot`). They were deleted again (two single files I had just created), so no pilot secret exists on Ryzen. Never run `hindsightctl.ps1` with its default `-Profile pilot` on Ryzen (`start`, `stop`, `status`, `writes`, `acl-guard` and `clear-alert` all write a `run\pilot` folder). Pass `-Profile synth`, or call `supervisor.py ... --profile synth` directly.

**F7. `install-backup-task.ps1` cannot run unmodified on Ryzen.** It hard-codes the owner `DESKTOP-D8QCTMG\Usman` and registers under `\MU\`, which is not ours to touch. Not run. At cutover it needs the owner changed to `RYZEN-PC\mkhan` (a parameter, not a redesign) and the task path agreed.

**F8. `proxy_acceptance.py` had 2 stale checks: RESOLVED (commit after `dd5ed983`).** The first Ryzen run was `72 passed, 2 failed` of 74.
- **Supported behaviour (confirmed from code and history).** Commit `a1ec9053` (28 Sep, REVIEW-STAGE-D B3) removed `sync_retain`, `update_memory` and `invalidate_memory` from `HINDSIGHT_API_MCP_ENABLED_TOOLS` in `hindsight.profiles.json`, so Hindsight's MCP is read-only; agents save through AgenticOS (`/__memory/mcp`). `proxy.py` still lists those names in `MCP_WRITE_TOOLS`, so the proxy gate remains as a second layer (writes OFF, then `write_images`, writer capability, write bank). `test_supervisor_unit.py` already asserted the tools are absent; `proxy_acceptance.py` was not updated. Observed on Ryzen: `tools/list` has 16 read tools and no write tool; `tools/call sync_retain` with writes ON returns HTTP 200 with `result.isError: true`, text "Unknown tool: 'sync_retain'" (the proxy forwards it, Hindsight's MCP rejects it); with writes OFF the proxy answers first with JSON-RPC error `-32001` "refused by proxy: memory writes are OFF".
- **Before (3 checks):** `MCP save (sync_retain) through the proxy`; `MCP recall through the proxy finds it`; `writes OFF: REST retain -> 403, MCP save refused, recall still works` (its MCP half only needed any `error`, which an unknown tool also gives, so it proved little).
- **After (6 checks, 74 -> 77 total):**
  1. `MCP tools/list does not offer sync_retain, update_memory or invalidate_memory`.
  2. `MCP tools/call sync_retain is refused: HTTP 200 + isError "Unknown tool", nothing stored` (also counts rows in `memory_units`: 0).
  3. `supported save path: REST retain through the proxy (writes ON, write bank) -> 200, forced synchronous (no async payload row)`.
  4. `MCP recall finds the REST-saved item with its source` (text, `document_id`, `chunk_id`).
  5. `REST recall finds the same item with its source` (`document_id` and `chunk_id`).
  6. `writes OFF: REST retain -> 403, MCP sync_retain -> JSON-RPC error -32001 "memory writes are OFF" (proxy gate), recall still works`: stricter than before, it names the proxy gate.
  The existing `MCP tools exclude delete/clear/async retain` check is unchanged; the leak scan also looks for the new canary word. No other check was touched.
- **Client configs on Ryzen (names and booleans only, no content read).** `%LOCALAPPDATA%/hermes/config.yaml` and `~/.hermes/config.yaml` (user mkhan) exist, point at `http://127.0.0.1:8081/__memory/mcp`, and list none of `sync_retain`, `update_memory`, `invalidate_memory`. `~/.claude.json` and the `hindsight-ask` skill are absent on Ryzen. So no Ryzen client lists the removed tools and none points at 8878 or 8888. Impact of a config that still did: the tool would not be offered, a forced call returns "Unknown tool", nothing is saved, reads still work. The main-PC configs were not inspected or changed. `docs/HINDSIGHT-OPS.md` §13 now carries a superseded-wiring note.

**F9. `session_end_check.py` needs the supervisor and the test in the same window station.** `FindWindowW` only sees windows on its own desktop. A supervisor started by one WMI call and a test started by another were on different stations (`window_found: false`). Run both from one WMI-launched wrapper (supervisor started by `hindsight.vbs` as its child, then the check). Also wait until `status.json` says `running` and the proxy is listening: the first attempt ran 1 second too early, before the proxy existed, and correctly reported a missing `proxy_stopped`.

**F10. The Codex fallback has no login on Ryzen.** The third chain member (`openai-codex`, `gpt-6-astra`) reads `%USERPROFILE%\.codex\auth.json`, which does not exist on Ryzen and must never be copied. The chain's first two members (OpenRouter, Groq) have their keys by reference from `C:\Users\mkhan\.config\agentic-os.env`; the status shows `llm_skipped: []`. Failover to Codex would fail until the owner runs `codex login` on Ryzen.

## 5. ACL state (Ryzen, verified)

```
C:\mu-hub\hindsight   Ryzen-PC\CodexSandboxUsers:(OI)(CI)(N)    <- explicit deny
                      NT AUTHORITY\SYSTEM:(OI)(CI)(F)
                      Ryzen-PC\mkhan:(OI)(CI)(F)
```
Children inherit that (`service`, `service\secrets`, `venv\Scripts\python.exe` checked). Explicit (not inherited) Codex entries on `C:\mu-hub\hindsight`, `service`, `service\secrets`, `venv`, `pgsql`, `onnx-cache`: **Deny** only. The pre-hardening ACLs are saved in `D:\hindsight\_backups\20261002-130358-acl` and `...-130517-acl` (`icacls /restore` format).

## 6. Commands on Ryzen

All via `C:\Windows\System32\OpenSSH\ssh.exe ryzen-bots "<cmd>"`. The ssh shell is cmd; write a `.ps1`, `scp` it to `C:/mu-hub/incoming/`, and run `powershell -NoProfile -ExecutionPolicy Bypass -File C:\mu-hub\incoming\x.ps1 < NUL`. Processes started inside an ssh session die with it; `start` uses WMI for that reason.

| Action | Command (synthetic instance) |
|---|---|
| Start | `powershell -NoProfile -ExecutionPolicy Bypass -File D:\hindsight\service\hindsightctl.ps1 start -Profile synth < NUL` (then wait about 25 to 50 s for health) |
| Stop (proxy, API, Postgres, in that order) | `... hindsightctl.ps1 stop -Profile synth` |
| Status | `D:\hindsight\venv\Scripts\python.exe D:\hindsight\service\supervisor.py status --profile synth` (JSON; `live.health_http` 200 and `recorded.state` `running`) |
| Writes through the proxy | `... hindsightctl.ps1 writes -State on\|off\|show -Profile synth` (currently ON, synthetic only) |
| Listener check | `Get-NetTCPConnection -State Listen \| ? { $_.LocalPort -in 5432,5433,8878,8879,8888,8889 }` |
| Operator commands needing the domain fix | prefix with `$env:USERDOMAIN = $env:COMPUTERNAME;` |

Never pass `-Profile pilot` here (finding F6). No scheduled task and no Startup item was created for Hindsight on Ryzen.

## 7. Test results on Ryzen

All run from `C:\mu-hub\hindsight-src` with `D:\hindsight\venv\Scripts\python.exe`, against the synthetic instance, with the real model chain (OpenRouter `deepseek/deepseek-v4.1-flash` ZDR answered every retain; the receipts say so). Secrets were referenced by path only.

| Test | Command (from `C:\mu-hub\hindsight-src`) | Result |
|---|---|---|
| Unit | `python -m unittest discover -s scripts/hindsight/tests -p "test_*.py"` | **48 pass, 0 fail** (includes the new codex-home test; the ops doc's "30" is out of date) |
| API acceptance (8889) | `python scripts/hindsight/tests/synthetic_acceptance.py --evidence ...` | **45/45** |
| Proxy acceptance (8879) | `python scripts/hindsight/tests/proxy_acceptance.py --evidence ...` | **77/77 ALL PASS** after the two stale MCP checks were replaced (F8); the first run, before that change, was 72 of 74 |
| Browser/rebinding | `python scripts/hindsight/tests/browser_check.py 8879` | **10/10**, `all_pass: true` |
| Credentials fixture | `python scripts/hindsight/tests/cred_fixture_test.py` | **ALL PASS** (success, failure, kill, no-root) |
| Backup + restore | `python scripts/hindsight/tests/restore_test.py` | **PASS**: 10 tables, source and restored counts identical, as the non-superuser role |
| Session end | `python scripts/hindsight/tests/session_end_check.py` | **PASS** (F9): events `session_ending`, `proxy_stopped`, `api_stopped`, `postgres_stopped`, `supervisor_stopped`; handler 0.8 s; nothing left running |

Instance checks: app role `rolsuper = f`, 0 tables owned by anyone else (`harden-db`); health 200; chain `openrouter/deepseek/deepseek-v4.1-flash`, `groq/openai/gpt-oss-120b`, `openai-codex/gpt-6-astra`.

**Cutover rehearsal on synthetic data** (all steps, log: `C:\mu-hub\hindsight-src\_results\rehearsal.log`)
1. Seeded a synthetic bank in `synth`; dumped it with the existing `backup.ps1` (`pg_dump -Fc`, verified with `pg_restore --list`).
2. Copy + checksum: source and copy SHA-256 `81def75afbffb42d891ea6b668c55e6a42961cb23f8dc9749fb542a37c3d4acd`, match.
3. New cluster `D:\hindsight\db\rehearse-restore` on **port 5441** (initdb, bootstrap password file), role `hindsight` `NOSUPERUSER`, database, extensions `vector` 0.8.5 and `pg_trgm` 1.6.
4. `pg_restore --no-owner --no-comments --role=hindsight --exit-on-error`: exit 0.
5. **All 24 public tables compared, counts identical** (source = restored), e.g. `banks=1 documents=2 chunks=2 memory_units=2 memory_links=4 entities=3 unit_entities=4 llm_requests=17 alembic_version=1`; 0 tables not owned by `hindsight`; app role not superuser.
6. New secrets for the throwaway profile (`init-key`), `harden-db` with the bootstrap password file, bootstrap file deleted.
7. Started under the supervisor (API 8895, proxy 8885): healthy; the seeded fact recalled from the restored database; one marked item retained and recalled (documents 2 -> 3). Stopped; ports 5441, 8895, 8885 free; the rehearsal cluster and folder were removed by real path.

## 8. Cutover: move the real `pilot` database to Ryzen (NOT executed)

**Decision this needs from the lead.** The connector only accepts a loopback `HINDSIGHT_URL`, and the proxy identifies the caller by process (same Windows account, `bun.exe`, and the process holding `127.0.0.1:8081`). An ssh tunnel from the main PC would arrive as `sshd`, so it would be refused. Hindsight and the one AgenticOS that writes memory must therefore run on the **same** machine. Moving Hindsight to Ryzen means the memory-writing AgenticOS runs on Ryzen too (its root `C:\mu-hub\AgenticOS-v4`, port 8081; set `MU_MEMORY_WRITER_ROOT=C:\mu-hub\AgenticOS-v4`, and `MU_MEMORY_WRITER_PORT` if it is not 8081). The main PC's AgenticOS then runs with `MU_MEMORY_WRITES=off` and `HINDSIGHT_URL=off`.

**Rule: there is exactly one writer at all times.** On the main PC the writer chain is connector -> proxy 8878 -> API 8888 -> Postgres 5432, started by `Startup\Hindsight.vbs` (and anything that runs `hindsightctl start`). **`Startup\Hindsight.vbs` must be removed at cutover** (step A3) and a crash-loop lock placed (A4), so that a reboot or a stray launch can never bring up a second writer.

### Which secrets can be regenerated

| Secret | Where it lives | Carry it? |
|---|---|---|
| Hindsight API key (`pilot.key`) | read only by the supervisor and proxy on the same machine; clients send no key | **Regenerate** on Ryzen (`init-key`) |
| Document-delete secret (`pilot-docdelete.key`) | read by the proxy to verify, and by the AgenticOS connector to sign (`HINDSIGHT_APPROVAL_SECRET_FILE`, default `D:\hindsight\service\secrets\pilot-docdelete.key`) | **Regenerate.** Both sides read the same local file, and the junction keeps that default path valid on Ryzen. Tokens live at most 1 hour and are single use, so nothing is pending once writes are off |
| `postgres` and app role passwords | not in the dump (`pg_dump` of one database carries no roles) | **Regenerate** (`harden-db`) |
| LLM keys (OpenRouter, Groq) | `%USERPROFILE%\.config\agentic-os.env`, by reference | Already on Ryzen (placed by the lead). Not copied by this procedure |
| Codex login (`%USERPROFILE%\.codex\auth.json`) | third failover member | **Never copy.** Owner runs `codex login` on Ryzen if the fallback is wanted (F10) |
| Claude OAuth token | unused | none |

So **nothing secret is carried.** The only carried item is the database dump (plus, for Obsidian, the vault and the connector state folder, which hold no credentials).

### A. Main PC (freeze and dump)

All commands on the main PC, from PowerShell as Usman. Keep a note of each time stamp.

1. **Writes off, connector side.** Set `MU_MEMORY_WRITES=off` (process environment or `~\.config\agentic-os.env`) and restart AgenticOS. Wait until the memory status panel shows the outbox empty (pending upserts and retracts drained) and no write in flight. The outbox must be empty so the dump and the connector state agree.
2. **Writes off, proxy side.** `powershell -NoProfile -ExecutionPolicy Bypass -File D:\hindsight\service\hindsightctl.ps1 writes -State off -Profile pilot`
3. **Remove the autostart.** Rename `C:\Users\Nebula PC\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Hindsight.vbs` to `Hindsight.vbs.disabled-cutover` (do not delete: rollback needs it). Confirm there is no scheduled task that starts the supervisor (`\MU\Hindsight supervisor` was never installed; the SYSTEM backup task `\MU\Hindsight nightly backup` only dumps when Postgres is running, so it does not start anything).
4. **Stop, in order** (proxy, then API, then Postgres): `... hindsightctl.ps1 stop -Profile pilot`. Verify that 8878, 8888 and 5432 are no longer listening. Then **lock the main PC supervisor**: create `D:\hindsight\service\run\pilot\crashloop.lock` (any content; the supervisor refuses to start while the file exists, exit code 3). Rollback removes it with `clear-alert`.
5. **Dump.** Start Postgres alone: `D:\hindsight\pgsql\18.1.0\bin\pg_ctl.exe start -D D:\hindsight\db\hindsight-mu -w -o "-p 5432 -c listen_addresses=127.0.0.1"` (output to a file, never a pipe). Then the existing script: `powershell -NoProfile -ExecutionPolicy Bypass -File D:\hindsight\service\backup.ps1 -Profile pilot -Port 5432 -PasswordFile D:\hindsight\service\secrets\pilot.db -OutDir D:\hindsight\cutover -PgBin D:\hindsight\pgsql\18.1.0\bin`. Check `D:\hindsight\cutover\last-backup.json` says `ok: true`.
6. **Record the source counts** while Postgres is still up, with the all-table query in section 8.B step 5 (run it against port 5432 as `hindsight`; save the output). Then `pg_ctl stop -D D:\hindsight\db\hindsight-mu -m fast -w`. Leave the original data directory exactly as it is (it is the rollback).
7. **Copy and checksum.** `Get-FileHash D:\hindsight\cutover\hindsight-<ts>.dump -Algorithm SHA256`, then `C:\Windows\System32\OpenSSH\scp.exe <dump> ryzen-bots:C:/mu-hub/incoming/`, then the same hash on Ryzen. They must match before anything else happens. Also copy `D:\tmp\ms-marco-MiniLM-L-12-v2` (finding F4), the vault and the connector state (section 8.D).

### B. Ryzen (create the pilot instance and restore)

Run from a shell with `$env:USERDOMAIN = $env:COMPUTERNAME` (F1). `$bin = 'D:\hindsight\pgsql\18.1.0\bin'`, `$sec = 'D:\hindsight\service\secrets'`, `$data = 'D:\hindsight\db\hindsight-mu'`. This is the sequence that was rehearsed (section 7) with the pilot's names, and it is `stage-d-instance.ps1 create` plus the restore.

1. **Preconditions.** Ports 5432, 8888, 8878 free; `$data` does not exist; the dump's checksum matched; the synthetic instance can stay up (different ports) or be stopped.
2. **Secrets and cluster.** Two random 48-character hex files: `$sec\pilot-bootstrap.db` and `$sec\pilot.db`. `initdb.exe -D $data -U postgres -A scram-sha-256 --pwfile=$sec\pilot-bootstrap.db -E UTF8 --locale=C`; create `$data\log`; `pg_ctl start -D $data -w -t 120 -l $data\log\pg_ctl.log -o "-p 5432 -c listen_addresses=127.0.0.1"` via `cmd /c ... > file 2>&1`.
3. **Role, database, extensions** (as `postgres`, password from the bootstrap file in `PGPASSWORD`):
   `CREATE ROLE hindsight LOGIN NOSUPERUSER NOCREATEROLE NOREPLICATION PASSWORD '<contents of pilot.db>'; CREATE DATABASE hindsight OWNER hindsight;` then in database `hindsight`: `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public; CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;`
4. **Restore:** `pg_restore.exe -h 127.0.0.1 -p 5432 -U postgres -d hindsight --no-owner --no-comments --role=hindsight --exit-on-error <dump>` (exit must be 0).
5. **Compare counts.** On both sides run, as the app role (or `postgres` on Ryzen), and diff the two outputs (they must be identical, all public tables, about 24):
   `SELECT format('SELECT %L, count(*) FROM %I.%I', table_name, table_schema, table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name` followed by `\gexec` on its own line, `psql -At -F '='`. Also confirm `select count(*) from pg_tables where schemaname='public' and tableowner <> 'hindsight'` is 0 and the role is not superuser. **Stop here on any difference.**
6. **Stop Postgres** (`pg_ctl stop -D $data -m fast -w`). **New secrets on Ryzen:** `D:\hindsight\venv\Scripts\python.exe D:\hindsight\service\supervisor.py init-key --profile pilot`; then `harden-db --profile pilot --bootstrap-password-file $sec\pilot-bootstrap.db`; then `[IO.File]::Delete("$sec\pilot-bootstrap.db")`. **Do not turn writes on** (`run\pilot\WRITES_ENABLED` must not exist; it does not unless `writes -State on` is run).
7. **Re-assert the ACLs** (F2): the three `icacls` commands on `C:\mu-hub\hindsight` and `supervisor.py acl-guard --profile pilot`. Nothing about the pilot is stored outside `C:\mu-hub\hindsight` (the data directory, secrets and logs are all under it).
8. **Start:** `hindsightctl.ps1 start -Profile pilot`; wait for `status --profile pilot` to show `running` and `health_http` 200 (first start loads the models, 25 to 50 s). `Get-NetTCPConnection` must show 5432, 8888 and 8878 listening on Ryzen and **nothing** on the main PC.
9. **One marked test item, through the operator console (proxy writes still OFF).** Save the helper below as `C:\mu-hub\incoming\cutover-marker.py` and run `D:\hindsight\venv\Scripts\python.exe C:\mu-hub\incoming\cutover-marker.py 8888 D:\hindsight\service\secrets\pilot.key mu-shared MK<6 hex digits>`. Expected: retain 200, recall finds marker True, delete 200, recall after delete False, GET 404. It leaves no residue. This was run on the synthetic instance (retain 200, found, delete 200, gone, 404).
10. **Only then enable writes:** `hindsightctl.ps1 writes -State on -Profile pilot`, then switch the Ryzen AgenticOS on (`MU_MEMORY_WRITES=on`, `HINDSIGHT_URL=http://127.0.0.1:8878`, the Obsidian state in place, section 8.D).
11. **Backups.** The nightly SYSTEM backup is not installed on Ryzen. Decide with the lead: `install-backup-task.ps1` needs its owner changed to `RYZEN-PC\mkhan` and its task path agreed (F7); it then writes dumps to `D:\hindsight-backups\pilot` on the **backup HDD**, which is the right place for them. Until then, take a manual dump with `backup.ps1` before enabling writes.

```python
"""Operator-console marker test for a Hindsight instance. The API key is read from its key file in this
process only and is never printed. Synthetic text only.
usage: cutover-marker.py <api-port> <key-file> <bank> <marker-id>
Retains ONE marked document, recalls it, deletes it, confirms it is gone (all through the API, not the proxy)."""
import json
import sys
import urllib.error
import urllib.request

port, keyfile, bank, marker = sys.argv[1:5]
key = open(keyfile, encoding="utf-8").read().strip()


def call(method, path, body=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def recall_hit():
    st, r = call("POST", f"/v1/default/banks/{bank}/memories/recall", {"query": f"when does the {marker} garage open", "max_tokens": 600})
    return st == 200 and any(marker.lower() in x.get("text", "").lower() for x in r.get("results", []))


doc = f"cutover-{marker}"
st, _ = call("POST", f"/v1/default/banks/{bank}/memories",
             {"async": False, "items": [{"content": f"The {marker} garage opens at 6am on Fridays.", "document_id": doc}]})
print("retain:", st)
print("recall finds marker:", recall_hit())
st, _ = call("DELETE", f"/v1/default/banks/{bank}/documents/{doc}")
print("delete marker document:", st)
print("recall after delete finds marker:", recall_hit())
st, _ = call("GET", f"/v1/default/banks/{bank}/documents/{doc}")
print("GET deleted document (expect 404):", st)
```

### C. Rollback

- **Before writes are enabled on Ryzen (steps 1 to 9):** nothing on the main PC changed except the autostart rename and the lock, and its database is untouched. On Ryzen: `hindsightctl.ps1 stop -Profile pilot`, then delete the pilot data directory by its **real path** `C:\mu-hub\hindsight\db\hindsight-mu` and the pilot secrets (single files). On the main PC: delete `run\pilot\crashloop.lock` (or `supervisor.py clear-alert --profile pilot`), rename `Hindsight.vbs.disabled-cutover` back to `Hindsight.vbs`, `hindsightctl.ps1 start -Profile pilot`, set `MU_MEMORY_WRITES=on`, `hindsightctl.ps1 writes -State on -Profile pilot`. No data is lost: nothing was written anywhere after step A1.
- **After writes are enabled on Ryzen (step 10):** the main PC's database is now stale. Roll back by the same procedure in reverse (freeze Ryzen, dump with `backup.ps1`, copy, checksum, restore on the main PC into a **new** data directory with the section 8.B commands, compare counts) and keep the old `hindsight-mu` folder renamed `hindsight-mu.pre-cutover`. Never run both at once: stop and lock one side (A3 and A4) before starting the other.
- The stopped Ryzen pilot instance keeps its own `crashloop.lock` and no Startup item, so it also cannot restart by itself.

### D. Obsidian side (vault and connector state)

How `scripts/memory` finds things (`settings.ts`):
- **Vault:** `MU_WIKI_ROOT` (the folder that holds `wiki/`); default `~\source\repos\mu-ventures-obsidian-wiki`. Only `wiki/**/*.md` is synced; `raw/**`, templates, `.obsidian`, `.git`, `.scripts`, `.skills`, `CLAUDE.md`, `AGENTS.md`, `README.md` and anything named like a credential or transcript are always skipped. The vault is a git repository.
- **Connector state:** `MEMORY_STATE_DIR`, default `<MU_DATA_DIR>\memory`, and `MU_DATA_DIR` defaults to `<AgenticOS root>\.operator-data` (`scripts/cloud/data-dir.ts`). It is **not** inside the vault and not in Hindsight. It holds `notes.json` (note path -> stable id, hash, rev), `index.json` (what Hindsight is confirmed to hold), `outbox.json` (pending upserts and retracts), `vault-docs.json`, `memories.json` (Hindsight-only memories, with provenance), `tombstones.json`, `exclusions.json`, `status.json`, `held.json`, `receipts.jsonl` and `processing.jsonl`.
- **Writer lock:** `~\.config\agentic-os\memory-writer.lock.json` (per machine; do not copy it). The real vault and the pilot proxy are written only by the canonical AgenticOS (`MU_MEMORY_WRITER_ROOT`, default `~\source\repos\AgenticOS-v4`; `MU_MEMORY_WRITER_PORT`, default 8081). A moved install must set those, or the Ryzen copy stays read-only.

**One authoritative vault copy, no two-way sync.**
1. At step A1 (writes off), the main vault is frozen: commit any pending changes in the vault repository (`git status` must be clean, `git rev-parse HEAD` noted).
2. Copy it **once** to Ryzen with its `.git`, for example `git clone --no-hardlinks` from the main PC over ssh, or `git bundle create` and `git clone` the bundle, into `C:\mu-hub\vault\mu-ventures-obsidian-wiki`. Verify `git rev-parse HEAD` and `git rev-parse HEAD^{tree}` are identical on both. The Ryzen copy is **the** vault from that moment.
3. Copy the connector state folder **byte for byte** from the same freeze moment (after the outbox drained): the main PC's `MEMORY_STATE_DIR`, or `<root>\.operator-data\memory` if neither variable is set (find it from the memory status panel; do not open the files). Put it on Ryzen at `C:\mu-hub\data\memory` and set `MEMORY_STATE_DIR` there explicitly. A fresh, empty state would give every note a new id and duplicate the whole vault in Hindsight; a state that does not match the restored database would re-send or retract documents.
4. Set on the Ryzen AgenticOS: `MU_WIKI_ROOT=C:\mu-hub\vault\mu-ventures-obsidian-wiki`, `MEMORY_STATE_DIR=C:\mu-hub\data\memory`, `MU_MEMORY_WRITER_ROOT=C:\mu-hub\AgenticOS-v4`, `HINDSIGHT_URL=http://127.0.0.1:8878`, `MU_MEMORY_WRITES=on` only at step 10.
5. On the main PC rename the old vault folder to `...-ARCHIVED-cutover-<date>` (or leave Obsidian pointed at nothing) and set `MU_MEMORY_WRITES=off`, `HINDSIGHT_URL=off`, so no process can scan an old vault into the new database. If the owner wants to keep editing in Obsidian on the main PC, the only supported transport is **git**: edit on a branch, push to a remote, and `git pull --ff-only` on Ryzen when the owner chooses. Never a live file sync, and never an edit made on both sides between two pulls.
6. After the first scan on Ryzen, the status panel should show 0 pending outbox items and the same document count as before the freeze; any difference is a stop.

## 9. Listener table (Ryzen, end of work)

```
127.0.0.1:5433  postgres   (synth database, also ::1:5433)
127.0.0.1:8879  python     (synth proxy)
127.0.0.1:8889  python     (synth API)
5432, 8878, 8888: not listening   (pilot absent)
5441, 8895, 8885: not listening   (rehearsal removed)
```
The final listener check, run immediately before the commit, is in the hand-over report. Pilot data dir, run dir, log dir and secrets: absent.

## 10. Not verified

- The real pilot cutover itself: no production data was dumped, copied or restored; steps A1 to A7 on the main PC and B1 to B11 for the pilot are written but not executed. Rehearsed on synthetic data: the dump, copy and checksum, new cluster, restore with `--no-owner --role=hindsight`, all-table counts, new secrets, `harden-db`, supervised start and one marked item. Not rehearsed: the main-PC freeze, the `crashloop.lock` refusal on the main PC, the Startup rename, the scp transfer of a real dump, the vault clone, moving the connector state, the Ryzen AgenticOS with `MU_MEMORY_WRITES=on`, the writer-capability handshake on Ryzen (the proxy checks `bun.exe` holding 127.0.0.1:8081), and the rollback.
- ~~`install-backup-task.ps1` and the nightly SYSTEM backup on Ryzen (F7)~~ Resolved 2 Oct 2026 19:51: the installer now takes `-Owner` (default: the account running it) and `-TaskPath` (default `\MU\`); the original is kept as `install-backup-task.ps1.pre-20261002` on both PCs. Installed on Ryzen with `-Owner 'RYZEN-PC\mkhan' -TaskPath '\Hindsight\'`: `\Hindsight\Hindsight nightly backup` (SYSTEM, daily 03:30). First run OK as `NT AUTHORITY\SYSTEM`: `D:\hindsight-backups\pilot\hindsight-20261002-195137.dump`, 816,992 bytes, 181 entries, verified with `pg_restore --list`.
- A real logoff or shutdown on Ryzen (the session-end test used a synthetic `WM_ENDSESSION`, as on the main PC).
- Reboot behaviour: nothing is registered to start Hindsight on Ryzen, by design.
- Codex fallback on Ryzen (no login, F10); Groq's free-tier limits and OpenRouter ZDR behaviour were not exercised beyond the acceptance run.
- `client_check.py`, `route_eval.py`, `pilot_check.py` and the TypeScript connector tests (`scripts/memory`, bun) were not run. No `node_modules` here and the pilot checks must not run on Ryzen.
- Whether `harden-acl` through the junction behaves the same after a redeploy (F2 was worked around by hand).
- The `proxy_acceptance.py` MCP checks against a corrected expectation (F8).
