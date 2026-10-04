<#
.SYNOPSIS
  Registers the Hindsight supervisor's boot task with a 5-minute watchdog: "\Hindsight\Hindsight pilot supervisor" (R9 ops, 3 Oct 2026).

.DESCRIPTION
  Replaces the task of the same name that the cutover registered (boot trigger only, never run: it was created after the last boot, and
  nothing restarts the supervisor if it exits). Same folder, same name, same account and logon type (S4U, limited), so nothing else changes.

  What the new definition does:
    Action     <PythonPath> "<ServiceDir>\supervisor.py" run --profile <Profile>     (working directory <ServiceDir>)
               python.exe directly, not wscript + hindsight.vbs: Task Scheduler then shows the task as Running for as long as the supervisor
               runs, and the reboot check can prove the supervisor came from the task. The supervisor allocates its own hidden console
               (it needs one to send CTRL_BREAK to the API).
    Triggers   at startup (+<DelaySeconds> s) and a repeating trigger every <WatchdogMinutes> min. With "one instance at a time" a repeat
               does nothing while the supervisor runs. If the supervisor has exited, the next repeat starts it again within
               <WatchdogMinutes> min. Repeats are cheap and safe:
                 - a supervisor already running (by hand, WMI or the task) holds the mutexes, so a second one exits 0 at once;
                 - after a crash loop the supervisor writes run\<profile>\crashloop.lock and every later start refuses (exit 3) until a
                   person runs `supervisor.py clear-alert`; the watchdog never clears it (this script never passes --clear-alert).
    Settings   no time limit, no "restart on failure" (the repeat is the watchdog), runs on battery, hidden, start when available.
    Account    the account that runs the hub (default: the one running this script), S4U. Never SYSTEM: the Hindsight proxy only accepts
               memory writes from bun.exe holding 127.0.0.1:8081 under the SAME Windows account, and C:\mu-hub\hindsight is ACL'd to it.

  To stop Hindsight, never "End" the task (that kills the supervisor without its clean shutdown of the proxy, API and Postgres). Use,
  OVER SSH (session 0, where the task runs; the supervisor's mutexes and stop event are per-session Local\ names, so from a desktop
  window `stop` and `status` see nothing and `run` would start a second supervisor):
     D:\hindsight\venv\Scripts\python.exe D:\hindsight\service\supervisor.py stop --profile pilot
  and, if it must stay down, Disable-ScheduledTask -TaskPath '\Hindsight\' -TaskName 'Hindsight pilot supervisor' first (else the watchdog
  starts it again within 5 minutes).

  Supports -WhatIf (prints the plan, changes nothing). Must run elevated (boot triggers need it). Starts nothing unless -StartNow is given,
  and -StartNow while a supervisor runs is harmless (the new one exits 0 on the mutex).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidatePattern('^[a-z][a-z0-9_-]{0,31}$')][string]$Profile = 'pilot',
  [string]$PythonPath = 'D:\hindsight\venv\Scripts\python.exe',
  [string]$ServiceDir = 'D:\hindsight\service',
  [string]$TaskPath = '\Hindsight\',
  [string]$TaskName = '',
  [string]$UserName = ([Security.Principal.WindowsIdentity]::GetCurrent().Name),
  [ValidateRange(0, 600)][int]$DelaySeconds = 30,
  [ValidateRange(1, 60)][int]$WatchdogMinutes = 5,
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
if (-not $TaskName) { $TaskName = "Hindsight $Profile supervisor" }
if (-not $TaskPath.StartsWith('\') -or -not $TaskPath.EndsWith('\')) { throw "-TaskPath must look like \Folder\ (got $TaskPath)" }
$supervisor = Join-Path $ServiceDir 'supervisor.py'
$arguments = "`"$supervisor`" run --profile $Profile"

"Plan: $TaskPath$TaskName for $UserName (S4U, limited)"
"  action  : `"$PythonPath`" $arguments   (cwd $ServiceDir)"
"  triggers: at startup (+$DelaySeconds s); every $WatchdogMinutes min (watchdog; one instance at a time, so a repeat does nothing while it runs)"
"  settings: no time limit, no restart-on-failure, hidden, runs on battery, start when available"
"  never passes --clear-alert: a crash-loop lock keeps it stopped until a person clears it"

$problems = @()
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { $problems += "python not found: $PythonPath" }
if (-not (Test-Path -LiteralPath $supervisor -PathType Leaf)) { $problems += "supervisor not found: $supervisor" }
if ($UserName -match '^(NT AUTHORITY\\)?SYSTEM$' -or $UserName -match 'S-1-5-18') { $problems += "refusing SYSTEM: the proxy only accepts memory writes from the hub's own account" }
foreach ($p in $problems) { "  PROBLEM: $p" }

$existing = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  $acts = @($existing.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | '
  "  replaces: $TaskPath$TaskName (state $($existing.State), $($existing.Principal.LogonType), action: $acts)"
} else { "  new task (nothing named $TaskPath$TaskName yet)" }

if ($WhatIfPreference) { "WhatIf: nothing was registered, started or changed."; return }
if ($problems.Count) { throw "Fix the problems above and run again." }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this from an elevated (Run as administrator) PowerShell: boot-trigger tasks cannot be registered otherwise." }

$action = New-ScheduledTaskAction -Execute $PythonPath -Argument $arguments -WorkingDirectory $ServiceDir
$boot = New-ScheduledTaskTrigger -AtStartup
if ($DelaySeconds -gt 0) { $boot.Delay = "PT$($DelaySeconds)S" }
$repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType S4U -RunLevel Limited
$def = New-ScheduledTask -Action $action -Trigger @($boot, $repeat) -Settings $settings -Principal $principal `
  -Description "Starts the Hindsight supervisor (profile $Profile) at boot and every $WatchdogMinutes min if it is not running. Installed by Install-MuHindsightTask.ps1."
if ($PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Register (replace)')) {
  Register-ScheduledTask -InputObject $def -TaskName $TaskName -TaskPath $TaskPath -Force | Out-Null
  "Registered $TaskPath$TaskName"
}
$t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
"  state: $($t.State); triggers: $(@($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task', '' }) -join ', ')"
if ($StartNow -and $PSCmdlet.ShouldProcess("$TaskPath$TaskName", 'Start now')) {
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
  "Started. If a supervisor was already running, the new one exits 0 at once (last result 0x0) and the old one carries on."
} else {
  "Not started. The watchdog trigger fires within $WatchdogMinutes min; with a supervisor already running it exits 0 at once."
}
