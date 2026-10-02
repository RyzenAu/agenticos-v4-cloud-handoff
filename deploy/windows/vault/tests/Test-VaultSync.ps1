# Tests for deploy\windows\vault. Plain PowerShell, no Pester. Run under Windows PowerShell 5.1:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\vault\tests\Test-VaultSync.ps1
# Exit code = number of failed checks. Uses TEMP repos only (a "ryzen" non-bare repo with updateInstead and a "main" clone
# talking to it over a LOCAL PATH remote, never ssh), a private git config (identity only for the test), registers no scheduled
# task and never touches the real vault.
param([switch]$KeepTemp)

$ErrorActionPreference = 'Stop'
$vaultDir = Split-Path -Parent $PSScriptRoot
$winDir = Split-Path -Parent $vaultDir
$repoRoot = Split-Path -Parent (Split-Path -Parent $winDir)
. (Join-Path $vaultDir 'mu-vault-common.ps1')
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script:passed = 0
$script:failed = 0
function Check([string]$name, $cond, [string]$detail = '') {
  if ($cond) { $script:passed++; Write-Host "  ok   $name" }
  else { $script:failed++; Write-Host "  FAIL $name  $detail" }
}
function Section([string]$t) { Write-Host ""; Write-Host "== $t" }

$root = Join-Path ([IO.Path]::GetTempPath()) ("mu-vault-tests-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$logDir = Join-Path $root 'logs'

# Hermetic git: a private global config (test identity, main as default branch), no system config.
$cfgDir = Join-Path $root 'cfg'; New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$globalCfg = Join-Path $cfgDir 'gitconfig-with-identity'
[IO.File]::WriteAllText($globalCfg, "[user]`n`tname = Vault Test`n`temail = vault-test@example.invalid`n[init]`n`tdefaultBranch = main`n[core]`n`tautocrlf = false`n")
$emptyCfg = Join-Path $cfgDir 'gitconfig-empty'
[IO.File]::WriteAllText($emptyCfg, "[init]`n`tdefaultBranch = main`n")
$saved = @{}
foreach ($n in @('GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM')) { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
[Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', $globalCfg, 'Process')
[Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', '1', 'Process')

function G([string]$repo, [string[]]$a) { $r = Invoke-VaultGit -Repo $repo -GitArgs $a; if ($r.Code -ne 0) { throw "git $($a -join ' ') failed in ${repo}: $($r.Err)" }; return $r.Out }
function GCode([string]$repo, [string[]]$a) { return (Invoke-VaultGit -Repo $repo -GitArgs $a).Code }
function Write-Text([string]$path, [string]$text) {
  $d = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}
function Read-Text([string]$path) { return [IO.File]::ReadAllText($path) }
function Run([string]$script, [string[]]$arguments, [int]$timeout = 180) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $vaultDir $script)) + $arguments
  $r = Invoke-MuProcess -FilePath $ps -ArgumentList $a -TimeoutSeconds $timeout
  return [pscustomobject]@{ Code = $r.ExitCode; Out = ($r.Stdout + $r.Stderr) }
}
$script:n = 0
# A fresh "ryzen" repo (initialised with the real Initialize script) and a "main" clone wired with remote 'ryzen' (a local path).
function New-Pair {
  $script:n++
  $r = Join-Path $root "ryzen$($script:n)"; $m = Join-Path $root "main$($script:n)"
  New-Item -ItemType Directory -Force -Path $r | Out-Null
  [void](G $r @('init', '-q', '-b', 'main'))
  Write-Text (Join-Path $r 'wiki\a.md') "line one`nline two`nline three`n"
  Write-Text (Join-Path $r 'wiki\b.md') "bee one`nbee two`nbee three`n"
  Write-Text (Join-Path $r 'README.md') "readme`n"
  [void](G $r @('add', '-A')); [void](G $r @('commit', '-q', '-m', 'initial'))
  $init = Run 'Initialize-RyzenVault.ps1' @('-Path', $r)
  if ($init.Code -ne 0) { throw "Initialize failed in New-Pair: $($init.Out)" }
  [void](G $root @('clone', '-q', $r, $m))
  [void](G $m @('remote', 'rename', 'origin', 'ryzen'))
  return [pscustomobject]@{ Ryzen = $r; Main = $m }
}
function Sync([string]$main, [string]$ryzen, [string[]]$extra = @()) {
  return (Run 'vault-sync.ps1' (@('-VaultPath', $main, '-RemoteUrl', $ryzen, '-RetryWaitSeconds', '0') + $extra))
}
function Autocommit-Cmd([string]$ryzen) {
  return ('"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -VaultPath "{2}" -LogDir "{3}" -LockWaitSeconds 1' -f $ps, (Join-Path $vaultDir 'mu-vault-autocommit.ps1'), $ryzen, $logDir)
}
function Run-Autocommit([string]$ryzen, [string[]]$extra = @()) {
  return (Run 'mu-vault-autocommit.ps1' (@('-VaultPath', $ryzen, '-LogDir', $logDir, '-LockWaitSeconds', '1') + $extra))
}

try {

# ------------------------------------------------------------------ 1. parse, ASCII, safety greps
Section 'scripts parse cleanly, ASCII only, never force/reset/stash'
$files = @(Get-ChildItem -Path $vaultDir -Filter *.ps1 -File) + @(Get-ChildItem -Path $PSScriptRoot -Filter *.ps1 -File)
foreach ($f in $files) {
  $errs = $null; $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
  Check "parses: $($f.Name)" ($errs.Count -eq 0) (($errs | ForEach-Object { $_.Message }) -join '; ')
  Check "ascii only: $($f.Name)" (-not ([IO.File]::ReadAllBytes($f.FullName) | Where-Object { $_ -gt 127 }))
}
foreach ($s in @('vault-sync.ps1', 'mu-vault-autocommit.ps1', 'Initialize-RyzenVault.ps1')) {
  $txt = Read-Text (Join-Path $vaultDir $s)
  Check "$s has no force, reset, stash, clean or checkout git calls" ($txt -notmatch "'--force'|'-f'|--force-with-lease|'reset'|'stash'|'clean'|'checkout'|'restore'")
}
$ac = Read-Text (Join-Path $vaultDir 'mu-vault-autocommit.ps1')
Check "autocommit never pushes, fetches or pulls" ($ac -notmatch "'push'|'fetch'|'pull'")

# ------------------------------------------------------------------ 2. path rules pinned to the connector
Section 'deny/allow rules match scripts/memory/settings.ts'
$settings = Read-Text (Join-Path $repoRoot 'scripts\memory\settings.ts')
function Get-TsList([string]$name) {
  $m = [regex]::Match($settings, 'export const ' + $name + '\s*=\s*\[(.*?)\];', 'Singleline')
  if (-not $m.Success) { return $null }
  return @([regex]::Matches($m.Groups[1].Value, '"([^"]*)"') | ForEach-Object { $_.Groups[1].Value })
}
$tsDeny = Get-TsList 'HARD_DENY'; $tsAllow = Get-TsList 'DEFAULT_ALLOW'
Check 'found HARD_DENY and DEFAULT_ALLOW in settings.ts' ($tsDeny -and $tsAllow)
Check 'HARD_DENY identical (order and content)' ((@($tsDeny) -join '|') -ceq ($script:VaultHardDeny -join '|')) "ts=$(@($tsDeny) -join '|')"
Check 'DEFAULT_ALLOW identical' ((@($tsAllow) -join '|') -ceq ($script:VaultAllow -join '|'))
$samples = @(
  'wiki/a.md', 'wiki/sub/dir/b.md', 'wiki/Index.MD', 'wiki/secret-token.md', 'wiki/notes/my-credentials.md', 'wiki/password-list.md',
  'wiki/transcript-2026.md', 'wiki/bank-statement-march.md', 'wiki/x.env.md', 'wiki/templates/t.md', 'wiki/README.md', 'wiki/CLAUDE.md',
  'wiki/AGENTS.md', 'wiki/notes.txt', 'raw/a.md', '.obsidian/x.md', 'scratch.md', 'wiki/.trash/z.md', 'wiki/sub/templates/t.md', 'Wiki/Upper.md',
  'wiki/cafe-note.md', ("wiki/caf" + [char]0xE9 + "-note.md"), 'wiki/a.markdown', 'wiki/Secret/inner.md', 'wiki/readme.md'
)
$psAnswers = @{}
foreach ($s in $samples) { $psAnswers[$s] = (Test-VaultPathReadable -Path $s) }
Check 'spot checks: readable and denied names' ($psAnswers['wiki/a.md'] -and $psAnswers['wiki/sub/dir/b.md'] -and -not $psAnswers['wiki/secret-token.md'] -and -not $psAnswers['wiki/notes.txt'] -and -not $psAnswers['scratch.md'] -and -not $psAnswers['wiki/templates/t.md'] -and -not $psAnswers['wiki/transcript-2026.md'] -and -not $psAnswers['raw/a.md'])
$bun = $null
$bc = Get-Command bun.exe -ErrorAction SilentlyContinue; if ($bc) { $bun = $bc.Source }
foreach ($cand in @('C:\mu-hub\bin\bun.exe', (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'), (Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'), (Join-Path $env:APPDATA 'npm\node_modules\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe'))) {
  if (-not $bun -and (Test-Path -LiteralPath $cand)) { $bun = $cand }
}
if ($bun) {
  $tsFile = Join-Path $root 'parity.ts'
  $vaultTs = (Join-Path $repoRoot 'scripts\memory\vault.ts') -replace '\\', '/'
  $setTs = (Join-Path $repoRoot 'scripts\memory\settings.ts') -replace '\\', '/'
  $list = ($samples | ForEach-Object { '"' + (($_ -replace '\\', '\\') -replace '"', '\"') + '"' }) -join ','
  # Non-ASCII sample written with an escape so this file stays ASCII.
  $list = $list -replace [regex]::Escape([string][char]0xE9), '\u00e9'
  $src = "import { matchesAny } from `"file:///$vaultTs`";`nimport { DEFAULT_ALLOW, HARD_DENY } from `"file:///$setTs`";`nconst s = [$list];`nconsole.log(JSON.stringify(s.map((p) => matchesAny(p, DEFAULT_ALLOW) && !matchesAny(p, HARD_DENY))));`n"
  [IO.File]::WriteAllText($tsFile, $src, (New-Object Text.UTF8Encoding($false)))
  $br = $null
  try { $br = Invoke-MuProcess -FilePath $bun -ArgumentList @($tsFile) -WorkingDirectory $repoRoot -TimeoutSeconds 120 } catch { $br = [pscustomobject]@{ ExitCode = -1; Stdout = ''; Stderr = $_.Exception.Message } }
  $arr = $null
  try { $parsed = ConvertFrom-Json -InputObject $br.Stdout.Trim(); $arr = @($parsed) } catch { }
  if ($arr -and $arr.Count -eq $samples.Count) {
    $diff = @(); for ($i = 0; $i -lt $samples.Count; $i++) { if ([bool]$arr[$i] -ne [bool]$psAnswers[$samples[$i]]) { $diff += $samples[$i] } }
    Check "bun runs the connector's own matcher: same answer for all $($samples.Count) sample paths" ($diff.Count -eq 0) ("differs: " + ($diff -join ', '))
  } else { Write-Host "  skip  bun parity run gave no usable answer (exit $($br.ExitCode)); the textual pin above still holds" }
} else { Write-Host '  skip  bun not found; the textual pin above still holds' }

# ------------------------------------------------------------------ 3. Initialize
Section 'Initialize-RyzenVault'
$iv = Join-Path $root 'init1'; New-Item -ItemType Directory -Force -Path $iv | Out-Null
[void](G $iv @('init', '-q', '-b', 'main')); Write-Text (Join-Path $iv 'wiki\a.md') "x`n"; [void](G $iv @('add', '-A')); [void](G $iv @('commit', '-q', '-m', 'i'))
$cfgFile = Join-Path $iv '.git\config'
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv, '-WhatIf')
$wiCfg = Read-Text $cfgFile
Check 'WhatIf exits 0 and changes nothing' ($r.Code -eq 0 -and $wiCfg -notmatch 'updateInstead' -and $r.Out -match 'would set receive.denyCurrentBranch') $r.Out
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv)
Check 'first run: exit 0, updateInstead and autocrlf false set' ($r.Code -eq 0 -and (G $iv @('config', '--local', 'receive.denyCurrentBranch')) -eq 'updateInstead' -and (G $iv @('config', '--local', 'core.autocrlf')) -eq 'false') $r.Out
Check 'global identity present: no local identity invented' ((GCode $iv @('config', '--local', 'user.name')) -ne 0)
$cfgBefore = [IO.File]::ReadAllBytes($cfgFile)
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv)
$cfgAfter = [IO.File]::ReadAllBytes($cfgFile)
Check 'second run: idempotent (config bytes identical, says No change)' ($r.Code -eq 0 -and $r.Out -match 'No change' -and ([Convert]::ToBase64String($cfgBefore) -ceq [Convert]::ToBase64String($cfgAfter))) $r.Out
# not main / not a repo / subdirectory / no commits
$iv2 = Join-Path $root 'init2'; New-Item -ItemType Directory -Force -Path $iv2 | Out-Null
[void](G $iv2 @('init', '-q', '-b', 'dev')); Write-Text (Join-Path $iv2 'a.md') "x`n"; [void](G $iv2 @('add', '-A')); [void](G $iv2 @('commit', '-q', '-m', 'i'))
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv2)
Check 'refuses a repo on a branch other than main, changes nothing' ($r.Code -eq 2 -and (GCode $iv2 @('config', '--local', 'receive.denyCurrentBranch')) -ne 0) $r.Out
$plain = Join-Path $root 'plain'; New-Item -ItemType Directory -Force -Path $plain | Out-Null
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $plain)
Check 'refuses a folder that is not a git repo' ($r.Code -eq 2) $r.Out
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', (Join-Path $iv 'wiki'))
Check 'refuses a subfolder of a repo' ($r.Code -eq 2) $r.Out
$iv3 = Join-Path $root 'init3'; New-Item -ItemType Directory -Force -Path $iv3 | Out-Null; [void](G $iv3 @('init', '-q', '-b', 'main'))
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv3)
Check 'refuses a repo with no commits' ($r.Code -eq 2) $r.Out
# identity: none anywhere -> fail without writing; with params -> local identity
$iv4 = Join-Path $root 'init4'; New-Item -ItemType Directory -Force -Path $iv4 | Out-Null
[void](G $iv4 @('init', '-q', '-b', 'main')); Write-Text (Join-Path $iv4 'a.md') "x`n"; [void](G $iv4 @('add', '-A')); [void](G $iv4 @('commit', '-q', '-m', 'i'))
[Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', $emptyCfg, 'Process')
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv4)
Check 'no identity anywhere and no params: fails (exit 3) before changing anything' ($r.Code -eq 3 -and (GCode $iv4 @('config', '--local', 'receive.denyCurrentBranch')) -ne 0) $r.Out
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv4, '-AuthorName', 'Hub Bot', '-AuthorEmail', 'hub@example.invalid')
Check 'with -AuthorName/-AuthorEmail: local identity set' ($r.Code -eq 0 -and (G $iv4 @('config', '--local', 'user.name')) -eq 'Hub Bot' -and (G $iv4 @('config', '--local', 'user.email')) -eq 'hub@example.invalid') $r.Out
$r = Run 'Initialize-RyzenVault.ps1' @('-Path', $iv4)
Check 'later run without params keeps the local identity (idempotent)' ($r.Code -eq 0 -and $r.Out -match 'No change') $r.Out
[Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', $globalCfg, 'Process')

# ------------------------------------------------------------------ 4. clean sync, both ways
Section 'sync: clean, both directions'
$p = New-Pair
$r = Sync $p.Main $p.Ryzen
Check 'nothing to do: exit 0, heads equal' ($r.Code -eq 0 -and (G $p.Main @('rev-parse', 'HEAD')) -eq (G $p.Ryzen @('rev-parse', 'HEAD'))) $r.Out
Write-Text (Join-Path $p.Main 'wiki\new-from-main.md') "from main`n"
$r = Sync $p.Main $p.Ryzen
Check 'main to ryzen: exit 0, commit message default, ryzen work tree updated and clean' ($r.Code -eq 0 -and (G $p.Ryzen @('log', '-1', '--format=%s')) -match '^vault: edits from ' -and (Test-Path -LiteralPath (Join-Path $p.Ryzen 'wiki\new-from-main.md')) -and -not (G $p.Ryzen @('status', '--porcelain')) -and (G $p.Main @('rev-parse', 'HEAD^{tree}')) -eq (G $p.Ryzen @('rev-parse', 'HEAD^{tree}'))) $r.Out
# ryzen ahead (autocommitted note), main has nothing local
Write-Text (Join-Path $p.Ryzen 'wiki\from-ryzen.md') "from ryzen`n"
$r = Run-Autocommit $p.Ryzen
Check 'autocommit commits the new ryzen note' ($r.Code -eq 0 -and (G $p.Ryzen @('log', '-1', '--format=%s')) -match '^vault: OS memory notes \(auto, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\)$') $r.Out
$r = Sync $p.Main $p.Ryzen
Check 'ryzen to main: main fast-forwards to ryzen, file present, equal trees' ($r.Code -eq 0 -and (Test-Path -LiteralPath (Join-Path $p.Main 'wiki\from-ryzen.md')) -and (G $p.Main @('rev-parse', 'HEAD')) -eq (G $p.Ryzen @('rev-parse', 'HEAD'))) $r.Out
$r = Sync $p.Main $p.Ryzen -extra @('-Message', 'custom message')
Check 'a custom -Message is used only when there is something to commit' ($r.Code -eq 0 -and (G $p.Main @('log', '-1', '--format=%s')) -notmatch 'custom message')

# ------------------------------------------------------------------ 5. diverged, different files
Section 'sync: main edit plus ryzen autocommit of a different file'
$p = New-Pair
Write-Text (Join-Path $p.Main 'wiki\a.md') "line one`nline two EDITED ON MAIN`nline three`n"
Write-Text (Join-Path $p.Ryzen 'wiki\os-note.md') "written by the connector`n"
[void](Run-Autocommit $p.Ryzen)
$r = Sync $p.Main $p.Ryzen -extra @('-Message', 'obsidian edit')
$same = ((G $p.Main @('rev-parse', 'HEAD')) -eq (G $p.Ryzen @('rev-parse', 'HEAD')))
Check 'rebase succeeded, pushed, both converge on one HEAD' ($r.Code -eq 0 -and $same) $r.Out
Check 'both changes present on both sides, ryzen work tree clean' ((Read-Text (Join-Path $p.Ryzen 'wiki\a.md')) -match 'EDITED ON MAIN' -and (Test-Path -LiteralPath (Join-Path $p.Main 'wiki\os-note.md')) -and -not (G $p.Ryzen @('status', '--porcelain')))
Check 'history is linear (main commit sits on top of the autocommit)' ((G $p.Main @('log', '-2', '--format=%s')) -match 'obsidian edit' -and (G $p.Main @('rev-list', '--merges', '--count', 'HEAD')) -eq '0')

# ------------------------------------------------------------------ 6. conflict
Section 'sync: same-line conflict'
$p = New-Pair
Write-Text (Join-Path $p.Ryzen 'wiki\b.md') "bee one RYZEN`nbee two`nbee three`n"
[void](Run-Autocommit $p.Ryzen)
$ryzenHead = G $p.Ryzen @('rev-parse', 'HEAD')
Write-Text (Join-Path $p.Main 'wiki\b.md') "bee one MAIN`nbee two`nbee three`n"
$r = Sync $p.Main $p.Ryzen -extra @('-Message', 'main conflicting edit')
Check 'exit 2 and names the conflicting file' ($r.Code -eq 2 -and $r.Out -match 'CONFLICT' -and $r.Out -match 'wiki/b\.md') $r.Out
Check 'nothing pushed: ryzen HEAD unchanged' ((G $p.Ryzen @('rev-parse', 'HEAD')) -eq $ryzenHead)
Check "main's commit is still there, on its own, work tree clean, no rebase left running" ((G $p.Main @('log', '-1', '--format=%s')) -eq 'main conflicting edit' -and -not (G $p.Main @('status', '--porcelain')) -and -not (Test-Path -LiteralPath (Join-Path $p.Main '.git\rebase-merge')) -and (Read-Text (Join-Path $p.Main 'wiki\b.md')) -match 'bee one MAIN') $r.Out
Check "ryzen's file content is intact" ((Read-Text (Join-Path $p.Ryzen 'wiki\b.md')) -match 'bee one RYZEN')

# ------------------------------------------------------------------ 7. ryzen dirty -> push refused path
Section 'sync: ryzen work tree dirty'
$p = New-Pair
Write-Text (Join-Path $p.Ryzen 'wiki\a.md') "line one`nline two`nline three`nappended by the connector`n"   # tracked file changed, not committed
Write-Text (Join-Path $p.Main 'wiki\d.md') "main note d`n"
$r = Sync $p.Main $p.Ryzen -extra @('-TriggerCommand', 'none')
Check 'with no trigger: push refused, exit 3, nothing lost' ($r.Code -eq 3 -and $r.Out -match 'PUSH REFUSED' -and (G $p.Main @('log', '-1', '--format=%s')) -match '^vault: edits from' -and (Read-Text (Join-Path $p.Ryzen 'wiki\a.md')) -match 'appended by the connector' -and -not (Test-Path -LiteralPath (Join-Path $p.Ryzen 'wiki\d.md'))) $r.Out
$r = Sync $p.Main $p.Ryzen -extra @('-TriggerCommand', 'exit 0')
Check 'trigger that fixes nothing: retried once, then exit 3 (no loop)' ($r.Code -eq 3 -and $r.Out -match 'retrying one time' -and $r.Out -match 'PUSH REFUSED') $r.Out
$r = Sync $p.Main $p.Ryzen -extra @('-TriggerCommand', (Autocommit-Cmd $p.Ryzen))
Check 'trigger runs the autocommit: retry fetches, rebases, pushes, exit 0' ($r.Code -eq 0 -and $r.Out -match 'Trigger command exit code 0' -and (Test-Path -LiteralPath (Join-Path $p.Ryzen 'wiki\d.md')) -and (G $p.Main @('rev-parse', 'HEAD')) -eq (G $p.Ryzen @('rev-parse', 'HEAD')) -and -not (G $p.Ryzen @('status', '--porcelain'))) $r.Out
Check "the connector's appended line survived in the autocommit" ((Read-Text (Join-Path $p.Ryzen 'wiki\a.md')) -match 'appended by the connector')

# ------------------------------------------------------------------ 8. vault-sync guards and -Setup
Section 'vault-sync: guards and -Setup'
$p = New-Pair
[void](G $p.Main @('remote', 'remove', 'ryzen'))
$r = Sync $p.Main $p.Ryzen
Check 'no remote and no -Setup: refused (exit 4)' ($r.Code -eq 4 -and $r.Out -match '-Setup') $r.Out
$r = Sync $p.Main $p.Ryzen -extra @('-Setup')
Check '-Setup adds the remote and verifies it with ls-remote' ($r.Code -eq 0 -and $r.Out -match 'Added remote' -and $r.Out -match 'Verified' -and (G $p.Main @('remote', 'get-url', 'ryzen')) -eq $p.Ryzen) $r.Out
$r = Sync $p.Main $p.Ryzen -extra @('-Setup')
Check '-Setup again is idempotent' ($r.Code -eq 0 -and $r.Out -match 'already set')
$r = Run 'vault-sync.ps1' @('-VaultPath', $p.Main, '-Setup', '-RemoteName', 'nowhere', '-RemoteUrl', (Join-Path $root 'does-not-exist'), '-RetryWaitSeconds', '0')
Check 'an unreachable remote fails -Setup verification (exit 5)' ($r.Code -eq 5) $r.Out
[void](G $p.Main @('remote', 'remove', 'nowhere'))
[void](G $p.Main @('checkout', '-q', '-b', 'side'))
Write-Text (Join-Path $p.Main 'wiki\side.md') "side`n"
$r = Sync $p.Main $p.Ryzen
Check 'refuses when the vault is not on main, commits nothing' ($r.Code -eq 4 -and (G $p.Main @('status', '--porcelain')) -match 'side\.md')
[void](G $p.Main @('checkout', '-q', 'main'))
Remove-Item -LiteralPath (Join-Path $p.Main 'wiki\side.md') -Force
Write-Text (Join-Path $p.Main '.git\index.lock') ''
$r = Sync $p.Main $p.Ryzen
Check 'refuses while index.lock exists' ($r.Code -eq 4 -and $r.Out -match 'index.lock')
Remove-Item -LiteralPath (Join-Path $p.Main '.git\index.lock') -Force
Write-Text (Join-Path $p.Main 'wiki\x.md') "x`n"
[void](G $p.Main @('remote', 'set-url', 'ryzen', (Join-Path $root 'gone')))
$r = Sync $p.Main (Join-Path $root 'gone')
Check 'unreachable ryzen at fetch: exit 5, local commit kept' ($r.Code -eq 5 -and (G $p.Main @('log', '-1', '--format=%s')) -match '^vault: edits from')
[void](G $p.Main @('remote', 'set-url', 'ryzen', $p.Ryzen))
# an ignored file is not committed
$p = New-Pair
Write-Text (Join-Path $p.Main '.gitignore') ".obsidian/workspace.json`n"
[void](G $p.Main @('add', '.gitignore')); [void](G $p.Main @('commit', '-q', '-m', 'ignore'))
Write-Text (Join-Path $p.Main '.obsidian\workspace.json') "{}`n"
Write-Text (Join-Path $p.Main 'wiki\kept.md') "k`n"
$r = Sync $p.Main $p.Ryzen
Check 'git add -A respects .gitignore' ($r.Code -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $p.Ryzen '.obsidian\workspace.json')) -and (Test-Path -LiteralPath (Join-Path $p.Ryzen 'wiki\kept.md'))) $r.Out

