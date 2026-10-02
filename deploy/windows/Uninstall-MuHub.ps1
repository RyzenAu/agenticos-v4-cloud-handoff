<#
.SYNOPSIS
  Removes the four \MU\ scheduled tasks created by Install-MuHub.ps1 (and stops their running processes).

.DESCRIPTION
  Only these exact names in the \MU\ folder are touched: MU Hub Supervisor, MU WSL KeepAlive, MU SearXNG, MU Hub Backup.
  Any other task in \MU\ and everything outside \MU\ is left alone. Logs, backups, the hub data and the repo are NOT deleted.
  Ending a task also ends the processes it started (Task Scheduler runs them in a job). Supports -WhatIf. Idempotent.
  Needs an elevated PowerShell for a real run.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$taskPath = '\MU\'
$names = @('MU Hub Supervisor', 'MU WSL KeepAlive', 'MU SearXNG', 'MU Hub Backup')

if (-not $WhatIfPreference) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { throw "Run this from an elevated PowerShell." }
}

foreach ($n in $names) {
  $t = Get-ScheduledTask -TaskPath $taskPath -TaskName $n -ErrorAction SilentlyContinue
  if (-not $t) { "Not present: $taskPath$n"; continue }
  if ($PSCmdlet.ShouldProcess("$taskPath$n", 'Stop and unregister')) {
    if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskPath $taskPath -TaskName $n }
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $n -Confirm:$false
    "Removed $taskPath$n"
  }
}
$left = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
if ($left.Count) { "Still in ${taskPath}: $($left -join ', ')" } else { "Nothing left in $taskPath" }
"Logs, backups, data and the repo were not touched."
