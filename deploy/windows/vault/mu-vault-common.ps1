# Shared helpers for deploy\windows\vault. Dot-source it:  . (Join-Path $PSScriptRoot 'mu-vault-common.ps1')
# Windows PowerShell 5.1 compatible. ASCII only. Builds on ..\mu-common.ps1 (logging, mutex, arg quoting).
# Nothing here prints note CONTENT or any environment value: only paths, counts and git's own messages.

. (Join-Path (Split-Path -Parent $PSScriptRoot) 'mu-common.ps1')
Set-StrictMode -Version 2

$script:VaultDefaultRyzenPath = 'C:\mu-hub\vault\mu-ventures-obsidian-wiki'
$script:VaultTaskPath = '\MU\'
$script:VaultTaskName = 'MU Vault Autocommit'

# ---------------------------------------------------------------- the connector's path rules (pinned by a test)
# MUST equal DEFAULT_ALLOW and HARD_DENY in scripts/memory/settings.ts (Test-VaultSync.ps1 parses that file and compares,
# and, when bun is available, runs the connector's own matcher over sample paths and compares the answers).
$script:VaultAllow = @('wiki/**/*.md')
$script:VaultHardDeny = @(
  'raw/**',
  '**/templates/**',
  '.obsidian/**',
  '.trash/**',
  '.git/**',
  '.scripts/**',
  '.skills/**',
  '**/CLAUDE.md',
  '**/AGENTS.md',
  '**/README.md',
  '**/*credential*',
  '**/*secret*',
  '**/*password*',
  '**/*.env*',
  '**/*transcript*',
  '**/*bank-statement*'
)

# Same translation as globToRegExp in scripts/memory/vault.ts: ** any depth, * within a segment, ? one char, case-insensitive.
function ConvertTo-VaultGlobRegex {
  param([Parameter(Mandatory)][string]$Glob)
  $out = New-Object Text.StringBuilder
  $i = 0
  while ($i -lt $Glob.Length) {
    $c = $Glob[$i]
    $next = if ($i + 1 -lt $Glob.Length) { $Glob[$i + 1] } else { [char]0 }
    if ($c -eq '*' -and $next -eq '*') {
      $after = if ($i + 2 -lt $Glob.Length) { $Glob[$i + 2] } else { [char]0 }
      if ($after -eq '/') { [void]$out.Append('(?:.*/)?'); $i += 3 } else { [void]$out.Append('.*'); $i += 2 }
      continue
    }
    if ($c -eq '*') { [void]$out.Append('[^/]*') }
    elseif ($c -eq '?') { [void]$out.Append('[^/]') }
    else { [void]$out.Append([regex]::Escape([string]$c)) }
    $i++
  }
  return New-Object Text.RegularExpressions.Regex(('^' + $out.ToString() + '$'), ([Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::CultureInvariant))
}

function Test-VaultMatchesAny {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string[]]$Globs)
  foreach ($g in $Globs) { if ((ConvertTo-VaultGlobRegex -Glob $g).IsMatch($Path)) { return $true } }
  return $false
}

# A vault-relative path (forward slashes) the connector would read: allowed and not hard-denied.
function Test-VaultPathReadable {
  param([Parameter(Mandatory)][string]$Path)
  return ((Test-VaultMatchesAny -Path $Path -Globs $script:VaultAllow) -and -not (Test-VaultMatchesAny -Path $Path -Globs $script:VaultHardDeny))
}

# ---------------------------------------------------------------- git
function Get-VaultGitPath {
  $c = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @('C:\Program Files\Git\cmd\git.exe', 'C:\Program Files\Git\bin\git.exe')) { if (Test-Path -LiteralPath $p) { return $p } }
  throw 'git.exe not found (looked on PATH and in C:\Program Files\Git).'
}