# ------------------------------------------------------------------ 9. autocommit staging rules
Section 'autocommit: stages only wiki/*.md, skips denied and non-wiki'
$p = New-Pair
$rz = $p.Ryzen
Write-Text (Join-Path $rz 'wiki\new-note.md') "ok`n"
Write-Text (Join-Path $rz ("wiki\caf" + [char]0xE9 + "-note.md")) "accent`n"
Write-Text (Join-Path $rz 'wiki\sub dir\spaced name.md') "spaced`n"
Write-Text (Join-Path $rz 'wiki\secret-token.md') "denied by name`n"
Write-Text (Join-Path $rz 'wiki\transcript-1.md') "denied`n"
Write-Text (Join-Path $rz 'wiki\templates\t.md') "denied`n"
Write-Text (Join-Path $rz 'wiki\plain.txt') "not md`n"
Write-Text (Join-Path $rz 'scratch.md') "not under wiki`n"
Write-Text (Join-Path $rz 'staged-elsewhere.md') "staged by hand`n"
[void](G $rz @('add', 'staged-elsewhere.md'))
Remove-Item -LiteralPath (Join-Path $rz 'wiki\b.md') -Force
Move-Item -LiteralPath (Join-Path $rz 'wiki\a.md') -Destination (Join-Path $rz 'wiki\a-renamed.md')
Write-Text (Join-Path $rz 'README.md') "readme changed`n"
$r = Run-Autocommit $rz @('-DryRun')
Check 'dry run changes nothing' ($r.Code -eq 0 -and $r.Out -match 'dry run' -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '1')
$r = Run-Autocommit $rz
$files = @((G $rz @('show', '--name-status', '--format=', 'HEAD')) -split "`r?`n" | Where-Object { $_ })
$names = @($files | ForEach-Object { ($_ -split "`t") | Select-Object -Skip 1 } | Sort-Object -Unique)   # a rename lists old and new
Check 'exit 0 and one commit with the auto message' ($r.Code -eq 0 -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '2' -and (G $rz @('log', '-1', '--format=%s')) -match '^vault: OS memory notes \(auto, ') $r.Out
Check 'committed: plain note, accented name, spaced name, rename, deletion' (($names -contains 'wiki/new-note.md') -and ($names -contains ('wiki/caf' + [char]0xE9 + '-note.md')) -and ($names -contains 'wiki/sub dir/spaced name.md') -and ($names -contains 'wiki/a-renamed.md') -and ($names -contains 'wiki/a.md') -and ($names -contains 'wiki/b.md')) ($files -join ' | ')
Check 'committed nothing else (exactly 6 paths)' ($names.Count -eq 6) ($files -join ' | ')
$st = G $rz @('status', '--porcelain', '--untracked-files=all')
Check 'denied name, transcript, template, .txt and non-wiki files are left untouched' (($st -match 'secret-token\.md') -and ($st -match 'transcript-1\.md') -and ($st -match 'templates/t\.md') -and ($st -match 'plain\.txt') -and ($st -match 'scratch\.md') -and ($st -match 'README\.md'))
Check 'a file staged by hand elsewhere is still staged and was not committed' ($st -match '^A  staged-elsewhere\.md' -or $st -match "(?m)^A  staged-elsewhere\.md") $st
Check 'the log line names the files it left' ((Read-Text (Join-Path $logDir 'mu-vault-autocommit.log')) -match 'LEFT UNTOUCHED \d+ path\(s\):.*secret-token\.md')
$r = Run-Autocommit $rz
Check 'second run commits nothing more (only ineligible paths remain)' ($r.Code -eq 0 -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '2' -and $r.Out -match 'nothing eligible')
Check 'autocommit never pushed anywhere (no remotes)' ((G $rz @('remote')) -eq '')
# refuse off-main
$p2 = New-Pair
[void](G $p2.Ryzen @('checkout', '-q', '-b', 'dev')); Write-Text (Join-Path $p2.Ryzen 'wiki\q.md') "q`n"
$r = Run-Autocommit $p2.Ryzen
Check 'autocommit refuses when the vault is not on main (exit 2), commits nothing' ($r.Code -eq 2 -and (G $p2.Ryzen @('rev-list', '--count', 'HEAD')) -eq '1')
$r = Run 'mu-vault-autocommit.ps1' @('-VaultPath', (Join-Path $root 'plain'), '-LogDir', $logDir)
Check 'autocommit refuses a non-repo (exit 2)' ($r.Code -eq 2)

