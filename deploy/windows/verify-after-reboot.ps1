<#
.SYNOPSIS
  Read-only check that the hub computer came back by itself after a reboot (R9 ops, 3 Oct 2026).

.DESCRIPTION
  Two modes, both read-only apart from the one baseline file:
    -Snapshot   BEFORE the reboot: records what must survive (hub commit, sign-in session count, devices-secret size and date, Hindsight
                writes switch, newest backups) in -BaselineFile. Nothing else is written.
    (default)   AFTER the reboot (wait about 5 minutes for every boot task to have fired): checks each item below and compares with the
                baseline when there is one. Prints PASS / FAIL / INFO lines; the exit code is the number of FAILs.

  Checks:
    tasks      each boot task ran after this boot (LastRunTime >= boot), the long-running ones are Running, and their processes started
               after the boot under Task Scheduler (parent svchost), i.e. not by hand
    ports      hub 8081 /__version, Hindsight 8888 /health and proxy 8878 /health (200), Postgres 5432 listening, SearXNG 18888 /healthz,
               Hermes 8642 /health; Dot's staging 8096 / 8086 reported only
    version    the hub's /__version over the tailnet (gitSha) against the checkout's HEAD and the baseline
    Hindsight  run\pilot\status.json says running, no crash-loop lock, the writes switch as before
    backups    last-backup.json ok + verified + younger than 26 h; newest Hindsight dump younger than 26 h
    sessions   number of sign-in sessions in devices.json (a COUNT only; nothing from the file is printed) against the baseline;
               devices-secret size and date unchanged (never opened)
    health     the 5-minute health check has written its report since the boot; any active alert is listed
  It never starts, stops, restarts or registers anything, never reads an env file and never prints an environment value.
#>
[CmdletBinding()]
param(
  [switch]$Snapshot,
  [string]$BaselineFile = 'C:\mu-hub\ops-check\pre-reboot-baseline.json',
  [string]$RepoRoot = 'C:\mu-hub\AgenticOS-v4',
  [string]$DataDir = 'C:\mu-hub\data\production',
  [string]$LogDir = 'C:\mu-hub\logs',
  [string]$BackupDir = 'D:\mu-hub-backups\production',
  [string]$HindsightRunDir = 'D:\hindsight\service\run\pilot',
  [string]$HindsightBackupDir = 'D:\hindsight-backups\pilot',
  [string]$PublicVersionUrl = 'https://ryzen-pc.tailnet-name.ts.net:8443/__version',
  [int]$MaxBackupHours = 26,
  [switch]$SkipTasks
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'mu-common.ps1')

$script:fails = 0
function Pass([string]$m) { "PASS  $m" }
function Fail([string]$m) { $script:fails++; "FAIL  $m" }
function Info([string]$m) { "INFO  $m" }
function Check([bool]$ok, [string]$m) { if ($ok) { Pass $m } else { Fail $m } }

function Read-Shared([string]$Path) {
  $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite,Delete')
  try { $t = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Dispose() }
  if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  return $t
}
function Read-Json([string]$Path) { try { return (Read-Shared $Path | ConvertFrom-Json -ErrorAction Stop) } catch { return $null } }

