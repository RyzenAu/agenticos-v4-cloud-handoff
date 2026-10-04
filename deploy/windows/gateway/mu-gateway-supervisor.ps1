<#
.SYNOPSIS
  Runs the Dot gateway on an always-on Windows host and restarts it when it dies or hangs (the same shape as
  ..\mu-hub-supervisor.ps1). FOR LATER: it is not installed by anything, and production exposure is a separate owner decision.

.DESCRIPTION
  1. Takes the mutex Global\MuGatewaySupervisor-<port> (a second copy exits 0). Refuses (exit 3) if the port is in use.
  2. Refuses (exit 5) when -Upstream is not a loopback http URL, or -Port is a hub port.
  3. Sets MU_DATA_DIR, MU_GATEWAY_PORT, MU_GATEWAY_UPSTREAM, MU_GATEWAY_PUBLIC_ORIGIN, MU_GATEWAY_UI_DIR, MU_GATEWAY_FORWARDED_FOR=0 (no
     env file: the gateway needs no secret from the environment; its key file is created under the data folder).
  4. Starts `bun scripts/gateway/main.ts` hidden, waits for /gw/health, probes it every -ProbeIntervalSeconds.
     A dead process or -MaxProbeFailures failed probes kills it and restarts after a backoff (2, 5, 15, 60 s).
     A 503 from /gw/health is the KILL switch, not a failure: the supervisor keeps the process up and refusing.
  5. Gives up (exit 2) after -MaxFailures failures inside -FailureWindowMinutes.
  -DryRun prints the plan and exits.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepoRoot,
  [Parameter(Mandatory)][string]$BunPath,
  [Parameter(Mandatory)][string]$DataDir,
  [Parameter(Mandatory)][string]$LogDir,
  [Parameter(Mandatory)][string]$PublicOrigin,
  # The built UI to serve (dist\client of a clean export, with gateway-ui-manifest.json). The gateway never forwards UI requests.
  [Parameter(Mandatory)][string]$UiDir,
  [int]$Port = 8092,
  [string]$Upstream = 'http://127.0.0.1:8081',
  [int]$ProbeIntervalSeconds = 15,
  [int]$ProbeTimeoutSeconds = 5,
  [int]$MaxProbeFailures = 4,
  [int]$BootWaitSeconds = 60,
  [int[]]$BackoffSchedule = @(2, 5, 15, 60),
  [int]$MaxFailures = 6,
  [int]$FailureWindowMinutes = 10,
  [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '..\mu-common.ps1')
$logFile = Join-Path $LogDir 'mu-gateway-supervisor.log'
function Log([string]$m) { Write-MuLog -Path $logFile -Message $m }
$health = "http://127.0.0.1:$Port/gw/health"
$mutexName = "Global\MuGatewaySupervisor-$Port"

$problems = @()
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'scripts\gateway\main.ts'))) { $problems += "RepoRoot has no scripts\gateway\main.ts: $RepoRoot" }
if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { $problems += "BunPath not found: $BunPath" }
if ($Upstream -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\]):\d+/?$') { $problems += "Upstream must be the hub on loopback: $Upstream" }
if ($Port -in @(8081, 8082, 8083, 8084, 8086, 8091, 8093)) { $problems += "Port $Port is a hub port" }
if ($PublicOrigin -notmatch '^https://[a-z0-9.-]+$') { $problems += "PublicOrigin must be a bare https origin: $PublicOrigin" }
if (-not (Test-Path -LiteralPath (Join-Path $UiDir 'gateway-ui-manifest.json'))) { $problems += "UiDir has no gateway-ui-manifest.json: $UiDir" }

