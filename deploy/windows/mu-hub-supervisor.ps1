<#
.SYNOPSIS
  Runs the AgenticOS hub on an always-on Windows host and restarts it when it dies or hangs, with bounded backoff.

.DESCRIPTION
  Meant to be started by the "\MU\MU Hub Supervisor" scheduled task at boot (no interactive logon needed), but it
  works the same from a console. Behaviour, in order:
    1. Checks the repo and bun exist; takes the named mutex Global\MuHubSupervisor-<port> (a second copy exits 0).
    2. Refuses to start (exit 3) if anything already listens on the port.
    3. Loads KEY=VALUE lines from -EnvFile into this process's environment (values are never printed or logged),
       then sets MU_HUB_ROLE=pc, MU_DATA_DIR and BROWSER=none (these three always win over the file).
    4. Starts the hub hidden: bun --bun run dev --port <port> --strictPort --host 127.0.0.1
       (the repo's `dev` script runs `seed:data` first, exactly like the existing scripts\windows supervisor, then vite).
    5. Waits for /__version to answer, then probes it every -ProbeIntervalSeconds. A dead process, or
       -MaxProbeFailures failed probes in a row, kills the hub's process tree and restarts it after a backoff
       (default 2, 5, 15, 60 s, then 60 s). The failure count resets after the hub has stayed healthy for -StableSeconds.
    6. Gives up (exit 2, with a line saying so) after -MaxFailures failures inside -FailureWindowMinutes, instead of looping hot.
  Exit codes: 0 stopped or another copy runs, 2 gave up, 3 port in use, 5 bad parameters.

  -DryRun (alias -Once) prints the plan with every value redacted and exits without starting anything.

.PARAMETER RepoRoot   Checkout of AgenticOS-v4 (C:\mu-hub\AgenticOS-v4 on the Ryzen-PC).
.PARAMETER BunPath    bun.exe (C:\mu-hub\bin\bun.exe).
.PARAMETER DataDir    MU_DATA_DIR for the hub (C:\mu-hub\data\production).
.PARAMETER LogDir     Where mu-hub-supervisor.log, hub-stdout.log and hub-stderr.log go.
.PARAMETER EnvFile    Optional KEY=VALUE file (secrets live here; it is read, never echoed).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\mu-hub-supervisor.ps1 -RepoRoot C:\mu-hub\AgenticOS-v4 -BunPath C:\mu-hub\bin\bun.exe -DataDir C:\mu-hub\data\production -LogDir C:\mu-hub\logs -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepoRoot,
  [Parameter(Mandatory)][string]$BunPath,
  [int]$Port = 8081,
  [Parameter(Mandatory)][string]$DataDir,
  [Parameter(Mandatory)][string]$LogDir,
  [string]$EnvFile = '',
  [string]$HubRole = 'pc',
  [int]$ProbeIntervalSeconds = 15,
  [int]$ProbeTimeoutSeconds = 10,
  [int]$MaxProbeFailures = 5,
  [int]$BootWaitSeconds = 180,
  [int]$StableSeconds = 300,
  [int[]]$BackoffSchedule = @(2, 5, 15, 60),
  [int]$MaxFailures = 6,
  [int]$FailureWindowMinutes = 10,
  [Alias('Once')][switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'mu-common.ps1')

$logFile = Join-Path $LogDir 'mu-hub-supervisor.log'
function Log([string]$m) { Write-MuLog -Path $logFile -Message $m }

# The exact command (also used by the plan). `dev` = seed:data && vite dev; extra args reach vite.
$hubArgs = @('--bun', 'run', 'dev', '--port', "$Port", '--strictPort', '--host', '127.0.0.1')
$mutexName = "Global\MuHubSupervisor-$Port"
$versionUrl = "http://127.0.0.1:$Port/__version"

# ---- parameter checks
$problems = @()
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'package.json'))) { $problems += "RepoRoot has no package.json: $RepoRoot" }
if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { $problems += "BunPath not found: $BunPath" }
if ($EnvFile -and -not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { $problems += "EnvFile not found: $EnvFile" }
if ($Port -lt 1 -or $Port -gt 65535) { $problems += "Port out of range: $Port" }

# ---- plan (dry run)
if ($DryRun) {
  "PLAN (dry run, nothing is started)"
  "  repo        : $RepoRoot"
  "  bun         : $BunPath"
  "  command     : `"$BunPath`" $(ConvertTo-MuArgString $hubArgs)   (cwd = repo)"
  "  port        : $Port   (/__version probe every ${ProbeIntervalSeconds}s, timeout ${ProbeTimeoutSeconds}s, restart after $MaxProbeFailures failed probes)"
  "  environment : MU_HUB_ROLE=$HubRole, MU_DATA_DIR=$DataDir, BROWSER=none"
  if ($EnvFile -and (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    $keys = @((Read-MuEnvFile -Path $EnvFile).Keys)
    "  env file    : $EnvFile -> $($keys.Count) variable(s): $($keys -join ', ') (values redacted)"
  } else { "  env file    : (none)" }
  "  logs        : $logFile, $(Join-Path $LogDir 'hub-stdout.log'), $(Join-Path $LogDir 'hub-stderr.log')"
  "  mutex       : $mutexName"
  "  backoff     : $($BackoffSchedule -join ', ') s; give up after $MaxFailures failures in $FailureWindowMinutes min"
  if (Test-MuPortInUse -Port $Port) { "  port status : IN USE by $(Get-MuPortOwner -Port $Port) (a real run would refuse to start, exit 3)" } else { "  port status : free" }
  foreach ($p in $problems) { "  PROBLEM     : $p" }
  if ($problems.Count) { exit 5 }
  exit 0
}

if ($problems.Count) { foreach ($p in $problems) { Log "bad parameters: $p" }; exit 5 }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$mutex = Get-MuMutex -Name $mutexName
if (-not $mutex) { Log "another supervisor already holds $mutexName; exiting"; exit 0 }

if (Test-MuPortInUse -Port $Port) {
  Log "REFUSING TO START: port $Port is already in use by $(Get-MuPortOwner -Port $Port). Stop that process (or the old hub) first."
  exit 3
}

# ---- environment: file first, then the three the supervisor owns
if ($EnvFile) {
  $names = Set-MuEnvFromFile -Path $EnvFile
  Log "loaded $($names.Count) variable(s) from the env file (values not logged)"
}
$env:MU_HUB_ROLE = $HubRole
$env:MU_DATA_DIR = $DataDir
$env:BROWSER = 'none'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$stdout = Join-Path $LogDir 'hub-stdout.log'
$stderr = Join-Path $LogDir 'hub-stderr.log'
$script:hub = $null

function Start-Hub {
  foreach ($f in @($stdout, $stderr)) { Invoke-MuLogRotation -Path $f -MaxBytes 10MB -Keep 3 }
  $p = Start-Process -FilePath $BunPath -ArgumentList (ConvertTo-MuArgString $hubArgs) -WorkingDirectory $RepoRoot `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $null = $p.Handle   # keeps the handle so ExitCode is readable after exit
  return $p
}

function Stop-Hub {
  if ($script:hub) {
    if (-not $script:hub.HasExited) { Stop-MuProcessTree -ProcessId $script:hub.Id }
    # The port can take a moment to be released.
    for ($i = 0; $i -lt 20 -and (Test-MuPortInUse -Port $Port); $i++) { Start-Sleep -Seconds 1 }
  }
}

Log "supervisor started (pid $PID, repo $RepoRoot, port $Port, role $HubRole, bun $BunPath)"

$failureTimes = New-Object System.Collections.Generic.List[datetime]
$consecutive = 0
try {
  while ($true) {
    $reason = $null
    if (Test-MuPortInUse -Port $Port) {
      $reason = "port $Port still in use by $(Get-MuPortOwner -Port $Port) before start"
    } else {
      $script:hub = Start-Hub
      $startedAt = Get-Date
      Log "starting hub (pid $($script:hub.Id)): bun $(ConvertTo-MuArgString $hubArgs)"
      $up = $false
      while (((Get-Date) - $startedAt).TotalSeconds -lt $BootWaitSeconds) {
        Start-Sleep -Seconds 2
        if ($script:hub.HasExited) { $reason = "hub exited during boot (code $($script:hub.ExitCode))"; break }
        if ((Test-MuHttp -Url $versionUrl -TimeoutSeconds $ProbeTimeoutSeconds).Answered) { $up = $true; break }
      }
      if ($up) {
        $healthySince = Get-Date
        Log ("hub is up on port $Port after {0:N0}s (pid $($script:hub.Id))" -f ((Get-Date) - $startedAt).TotalSeconds)
        $probeFails = 0
        while ($true) {
          Start-Sleep -Seconds $ProbeIntervalSeconds
          if ($script:hub.HasExited) { $reason = "hub exited (code $($script:hub.ExitCode))"; break }
          if ((Test-MuHttp -Url $versionUrl -TimeoutSeconds $ProbeTimeoutSeconds).Answered) {
            if ($probeFails -gt 0) { Log "hub answering again after $probeFails failed probe(s)" }
            $probeFails = 0
            if ($consecutive -gt 0 -and ((Get-Date) - $healthySince).TotalSeconds -ge $StableSeconds) {
              Log "hub stable for ${StableSeconds}s; failure counter reset"
              $consecutive = 0
            }
          } else {
            $probeFails++
            Log "/__version did not answer ($probeFails of $MaxProbeFailures)"
            if ($probeFails -ge $MaxProbeFailures) { $reason = "hub unresponsive for $probeFails probes"; break }
          }
        }
      } elseif (-not $reason) {
        $reason = "hub did not answer /__version within ${BootWaitSeconds}s"
      }
    }

    # ---- a failure: tidy up, then back off or give up
    Log "FAILURE: $reason"
    Stop-Hub
    $consecutive++
    $failureTimes.Add((Get-Date))
    if (Test-MuGiveUp -Times $failureTimes.ToArray() -Max $MaxFailures -WindowSeconds ($FailureWindowMinutes * 60)) {
      Log "GIVING UP: $MaxFailures failures within $FailureWindowMinutes minutes. Not restarting again. Check $stderr and $stdout, fix the cause, then start the task again."
      exit 2
    }
    $delay = Get-MuBackoffSeconds -Attempt $consecutive -Schedule $BackoffSchedule
    Log "restarting in ${delay}s (consecutive failure $consecutive)"
    Start-Sleep -Seconds $delay
  }
} finally {
  # Normal stop (task ended, console closed): take the hub down with us so nothing is orphaned.
  if ($script:hub -and -not $script:hub.HasExited) { Stop-MuProcessTree -ProcessId $script:hub.Id }
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
}
