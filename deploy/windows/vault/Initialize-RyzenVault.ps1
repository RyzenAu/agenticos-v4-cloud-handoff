<#
.SYNOPSIS
  Run ON RYZEN, once, on the vault clone: makes it accept pushes into its checked-out main.

.DESCRIPTION
  For the clone at -Path (default C:\mu-hub\vault\mu-ventures-obsidian-wiki) it:
    1. REFUSES (exit 2) unless -Path is the top level of a normal git work tree with at least one commit and
       branch `main` checked out. Nothing is changed in that case.
    2. Sets, locally in that repo:  receive.denyCurrentBranch=updateInstead  (a push into main updates the work tree,
       and is refused if the work tree is dirty), and  core.autocrlf=false.
    3. Identity: if a global user.name and user.email exist for this account, nothing is set. Otherwise, if the repo
       already has a local identity, it is kept. Otherwise -AuthorName and -AuthorEmail are required and are set LOCALLY.
       No identity is ever invented: with none available the script fails (exit 3) BEFORE changing anything.
  Idempotent: a second run reports "no change" and writes nothing. -WhatIf prints what would change and changes nothing.
  Exit codes: 0 ok, 2 refused (not a repo / not main / no commits), 3 no identity available.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Path = 'C:\mu-hub\vault\mu-ventures-obsidian-wiki',
  [string]$AuthorName = '',
  [string]$AuthorEmail = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-vault-common.ps1')

function Get-Cfg([string[]]$scope, [string]$key) {
  $r = Invoke-VaultGit -Repo $Path -GitArgs (@('config') + $scope + @('--get', $key))
  if ($r.Code -eq 0) { return $r.Out }
  return $null
}

$why = Test-VaultRepoRoot -Path $Path
if ($why) { Write-Host "REFUSED: $why"; exit 2 }
$Path = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
$branch = Get-VaultBranch -Repo $Path
if ($branch -ne 'main') {
  $shown = if ($branch) { $branch } else { '(detached HEAD)' }
  Write-Host "REFUSED: $Path is on branch $shown, not main."; exit 2
}
$head = Invoke-VaultGit -Repo $Path -GitArgs @('rev-parse', '--verify', '--quiet', 'HEAD^{commit}')
if ($head.Code -ne 0) { Write-Host "REFUSED: $Path has no commits yet (clone or unbundle the vault first)."; exit 2 }

# ---- identity decision (read-only, before any write)
$identityAction = 'none'
$gName = Get-Cfg @('--global') 'user.name'; $gMail = Get-Cfg @('--global') 'user.email'
$lName = Get-Cfg @('--local') 'user.name'; $lMail = Get-Cfg @('--local') 'user.email'
if ($gName -and $gMail) { $identityAction = 'global' }
elseif ($lName -and $lMail) { $identityAction = 'kept-local' }
elseif ($AuthorName.Trim() -and $AuthorEmail.Trim()) { $identityAction = 'set-local' }
else {
  Write-Host 'FAILED: no git identity for this account (no global user.name/user.email) and none in the repo.'
  Write-Host 'Run again with -AuthorName "<name>" -AuthorEmail "<email>". The script will not invent one.'
  exit 3
}

# ---- apply
$changes = 0
function Set-LocalCfg([string]$key, [string]$value) {
  $cur = Get-Cfg @('--local') $key
  if ($cur -ceq $value) { Write-Host "  ok    $key = $value (already)"; return }
  if ($PSCmdlet.ShouldProcess("$Path ($key)", "git config --local $key $value")) {
    $r = Invoke-VaultGit -Repo $Path -GitArgs @('config', '--local', $key, $value)
    if ($r.Code -ne 0) { throw "git config $key failed: $($r.Err)" }
    Write-Host "  set   $key = $value"
  } else { Write-Host "  would set $key = $value" }
  $script:changes++
}

Write-Host "Vault clone: $Path (branch main)"
Set-LocalCfg 'receive.denyCurrentBranch' 'updateInstead'
Set-LocalCfg 'core.autocrlf' 'false'
switch ($identityAction) {
  'global' { Write-Host '  ok    identity: global user.name/user.email present, nothing set' }
  'kept-local' { Write-Host '  ok    identity: repo already has a local user.name/user.email, kept' }
  'set-local' {
    Set-LocalCfg 'user.name' $AuthorName.Trim()
    Set-LocalCfg 'user.email' $AuthorEmail.Trim()
  }
}
if ($changes -eq 0) { Write-Host 'No change.' }
elseif ($WhatIfPreference) { Write-Host "WhatIf: $changes setting(s) would change; nothing was written." }
else { Write-Host "Done: $changes setting(s) changed." }
exit 0
