# REFERENCE COPY (R8 F, 3 Oct 2026) of the lead's Ryzen release script. It is run by hand on Ryzen, never by CI or a test; the static test
# deploy/windows/tests/Test-ReleaseRyzen.ps1 only parses it. Two changes from the working copy it was taken from, both marked "R8 F":
#   1. -AdoptCommit: `git ls-files --error-unmatch -- <path> 2>$null` THROWS under $ErrorActionPreference = 'Stop' in Windows PowerShell 5.1
#      whenever git writes to stderr (an untracked overlay file), so adopting any untracked file failed the release (safely, in pre-update).
#      Replaced by `git ls-files -- <path>`, which prints the path when tracked and nothing otherwise, with no stderr.
#   2. The RELEASED line held a carriage-return character where `\r` of `$LogDir\release-<stamp>.json` was meant, so the console showed a
#      mangled path. It now prints the receipt's real path.
# Pass a fresh -TagName per release (e.g. rollback/pre-r8-20261003): the default is reused and git tag -f moves it.
# Agents workspace release on Ryzen (2-3 Oct 2026). Stops the hub, takes a verified backup with the hub stopped, fast-forwards the
# checkout (owner overlay preserved), sets the designs folder, restarts the supervisor and checks health.
# Recovery:
#   - anything fails BEFORE the code changes  -> the unchanged old hub is restarted and its health confirmed;
#   - anything fails AFTER the code changes   -> code back to the rollback point (git reset --keep: owner files kept), hub.env restored
#     from its copy, and, if the new code started, the data dir replaced by the backup just taken (the failed one is kept aside);
#     then the old hub is restarted and its health confirmed.
param(
  [Parameter(Mandatory)][string]$Target,
  [string]$Repo = 'C:\mu-hub\AgenticOS-v4',
  [string]$EnvFile = 'C:\mu-hub\config\hub.env',
  [string]$DataDir = 'C:\mu-hub\data\production',
  [string]$LogDir = 'C:\mu-hub\logs',
  [int]$Port = 8081,
  [string]$TaskPath = '\MU\',
  [string]$SupervisorTask = 'MU Hub Supervisor',
  [string]$BackupTask = 'MU Hub Backup',
  [string]$Branch = 'ryzen/migration-20261002',
  [string]$TagName = 'rollback/pre-agents-20261002',
  [string]$DesignsDir = 'C:\mu-hub\designs',
  # Rehearsal only: fail on purpose after the new hub has started, to exercise the full rollback. Refused against production.
  [switch]$FailAfterStart,
  # Run the CRM schema migration (scripts/crm/migrate.ts --apply --backup) while the hub is stopped, after the code update.
  [switch]$MigrateCrm,
  # A commit in the target that commits some of the owner's local overlay files (owner-approved). Only those paths are adopted: each must be
  # byte-identical to that commit (git blob hash) or the release stops; they are copied aside, cleared, and the fast-forward brings them back as
  # committed files. Every other local file is left exactly as it is.
  [string]$AdoptCommit = ''
)
$ErrorActionPreference = 'Stop'
if ($FailAfterStart -and ($TaskPath -eq '\MU\' -or $Port -eq 8081)) { throw 'FailAfterStart is for the staging rehearsal only.' }
$repo = $Repo; $envFile = $EnvFile; $dataDir = $DataDir
$bun = 'C:\mu-hub\bin\bun.exe'
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
$envCopy = "$EnvFile.pre-release-$stamp"
function Step($m) { "[{0:HH:mm:ss}] {1}" -f (Get-Date), $m }
function Hub-Pids { @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) }
function Stop-Hub {
  Stop-ScheduledTask -TaskPath $TaskPath -TaskName $SupervisorTask -ErrorAction SilentlyContinue
  foreach ($p in Hub-Pids) { taskkill /PID $p /T /F | Out-Null }
  $deadline = (Get-Date).AddSeconds(60); while ((Hub-Pids).Count -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
  if ((Hub-Pids).Count) { throw "hub still listening on $Port" }
}
function Start-HubAndWait([int]$minutes = 4) {
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $SupervisorTask
  $deadline = (Get-Date).AddMinutes($minutes); $code = 0
  do { Start-Sleep 5; try { $code = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://127.0.0.1:$Port/__version).StatusCode } catch { $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } } }
  while ((Get-Date) -lt $deadline -and $code -eq 0)
  return $code
}
function Overlay { (git -C $repo status --porcelain | Sort-Object) -join "`n" }

Set-Location $repo
$before = (git rev-parse HEAD).Trim()
$adopted = @(); $adoptDir = "C:\mu-hub\overlay-adopted-$stamp"
function Restore-Adopted { foreach ($p in $adopted) { $src = Join-Path $adoptDir $p; if (Test-Path -LiteralPath $src) { $dst = Join-Path $repo $p; New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item -LiteralPath $src $dst -Force } } }
$overlayOriginal = Overlay   # the owner overlay as it was BEFORE anything was adopted: the rollback compares against this, never the post-adoption snapshot
$overlayBefore = $overlayOriginal
$overlayHashes = @{}; git status --porcelain --untracked-files=all | ForEach-Object { $p = $_.Substring(3).Trim('"'); if (Test-Path -LiteralPath $p -PathType Leaf) { $overlayHashes[$p] = (Get-FileHash -LiteralPath $p).Hash } }
Step "head before: $before ; overlay entries: $(@(git status --porcelain).Count) ; owner files hashed: $($overlayHashes.Count)"
$phase = 'pre-update'; $newCodeStarted = $false; $backupPath = $null
try {
  if ((git rev-parse --abbrev-ref HEAD).Trim() -ne $Branch) { throw 'unexpected branch' }
  git fetch -q origin "+refs/heads/ws/integration-20261002:refs/remotes/origin/ws/integration-20261002"
  $cand = (git rev-parse origin/ws/integration-20261002).Trim()
  if ($cand -notlike "$Target*") { throw "bundle head $cand is not the target $Target" }
  git merge-base --is-ancestor $before $cand; if ($LASTEXITCODE -ne 0) { throw 'not a fast-forward' }
  if ($AdoptCommit) {
    git merge-base --is-ancestor $AdoptCommit $cand; if ($LASTEXITCODE -ne 0) { throw "adopt commit $AdoptCommit is not in the target" }
    $paths = @(git diff --name-only "$AdoptCommit^" $AdoptCommit)
    foreach ($p in $paths) {
      if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "adopt: $p is not present locally" }
      $want = (git rev-parse "${AdoptCommit}:$p").Trim(); $have = (git hash-object -- $p).Trim()
      if ($want -ne $have) { throw "adopt: $p differs from $AdoptCommit (local edits would be lost)" }
    }
  }
  $overlayPaths = @(git status --porcelain | ForEach-Object { $_.Substring(3).Trim('"') })
  $adoptSet = @{}; if ($AdoptCommit) { foreach ($q in $paths) { $adoptSet[$q] = $true } }
  $touched = @(git diff --name-only $before $cand) | Where-Object { -not $adoptSet.ContainsKey($_) } | Where-Object { $p = $_; $overlayPaths | Where-Object { $p -eq $_ -or $p.StartsWith($_.TrimEnd('/') + '/') } }
  if ($touched) { throw "release touches owner files: $($touched -join ', ')" }
  git tag -f $TagName $before | Out-Null
  Copy-Item $envFile $envCopy
  Step "candidate $cand fast-forwards; overlay untouched; rollback tag -> $before; hub.env copied"

  Stop-Hub; Step 'hub stopped'

  $t0 = Get-Date; $t0 = $t0.AddMilliseconds(-$t0.Millisecond)  # Task Scheduler records LastRunTime to the second
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $BackupTask
  $deadline = (Get-Date).AddMinutes(20)
  do { Start-Sleep 5; $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $BackupTask; $st = (Get-ScheduledTask -TaskPath $TaskPath -TaskName $BackupTask).State }
  while ((Get-Date) -lt $deadline -and ($st -eq 'Running' -or $info.LastRunTime -lt $t0.AddSeconds(-5)))
  $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $BackupTask   # re-read after the loop: the result and the state come from two calls, and the task can finish between them
  $bs = Get-Content -Raw (Join-Path $LogDir 'last-backup.json') | ConvertFrom-Json
  if ($info.LastTaskResult -ne 0 -or -not $bs.ok -or -not $bs.verified -or ([datetime]$bs.time) -lt $t0.AddSeconds(-5)) { throw "backup failed or stale (result $($info.LastTaskResult))" }
  $backupPath = $bs.path
  Step "backup verified: $backupPath ($($bs.files) files)"

  $phase = 'update'
  # R8: adoption runs with the hub stopped and after the verified backup (the dev server watches the checkout).
  if ($AdoptCommit) {
      foreach ($p in $paths) { $dst = Join-Path $adoptDir $p; New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item -LiteralPath $p $dst }
      foreach ($p in $paths) {
        $adopted += $p
        # R8 F: no --error-unmatch / 2>$null here (that throws under 'Stop' in PowerShell 5.1 for an untracked path).
        $tracked = [bool](git ls-files -- $p)
        if ($tracked) { git checkout -q HEAD -- $p } else { Remove-Item -LiteralPath $p -Force }
      }
      Step "adopted $($paths.Count) owner files from $AdoptCommit (byte-identical; copies in $adoptDir); other local files untouched"
      $overlayBefore = Overlay
      $overlayHashes = @{}; git status --porcelain --untracked-files=all | ForEach-Object { $q = $_.Substring(3).Trim('"'); if (Test-Path -LiteralPath $q -PathType Leaf) { $overlayHashes[$q] = (Get-FileHash -LiteralPath $q).Hash } }
  }
  git merge -q --ff-only $cand; if ($LASTEXITCODE -ne 0) { throw 'merge failed' }
  if (-not (Get-Content $envFile | Where-Object { $_ -match '^\s*MU_DESIGN_PROJECTS_DIR=' })) { $raw = [IO.File]::ReadAllText($envFile); $sep = if ($raw.Length -and -not $raw.EndsWith("`n")) { "`r`n" } else { "" }; [IO.File]::AppendAllText($envFile, "${sep}MU_DESIGN_PROJECTS_DIR=$DesignsDir`r`n"); Step 'designs folder set' }
  if ((Overlay) -ne $overlayBefore) { throw 'owner overlay changed during the merge' }
  foreach ($k in $overlayHashes.Keys) { if ((Get-FileHash -LiteralPath $k).Hash -ne $overlayHashes[$k]) { throw "owner file changed: $k" } }
  Step "head now: $(git log --oneline -1) ; overlay identical ($($overlayHashes.Count) owner files hash-checked)"

  if ($MigrateCrm) {
    $newCodeStarted = $true   # the data folder changes from here: any later failure restores it from the verified backup
    $crmDb = Join-Path $dataDir 'crm.sqlite'
    $crmBk = "D:\mu-hub-backups\crm-pre-migration-$stamp.sqlite"
    & $bun scripts\crm\migrate.ts --db $crmDb *> "$LogDir\crm-migrate-dry-$stamp.txt"
    if ($LASTEXITCODE -ne 0) { throw "CRM migration dry run failed (see $LogDir\crm-migrate-dry-$stamp.txt)" }
    & $bun scripts\crm\migrate.ts --db $crmDb --apply --backup $crmBk *> "$LogDir\crm-migrate-$stamp.txt"
    if ($LASTEXITCODE -ne 0) { throw "CRM migration failed (see $LogDir\crm-migrate-$stamp.txt)" }
    $m = Get-Content -Raw "$LogDir\crm-migrate-$stamp.txt" | ConvertFrom-Json
    if (-not $m.validation.originalRowsUnchanged -or $m.validation.foreignKeyViolations -ne 0) { throw 'CRM migration validation failed (original rows or foreign keys)' }
    Step "CRM migrated v$($m.fromVersion) -> v$($m.toVersion): companies $($m.validation.companies), deals $($m.validation.deals), activities $($m.validation.activities); original rows unchanged; pre-migration copy $crmBk"
  }

  $newCodeStarted = $true
  $code = Start-HubAndWait 5
  if ($code -ne 200 -and $code -ne 401) { throw "new hub did not answer (HTTP $code)" }
  if ($FailAfterStart) { throw "rehearsal: injected failure after the new hub started (HTTP $code on $(git rev-parse --short HEAD))" }
  # Settle: a hub that answers once and dies half a minute later is not a release.
  Start-Sleep 75
  try { $code2 = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://127.0.0.1:$Port/__version).StatusCode } catch { $code2 = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
  if (($code2 -ne 200 -and $code2 -ne 401) -or -not (Hub-Pids).Count) { throw "new hub stopped answering within 75 s (HTTP $code2)" }
  $receipt = [ordered]@{ time = (Get-Date).ToString('o'); oldHead = $before; newHead = (git rev-parse HEAD).Trim(); rollbackTag = $TagName; backup = $backupPath; envCopy = $envCopy; crmMigrated = [bool]$MigrateCrm; crmPreMigrationCopy = $(if ($MigrateCrm) { "D:\mu-hub-backups\crm-pre-migration-$stamp.sqlite" } else { $null }) }
  $receipt | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $LogDir "release-$stamp.json")
  Step "RELEASED: hub answering HTTP $code then $code2 after 75 s on $(git rev-parse --short HEAD); receipt $(Join-Path $LogDir "release-$stamp.json")"
} catch {
  Step "FAILED in phase '$phase': $($_.Exception.Message)"
  try {
    if ($phase -eq 'update') {
      Stop-Hub
      git reset -q --keep $before; Step "code back to $(git rev-parse --short HEAD)"
      if ($adopted.Count) { Restore-Adopted; Step "adopted owner files put back as local edits ($($adopted.Count))" }
      Copy-Item $envCopy $envFile -Force; Step 'hub.env restored'
      if ($newCodeStarted -and $backupPath) {
        $restore = "$dataDir.restore-$stamp"
        & $bun scripts\cloud\backup-cli.ts restore --from $backupPath --to $restore --keep-sessions
        if ($LASTEXITCODE -ne 0) { throw 'data restore failed: data dir left as the new code wrote it; investigate before starting' }
        $leaf = Split-Path $dataDir -Leaf; Rename-Item $dataDir "$leaf.failed-$stamp"; Rename-Item $restore $leaf
        Step "data restored from $backupPath (the failed data kept as $leaf.failed-$stamp)"
      }
      if ((Overlay) -ne $overlayOriginal) { Step 'WARNING: owner overlay differs after rollback - check before anything else' }
    }
    $code = Start-HubAndWait 5
    Step "ROLLED BACK: old hub answering HTTP $code on $(git rev-parse --short HEAD)"
  } catch { Step "RECOVERY FAILED: $($_.Exception.Message) - the hub may be stopped; see RYZEN-MIGRATION.md rollback" }
  exit 1
}
