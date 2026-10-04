<#
.SYNOPSIS
  Five-minute health check of the always-on hub computer: writes the facts, then raises alerts (R9 ops, 3 Oct 2026).

.DESCRIPTION
  Run by the "\MU\MU Health Check" scheduled task (at startup +3 min, then every 5 minutes; Install-MuHub.ps1 registers it).
    1. Gathers FACTS it can only see from Windows, all read-only and bounded:
         hub          http://127.0.0.1:<HubPort>/__version answers; the supervisor log says GIVING UP after its last start; task state
         Hindsight    8888 /health and the proxy 8878 /health; run\pilot\status.json state; the crash-loop lock; task state
         SearXNG      18888 /healthz        Hermes gateway  8642 /health
         WSL          wsl.exe -l --running lists the distro; the keep-alive task state
         staging      Dot's gateway 8096 and staging hub 8086 (report only: never alerts)
         backup       <LogDir>\last-backup.json: ok, verified, age
         disks        free GB and % on each -Drives letter
         sign-in      <DataDir>\devices.json opens and is a sign-in record (its contents are never printed or kept)
    2. Writes them to <DataDir>\ops\host-health.json (atomic). The hub reads that file for GET /__health and the System and Home pages.
    3. Runs  bun --no-env-file scripts\ops\host-alerts.ts evaluate  which decides what alerts (one alert per condition, a reminder every
       6 h, one "resolved"), sends one Telegram DM per run to the OWNER ONLY through the existing `hermes send` path (switch:
       bun scripts\ops\host-alerts.ts telegram on|off), and prints the events. This script writes each event to the Windows
       Application log, source "MU Hub" (4101 alert, 4102 reminder, 4103 resolved, 4199 the evaluator itself failed).
  Conditions and thresholds live in scripts\ops\host-health.ts: supervisor gave up (at once), hub down > 10 min, Hindsight down > 10 min
  (crash-loop lock at once), backup failed / not verified / older than 26 h, disk below 10% or 20 GB, sign-in records unreadable.
  It starts, stops and changes nothing. No env file is read and no environment value is printed.
  Exit codes: 0 ran (whatever it found), 4 bad parameters.

  -DryRun prints the facts and writes nothing (no file, no evaluator, no event).
  -NoAlerts writes the facts but skips step 3.   -NoTelegram runs step 3 with --no-send (Event Log only).
  -NoEventLog (tests) logs each would-be Event Log entry to mu-health-check.log instead of writing it.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = 'C:\mu-hub\AgenticOS-v4',
  [string]$BunPath = 'C:\mu-hub\bin\bun.exe',
  [string]$DataDir = 'C:\mu-hub\data\production',
  [string]$LogDir = 'C:\mu-hub\logs',
  [string]$OutFile = '',
  [int]$HubPort = 8081,
  [int]$HindsightPort = 8888,
  [int]$HindsightProxyPort = 8878,
  [string]$HindsightRunDir = 'D:\hindsight\service\run\pilot',
  [int]$SearxngPort = 18888,
  [int]$HermesPort = 8642,
  [int]$StagingGatewayPort = 8096,
  [int]$StagingHubPort = 8086,
  [string]$Distro = 'kali-linux',
  [string[]]$Drives = @('C:', 'D:'),
  [string]$EventSource = 'MU Hub',
  [int]$ProbeTimeoutSeconds = 5,
  [switch]$SkipWsl,
  [switch]$SkipTasks,
  # Probes that must not open devices.json (an operator's read-only check); the task never passes it.
  [switch]$SkipSessionStore,
  [switch]$NoAlerts,
  [switch]$NoTelegram,
  # Tests: log the would-be Event Log entry instead of writing it (a test must never register or fill a real event source).
  [switch]$NoEventLog,
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'mu-common.ps1')

$logFile = Join-Path $LogDir 'mu-health-check.log'
function Log([string]$m) { if (-not $DryRun) { Write-MuLog -Path $logFile -Message $m } else { Write-Host $m } }
if (-not $OutFile) { $OutFile = Join-Path (Join-Path $DataDir 'ops') 'host-health.json' }
# powershell -File passes 'C:,D:' as one string.
$Drives = @($Drives | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { Log "bad parameters: DataDir not found: $DataDir"; exit 4 }

# ---------------------------------------------------------------- helpers (all read-only)

function Test-Answer([int]$Port, [string]$Path, [switch]$Need2xx) {
  $r = Test-MuHttp -Url "http://127.0.0.1:$Port$Path" -TimeoutSeconds $ProbeTimeoutSeconds
  if ($Need2xx) { return [bool]($r.Answered -and $r.Status -ge 200 -and $r.Status -lt 400) }
  return [bool]$r.Answered
}

function Get-TaskStateText([string]$TaskPath, [string]$TaskName) {
  if ($SkipTasks) { return $null }
  try {
    $t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction Stop
    $i = $t | Get-ScheduledTaskInfo -ErrorAction Stop
    return ('{0}, last result 0x{1:X}' -f $t.State, $i.LastTaskResult)
  } catch { return 'not registered' }
}

# True when the supervisor log's last start is followed by a GIVING UP line. Returns @{ gaveUp; at }.
function Get-GaveUp([string]$Path) {
  $res = @{ gaveUp = $false; at = $null }
  if (-not (Test-Path -LiteralPath $Path)) { return $res }
  try {
    $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite,Delete')
    try { $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
  } catch { return $res }
  $lines = @($text -split "`r?`n")
  $lastStart = -1
  for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -match 'supervisor started') { $lastStart = $i; break } }
  for ($i = [Math]::Max(0, $lastStart); $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'GIVING UP') { $res.gaveUp = $true; if ($lines[$i].Length -ge 19) { $res.at = $lines[$i].Substring(0, 19) } }
  }
  return $res
}

