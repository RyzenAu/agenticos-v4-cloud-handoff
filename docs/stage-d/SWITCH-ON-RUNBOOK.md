# Stage D switch-on runbook (the lead runs this, not an agent)

Turns on shared memory writes for the real pool: Jarvis, the OS page, Claude Code, Hermes and
hindsight-ask all save through `http://127.0.0.1:8081/__memory`, and AgenticOS is the only writer of
Hindsight's `mu-shared` bank. Every step has its rollback directly under it. Run the steps in order in
**Windows PowerShell as Usman**, not Git Bash, because Git Bash rewrites `/…` arguments. Nothing here
prints a key.

State on 28 Sep 2026 (read-only probes):
- The pilot is running: API 8888, proxy 8878, writes through the proxy are **OFF**.
- The main tree `AgenticOS-v4` is on `jarvis-voice` at `709c8ab`. It has 10 unrelated dirty or untracked
  files, none of them touched by this branch.
- `~/.config/agentic-os.env` has no memory variables.
- Claude Code and hindsight-ask point straight at the pilot API (`8888/mcp/mu-pilot/`). Hermes points at
  the proxy (`8878/mcp/mu-shared/`).

**Emergency off, at any point:** `& D:\hindsight\service\hindsightctl.ps1 writes -State off -Profile pilot`.
The proxy then refuses every write straight away, whatever the OS or any client does.

```powershell
$os  = "$env:USERPROFILE\source\repos\AgenticOS-v4"
$ctl = "$os\scripts\hindsight\hindsightctl.ps1"          # the repo copy (deploy refuses to run from D:\hindsight\service)
$envFile = "$env:USERPROFILE\.config\agentic-os.env"
function Restart-OS {                                     # the supervisor restarts it within about a minute
  $p = (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
  if ($p) { taskkill /PID $p /T /F | Out-Null }
  $t = (Get-Date).AddMinutes(3)
  do { Start-Sleep 5 } until ((Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) -or (Get-Date) -gt $t)
  if (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) { 'OS is back on 8081' } else { 'OS NOT back: check .operator-data\supervisor.log' }
}
```

## 0 · Pre-flight (read-only)

```powershell
git -C $os branch --show-current; git -C $os log --oneline -1       # jarvis-voice / 709c8ab
git -C $os status --short                                            # the 10 unrelated files; leave them alone
& $ctl status -Profile pilot | Select-String '"state"|health_http'   # running / 200
& $ctl writes -State show -Profile pilot                             # OFF
Select-String -Path $envFile -Pattern '^(MU_MEMORY|HINDSIGHT_)'     # nothing
[Environment]::GetEnvironmentVariable('MU_MEMORY_WRITES','User')     # empty: a user env var would override the file
```

If a `MU_MEMORY_WRITES` or `HINDSIGHT_*` user environment variable exists, stop and remove it first.
The process environment wins over the file.

## 1 · Bring Stage D into the main tree (fast-forward only) and restart the OS

```powershell
git -C $os merge --ff-only f/stage-d-memory-20260928
git -C $os log --oneline -1                                          # the branch tip
Restart-OS
```

This fast-forward also brings in the branches Stage D already merged: B1 identity, C1/C2, deflake,
hindsight-ops rev 3.1 and the memory connector. With no switch set, memory is **off**. The Memory page
browses and recalls from the local index, `/__memory/mcp` answers, and saves are refused. No dirty file
overlaps this change. If git still refuses, stop and resolve it by hand. Never stash, reset or clean.

**Rollback 1:** `git -C $os revert --no-edit <the commits the fast-forward brought in, newest first>` (or `git revert -m 1 <merge>` if it was merged), then `Restart-OS`. Revert keeps history and moves no ref. It leaves the main tree's unrelated dirty files alone.

## 2 · Deploy the Hindsight config and ops changes, then restart the pilot

This deploys two changes that differ from `D:\hindsight\service` today:
- `hindsight.profiles.json`: the pilot proxy gains `"write_images": ["bun.exe"]`, so only AgenticOS
  (bun) may write. Claude Code, Hermes and Python read only. The pilot's Hindsight MCP loses
  `sync_retain`, `update_memory` and `invalidate_memory`.
- `proxy.py`: the `write_images` refusal.

The other deployed files are already identical.