# Sign-in sessions in devices.json: a count only. $null when absent or unreadable.
function Get-SessionCount {
  $p = Join-Path $DataDir 'devices.json'
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  $o = Read-Json $p
  if ($o -and ($o.PSObject.Properties.Name -contains 'sessions') -and ($o.sessions -is [array])) { return @($o.sessions).Count }
  return $null
}
function Get-FileStamp([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $i = Get-Item -LiteralPath $Path
  return "$($i.Length) bytes, $($i.LastWriteTimeUtc.ToString('o'))"
}
function Get-HeadShort { $h = & git --no-optional-locks -C $RepoRoot rev-parse --short=7 HEAD 2>$null; if ($LASTEXITCODE -eq 0) { return [string]$h } else { return $null } }
function Get-PublicSha {
  try {
    $req = [Net.HttpWebRequest]::Create($PublicVersionUrl); $req.Timeout = 10000; $req.ReadWriteTimeout = 10000; $req.Proxy = $null
    $resp = $req.GetResponse(); $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $body = $sr.ReadToEnd(); $resp.Close()
    $j = $body | ConvertFrom-Json -ErrorAction Stop
    if ($j.PSObject.Properties.Name -contains 'gitSha') { return [string]$j.gitSha }
    return $null
  } catch { return $null }
}
function Get-NewestDir([string]$Dir) { Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
function Get-NewestFile([string]$Dir, [string]$Filter) { Get-ChildItem -LiteralPath $Dir -File -Filter $Filter -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }

# ---------------------------------------------------------------- snapshot (before the reboot)
if ($Snapshot) {
  $writes = Test-Path -LiteralPath (Join-Path $HindsightRunDir 'WRITES_ENABLED')
  $nb = Get-NewestDir $BackupDir
  $nh = Get-NewestFile $HindsightBackupDir '*.dump'
  $base = [ordered]@{
    takenAt          = (Get-Date).ToString('o')
    host             = $env:COMPUTERNAME
    bootedAt         = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
    headShort        = (Get-HeadShort)
    publicGitSha     = (Get-PublicSha)
    sessions         = (Get-SessionCount)
    devicesSecret    = (Get-FileStamp (Join-Path $DataDir 'devices-secret'))
    hindsightWrites  = $writes
    newestBackup     = $(if ($nb) { $nb.Name } else { $null })
    newestHindsight  = $(if ($nh) { $nh.Name } else { $null })
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $BaselineFile) | Out-Null
  [IO.File]::WriteAllText($BaselineFile, ($base | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  "Baseline written to $BaselineFile (counts, sizes, dates and the commit only):"
  $base.GetEnumerator() | ForEach-Object { "  $($_.Key) = $($_.Value)" }
  exit 0
}

# ---------------------------------------------------------------- after the reboot
$baseline = if (Test-Path -LiteralPath $BaselineFile) { Read-Json $BaselineFile } else { $null }
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$now = Get-Date
Info ("booted {0:yyyy-MM-dd HH:mm:ss}, up {1:N1} min{2}" -f $boot, ($now - $boot).TotalMinutes, $(if ($baseline) { "; baseline from $($baseline.takenAt)" } else { '; no baseline file (run -Snapshot before the next reboot)' }))
if ($baseline -and $baseline.bootedAt) {
  $prevBoot = [datetime]::Parse([string]$baseline.bootedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  Check ($boot -gt $prevBoot.ToLocalTime().AddSeconds(5)) "the machine has rebooted since the baseline (previous boot $($prevBoot.ToLocalTime().ToString('s')))"
}
if (($now - $boot).TotalMinutes -lt 4) { Info 'less than 4 minutes since boot: the health check (+3 min) and SearXNG (+1 min) may not have fired yet; run again shortly' }

''
'-- scheduled tasks'
# name, must be Running now, must have run since boot
$tasks = @(
  @('\MU\', 'MU Hub Supervisor', $true, $true),
  @('\MU\', 'MU WSL KeepAlive', $true, $true),
  @('\MU\', 'MU SearXNG', $true, $true),
  @('\MU\', 'MU Hermes Gateway', $false, $true),
  @('\MU\', 'MU Vault Autocommit', $false, $true),
  @('\MU\', 'MU Health Check', $false, $true),
  @('\Hindsight\', 'Hindsight pilot supervisor', $true, $true),
  @('\MU\', 'MU Hub Backup', $false, $false),
  @('\Hindsight\', 'Hindsight nightly backup', $false, $false)
)
if (-not $SkipTasks) {
  foreach ($t in $tasks) {
    $full = "$($t[0])$($t[1])"
    $task = Get-ScheduledTask -TaskPath $t[0] -TaskName $t[1] -ErrorAction SilentlyContinue
    if (-not $task) { if ($t[3]) { Fail "$full is not registered" } else { Info "$full is not registered" }; continue }
    $i = $task | Get-ScheduledTaskInfo
    $line = '{0}: state {1}, last run {2:yyyy-MM-dd HH:mm:ss}, result 0x{3:X}' -f $full, $task.State, $i.LastRunTime, $i.LastTaskResult
    if (-not $t[3]) { Info "$line, next run $($i.NextRunTime)"; continue }
    $ranSinceBoot = $i.LastRunTime -ge $boot.AddSeconds(-5)
    if ($t[2]) { Check ($ranSinceBoot -and $task.State -eq 'Running') "$line (must be Running and started after boot)" }
    else { Check ($ranSinceBoot -and ($i.LastTaskResult -eq 0 -or $i.LastTaskResult -eq 0x41301)) "$line (must have run since boot, result 0)" }
  }
}

''
'-- processes came from Task Scheduler after the boot'
$procs = @(Get-CimInstance Win32_Process)
# The outermost matching process (a venv python.exe is a launcher whose child has the same command line).
function Find-Proc([string]$Pattern) {
  $m = @($procs | Where-Object { [string]$_.CommandLine -match $Pattern })
  $ids = @($m | ForEach-Object { $_.ProcessId })
  @($m | Where-Object { $ids -notcontains $_.ParentProcessId } | Sort-Object CreationDate | Select-Object -First 1)
}
function Parent-Name($p) { $pp = $procs | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1; if ($pp) { return "$($pp.Name)" } else { return 'gone' } }
foreach ($pair in @(@('hub supervisor', 'mu-hub-supervisor\.ps1'), @('Hindsight supervisor', 'supervisor\.py"? run --profile pilot'))) {
  $p = Find-Proc $pair[1]
  if (-not $p) { Fail "$($pair[0]): no process"; continue }
  $p = $p[0]
  $parent = Parent-Name $p
  Check (($p.CreationDate -ge $boot) -and ($parent -match '^svchost')) ("{0}: pid {1} started {2:HH:mm:ss}, parent {3} (Task Scheduler = svchost)" -f $pair[0], $p.ProcessId, $p.CreationDate, $parent)
}

''
'-- ports'
function Probe([int]$Port, [string]$Path, [bool]$Need2xx, [string]$Name, [bool]$ReportOnly = $false) {
  $r = Test-MuHttp -Url "http://127.0.0.1:$Port$Path" -TimeoutSeconds 8
  $ok = $r.Answered -and ((-not $Need2xx) -or ($r.Status -ge 200 -and $r.Status -lt 400))
  $m = "$Name http://127.0.0.1:$Port$Path -> $(if ($r.Answered) { $r.Status } else { 'no answer' })"
  if ($ReportOnly) { Info "$m (report only)" } else { Check $ok $m }
}
Probe 8081 '/__version' $false 'hub'
Probe 8888 '/health' $true 'Hindsight API'
Probe 8878 '/health' $true 'Hindsight proxy'
Check (Test-MuPortInUse -Port 5432) 'Postgres listening on 5432'
Probe 18888 '/healthz' $true 'SearXNG'
Probe 8642 '/health' $true 'Hermes gateway'
Probe 8096 '/' $false "Dot's staging gateway" $true
Probe 8086 '/__version' $false "Dot's staging hub" $true

''
'-- hub version'
$head = Get-HeadShort
$sha = Get-PublicSha
Check ([bool]$sha) "tailnet /__version answers with a gitSha ($sha)"
if ($sha -and $head) { Check ($head.StartsWith($sha) -or $sha.StartsWith($head)) "serving commit $sha = checkout HEAD $head" }
if ($baseline -and $baseline.publicGitSha -and $sha) { Check ($sha -eq [string]$baseline.publicGitSha) "same commit as before the reboot ($($baseline.publicGitSha))" }

''
'-- Hindsight'
$st = Read-Json (Join-Path $HindsightRunDir 'status.json')
Check ($st -and [string]$st.state -eq 'running') "status.json state: $(if ($st) { $st.state } else { 'unreadable' })"
Check (-not (Test-Path -LiteralPath (Join-Path $HindsightRunDir 'crashloop.lock'))) 'no crash-loop lock'
$writes = Test-Path -LiteralPath (Join-Path $HindsightRunDir 'WRITES_ENABLED')
if ($baseline -and $null -ne $baseline.hindsightWrites) { Check ($writes -eq [bool]$baseline.hindsightWrites) "memory writes switch unchanged ($writes)" } else { Info "memory writes switch: $writes" }

''
'-- backups'
$lb = Read-Json (Join-Path $LogDir 'last-backup.json')
if ($lb) {
  $age = $null
  try { $age = ($now - [datetime]::Parse([string]$lb.time, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()).TotalHours } catch { }
  Check ([bool]$lb.ok -and [bool]$lb.verified -and $null -ne $age -and $age -le $MaxBackupHours) ("last hub backup: ok {0}, verified {1}, {2:N1} h old, {3}" -f $lb.ok, $lb.verified, $age, $lb.path)
} else { Fail "no readable $LogDir\last-backup.json" }
$nh = Get-NewestFile $HindsightBackupDir '*.dump'
if ($nh) { Check ((($now - $nh.LastWriteTime).TotalHours) -le $MaxBackupHours) ("newest Hindsight dump {0}, {1:N1} h old" -f $nh.Name, ($now - $nh.LastWriteTime).TotalHours) } else { Fail "no Hindsight dump in $HindsightBackupDir" }

''
'-- sign-in sessions (a count only)'
$count = Get-SessionCount
$secret = Get-FileStamp (Join-Path $DataDir 'devices-secret')
if ($null -eq $count) { Fail 'devices.json is absent or not readable as a sign-in record' }
elseif ($baseline -and $null -ne $baseline.sessions) {
  # Sessions can expire (30 days) or be removed by a person between the snapshot and now; losing all of them is the failure that matters.
  Check (-not ([int]$baseline.sessions -gt 0 -and $count -eq 0)) "sessions now $count, before the reboot $($baseline.sessions)"
  if ($count -lt [int]$baseline.sessions) { Info 'fewer sessions than before: expected only if some expired or were signed out in between' }
} else { Info "sessions now: $count" }
if ($baseline -and $baseline.devicesSecret) { Check ($secret -eq [string]$baseline.devicesSecret) "devices-secret unchanged ($secret)" } else { Info "devices-secret: $secret" }

''
'-- health check and alerts'
$hh = Read-Json (Join-Path $DataDir 'ops\host-health.json')
if ($hh) {
  $at = [datetime]::Parse([string]$hh.checkedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
  Check ($at -ge $boot) "health check report written since the boot ($($at.ToString('HH:mm:ss')))"
} else { Fail 'no health check report (ops\host-health.json): is \MU\MU Health Check installed?' }
$ha = Read-Json (Join-Path $DataDir 'ops\host-alerts.json')
$active = @()
if ($ha -and $ha.conditions) { foreach ($pr in $ha.conditions.PSObject.Properties) { if ($pr.Value.alertedAt) { $active += "$($pr.Name): $($pr.Value.title)" } } }
if ($active.Count) { foreach ($a in $active) { Info "active alert: $a" } } else { Info 'no active host alert' }
try {
  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'MU Hub'; StartTime = $boot } -ErrorAction Stop)
  Info "Event Log 'MU Hub' entries since boot: $($ev.Count)"
} catch { Info "Event Log 'MU Hub' entries since boot: 0 (or the source is not registered)" }

''
'-- disks'
foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) { Info ("{0} {1:N1} GB free of {2:N1} GB ({3:N0}%)" -f $d.DeviceID, ($d.FreeSpace / 1e9), ($d.Size / 1e9), (100 * $d.FreeSpace / $d.Size)) }

''
"failed: $script:fails"
exit $script:fails
