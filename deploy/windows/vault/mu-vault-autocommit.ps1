<#
.SYNOPSIS
  Run ON RYZEN by a scheduled task (every 10 minutes and at startup): commits the notes the AgenticOS connector wrote.

.DESCRIPTION
  Why: a push from the main PC into Ryzen's checked-out main (receive.denyCurrentBranch=updateInstead) is refused while
  Ryzen's work tree is dirty. The connector's "save to vault" leaves new or changed notes uncommitted, so this commits them.

  Stages ONLY what the connector itself may read and write:
    - present files that match wiki/**/*.md and none of the connector's HARD_DENY patterns (credential, secret, password,
      transcript, bank-statement, .env, README/CLAUDE/AGENTS, templates, raw/, .obsidian ...). The rules are the ones in
      scripts/memory/settings.ts; Test-VaultSync.ps1 pins parity;
    - deletions (and the old side of renames) under wiki/ that are not hard-denied.
  Anything else (other folders, non-markdown files, denied names, changes already staged outside this set) is LEFT
  UNTOUCHED and named in the log line. The commit uses `git commit --only` on the staged set, so something somebody
  staged by hand elsewhere is never swept in.
  Commit message: vault: OS memory notes (auto, <timestamp>). One log line per run in <LogDir>\mu-vault-autocommit.log.
  NEVER pushes, fetches or touches any remote: Ryzen is the hub of the star.

  Safety: holds a per-vault mutex (a second run exits at once); does nothing while .git\index.lock exists or a rebase,
  merge, cherry-pick or revert is in progress (waits up to -LockWaitSeconds, then exits 0 as "deferred": the next scheduled run retries);
  refuses unless the vault is on branch main.
  Exit codes: 0 done / nothing to do / deferred / another run active, 1 error, 2 refused (not a repo, not main).
  -DryRun lists what would be staged and changes nothing.
#>
[CmdletBinding()]
param(
  [string]$VaultPath = 'C:\mu-hub\vault\mu-ventures-obsidian-wiki',
  [string]$LogDir = 'C:\mu-hub\logs',
  [int]$LockWaitSeconds = 20,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-vault-common.ps1')
$logFile = Join-Path $LogDir 'mu-vault-autocommit.log'
function Log([string]$m) { Write-MuLog -Path $logFile -Message ('mu-vault-autocommit: ' + $m) }

$mutex = $null
try {
  $why = Test-VaultRepoRoot -Path $VaultPath
  if ($why) { Log "REFUSED $why"; exit 2 }
  $VaultPath = [IO.Path]::GetFullPath($VaultPath).TrimEnd('\', '/')

  $mutex = Get-MuMutex -Name (Get-VaultMutexName -VaultPath $VaultPath)
  if (-not $mutex) { Log 'another run is active, exiting'; exit 0 }

  $branch = Get-VaultBranch -Repo $VaultPath
  if ($branch -ne 'main') { Log "REFUSED vault is on '$branch', not main"; exit 2 }
  $gitDir = Get-VaultGitDir -Repo $VaultPath
  if (-not $gitDir) { Log 'REFUSED cannot find the git dir'; exit 2 }

  # Wait briefly for a lock or an unfinished operation to clear; otherwise defer to the next scheduled run.
  $deadline = (Get-Date).AddSeconds([Math]::Max(0, $LockWaitSeconds))
  while ($true) {
    $busy = ''
    if (Test-Path -LiteralPath (Join-Path $gitDir 'index.lock')) { $busy = 'index.lock exists' }
    else { $op = Get-VaultOperationInProgress -GitDir $gitDir; if ($op) { $busy = "$op in progress" } }
    if (-not $busy) { break }
    if ((Get-Date) -ge $deadline) { Log "deferred: $busy (next scheduled run retries)"; exit 0 }
    Start-Sleep -Seconds 1
  }

  $entries = @(Get-VaultStatusEntries -Repo $VaultPath)
  if ($entries.Count -eq 0) { Log 'nothing to commit'; exit 0 }
  $sel = Select-VaultAutocommitPaths -Entries $entries
  $stage = @($sel.Stage); $left = @($sel.Left)
  $leftNames = @($left | ForEach-Object { $_.Path } | Sort-Object -Unique)
  $leftText = ''
  if ($leftNames.Count -gt 0) {
    $shown = @($leftNames | Select-Object -First 8)
    $leftText = "; LEFT UNTOUCHED $($leftNames.Count) path(s): " + ($shown -join ', ') + $(if ($leftNames.Count -gt 8) { ', ...' } else { '' }) + ' (not wiki/*.md or denied; Ryzen stays dirty and pushes are refused until someone commits or removes them)'
  }
  if ($stage.Count -eq 0) { Log ("nothing eligible to commit" + $leftText); exit 0 }

  $paths = @($stage | ForEach-Object { $_.Path } | Sort-Object -Unique)
  if ($DryRun) { Log ("dry run: would commit $($paths.Count) path(s): " + ($paths -join ', ') + $leftText); exit 0 }

  # Literal pathspecs from a NUL-separated UTF-8 file: no globbing, no quoting problems, any characters in names.
  $specFile = Join-Path ([IO.Path]::GetTempPath()) ('mu-vault-paths-' + [Guid]::NewGuid().ToString('N') + '.txt')
  try {
    $utf8 = New-Object Text.UTF8Encoding($false)
    $bytes = $utf8.GetBytes((($paths | ForEach-Object { ':(literal)' + $_ }) -join "`0") + "`0")
    [IO.File]::WriteAllBytes($specFile, $bytes)
    $add = Invoke-VaultGit -Repo $VaultPath -GitArgs @('add', '-A', "--pathspec-from-file=$specFile", '--pathspec-file-nul')
    if ($add.Code -ne 0) {
      if ($add.Err -match 'index\.lock') { Log 'deferred: git reported index.lock during add (next scheduled run retries)'; exit 0 }
      Log "ERROR git add failed: $($add.Err -replace '\s+', ' ')"; exit 1
    }
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $msg = "vault: OS memory notes (auto, $stamp)"
    $commit = Invoke-VaultGit -Repo $VaultPath -GitArgs @('commit', '--only', '--quiet', '-m', $msg, "--pathspec-from-file=$specFile", '--pathspec-file-nul')
    if ($commit.Code -ne 0) {
      if ($commit.Err -match 'index\.lock') { Log 'deferred: git reported index.lock during commit (next scheduled run retries)'; exit 0 }
      Log "ERROR git commit failed: $(($commit.Err + ' ' + $commit.Out) -replace '\s+', ' ')"; exit 1
    }
  } finally {
    if (Test-Path -LiteralPath $specFile) { Remove-Item -LiteralPath $specFile -Force -ErrorAction SilentlyContinue }
  }
  $sha = (Invoke-VaultGit -Repo $VaultPath -GitArgs @('rev-parse', '--short', 'HEAD')).Out
  Log ("committed $($paths.Count) path(s) as $sha" + $leftText)
  exit 0
} catch {
  Log "ERROR $($_.Exception.Message)"
  exit 1
} finally {
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
}