```powershell
Start-ScheduledTask -TaskPath '\MU\' -TaskName 'Hindsight nightly backup' -ErrorAction SilentlyContinue   # optional DB backup first, if the task is installed
$out = & $ctl deploy; $out                                             # "deployed to D:\hindsight\service (backup: D:\hindsight\_backups\<ts>)"
$bk = [regex]::Match(($out -join ' '), 'backup: ([^)]+)\)').Groups[1].Value; $bk
Select-String -Path D:\hindsight\service\hindsight.profiles.json -Pattern '"write_images"'              # one line: bun.exe
& $ctl stop  -Profile pilot
& $ctl start -Profile pilot
Start-Sleep 60
& $ctl status -Profile pilot | Select-String '"state"|health_http'   # running / 200 (repeat after 30 s if still starting)
& $ctl writes -State show -Profile pilot                             # still OFF (the flag survives restarts)
```

`deploy` starts nothing. It backs up `D:\hindsight\service` and the provider file, with SHA256SUMS, then
copies, re-applies the provider patch (idempotent) and creates only *missing* keys. The stop order is
proxy, then API, then Postgres. `start` launches the supervisor through WMI, outside any agent session.

**Rollback 2:**
```powershell
Copy-Item "$bk\service\*" D:\hindsight\service -Force
Copy-Item "$bk\providers\claude_code_llm.py" D:\hindsight\venv\Lib\site-packages\hindsight_api\engine\providers\ -Force
& $ctl stop -Profile pilot; & $ctl start -Profile pilot
```

## 3 · Point Claude Code, Hermes and hindsight-ask at the OS

```powershell
$cc = "$os\scripts\hindsight\clients\connect-clients.ps1"
foreach ($c in 'claude', 'hermes', 'skill') { & $cc -Client $c }             # dry run: redacted diffs only
foreach ($c in 'claude', 'hermes', 'skill') { & $cc -Client $c -Apply }      # each prints "applied; backup: <file>.bak-hindsight-<ts>"
& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" gateway restart                  # Hermes re-reads config.yaml
```

What changes:
- **Claude Code:** `mcpServers.hindsight` changes from `http://127.0.0.1:8888/mcp/mu-pilot/` to
  `http://127.0.0.1:8081/__memory/mcp`. New Claude Code sessions pick it up; running sessions keep the old
  connection until restarted.
- **Hermes:** `hindsight.url` changes from `http://127.0.0.1:8878/mcp/mu-shared/` to
  `http://127.0.0.1:8081/__memory/mcp`. The include list drops the Hindsight write tools and gains
  `remember`, `save_to_vault` and `forget` (forget only asks; a person approves).
- **hindsight-ask:** recall goes to `http://127.0.0.1:8081/__memory/recall`, and the health check to
  `/__memory/status`.

**Rollback 3.** This undoes only the URL, so later edits Claude Code makes to `.claude.json` are kept:
```powershell
function Undo-Url($file, $old) {
  $t = [IO.File]::ReadAllText($file)
  $t = $t -replace 'http://127\.0\.0\.1:8081/__memory/mcp', $old
  [IO.File]::WriteAllText($file, $t, (New-Object Text.UTF8Encoding($false)))
}
Undo-Url "$env:USERPROFILE\.claude.json" 'http://127.0.0.1:8888/mcp/mu-pilot/'
# Hermes and the skill: restore the backups the script made (these files aren't rewritten behind your back):
$h = "$env:LOCALAPPDATA\hermes\config.yaml"; Copy-Item (Get-ChildItem "$h.bak-hindsight-*" | Sort-Object Name | Select-Object -Last 1).FullName $h -Force
$s = "$env:USERPROFILE\.claude\skills\hindsight-ask\SKILL.md"; Copy-Item (Get-ChildItem "$s.bak-hindsight-*" | Sort-Object Name | Select-Object -Last 1).FullName $s -Force
& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" gateway restart
```

## 4 · Allow writes through the pilot proxy

```powershell
& $ctl writes -State on -Profile pilot                               # "memory writes through the proxy: ON"
```

This takes effect immediately and needs no restart. Only bun.exe processes may write (step 2), and the
OS itself still refuses saves until step 5.

**Rollback 4:** `& $ctl writes -State off -Profile pilot`

## 5 · The one switch: `MU_MEMORY_WRITES=on`, then restart the OS

