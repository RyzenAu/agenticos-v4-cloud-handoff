<#
.SYNOPSIS
  Starts SearXNG inside the WSL distro and keeps it answering on http://127.0.0.1:<port>/, with bounded restarts.

.DESCRIPTION
  Same start command as scripts\windows\searxng.ps1, but every path is INSIDE the distro (so `~` is the distro
  user's home) and nothing refers to a Windows user profile:
      source <venv>/bin/activate; export SEARXNG_SETTINGS_PATH=<settings>; cd <src>
      nohup python3 -m searx.webapp > ~/searxng.log 2>&1 < /dev/null & disown $!; sleep 2
  The python process lives in the distro, so it survives this script; the WSL keep-alive task keeps the distro up.
  Health = any HTTP 200 from GET http://127.0.0.1:<port>/ . After -MaxProbeFailures failed probes in a row the
  stale process is killed (pkill -f searx.webapp) and SearXNG started again, after a backoff.
  Gives up (exit 2) after -MaxFailures failures in -FailureWindowMinutes. Exit codes: 0 stopped / already running,
  2 gave up, 5 bad parameters. Never installs or modifies the distro.

  -DryRun (alias -Once) prints the plan and exits.
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9._-]{1,40}$')][string]$Distro = 'kali-linux',
  [int]$Port = 18888,
  [Parameter(Mandatory)][string]$LogDir,
  # Linux user inside the distro that owns the SearXNG install (empty = the distro's default user).
  [ValidatePattern('^(|[a-z_][a-z0-9_-]{0,31})$')][string]$WslUser = '',
  [string]$VenvPath = '~/searxng-venv',
  [string]$SrcDir = '~/searxng-src/searxng',
  [string]$SettingsPath = '~/searxng-config/settings.yml',
  [int]$ProbeIntervalSeconds = 30,
  [int]$ProbeTimeoutSeconds = 8,
  [int]$MaxProbeFailures = 3,
  [int]$BootWaitSeconds = 90,
  [int[]]$BackoffSchedule = @(2, 5, 15, 60),
  [int]$MaxFailures = 6,
  [int]$FailureWindowMinutes = 10,
  [int]$StableSeconds = 300,
  [Alias('Once')][switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'mu-common.ps1')

$logFile = Join-Path $LogDir 'mu-searxng.log'
function Log([string]$m) { Write-MuLog -Path $logFile -Message $m }
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$url = "http://127.0.0.1:$Port/"
$mutexName = "Global\MuSearxng-$Distro-$Port"
$userArgs = if ($WslUser) { @('-u', $WslUser) } else { @() }

# Only path-like characters may reach the bash string.
foreach ($pair in @(@('VenvPath', $VenvPath), @('SrcDir', $SrcDir), @('SettingsPath', $SettingsPath))) {
  if ($pair[1] -notmatch '^[A-Za-z0-9_./~-]+$') { Write-Host "bad parameter $($pair[0]): only letters, digits and _ . / ~ - are allowed"; exit 5 }
}
$startBash = "source $VenvPath/bin/activate; export SEARXNG_SETTINGS_PATH=$SettingsPath; cd $SrcDir; nohup python3 -m searx.webapp > ~/searxng.log 2>&1 < /dev/null & disown `$!; sleep 2"
$stopBash = 'pkill -f searx.webapp; true'

