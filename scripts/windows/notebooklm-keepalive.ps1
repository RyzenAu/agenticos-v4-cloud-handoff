# NotebookLM keepalive (25 Sep 2026). Google rotates __Secure-1PSIDTS, so an idle notebooklm-py
# profile goes stale after ~2 h. `notebooklm auth refresh` every 20 min keeps the saved cookie jar
# fresh. Skips the run if any other notebooklm command is active (parallel use killed sign-in once).
# Registered as the "NotebookLM keepalive" scheduled task, launched hidden via the .vbs beside it.
#
# The exit code is the truth (28 Sep; the .vbs passes it to Task Scheduler's "Last Run Result"):
#   0  refreshed, or skipped because another notebooklm command started in the last 10 minutes
#   the refresh's own code when it failed (e.g. 2: the saved sign-in has expired)
#   3  notebooklm-py isn't installed
#   4  the refresh didn't finish in 4 minutes: its process tree was stopped
#   5  another notebooklm command has been running for over 10 minutes, so nothing was refreshed
# Review T8 S-3: `auth refresh` had no timeout; the task's own limit killed wscript and orphaned
# notebooklm.exe, and every later run saw it as "busy" and reported success (0x0) while nothing
# refreshed. An earlier refresh left behind by this script is now stopped, not counted as busy.
$ErrorActionPreference = 'SilentlyContinue'
$exe = Join-Path $env:USERPROFILE '.notebooklm-venv\Scripts\notebooklm.exe'
$log = Join-Path $env:USERPROFILE '.notebooklm\keepalive.log'
# Tests may shorten the wait (a whole number of ms); the task never sets this.
$refreshTimeoutMs = if ($env:NOTEBOOKLM_KEEPALIVE_TIMEOUT_MS -match '^\d+$') { [int]$env:NOTEBOOKLM_KEEPALIVE_TIMEOUT_MS } else { 240000 }
$minutes = { param($name, $default) $v = [Environment]::GetEnvironmentVariable($name); if ($v -match '^\d+(\.\d+)?$') { [double]$v } else { $default } }
$busyLimit = (Get-Date).AddMinutes(-(& $minutes 'NOTEBOOKLM_KEEPALIVE_BUSY_MINUTES' 10))
$leftoverLimit = (Get-Date).AddMinutes(-(& $minutes 'NOTEBOOKLM_KEEPALIVE_LEFTOVER_MINUTES' 5))
function Write-KeepaliveLog($line) {
  New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
  Add-Content $log "$(Get-Date -Format s) $line"
  if ((Get-Item $log).Length -gt 200KB) { Get-Content $log -Tail 500 | Set-Content $log }
}
if (-not (Test-Path $exe)) { Write-KeepaliveLog "FAILED: $exe not found (reinstall notebooklm-py in ~\.notebooklm-venv)"; exit 3 }

$others = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*notebooklm*' -and $_.CommandLine -notlike '*keepalive*' })
# A refresh this script started earlier and never finished (orphaned when the task was stopped).
$leftover = @($others | Where-Object { $_.CommandLine -match 'auth\s+refresh' -and $_.CreationDate -lt $leftoverLimit })
foreach ($p in $leftover) {
  & taskkill.exe /PID $p.ProcessId /T /F 2>&1 | Out-Null
  Write-KeepaliveLog "stopped a stuck earlier refresh (pid $($p.ProcessId), started $('{0:HH:mm}' -f $p.CreationDate))"
}
$busy = @($others | Where-Object { $leftover.ProcessId -notcontains $_.ProcessId -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) })
if ($busy.Count) {
  $oldest = ($busy | Sort-Object CreationDate | Select-Object -First 1).CreationDate
  if ($oldest -lt $busyLimit) { Write-KeepaliveLog "FAILED: another notebooklm command has been running since $('{0:HH:mm}' -f $oldest), so nothing was refreshed"; exit 5 }
  Write-KeepaliveLog 'skipped (notebooklm busy)'; exit 0
}

$stamp = [Guid]::NewGuid().ToString('N')
$outFile = Join-Path $env:TEMP "notebooklm-keepalive-$stamp.out"
$errFile = Join-Path $env:TEMP "notebooklm-keepalive-$stamp.err"
$proc = Start-Process -FilePath $exe -ArgumentList '--quiet', 'auth', 'refresh' -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
if (-not $proc) { Write-KeepaliveLog "FAILED: couldn't start $exe"; exit 1 }
if (-not $proc.WaitForExit($refreshTimeoutMs)) {
  & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null
  Write-KeepaliveLog "FAILED exit=4 the refresh didn't finish in $($refreshTimeoutMs / 60000) minutes; stopped it"
  Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  exit 4
}
$proc.WaitForExit()
$code = $proc.ExitCode
if ($null -eq $code) { $code = 1 }
$detail = ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) + ' ' + (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)).Trim() -replace '\s+', ' '
Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
if ($code -eq 0) { Write-KeepaliveLog "exit=0 $detail" }
else { Write-KeepaliveLog "FAILED exit=$code $detail (the saved sign-in has probably expired: run ``notebooklm login`` in ~\.notebooklm-venv)" }
exit $code