if ($DryRun) {
  'PLAN (dry run, nothing is started)'
  "  command     : `"$BunPath`" scripts/gateway/main.ts   (cwd = $RepoRoot)"
  "  listens     : 127.0.0.1:$Port only; upstream $Upstream; public origin $PublicOrigin; UI $UiDir"
  "  data        : $DataDir\gateway (sessions, control, audit, key file)"
  "  probe       : $health every ${ProbeIntervalSeconds}s; restart after $MaxProbeFailures failures; 503 = kill switch (kept running)"
  "  logs        : $logFile, $(Join-Path $LogDir 'gateway-stdout.log'), $(Join-Path $LogDir 'gateway-stderr.log')"
  foreach ($p in $problems) { "  PROBLEM     : $p" }
  if ($problems.Count) { exit 5 } else { exit 0 }
}
if ($problems.Count) { foreach ($p in $problems) { Log "bad parameters: $p" }; exit 5 }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$mutex = Get-MuMutex -Name $mutexName
if (-not $mutex) { Log "another supervisor already holds $mutexName; exiting"; exit 0 }
if (Test-MuPortInUse -Port $Port) { Log "REFUSING TO START: port $Port is in use by $(Get-MuPortOwner -Port $Port)"; exit 3 }

$env:MU_DATA_DIR = $DataDir; $env:MU_GATEWAY_PORT = [string]$Port; $env:MU_GATEWAY_UPSTREAM = $Upstream
$env:MU_GATEWAY_PUBLIC_ORIGIN = $PublicOrigin; $env:MU_GATEWAY_UI_DIR = $UiDir
# Funnel's X-Forwarded-For is UNVERIFIED: not trusted (sign-in relies on the per-code limit). Turn on only once verified.
$env:MU_GATEWAY_FORWARDED_FOR = '0'
$stdout = Join-Path $LogDir 'gateway-stdout.log'; $stderr = Join-Path $LogDir 'gateway-stderr.log'
$script:gw = $null
$failures = New-Object System.Collections.Generic.List[datetime]
$consecutive = 0
Log "gateway supervisor started (pid $PID, port $Port, upstream $Upstream)"
try {
  while ($true) {
    foreach ($f in @($stdout, $stderr)) { Invoke-MuLogRotation -Path $f -MaxBytes 10MB -Keep 3 }
    $script:gw = Start-Process -FilePath $BunPath -ArgumentList 'scripts/gateway/main.ts' -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $script:gw.Handle
    $started = Get-Date; $reason = $null; $up = $false
    while (((Get-Date) - $started).TotalSeconds -lt $BootWaitSeconds) {
      Start-Sleep -Seconds 1
      if ($script:gw.HasExited) { $reason = "gateway exited during boot (code $($script:gw.ExitCode))"; break }
      if ((Test-MuHttp -Url $health -TimeoutSeconds $ProbeTimeoutSeconds).Answered) { $up = $true; break }
    }
    if ($up) {
      Log "gateway up on $Port (pid $($script:gw.Id))"
      $fails = 0
      while ($true) {
        Start-Sleep -Seconds $ProbeIntervalSeconds
        if ($script:gw.HasExited) { $reason = "gateway exited (code $($script:gw.ExitCode))"; break }
        $r = Test-MuHttp -Url $health -TimeoutSeconds $ProbeTimeoutSeconds
        if ($r.Answered) { $fails = 0; if ($r.Status -eq 503) { Log 'kill switch is on (503); keeping the gateway up and refusing' } }
        else { $fails++; Log "/gw/health did not answer ($fails of $MaxProbeFailures)"; if ($fails -ge $MaxProbeFailures) { $reason = 'gateway unresponsive'; break } }
      }
    } elseif (-not $reason) { $reason = "gateway did not answer within ${BootWaitSeconds}s" }
    Log "FAILURE: $reason"
    if ($script:gw -and -not $script:gw.HasExited) { Stop-MuProcessTree -ProcessId $script:gw.Id }
    $consecutive++; $failures.Add((Get-Date))
    if (Test-MuGiveUp -Times $failures.ToArray() -Max $MaxFailures -WindowSeconds ($FailureWindowMinutes * 60)) { Log "GIVING UP after $MaxFailures failures in $FailureWindowMinutes min"; exit 2 }
    $delay = Get-MuBackoffSeconds -Attempt $consecutive -Schedule $BackoffSchedule
    Log "restarting in ${delay}s"; Start-Sleep -Seconds $delay
  }
} finally {
  if ($script:gw -and -not $script:gw.HasExited) { Stop-MuProcessTree -ProcessId $script:gw.Id }
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
}
