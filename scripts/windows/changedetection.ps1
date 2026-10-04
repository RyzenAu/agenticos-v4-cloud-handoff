# Start changedetection.io (pip install, no Docker) as the prospect-monitoring feed for the
# M&U lead engine: loopback only, API-key auth already enabled by its own default. Watches are
# managed through scripts/leads/watch.ts, not this launcher.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\changedetection.ps1          start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\changedetection.ps1 -Stop    stop
#
# Runs from its own venv (~\.venvs\changedetection, created by `python -m venv`), datastore at
# ~\.changedetection. Safe to run repeatedly.
param([switch]$Stop)

$exe = Join-Path $env:USERPROFILE '.venvs\changedetection\Scripts\changedetection.io.exe'
$datastore = Join-Path $env:USERPROFILE '.changedetection'
$log = Join-Path $datastore 'service.log'

function Listener { Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }

if ($Stop) {
  $l = Listener
  if ($l) { taskkill /PID $l.OwningProcess /T /F | Out-Null; 'changedetection.io stopped' } else { 'changedetection.io was not running' }
  return
}
if (-not (Test-Path $exe)) { throw "changedetection.io is missing at $exe - pip install changedetection.io into the venv first" }

$l = Listener
if ($l) {
  if ($l.LocalAddress -ne '127.0.0.1') { throw "Port 5000 is listening on $($l.LocalAddress), not loopback" }
  'changedetection.io already running on 127.0.0.1:5000'
  return
}
New-Item -ItemType Directory -Force -Path $datastore | Out-Null
Start-Process $exe -ArgumentList @('-d', "`"$datastore`"", '-h', '127.0.0.1', '-p', '5000') -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
foreach ($i in 1..30) { Start-Sleep 1; if (Listener) { 'changedetection.io running on 127.0.0.1:5000'; return } }
throw "changedetection.io did not start; see $log"