# ------------------------------------------------------------------ 10. lock and mutex
Section 'autocommit: index.lock, unfinished operation and mutex'
$p = New-Pair; $rz = $p.Ryzen
Write-Text (Join-Path $rz 'wiki\locked-note.md') "n`n"
$lock = Join-Path $rz '.git\index.lock'
Write-Text $lock ''
$r = Run-Autocommit $rz
Check 'index.lock present: deferred, exit 0, no commit, note untouched' ($r.Code -eq 0 -and $r.Out -match 'deferred: index.lock exists' -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '1' -and (Test-Path -LiteralPath (Join-Path $rz 'wiki\locked-note.md')))
Remove-Item -LiteralPath $lock -Force
Write-Text (Join-Path $rz '.git\MERGE_HEAD') ((G $rz @('rev-parse', 'HEAD')) + "`n")
$r = Run-Autocommit $rz
Check 'unfinished merge: deferred, no commit' ($r.Code -eq 0 -and $r.Out -match 'deferred: MERGE_HEAD' -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '1')
Remove-Item -LiteralPath (Join-Path $rz '.git\MERGE_HEAD') -Force
$mtx = Get-MuMutex -Name (Get-VaultMutexName -VaultPath $rz)
Check 'test process took the vault mutex' ($null -ne $mtx)
try {
  $r = Run-Autocommit $rz
  Check 'mutex held by another run: exits 0 at once, no commit' ($r.Code -eq 0 -and $r.Out -match 'another run is active' -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '1') $r.Out
} finally { if ($mtx) { $mtx.ReleaseMutex(); $mtx.Dispose() } }
$r = Run-Autocommit $rz
Check 'after the lock, merge marker and mutex are gone: it commits' ($r.Code -eq 0 -and (G $rz @('rev-list', '--count', 'HEAD')) -eq '2' -and -not (G $rz @('status', '--porcelain')))
Check 'mutex names differ per vault' ((Get-VaultMutexName -VaultPath $rz) -ne (Get-VaultMutexName -VaultPath $p.Main))