if ($DryRun) {
  "PLAN (dry run, nothing is started)"
  "  distro  : $Distro$(if ($WslUser) { " (user $WslUser)" })"
  "  start   : wsl.exe -d $Distro -- bash -c `"$startBash`""
  "  health  : GET $url every ${ProbeIntervalSeconds}s (timeout ${ProbeTimeoutSeconds}s, restart after $MaxProbeFailures failures)"
  "  log     : $logFile"
  "  mutex   : $mutexName"
  "  backoff : $($BackoffSchedule -join ', ') s; give up after $MaxFailures failures in $FailureWindowMinutes min"
  if (-not (Test-Path -LiteralPath $wsl)) { "  PROBLEM : wsl.exe not found"; exit 5 }
  if ((Get-MuWslDistros) -notcontains $Distro) { "  PROBLEM : distro '$Distro' not installed for this user"; exit 5 }
  "  distro  : $Distro present"
  exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if (-not (Test-Path -LiteralPath $wsl)) { Log "wsl.exe not found"; exit 5 }
$mutex = Get-MuMutex -Name $mutexName
if (-not $mutex) { Log "another SearXNG supervisor already holds $mutexName; exiting"; exit 0 }

function Test-SearxUp { return [bool]((Test-MuHttp -Url $url -TimeoutSeconds $ProbeTimeoutSeconds) | Where-Object { $_.Answered -and $_.Status -eq 200 }) }

function Wait-Distro {
  # `wsl -d X --exec true` also starts the distro if it is stopped. Retry for a while: at boot the WSL service may lag.
  for ($i = 0; $i -lt 12; $i++) {
    $r = Invoke-MuProcess -FilePath $wsl -ArgumentList @('-d', $Distro, '--exec', 'true') -TimeoutSeconds 60
    if ($r.ExitCode -eq 0) { return $true }
    Start-Sleep -Seconds 5
  }
  return $false
}

function Start-Searx {
  if (-not (Wait-Distro)) { return "distro $Distro would not start" }
  # Clear any hung copy first so the port is free, then the proven start command.
  [void](Invoke-MuProcess -FilePath $wsl -ArgumentList (@('-d', $Distro) + $userArgs + @('--', 'bash', '-c', $stopBash)) -TimeoutSeconds 30)
  Start-Sleep -Seconds 1
  $r = Invoke-MuProcess -FilePath $wsl -ArgumentList (@('-d', $Distro) + $userArgs + @('--', 'bash', '-c', $startBash)) -TimeoutSeconds 60
  if ($r.ExitCode -ne 0) { return "start command exited $($r.ExitCode)" }
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $BootWaitSeconds) {
    Start-Sleep -Seconds 2
    if (Test-SearxUp) { return $null }
  }
  return "SearXNG did not answer on $url within ${BootWaitSeconds}s (see ~/searxng.log inside $Distro)"
}

Log "SearXNG supervisor started (pid $PID, distro $Distro, port $Port)"
$failureTimes = New-Object System.Collections.Generic.List[datetime]
$consecutive = 0
try {
  while ($true) {
    $reason = $null
    if (Test-SearxUp) {
      Log "SearXNG already answering on $url"
    } else {
      Log "SearXNG not answering; starting it in $Distro"
      $reason = Start-Searx
      if (-not $reason) { Log "SearXNG is up on $url" }
    }
    if (-not $reason) {
      $healthySince = Get-Date
      $probeFails = 0
      while ($true) {
        Start-Sleep -Seconds $ProbeIntervalSeconds
        if (Test-SearxUp) {
          if ($probeFails -gt 0) { Log "SearXNG answering again after $probeFails failed probe(s)" }
          $probeFails = 0
          if ($consecutive -gt 0 -and ((Get-Date) - $healthySince).TotalSeconds -ge $StableSeconds) { Log "stable for ${StableSeconds}s; failure counter reset"; $consecutive = 0 }
        } else {
          $probeFails++
          Log "SearXNG probe failed ($probeFails of $MaxProbeFailures)"
          if ($probeFails -ge $MaxProbeFailures) { $reason = "SearXNG unresponsive for $probeFails probes"; break }
        }
      }
    }
    Log "FAILURE: $reason"
    $consecutive++
    $failureTimes.Add((Get-Date))
    if (Test-MuGiveUp -Times $failureTimes.ToArray() -Max $MaxFailures -WindowSeconds ($FailureWindowMinutes * 60)) {
      Log "GIVING UP: $MaxFailures failures within $FailureWindowMinutes minutes. Check ~/searxng.log inside $Distro, then start the task again."
      exit 2
    }
    $delay = Get-MuBackoffSeconds -Attempt $consecutive -Schedule $BackoffSchedule
    Log "retrying in ${delay}s (consecutive failure $consecutive)"
    Start-Sleep -Seconds $delay
  }
} finally {
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
}
