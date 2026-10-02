<#
.SYNOPSIS
  Run on the MAIN PC (also callable by the obsidian-wrap-up skill): one command to sync the vault clone with Ryzen.

.DESCRIPTION
  In the vault clone (-VaultPath), on branch main:
    1. If the work tree is dirty: `git add -A` (the repo's .gitignore applies) and commit
       (-Message, default "vault: edits from <COMPUTERNAME> <timestamp>").
    2. git fetch ryzen
    3. git rebase ryzen/main. On a conflict: lists the conflicting files, runs `git rebase --abort`, and exits 2 WITHOUT
       pushing. Your commits stay exactly as they were.
    4. git push ryzen HEAD:main. Ryzen has receive.denyCurrentBranch=updateInstead, so its work tree is updated; the push is
       refused while Ryzen's work tree is dirty (the connector wrote a note and the autocommit has not run yet). Then the script
       runs -TriggerCommand once (default: starts the \MU\MU Vault Autocommit task over ssh), waits -RetryWaitSeconds, and
       repeats steps 2 to 4 ONE time. If that is refused too it exits 3 and says to wait for the next autocommit (10 minutes at most).
  -Setup first adds the `ryzen` remote (-RemoteUrl) if it is missing and checks it with `git ls-remote`.
  Never force-pushes, resets, stashes, checks out over files, or deletes anything.
  Exit codes: 0 synced, 1 unexpected error, 2 conflict (rebase aborted, nothing pushed), 3 push refused (nothing lost, run again later),
  4 refused to start (not main, unfinished git operation, remote missing without -Setup, not a repo), 5 Ryzen unreachable or fetch failed (local commit is kept).
#>
[CmdletBinding()]
param(
  [string]$VaultPath = 'C:\Users\Nebula PC\source\repos\mu-ventures-obsidian-wiki',
  [string]$Message = '',
  [switch]$Setup,
  [string]$RemoteName = 'ryzen',
  [string]$RemoteUrl = 'ryzen-bots:C:/mu-hub/vault/mu-ventures-obsidian-wiki',
  # Run through cmd.exe once when Ryzen refuses the push because its work tree is dirty. Empty = the default below. 'none' = never.
  [string]$TriggerCommand = '',
  [int]$RetryWaitSeconds = 25
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-vault-common.ps1')
$defaultTrigger = 'ssh ryzen-bots "schtasks /run /tn \"\MU\MU Vault Autocommit\""'

function Say([string]$m) { Write-Host $m }
function Git([string[]]$a, [int]$timeout = 120) { Invoke-VaultGit -Repo $VaultPath -GitArgs $a -TimeoutSeconds $timeout }
function Short([string]$s) { ($s -replace '\s+', ' ').Trim() }

$why = Test-VaultRepoRoot -Path $VaultPath
if ($why) { Say "REFUSED: $why"; exit 4 }
$VaultPath = [IO.Path]::GetFullPath($VaultPath).TrimEnd('\', '/')
$branch = Get-VaultBranch -Repo $VaultPath
if ($branch -ne 'main') { Say "REFUSED: the vault is on '$branch', not main. Nothing was changed."; exit 4 }
$gitDir = Get-VaultGitDir -Repo $VaultPath
$op = Get-VaultOperationInProgress -GitDir $gitDir
if ($op) { Say "REFUSED: an unfinished git operation ($op) is in this repo. Finish or abort it yourself, then run again."; exit 4 }
if (Test-Path -LiteralPath (Join-Path $gitDir 'index.lock')) { Say 'REFUSED: .git\index.lock exists (Obsidian Git or another git process is running). Try again in a moment.'; exit 4 }

# ---- remote
$cur = Git @('remote', 'get-url', $RemoteName)
if ($cur.Code -ne 0) {
  if (-not $Setup) { Say "REFUSED: no remote named '$RemoteName'. Run once with -Setup."; exit 4 }
  $add = Git @('remote', 'add', $RemoteName, $RemoteUrl)
  if ($add.Code -ne 0) { Say "REFUSED: could not add remote: $(Short $add.Err)"; exit 4 }
  Say "Added remote $RemoteName -> $RemoteUrl"
} elseif ($Setup) {
  if ($cur.Out -ceq $RemoteUrl) { Say "Remote $RemoteName already set to $RemoteUrl" }
  else { Say "WARNING: remote $RemoteName points at $($cur.Out), not $RemoteUrl. Left as it is; change it yourself if that is wrong." }
}
if ($Setup) {
  $ls = Git @('ls-remote', $RemoteName) 60
  if ($ls.Code -ne 0) { Say "FAILED: git ls-remote $RemoteName did not work: $(Short $ls.Err)"; exit 5 }
  $heads = @($ls.Out -split "`r?`n" | Where-Object { $_ -match 'refs/heads/main$' })
  if ($heads.Count -eq 0) { Say "WARNING: remote $RemoteName answers but has no main branch yet." } else { Say "Verified: $RemoteName answers and has main." }
}

# ---- 1. commit local edits
$st = Git @('status', '--porcelain=v1', '--untracked-files=all')
if ($st.Code -ne 0) { Say "FAILED: git status: $(Short $st.Err)"; exit 1 }
if ($st.Out) {
  if (-not $Message) { $Message = 'vault: edits from {0} {1:yyyy-MM-dd HH:mm:ss}' -f $env:COMPUTERNAME, (Get-Date) }
  $n = @($st.Out -split "`r?`n" | Where-Object { $_ }).Count
  $a = Git @('add', '-A')
  if ($a.Code -ne 0) { Say "FAILED: git add: $(Short $a.Err)"; exit 1 }
  $c = Git @('commit', '--quiet', '-m', $Message)
  if ($c.Code -ne 0) { Say "FAILED: git commit: $(Short ($c.Err + ' ' + $c.Out))"; exit 1 }
  Say "Committed $n changed path(s): $Message"
} else { Say 'Work tree clean, nothing to commit.' }
$before = (Git @('rev-parse', 'HEAD')).Out

# ---- 2 to 4, at most twice
$attempt = 0
$triggered = $false
while ($true) {
  $attempt++
  $f = Git @('fetch', $RemoteName) 120
  if ($f.Code -ne 0) { Say "FAILED: git fetch $RemoteName did not work (is Ryzen up? ssh ryzen-bots): $(Short $f.Err)"; Say 'Your local commit is kept. Nothing was pushed.'; exit 5 }

  $hasRemoteMain = ((Git @('rev-parse', '--verify', '--quiet', "refs/remotes/$RemoteName/main^{commit}")).Code -eq 0)
  if ($hasRemoteMain) {
    $headBefore = (Git @('rev-parse', 'HEAD')).Out
    $rb = Git @('rebase', "$RemoteName/main") 300
    if ($rb.Code -ne 0) {
      $conf = Git @('diff', '--name-only', '--diff-filter=U')
      $files = @($conf.Out -split "`r?`n" | Where-Object { $_ })
      $ab = Git @('rebase', '--abort')
      Say "CONFLICT: your edits and Ryzen's changed the same lines. The rebase was aborted; nothing was pushed or discarded."
      if ($files.Count -gt 0) { Say 'Conflicting files:'; foreach ($x in $files) { Say "  $x" } } else { Say "Git said: $(Short $rb.Err)" }
      if ($ab.Code -ne 0) { Say "WARNING: git rebase --abort reported: $(Short $ab.Err). Run 'git rebase --abort' yourself in $VaultPath." }
      else {
        $after = (Git @('rev-parse', 'HEAD')).Out
        if ($after -ne $headBefore) { Say "WARNING: HEAD moved ($headBefore to $after) during the abort; check 'git reflog'." }
      }
      Say "Resolve it by hand: in $VaultPath run 'git rebase $RemoteName/main', fix the files, 'git rebase --continue', then run this script again."
      exit 2
    }
  }

  $push = Git @('push', $RemoteName, 'HEAD:main') 300
  if ($push.Code -eq 0) {
    $head = (Git @('rev-parse', 'HEAD')).Out
    Say "Synced. main = $head (pushed to $RemoteName; Ryzen's work tree was updated)."
    exit 0
  }
  $reason = Short $push.Err
  if ($attempt -ge 2 -or $TriggerCommand -eq 'none') {
    Say "PUSH REFUSED: $reason"
    Say 'Nothing was lost; your commit is safe locally. Ryzen probably has uncommitted notes: wait for the next vault autocommit (10 minutes at most) and run this script again.'
    exit 3
  }
  Say "Push refused: $reason"
  Say 'Likely Ryzen has uncommitted notes. Asking it to run the vault autocommit once, then retrying one time.'
  $cmd = if ($TriggerCommand) { $TriggerCommand } else { $defaultTrigger }
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $psi.Arguments = '/d /s /c "' + $cmd + '"'
    $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit(120000)) { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null; Say 'Trigger command timed out.' }
    else { $p.WaitForExit(); Say "Trigger command exit code $($p.ExitCode)." }
  } catch { Say "Trigger command failed to start: $($_.Exception.Message)" }
  if ($RetryWaitSeconds -gt 0) { Say "Waiting $RetryWaitSeconds s for the autocommit..."; Start-Sleep -Seconds $RetryWaitSeconds }
}
