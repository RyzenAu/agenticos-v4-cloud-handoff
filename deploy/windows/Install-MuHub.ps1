<#
.SYNOPSIS
  Registers the four boot-time Scheduled Tasks that run the AgenticOS hub host, under the \MU\ task folder.

.DESCRIPTION
  Tasks (all under \MU\, nothing outside that folder is ever touched):
    MU Hub Supervisor   at startup (+45 s)   mu-hub-supervisor.ps1
    MU WSL KeepAlive    at startup           mu-wsl-keepalive.ps1
    MU SearXNG          at startup (+60 s)   mu-searxng.ps1
    MU Hub Backup       daily 03:15, runs as soon as possible after a missed start   mu-hub-backup.ps1
  Settings: no execution time limit (backup: 3 h), restart on failure (every 5 min, 10 times; backup: twice, 30 min),
  runs on battery, hidden, one instance at a time. Triggers are AT STARTUP, so nothing needs anyone to log in
  and there is no Windows auto-login anywhere in this design.

  -LogonType chooses how the tasks run without an interactive session (read README.md, "S4U or Password"):
    S4U       (default) Service-for-User. Stored with NO password. The task gets a token for the user without
              the user's credentials: no network credentials (no authenticated SMB shares), and DPAPI user
              secrets (Windows Credential Manager, anything stored with CryptProtectData) are not unlocked.
              Plain credential FILES in the user profile (for example ~\.claude, ~\.codex) are still readable.
    Password  The task is stored with the user's password, which YOU type at an interactive Get-Credential
              prompt when you run this script. It is never a parameter, never written to disk or a log. The task
              then runs as a normal (batch) logon with network credentials and DPAPI available.
  Recommendation: start with S4U; switch to Password only if the S4U test in the README fails for WSL or a CLI login.

  Idempotent (re-running replaces the same four tasks). Supports -WhatIf (prints the plan and changes nothing).
  Must run from an elevated PowerShell, as the account that owns the WSL distro (it defaults to that account).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('S4U', 'Password')][string]$LogonType = 'S4U',
  [string]$UserName = ([Security.Principal.WindowsIdentity]::GetCurrent().Name),
  [string]$RepoRoot = 'C:\mu-hub\AgenticOS-v4',
  [string]$BunPath = 'C:\mu-hub\bin\bun.exe',
  [string]$DataDir = 'C:\mu-hub\data\production',
  [string]$LogDir = 'C:\mu-hub\logs',
  [string]$BackupDir = 'D:\mu-hub-backups\production',
  [string]$EnvFile = '',
  [int]$Port = 8081,
  [string]$Distro = 'kali-linux',
  [int]$SearxngPort = 18888,
  # Linux user inside the distro that owns the SearXNG install (empty = the distro's default user).
  [ValidatePattern('^(|[a-z_][a-z0-9_-]{0,31})$')][string]$SearxngWslUser = '',
  [ValidateSet('pc', 'server')][string]$HubRole = 'pc',
  # Task names to leave registered but DISABLED (e.g. before cutover: 'MU Hub Supervisor','MU Hub Backup').
  [string[]]$Disable = @(),
  [int]$BackupKeep = 14,
  [string]$BackupTime = '03:15',
  [string]$ScriptDir = '',
  [switch]$AllowSameDisk,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-common.ps1')
$taskPath = '\MU\'
if (-not $ScriptDir) { $ScriptDir = $PSScriptRoot }