function Read-JsonFile([string]$Path) {
  try {
    $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite,Delete')
    try { $text = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return ($text | ConvertFrom-Json -ErrorAction Stop)
  } catch { return $null }
}

function Write-HostEvent([int]$Id, [string]$Type, [string]$Message) {
  if ($DryRun) { Write-Host "event $Id ($Type): $Message"; return $true }
  if ($NoEventLog) { Log "event $Id ($Type) not written (-NoEventLog): $Message"; return $true }
  try {
    [Diagnostics.EventLog]::WriteEntry($EventSource, $Message, [Diagnostics.EventLogEntryType]$Type, $Id)
    return $true
  } catch {
    Log "could not write to the Event Log as '$EventSource' ($($_.Exception.GetType().Name)); register it by re-running Install-MuHub.ps1 elevated"
    return $false
  }
}

# ---------------------------------------------------------------- facts

$now = Get-Date
$boot = $null
try { $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToString('o') } catch { }

$gave = Get-GaveUp (Join-Path $LogDir 'mu-hub-supervisor.log')
$hub = [ordered]@{
  answering      = (Test-Answer $HubPort '/__version')
  port           = $HubPort
  gaveUp         = [bool]$gave.gaveUp
  gaveUpAt       = $gave.at
  supervisorTask = (Get-TaskStateText '\MU\' 'MU Hub Supervisor')
}

$hsState = $null
$st = Read-JsonFile (Join-Path $HindsightRunDir 'status.json')
if ($st -and ($st.PSObject.Properties.Name -contains 'state')) { $hsState = [string]$st.state }
$hindsight = [ordered]@{
  answering      = (Test-Answer $HindsightPort '/health' -Need2xx)
  proxyAnswering = (Test-Answer $HindsightProxyPort '/health' -Need2xx)
  state          = $hsState
  crashloopLock  = (Test-Path -LiteralPath (Join-Path $HindsightRunDir 'crashloop.lock'))
  supervisorTask = (Get-TaskStateText '\Hindsight\' 'Hindsight pilot supervisor')
}

$wslRunning = $null
if (-not $SkipWsl) {
  $wslExe = Join-Path $env:SystemRoot 'System32\wsl.exe'
  if (Test-Path -LiteralPath $wslExe) {
    $w = Invoke-MuProcess -FilePath $wslExe -ArgumentList @('-l', '--running', '-q') -TimeoutSeconds 20
    if (-not $w.TimedOut) {
      $names = @((($w.Stdout -replace "`0", '') -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $wslRunning = [bool]($names -contains $Distro)
    }
  }
}

$backup = [ordered]@{ present = $false; ok = $false; verified = $false; time = $null; ageHours = $null; error = $null }
$lb = Read-JsonFile (Join-Path $LogDir 'last-backup.json')
if ($lb) {
  $backup.present = $true
  $backup.ok = [bool]$lb.ok
  $backup.verified = [bool]$lb.verified
  if ($lb.error) { $e = [string]$lb.error; if ($e.Length -gt 200) { $e = $e.Substring(0, 200) }; $backup.error = $e }
  try {
    $t = [datetime]::Parse([string]$lb.time, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    $backup.time = $t.ToString('o')
    $backup.ageHours = [Math]::Round(($now - $t.ToLocalTime()).TotalHours, 2)
  } catch { $backup.time = [string]$lb.time }
}

$disks = @()
foreach ($d in $Drives) {
  $letter = $d.TrimEnd(':', '\') + ':'
  try {
    $ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$letter'" -ErrorAction Stop
    if ($ld -and $ld.Size -gt 0) {
      $disks += [ordered]@{ drive = $letter; freeGb = [Math]::Round($ld.FreeSpace / 1e9, 1); sizeGb = [Math]::Round($ld.Size / 1e9, 1); freePct = [Math]::Round(100 * $ld.FreeSpace / $ld.Size, 1) }
    }
  } catch { }
}

$ssp = $null
$sspChecked = -not $SkipSessionStore
if ($sspChecked) { $ssp = Get-MuSessionStoreProblem -DataDir $DataDir }

$facts = [ordered]@{
  hub          = $hub
  hindsight    = $hindsight
  searxng      = [ordered]@{ answering = (Test-Answer $SearxngPort '/healthz' -Need2xx) }
  hermes       = [ordered]@{ answering = (Test-Answer $HermesPort '/health' -Need2xx) }
  wsl          = [ordered]@{ running = $wslRunning; keepAliveTask = (Get-TaskStateText '\MU\' 'MU WSL KeepAlive') }
  staging      = [ordered]@{ gateway = (Test-Answer $StagingGatewayPort '/'); hub = (Test-Answer $StagingHubPort '/__version') }
  backup       = $backup
  disks        = $disks
  sessionStore = $(if ($sspChecked) { [ordered]@{ readable = (-not $ssp); problem = $ssp } } else { $null })
}
$report = [ordered]@{ version = 1; checkedAt = $now.ToString('o'); host = $env:COMPUTERNAME; bootedAt = $boot; facts = $facts }
$json = $report | ConvertTo-Json -Depth 6

if ($DryRun) {
  "DRY RUN (nothing written, no alert evaluated). Would write $OutFile :"
  $json
  exit 0
}

# ---------------------------------------------------------------- write the report (atomic)
try {
  $dir = Split-Path -Parent $OutFile
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$OutFile.tmp-$PID"
  [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $OutFile -Force
} catch {
  Log "could not write $OutFile : $($_.Exception.Message)"
}

if ($NoAlerts) { exit 0 }

# ---------------------------------------------------------------- alerts
$failMarker = Join-Path $LogDir 'mu-health-check.evaluator-failed'
$cliArgs = @('--no-env-file', 'scripts/ops/host-alerts.ts', 'evaluate', '--data-dir', $DataDir, '--host', $env:COMPUTERNAME)
if ($NoTelegram) { $cliArgs += '--no-send' }
$env:MU_DATA_DIR = $DataDir   # ownerTelegram() finds people.json through MU_DATA_DIR
$result = $null
$why = ''
if ((Test-Path -LiteralPath $BunPath -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $RepoRoot 'scripts\ops\host-alerts.ts'))) {
  $r = Invoke-MuProcess -FilePath $BunPath -ArgumentList $cliArgs -WorkingDirectory $RepoRoot -TimeoutSeconds 120
  $lastLine = @(($r.Stdout -split "`r?`n") | Where-Object { $_.Trim().StartsWith('{') }) | Select-Object -Last 1
  if ($lastLine) { try { $result = $lastLine | ConvertFrom-Json -ErrorAction Stop } catch { } }
  if (-not $result -or -not $result.ok) {
    $why = (($r.Stderr + ' ' + $(if ($result) { $result.reason } else { '' })) -replace '\s+', ' ').Trim()
    if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }
    $why = "exit $($r.ExitCode), timed out $($r.TimedOut): $why"
  }
} else { $why = "bun or scripts\ops\host-alerts.ts not found under $RepoRoot" }

if (-not $result -or -not $result.ok) {
  Log "alert evaluator failed: $why"
  # At most one Event Log entry per 6 h for this, so a broken evaluator does not write one every 5 minutes.
  $last = if (Test-Path -LiteralPath $failMarker) { (Get-Item -LiteralPath $failMarker).LastWriteTime } else { [datetime]::MinValue }
  if (($now - $last).TotalHours -ge 6) {
    [void](Write-HostEvent 4199 'Warning' "MU hub health check: the alert evaluator failed, so alerts are not being raised. $why")
    [IO.File]::WriteAllText($failMarker, $now.ToString('o'))
  }
  exit 0
}
if (Test-Path -LiteralPath $failMarker) { Remove-Item -LiteralPath $failMarker -Force -ErrorAction SilentlyContinue }

foreach ($e in @($result.events)) {
  if (-not $e) { continue }
  switch ([string]$e.kind) {
    'alert'    { $id = 4101; $type = 'Error'; $head = 'ALERT' }
    'reminder' { $id = 4102; $type = 'Warning'; $head = 'STILL' }
    default    { $id = 4103; $type = 'Information'; $head = 'RESOLVED' }
  }
  $msg = "MU hub ($env:COMPUTERNAME) $head [$($e.id)]: $($e.title). $($e.detail)"
  if ($e.recovery) { $msg += " Fix: $($e.recovery)" }
  [void](Write-HostEvent $id $type $msg)
  Log "$head [$($e.id)] $($e.title) (telegram: $($result.telegram))"
}
exit 0
