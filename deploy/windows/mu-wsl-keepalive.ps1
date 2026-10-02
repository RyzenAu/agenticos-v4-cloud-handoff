<#
.SYNOPSIS
  Keeps a WSL distro running, independent of the hub, and restarts it if the keep-alive process exits.

.DESCRIPTION
  WSL shuts a distro down when nothing runs in it. This holds one process open inside it:
      wsl.exe -d <distro> --exec sleep infinity
  (the same command deploy\computers\windows\Install-WslKeepAlive.ps1 uses; that one starts at LOGON, this one is
  started at BOOT by the "\MU\MU WSL KeepAlive" task). Every -ProbeIntervalSeconds it also runs
  `wsl.exe -d <distro> --exec true` with a timeout; -MaxProbeFailures failures in a row restart the keep-alive.
  Restarts use the same bounded backoff and give-up rule as the hub supervisor (exit 2).
  Exit codes: 0 stopped or another copy runs, 2 gave up, 5 bad parameters (distro missing, no wsl.exe).

  Running both keep-alives is harmless (two idle sleeps) but the old logon one is redundant once this works;
  remove it with Install-WslKeepAlive.ps1 -Remove when the boot task is proven.

  -DryRun (alias -Once) prints the plan and exits.
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._-]{1,40}$')][string]$Distro = 'kali-linux',
  [Parameter(Mandatory)][string]$LogDir,
  [int]$ProbeIntervalSeconds = 60,
  [int]$ProbeTimeoutSeconds = 30,
  [int]$MaxProbeFailures = 3,
  [int[]]$BackoffSchedule = @(2, 5, 15, 60),
  [int]$MaxFailures = 6,
  [int]$FailureWindowMinutes = 10,
  [int]$StableSeconds = 300,
  [Alias('Once')][switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'mu-common.ps1')

$logFile = Join-Path $LogDir 'mu-wsl-keepalive.log'
function Log([string]$m) { Write-MuLog -Path $logFile -Message $m }
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$keepArgs = @('-d', $Distro, '--exec', 'sleep', 'infinity')
$mutexName = "Global\MuWslKeepAlive-$Distro"

if ($DryRun) {
  "PLAN (dry run, nothing is started)"
  "  command : `"$wsl`" $(ConvertTo-MuArgString $keepArgs)   (hidden)"
  "  probe   : wsl.exe -d $Distro --exec true every ${ProbeIntervalSeconds}s (timeout ${ProbeTimeoutSeconds}s, restart after $MaxProbeFailures failures)"
  "  log     : $logFile"
  "  mutex   : $mutexName"
  "  backoff : $($BackoffSchedule -join ', ') s; give up after $MaxFailures failures in $FailureWindowMinutes min"
  if (-not (Test-Path -LiteralPath $wsl)) { "  PROBLEM : wsl.exe not found at $wsl"; exit 5 }
  $names = Get-MuWslDistros
  if ($names -notcontains $Distro) { "  PROBLEM : distro '$Distro' not installed for this user (wsl -l -q: $($names -join ', '))"; exit 5 }
  "  distro  : $Distro present"
  exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path -LiteralPath $wsl)) { Log "wsl.exe not found at $wsl"; exit 5 }
$mutex = Get-MuMutex -Name $mutexName
if (-not $mutex) { Log "another keep-alive already holds $mutexName; exiting"; exit 0 }
$names = Get-MuWslDistros
if ($names -notcontains $Distro) { Log "distro '$Distro' is not installed for this user (wsl -l -q: $($names -join ', ')); this script never creates a distro"; exit 5 }

Log "keep-alive started (pid $PID, distro $Distro)"
$failureTimes = New-Object System.Collections.Generic.List[datetime]
$consecutive = 0
$keep = $null
try {
  while ($true) {
    $keep = Start-Process -FilePath $wsl -ArgumentList (ConvertTo-MuArgString $keepArgs) -WindowStyle Hidden -PassThru
    $null = $keep.Handle
    $startedAt = Get-Date
    Log "started wsl.exe keep-alive (pid $($keep.Id))"
    $reason = $null
    $probeFails = 0
    Start-Sleep -Seconds 5
    while ($true) {
      if ($keep.HasExited) { $reason = "keep-alive exited (code $($keep.ExitCode))"; break }
      $probe = Invoke-MuProcess -FilePath $wsl -ArgumentList @('-d', $Distro, '--exec', 'true') -TimeoutSeconds $ProbeTimeoutSeconds
      if ($probe.ExitCode -eq 0) {
        if ($probeFails -gt 0) { Log "distro answering again after $probeFails failed probe(s)" }
        $probeFails = 0
        if ($consecutive -gt 0 -and ((Get-Date) - $startedAt).TotalSeconds -ge $StableSeconds) { Log "stable for ${StableSeconds}s; failure counter reset"; $consecutive = 0 }
      } else {
        $probeFails++
        Log "distro probe failed ($probeFails of $MaxProbeFailures; exit $($probe.ExitCode), timed out: $($probe.TimedOut))"
        if ($probeFails -ge $MaxProbeFailures) { $reason = "distro unresponsive for $probeFails probes"; break }
      }
      Start-Sleep -Seconds $ProbeIntervalSeconds
    }
    Log "FAILURE: $reason"
    if ($keep -and -not $keep.HasExited) { Stop-MuProcessTree -ProcessId $keep.Id }
    $consecutive++
    $failureTimes.Add((Get-Date))
    if (Test-MuGiveUp -Times $failureTimes.ToArray() -Max $MaxFailures -WindowSeconds ($FailureWindowMinutes * 60)) {
      Log "GIVING UP: $MaxFailures failures within $FailureWindowMinutes minutes. Check 'wsl -l -v' and 'wsl --status' as the task's user, then start the task again."
      exit 2
    }
    $delay = Get-MuBackoffSeconds -Attempt $consecutive -Schedule $BackoffSchedule
    Log "restarting in ${delay}s (consecutive failure $consecutive)"
    Start-Sleep -Seconds $delay
  }
} finally {
  if ($keep -and -not $keep.HasExited) { Stop-MuProcessTree -ProcessId $keep.Id }
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
}