$plan = Get-MuTaskPlan -ScriptDir $ScriptDir -RepoRoot $RepoRoot -BunPath $BunPath -DataDir $DataDir -LogDir $LogDir -BackupDir $BackupDir `
  -EnvFile $EnvFile -Port $Port -Distro $Distro -SearxngPort $SearxngPort -BackupKeep $BackupKeep -BackupTime $BackupTime

# powershell -File passes 'a','b' as ONE string, so accept a comma-separated list too.
$Disable = @($Disable | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($n in $Disable) { if (@('MU Hub Supervisor', 'MU WSL KeepAlive', 'MU SearXNG', 'MU Hub Backup') -notcontains $n) { throw "-Disable: unknown task '$n'" } }
foreach ($t in $plan) {
  if ($t.Name -eq 'MU SearXNG' -and $SearxngWslUser) { $t.Arguments += " -WslUser $SearxngWslUser" }
  if ($t.Name -eq 'MU Hub Supervisor' -and $HubRole -ne 'pc') { $t.Arguments += " -HubRole $HubRole" }
}

"Plan: $($plan.Count) task(s) in $taskPath for $UserName, logon type $LogonType"
foreach ($t in $plan) {
  $when = if ($t.Kind -eq 'AtStartup') { "at startup (+$($t.DelaySeconds) s)" } else { "daily $($t.At), run as soon as possible after a missed start" }
  "  $taskPath$($t.Name)  [$when]"
  "      $($t.Execute) $($t.Arguments)"
}

# ---- preconditions (read-only)
$problems = @()
foreach ($s in @('mu-common.ps1', 'mu-hub-supervisor.ps1', 'mu-wsl-keepalive.ps1', 'mu-searxng.ps1', 'mu-hub-backup.ps1')) {
  if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir $s))) { $problems += "missing script: $(Join-Path $ScriptDir $s)" }
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) { $problems += "RepoRoot has no package.json: $RepoRoot" }
if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { $problems += "BunPath not found: $BunPath" }
if ($EnvFile -and -not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { $problems += "EnvFile not found: $EnvFile" }
$same = if (Test-Path -LiteralPath $DataDir) { Test-MuSameDisk -PathA $DataDir -PathB $BackupDir } else { $null }
if (-not $AllowSameDisk -and $true -eq $same) { $problems += "BackupDir $BackupDir is on the same physical disk as DataDir $DataDir; the backup task would refuse to run" }
foreach ($p in $problems) { "  PROBLEM: $p" }

if ($WhatIfPreference) {
  if ($LogonType -eq 'Password') { "  (a real run would show a Get-Credential prompt for $UserName; the password is not stored anywhere except in the tasks)" }
  "WhatIf: nothing was registered, created or changed."
  return
}
if ($problems.Count) { throw "Fix the problems above and run again." }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this from an elevated (Run as administrator) PowerShell: boot-trigger tasks cannot be registered otherwise." }

# ---- credentials (Password only): typed at the prompt, held in memory, passed straight to the scheduler
$plain = $null
if ($LogonType -eq 'Password') {
  if (-not [Environment]::UserInteractive) { throw "-LogonType Password needs an interactive console for the password prompt." }
  $cred = Get-Credential -UserName $UserName -Message "Password for $UserName (stored by Windows inside the MU tasks only)"
  if (-not $cred) { throw "No credential entered." }
  $plain = $cred.GetNetworkCredential().Password
  # A wrong password registers fine and then silently never runs, so check it first.
  try {
    Add-Type -AssemblyName System.DirectoryServices.AccountManagement
    $dom = $cred.GetNetworkCredential().Domain
    $isMachine = (-not $dom) -or $dom -eq '.' -or $dom -eq $env:COMPUTERNAME
    $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($(if ($isMachine) { 'Machine' } else { 'Domain' }), $(if ($isMachine) { $env:COMPUTERNAME } else { $dom }))
    $ok = $ctx.ValidateCredentials($cred.GetNetworkCredential().UserName, $plain)
    if (-not $ok) { throw "Windows did not accept that password for $UserName." }
  } catch {
    if ($_.Exception.Message -like 'Windows did not accept*') { throw }
    Write-Warning "Could not pre-check the password ($($_.Exception.Message)); continuing."
  }
}

# ---- directories
foreach ($d in @($LogDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# ---- register
$existing = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
try {
  foreach ($t in $plan) {
    $action = New-ScheduledTaskAction -Execute $t.Execute -Argument $t.Arguments -WorkingDirectory $RepoRoot
    if ($t.Kind -eq 'AtStartup') {
      $trigger = New-ScheduledTaskTrigger -AtStartup
      if ($t.DelaySeconds -gt 0) { $trigger.Delay = "PT$($t.DelaySeconds)S" }
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 5)
    } else {
      $trigger = New-ScheduledTaskTrigger -Daily -At $t.At
      # StartWhenAvailable = "run task as soon as possible after a scheduled start is missed".
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
        -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 30)
    }
    if ($LogonType -eq 'S4U') {
      $principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType S4U -RunLevel Limited
      $def = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $t.Description
      $verb = if ($existing -contains $t.Name) { 'Updating' } else { 'Registering' }
      if ($PSCmdlet.ShouldProcess("$taskPath$($t.Name)", "$verb (S4U, $UserName)")) {
        Register-ScheduledTask -InputObject $def -TaskName $t.Name -TaskPath $taskPath -Force | Out-Null
        "$verb $taskPath$($t.Name) (S4U)"
      }
    } else {
      $def = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Description $t.Description
      $verb = if ($existing -contains $t.Name) { 'Updating' } else { 'Registering' }
      if ($PSCmdlet.ShouldProcess("$taskPath$($t.Name)", "$verb (stored password, $UserName)")) {
        Register-ScheduledTask -InputObject $def -TaskName $t.Name -TaskPath $taskPath -User $UserName -Password $plain -RunLevel Limited -Force | Out-Null
        "$verb $taskPath$($t.Name) (password)"
      }
    }
  }
} finally {
  $plain = $null
  $cred = $null
}

foreach ($n in $Disable) {
  if ($PSCmdlet.ShouldProcess("$taskPath$n", 'Disable')) { Disable-ScheduledTask -TaskPath $taskPath -TaskName $n | Out-Null; "Disabled $taskPath$n" }
}

"Registered. State:"
Get-ScheduledTask -TaskPath $taskPath | ForEach-Object { "  $($_.TaskPath)$($_.TaskName): $($_.State)" }

if ($StartNow) {
  foreach ($n in (@('MU WSL KeepAlive', 'MU SearXNG', 'MU Hub Supervisor') | Where-Object { $Disable -notcontains $_ })) {
    if ($PSCmdlet.ShouldProcess("$taskPath$n", 'Start now')) { Start-ScheduledTask -TaskPath $taskPath -TaskName $n; "Started $n" }
  }
} else {
  "Tasks start at the next boot. To start now: Start-ScheduledTask -TaskPath '\MU\' -TaskName '<name>'  (or re-run with -StartNow)."
}
