<#
.SYNOPSIS
  Run ON RYZEN (elevated): registers the vault autocommit task as \MU\MU Vault Autocommit.

.DESCRIPTION
  One task, two triggers: at startup (+60 s) and every 10 minutes. It runs mu-vault-autocommit.ps1 for -VaultPath as
  -UserName, S4U logon (stored with no password, same pattern as Install-MuHub.ps1), hidden, one instance at a time,
  10 minute limit, runs on battery. Only the task named 'MU Vault Autocommit' in \MU\ is ever created, replaced or removed:
  no other task is read for changes or touched.
  Idempotent: running again replaces that one task. -WhatIf prints the plan and changes nothing (no admin needed).
  -Remove unregisters just this task (rollback). -StartNow runs it once after registering.
  Run it as the account that owns the vault clone and has the git identity (the account ssh logs in as).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$VaultPath = 'C:\mu-hub\vault\mu-ventures-obsidian-wiki',
  [string]$LogDir = 'C:\mu-hub\logs',
  [string]$UserName = ([Security.Principal.WindowsIdentity]::GetCurrent().Name),
  [int]$IntervalMinutes = 10,
  [string]$ScriptDir = '',
  [switch]$Remove,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-vault-common.ps1')
if (-not $ScriptDir) { $ScriptDir = $PSScriptRoot }
if ($IntervalMinutes -lt 1) { throw '-IntervalMinutes must be at least 1.' }
$plan = Get-VaultTaskPlan -ScriptDir $ScriptDir -VaultPath $VaultPath -LogDir $LogDir -IntervalMinutes $IntervalMinutes
$full = "$($plan.Path)$($plan.Name)"

if ($Remove) {
  "Plan: remove $full (nothing else)"
  if ($WhatIfPreference) { "WhatIf: nothing was removed."; return }
  $t = Get-ScheduledTask -TaskPath $plan.Path -TaskName $plan.Name -ErrorAction SilentlyContinue
  if (-not $t) { "Not registered: $full"; return }
  if ($PSCmdlet.ShouldProcess($full, 'Unregister')) { Unregister-ScheduledTask -TaskPath $plan.Path -TaskName $plan.Name -Confirm:$false; "Removed $full" }
  return
}

"Plan: register $full for $UserName (S4U)"
"  triggers: at startup (+$($plan.StartupDelaySeconds) s), then every $($plan.IntervalMinutes) minutes"
"  $($plan.Execute) $($plan.Arguments)"

$problems = @()
if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'mu-vault-autocommit.ps1'))) { $problems += "missing script: $(Join-Path $ScriptDir 'mu-vault-autocommit.ps1')" }
if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'mu-vault-common.ps1'))) { $problems += "missing script: $(Join-Path $ScriptDir 'mu-vault-common.ps1')" }
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $ScriptDir) 'mu-common.ps1'))) { $problems += 'missing ..\mu-common.ps1 next to the vault folder' }
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) { $problems += "VaultPath not found: $VaultPath" }
foreach ($p in $problems) { "  PROBLEM: $p" }

if ($WhatIfPreference) { "WhatIf: nothing was registered, created or changed."; return }
if ($problems.Count) { throw 'Fix the problems above and run again.' }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this from an elevated (Run as administrator) PowerShell: a startup-trigger task cannot be registered otherwise.' }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$existing = Get-ScheduledTask -TaskPath $plan.Path -TaskName $plan.Name -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute $plan.Execute -Argument $plan.Arguments -WorkingDirectory $VaultPath
$startup = New-ScheduledTaskTrigger -AtStartup
$startup.Delay = "PT$($plan.StartupDelaySeconds)S"
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $plan.IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType S4U -RunLevel Limited
$def = New-ScheduledTask -Action $action -Trigger @($startup, $repeat) -Settings $settings -Principal $principal -Description $plan.Description
$verb = if ($existing) { 'Updating' } else { 'Registering' }
if ($PSCmdlet.ShouldProcess($full, "$verb (S4U, $UserName)")) {
  Register-ScheduledTask -InputObject $def -TaskName $plan.Name -TaskPath $plan.Path -Force | Out-Null
  "$verb $full (S4U)"
  if ($StartNow) { Start-ScheduledTask -TaskPath $plan.Path -TaskName $plan.Name; "Started $full once" }
  (Get-ScheduledTask -TaskPath $plan.Path -TaskName $plan.Name) | ForEach-Object { "  $($_.TaskPath)$($_.TaskName): $($_.State)" }
}
