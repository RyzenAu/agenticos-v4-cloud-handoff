<#
.SYNOPSIS
  Keep a WSL distro running on this PC so shared bot computers survive hub restarts and tunnel drops (the Ryzen-PC keep-alive).

.DESCRIPTION
  WSL shuts the distro down when nothing runs in it. The bot computers are processes inside it, so a hub that is off for a few minutes
  would otherwise stop them (the hub recovers them automatically, but only after the host is reachable again). This installs a per-user,
  no-admin-needed logon entry that runs, hidden:

      wsl.exe -d kali-linux --exec sleep infinity

  Primary: a Scheduled Task at logon for the CURRENT user (named "WSL keep-alive (kali-linux)"), run with limited rights, no time limit,
  restarted if it ends. Fallback (used only if the task cannot be registered): a hidden script in this user's Startup folder.
  Nothing else on the PC is changed: no firewall, no sshd, no .wslconfig, no WSL settings.

  Run it as the user who owns the distro (mkhan on Ryzen-PC). It is idempotent. Use -WhatIf to see what it would do without doing it,
  and -Remove to take it out again. The task starts at the NEXT logon; add -StartNow to start the keep-alive now as well.

.PARAMETER Distro    The WSL distro to keep alive (default kali-linux).
.PARAMETER StartNow  Also start the keep-alive now (otherwise it starts at next logon).
.PARAMETER Remove    Remove the task and the Startup fallback.
.PARAMETER WhatIf    Show the plan and change nothing.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-WslKeepAlive.ps1 -WhatIf
  powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-WslKeepAlive.ps1 -StartNow
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidatePattern('^[A-Za-z0-9._-]{1,40}$')][string]$Distro = 'kali-linux',
  [switch]$StartNow,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$taskName = "WSL keep-alive ($Distro)"
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
# No `-u root`: keeping the distro awake needs no privilege, and the default WSL user is enough.
$arguments = "-d $Distro --exec sleep infinity"
$startup = [Environment]::GetFolderPath('Startup')
$fallback = Join-Path $startup "wsl-keepalive-$Distro.vbs"
$me = "$env:USERDOMAIN\$env:USERNAME"

# The one command, exactly as it will run. (A VBScript Run with window style 0 starts it with no window at all.)
function Get-KeepAliveCommand { "`"$wsl`" $arguments" }

function Get-TaskObjects {
  # In-memory objects only: nothing is registered until Register-ScheduledTask is called.
  $action    = New-ScheduledTaskAction -Execute $wsl -Argument $arguments
  $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
                 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  [pscustomobject]@{ Action = $action; Trigger = $trigger; Settings = $settings; Principal = $principal }
}

if ($Remove) {
  if ($PSCmdlet.ShouldProcess($taskName, 'Unregister the keep-alive task')) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; 'Removed the scheduled task.' } else { 'No scheduled task to remove.' }
  }
  # An instance this script started is stopped too: wsl.exe processes whose command line is exactly the keep-alive command for THIS distro.
  if ($PSCmdlet.ShouldProcess("wsl.exe $arguments", 'Stop a running keep-alive')) {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { ($_.CommandLine -replace '"', '').Trim() -like "*wsl.exe $arguments" })
    foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force; "Stopped the running keep-alive (pid $($p.ProcessId))." }
    if (-not $running) { 'No running keep-alive to stop.' }
  }
  if ($PSCmdlet.ShouldProcess($fallback, 'Delete the Startup fallback')) {
    if (Test-Path -LiteralPath $fallback) { Remove-Item -LiteralPath $fallback -Force; 'Removed the Startup fallback.' } else { 'No Startup fallback to remove.' }
  }
  return
}

# Preconditions (read-only): the distro exists and wsl.exe is where it should be.
if (-not (Test-Path -LiteralPath $wsl)) { throw "wsl.exe was not found at $wsl" }
# The distro name is matched EXACTLY (a line of `wsl -l -q`, not a substring: "kali" must not match "kali-linux-2").
$names = @(((& $wsl -l -q 2>$null) -join "`n") -replace "`0", '' -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($names -notcontains $Distro) { throw "The WSL distro '$Distro' is not installed for this user (wsl -l -q lists: $($names -join ', '))" }

"Plan (user $me, distro $Distro):"
"  command   : $(Get-KeepAliveCommand)"
"  task      : $taskName, at logon of $me, limited rights, hidden, no time limit, restart every 1 min if it ends"
"  fallback  : $fallback (only if the task cannot be registered)"

$objects = Get-TaskObjects   # proves every parameter is accepted, even under -WhatIf
$registered = $false
if ($PSCmdlet.ShouldProcess($taskName, 'Register the logon task')) {
  try {
    Register-ScheduledTask -TaskName $taskName -Action $objects.Action -Trigger $objects.Trigger -Settings $objects.Settings -Principal $objects.Principal `
      -Description "Keeps the $Distro WSL distro running (wsl.exe $arguments) so shared bot computers survive hub restarts. Installed by Install-WslKeepAlive.ps1; remove with -Remove." -Force | Out-Null
    $registered = $true
    "Registered the scheduled task '$taskName'."
    if (Test-Path -LiteralPath $fallback) { Remove-Item -LiteralPath $fallback -Force }
  } catch {
    "Could not register the task ($($_.Exception.Message.Trim())); using the Startup folder instead."
  }
  if (-not $registered) {
    $vbs = "' Keeps the $Distro WSL distro running (see Install-WslKeepAlive.ps1). Window style 0 = hidden.`r`nCreateObject(`"WScript.Shell`").Run `"`"`"$wsl`"`" $arguments`", 0, False`r`n"
    Set-Content -LiteralPath $fallback -Value $vbs -Encoding ASCII
    "Wrote the Startup fallback $fallback"
  }
  if ($StartNow) {
    if ($registered) { Start-ScheduledTask -TaskName $taskName; 'Started the keep-alive now.' }
    else { Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$fallback`"" -WindowStyle Hidden; 'Started the keep-alive now.' }
  }
  Start-Sleep -Seconds 3
  $up = (& $wsl -l -v 2>$null) -join ' ' -replace "`0", ''
  "WSL now: $($up -replace '\s+', ' ')"
}