# Runs git, UTF-8 in and out, never prompts, kills the tree on timeout. Returns Code, Out (trimmed end unless -Raw), Err (trimmed end).
function Invoke-VaultGit {
  param([Parameter(Mandatory)][string]$Repo, [Parameter(Mandatory)][string[]]$GitArgs, [int]$TimeoutSeconds = 120, [switch]$Raw)
  [Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT', '0', 'Process')
  if (-not [Environment]::GetEnvironmentVariable('GIT_SSH_COMMAND', 'Process')) { [Environment]::SetEnvironmentVariable('GIT_SSH_COMMAND', 'ssh -o BatchMode=yes', 'Process') }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Get-VaultGitPath
  $psi.Arguments = ConvertTo-MuArgString -ArgumentList (@('-C', $Repo, '-c', 'core.quotepath=false') + $GitArgs)
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
  $psi.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
  $p = [Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
    [void]$p.WaitForExit(5000)
    return [pscustomobject]@{ Code = -1; Out = ''; Err = "git timed out after $TimeoutSeconds s: $($GitArgs -join ' ')" }
  }
  $p.WaitForExit()
  $o = $outTask.Result; $e = $errTask.Result
  if (-not $Raw) { $o = $o.TrimEnd() }
  return [pscustomobject]@{ Code = $p.ExitCode; Out = $o; Err = $e.TrimEnd() }
}

function Get-VaultGitDir {
  param([Parameter(Mandatory)][string]$Repo)
  $r = Invoke-VaultGit -Repo $Repo -GitArgs @('rev-parse', '--absolute-git-dir')
  if ($r.Code -ne 0) { return $null }
  return $r.Out
}

# $null when $Path is the top level of a normal (non-bare) work tree; otherwise a one-line reason.
function Test-VaultRepoRoot {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return "path does not exist: $Path" }
  $bare = Invoke-VaultGit -Repo $Path -GitArgs @('rev-parse', '--is-bare-repository')
  if ($bare.Code -ne 0) { return "not a git repository: $Path" }
  if ($bare.Out -eq 'true') { return "bare repository, a work tree is needed: $Path" }
  $top = Invoke-VaultGit -Repo $Path -GitArgs @('rev-parse', '--show-toplevel')
  if ($top.Code -ne 0) { return "not inside a git work tree: $Path" }
  $a = [IO.Path]::GetFullPath($top.Out).TrimEnd('\', '/')
  $b = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  if ($a -ne $b) { return "$Path is inside a repository rooted at $a, not its top level" }
  return $null
}

# Current branch name, or '' when HEAD is detached.
function Get-VaultBranch {
  param([Parameter(Mandatory)][string]$Repo)
  $r = Invoke-VaultGit -Repo $Repo -GitArgs @('symbolic-ref', '--quiet', '--short', 'HEAD')
  if ($r.Code -ne 0) { return '' }
  return $r.Out
}

# Name of an unfinished operation (rebase, merge, cherry-pick, revert) or '' when none.
function Get-VaultOperationInProgress {
  param([Parameter(Mandatory)][string]$GitDir)
  foreach ($n in @('rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD')) {
    if (Test-Path -LiteralPath (Join-Path $GitDir $n)) { return $n }
  }
  return ''
}

# Parses `git status --porcelain=v1 -z --untracked-files=all` into { Xy, Path, Kind (deleted|present) } entries.
# A rename or copy yields the new path (present) and, for a rename, the old path (deleted).
function Get-VaultStatusEntries {
  param([Parameter(Mandatory)][string]$Repo)
  $r = Invoke-VaultGit -Repo $Repo -GitArgs @('status', '--porcelain=v1', '-z', '--untracked-files=all') -Raw
  if ($r.Code -ne 0) { throw "git status failed: $($r.Err)" }
  $tok = @($r.Out -split "`0")
  $list = New-Object System.Collections.ArrayList
  $i = 0
  while ($i -lt $tok.Count) {
    $t = $tok[$i]; $i++
    if ($t.Length -lt 4) { continue }
    $x = $t[0]; $y = $t[1]; $path = $t.Substring(3)
    $kind = if ($x -eq 'D' -or $y -eq 'D') { 'deleted' } else { 'present' }
    [void]$list.Add([pscustomobject]@{ Xy = "$x$y"; Path = $path; Kind = $kind })
    if ($x -eq 'R' -or $x -eq 'C' -or $y -eq 'R' -or $y -eq 'C') {
      if ($i -lt $tok.Count -and $tok[$i] -ne '') {
        $old = $tok[$i]; $i++
        if ($x -eq 'R' -or $y -eq 'R') { [void]$list.Add([pscustomobject]@{ Xy = "$x$y"; Path = $old; Kind = 'deleted' }) }
      }
    }
  }
  return @($list.ToArray())
}

# Decide which status entries the autocommit may stage. Returns Stage and Left (both arrays of entries).
# Present paths: allowed by the connector's allow list and not hard-denied. Deleted paths: anything under wiki/ that is not hard-denied.
function Select-VaultAutocommitPaths {
  param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Entries)
  $stage = New-Object System.Collections.ArrayList
  $left = New-Object System.Collections.ArrayList
  foreach ($e in $Entries) {
    $ok = $false
    if (Test-VaultMatchesAny -Path $e.Path -Globs $script:VaultHardDeny) { $ok = $false }
    elseif ($e.Kind -eq 'deleted') { $ok = $e.Path.StartsWith('wiki/', [StringComparison]::OrdinalIgnoreCase) }
    else { $ok = Test-VaultMatchesAny -Path $e.Path -Globs $script:VaultAllow }
    if ($ok) { [void]$stage.Add($e) } else { [void]$left.Add($e) }
  }
  return [pscustomobject]@{ Stage = @($stage.ToArray()); Left = @($left.ToArray()) }
}

# One mutex per vault path (so two different vaults, such as test copies, never block each other).
function Get-VaultMutexName {
  param([Parameter(Mandatory)][string]$VaultPath)
  $full = [IO.Path]::GetFullPath($VaultPath).TrimEnd('\', '/').ToLowerInvariant()
  $sha = [Security.Cryptography.SHA1]::Create()
  $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($full)) | ForEach-Object { $_.ToString('x2') }) -join ''
  return 'Global\MU-VaultAutocommit-' + $hash.Substring(0, 16)
}

# Pure data for the one scheduled task, so the installer and the tests agree.
function Get-VaultTaskPlan {
  param([Parameter(Mandatory)][string]$ScriptDir, [Parameter(Mandatory)][string]$VaultPath, [Parameter(Mandatory)][string]$LogDir, [int]$IntervalMinutes = 10)
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $prefix = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File')
  $a = @((Join-Path $ScriptDir 'mu-vault-autocommit.ps1'), '-VaultPath', $VaultPath, '-LogDir', $LogDir)
  return [pscustomobject]@{
    Name = $script:VaultTaskName; Path = $script:VaultTaskPath; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $a))
    StartupDelaySeconds = 60; IntervalMinutes = $IntervalMinutes
    Description = 'Commits OS memory notes written into the vault (wiki/*.md only) so the main PC can push. Never pushes. Installed by Install-VaultAutocommit.ps1.'
  }
}