```powershell
$t = [IO.File]::ReadAllText($envFile)
$sep = if ($t.Length -and -not $t.EndsWith("`n")) { "`r`n" } else { '' }
[IO.File]::AppendAllText($envFile, "${sep}MU_MEMORY_WRITES=on`r`n")     # UTF-8, no BOM; no copy of the file is made
Select-String -Path $envFile -Pattern '^MU_MEMORY_WRITES='            # exactly one line: MU_MEMORY_WRITES=on
Restart-OS
```

This is the whole switch. `HINDSIGHT_URL` defaults to the proxy (`http://127.0.0.1:8878`), the bank to
`mu-shared` and the delete secret to `D:\hindsight\service\secrets\pilot-docdelete.key`. Set nothing
else, and add no key.

After the restart, the main tree on 8081 takes the one-writer lock
(`~/.config/agentic-os/memory-writer.lock.json`). A lock left by a dead process is taken over. Any other
copy, such as a worktree dev server or a preview, stays read-only.

The OS then starts **the first vault sync**. Every note the vault permits is indexed once, oldest first,
at about one metered DeepSeek call per note (about US$0.0002 each). The Memory page shows it as pending
falling to 0.

**Rollback 5.** Remove the line and restart:
```powershell
$lines = [IO.File]::ReadAllLines($envFile) | Where-Object { $_ -notmatch '^\s*MU_MEMORY_WRITES\s*=' }
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
Restart-OS
```
(Or set `MU_MEMORY_WRITES=read` for recall from Hindsight with no writes.)

## 6 · Verify through the live OS

```powershell
Set-Location $os
bun --no-env-file scripts\memory\stage-d-verify-live.ts --live      # --live is required against the live OS
```

It prints PASS/FAIL per line and exits 0 only when everything passes. It first waits for the first
vault sync to finish (it prints progress, and carries on if nothing has moved for 3 minutes). Against the
live OS it then checks, in order:
1. The owner's browser session and page token at this PC.
2. `mode=on`, `writes=true`, no writer refusal, Hindsight through the proxy on `mu-shared`, no key in the OS.
3. **Save:** "remember" of one labelled synthetic line, `Stage D switch-on check <run>: the synthetic
   Verifier clinic opens at 7am (test data, deleted by the check).` The script waits until it is
   confirmed in Hindsight and prints **the model that processed it** (provider/model, cost basis, tokens,
   any fallback), then confirms the document is in the pilot's `mu-shared`.
4. **Recall:** the fact comes back through Hindsight with its source.
5. **Correction** (7am to 8am): the new version is confirmed with its model, the old document leaves
   Hindsight, and recall returns only the new one.
6. **Single delete:** forget of kind b asks for approval, the owner's own session approves, and the fact
   is deleted from the app and Hindsight (both versions return 404). A tombstone (id and hash, no text)
   stays in the app store.
7. The agents' endpoint `/__memory/mcp` lists `remember, save_to_vault, recall, forget`. The pilot's
   Hindsight MCP is read-only.
8. A final status line: pending, errors and saves per model.

It uses 2 of the proxy's 20 document deletes an hour (the correction and the forget), plus a few model
calls for the two saves. It prints no key. If it fails part-way, the line it stopped on says why. Any
leftover test fact is labelled "Stage D switch-on check <run>" and can be forgotten from the Memory page.

Then, by hand:
- Open `http://localhost:8081/memory/vault`. The Status panel shows processing, the model per save,
  failures and retries.
- Say "remember that …" to Jarvis, then ask it back.

## Full rollback, fastest first

1. `& $ctl writes -State off -Profile pilot`: all writes stop at the proxy immediately.
2. Rollback 5: the switch goes off and the OS restarts.
3. Rollback 3: the clients go back.
4. Rollback 2: the Hindsight files go back and the pilot restarts.
5. Rollback 1: the main tree goes back to `709c8ab`.

## Known limits (see ACCEPTANCE.md)

- `write_images` matches the image name only. Any bun.exe process could write straight to the proxy.
  Every other AgenticOS copy refuses to write because of the one-writer rule, and the
  proxy is loopback-only with its Host/Origin guard.
- The old `mu-pilot` bank (the pilot's earlier test data, readable through the proxy) is not part of
  `mu-shared`. The OS recalls `mu-shared` only. Nothing is migrated.
- Claude Code sessions already running keep their old MCP connection until restarted.
