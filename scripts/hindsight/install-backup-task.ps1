# Install (or re-install) the nightly Hindsight backup as a SYSTEM scheduled task (M&U, 28 Sep 2026).
# NEEDS AN ELEVATED PowerShell (a normal account cannot register a task that runs as SYSTEM). Idempotent.
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\hindsight\service\install-backup-task.ps1
#
# 1. D:\hindsight-backups\{bin,pilot}: SYSTEM + Administrators full, Usman READ only (cannot change or
#    delete), explicit DENY for CodexSandboxUsers; inheritance from D:\ removed.
# 2. Copies the CURRENT backup.ps1 and the Postgres client tools into D:\hindsight-backups\bin, so SYSTEM
#    never runs anything Usman's account can modify.
# 3. Makes sure SYSTEM can read the app DB password file (the 28 Sep first run failed there).
# 4. Registers \MU\Hindsight nightly backup (SYSTEM, daily 03:30, runs when missed, 30 min limit).
# 5. Runs it once, WAITS for it to finish (up to 5 min) and prints OK or FAILED with the step and path.
#    It never throws after the task is registered; the result is also in D:\hindsight-install-backup.log.
$ErrorActionPreference = 'Stop'
$log = 'D:\hindsight-install-backup.log'
function Log($m) { $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $m; Write-Output $line; Add-Content -Path $log -Value $line -Encoding utf8 }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Log 'FAILED: run this from an elevated (Administrator) PowerShell.'; exit 1 }
$root = 'D:\hindsight-backups'
$owner = 'DESKTOP-D8QCTMG\Usman'
$taskPath = '\MU\'; $taskName = 'Hindsight nightly backup'
try {
  New-Item -ItemType Directory -Force "$root\bin", "$root\pilot" | Out-Null
  icacls $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${owner}:(OI)(CI)RX" /C /Q | Out-Null
  icacls $root /deny 'CodexSandboxUsers:(OI)(CI)F' /C /Q | Out-Null
  Copy-Item 'D:\hindsight\service\backup.ps1' "$root\bin\backup.ps1" -Force
  robocopy 'D:\hindsight\pgsql\18.1.0\bin' "$root\bin\pgsql" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  icacls $root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  icacls "$root\*" /reset /T /C /Q | Out-Null
  icacls 'D:\hindsight\service\secrets\pilot.db' /grant '*S-1-5-18:R' /C /Q | Out-Null
  $taskArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$root\bin\backup.ps1`" -Profile pilot -Port 5432 -PasswordFile D:\hindsight\service\secrets\pilot.db -OutDir $root\pilot -PgBin $root\bin\pgsql -KeepDays 14"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
  $trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Log "task registered: $taskPath$taskName (SYSTEM, daily 03:30)"
} catch {
  Log "FAILED during install: $($_.Exception.GetType().Name): $($_.Exception.Message)"
  exit 2
}
$statusFile = "$root\pilot\last-backup.json"
$before = if (Test-Path $statusFile) { (Get-Item $statusFile).LastWriteTime } else { [datetime]::MinValue }
Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
$deadline = (Get-Date).AddMinutes(5)
do {
  Start-Sleep 5
  $state = (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State
  $fresh = (Test-Path $statusFile) -and ((Get-Item $statusFile).LastWriteTime -gt $before)
} while ((Get-Date) -lt $deadline -and ($state -eq 'Running' -or -not $fresh))
$info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName
if (-not $fresh) { Log "FAILED: the backup did not report within 5 min (task state $state, last result $($info.LastTaskResult))"; exit 3 }
$s = Get-Content -Raw $statusFile | ConvertFrom-Json
if ($s.ok) { Log "OK: $($s.file), $($s.bytes) bytes, $($s.entries) entries (ran as $($s.ran_as))"; exit 0 }
Log "FAILED: $($s.note) at step '$($s.step)' path '$($s.path)' (ran as $($s.ran_as))"
exit 4