# ------------------------------------------------------------------ 11. installers
Section 'installers: -WhatIf changes nothing'
$before = @(Get-ScheduledTask -TaskPath '\MU\*' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TaskPath)$($_.TaskName)=$($_.State)" } | Sort-Object)
$vroot = Join-Path $root 'ryzen1'
$r = Run 'Install-VaultAutocommit.ps1' @('-VaultPath', $vroot, '-LogDir', (Join-Path $root 'instlogs'), '-WhatIf')
$after = @(Get-ScheduledTask -TaskPath '\MU\*' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TaskPath)$($_.TaskName)=$($_.State)" } | Sort-Object)
Check 'Install -WhatIf: exit 0, prints the plan, registers nothing' ($r.Code -eq 0 -and $r.Out -match 'MU Vault Autocommit' -and $r.Out -match 'every 10 minutes' -and $r.Out -match 'WhatIf: nothing' -and (($before -join ';') -ceq ($after -join ';'))) $r.Out
Check 'Install -WhatIf did not create the log folder' (-not (Test-Path -LiteralPath (Join-Path $root 'instlogs')))
$r = Run 'Install-VaultAutocommit.ps1' @('-VaultPath', $vroot, '-Remove', '-WhatIf')
$after2 = @(Get-ScheduledTask -TaskPath '\MU\*' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TaskPath)$($_.TaskName)=$($_.State)" } | Sort-Object)
Check 'Install -Remove -WhatIf: removes nothing' ($r.Code -eq 0 -and $r.Out -match 'WhatIf: nothing was removed' -and (($before -join ';') -ceq ($after2 -join ';'))) $r.Out
$plan = Get-VaultTaskPlan -ScriptDir $vaultDir -VaultPath $vroot -LogDir $logDir
Check 'plan: one task under \MU\, runs powershell.exe -File on the autocommit script for that vault' ($plan.Path -eq '\MU\' -and $plan.Name -eq 'MU Vault Autocommit' -and $plan.Arguments -match 'mu-vault-autocommit\.ps1' -and $plan.Arguments -match 'ryzen1' -and $plan.Execute -match 'powershell\.exe$' -and $plan.IntervalMinutes -eq 10)
$ins = Read-Text (Join-Path $vaultDir 'Install-VaultAutocommit.ps1')
Check 'installer uses S4U' ($ins -match 'LogonType S4U')

} finally {
  foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n], 'Process') }
  if (-not $KeepTemp) { try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { Write-Host "  (could not delete $root : $($_.Exception.Message))" } }
}

Write-Host ""
Write-Host "passed: $($script:passed)  failed: $($script:failed)"
exit $script:failed
