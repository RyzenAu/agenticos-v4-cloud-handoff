# Compatibility shim (28 Sep 2026). Startup\Hindsight.vbs and older notes call
#   powershell -File D:\hindsight\service\hindsight.ps1 [start]    and    hindsight.ps1 -Stop
# Both now go through the supervisor (supervisor.py), which runs Hindsight on 127.0.0.1 with
# API-key auth, restarts it with a bounded backoff, and stops the API before Postgres.
# The old direct launcher (unauthenticated, logs overwritten, no restart) is in
# D:\hindsight\_backups\<timestamp>\service\hindsight.ps1.
param([Parameter(Position = 0)][ValidateSet('start', 'stop', 'status')][string]$Action = 'start',
      [switch]$Stop, [string]$Profile = 'pilot')
$svc = 'D:\hindsight\service'
$py  = 'D:\hindsight\venv\Scripts\python.exe'
if ($Action -eq 'status') {
  & $py (Join-Path $svc 'supervisor.py') status --profile $Profile
  return
}
if ($Stop -or $Action -eq 'stop') {
  & $py (Join-Path $svc 'supervisor.py') stop --profile $Profile
  return
}
# wscript + the .vbs gives the supervisor a hidden console of its own (needed for CTRL_BREAK).
Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$(Join-Path $svc 'hindsight.vbs')`"", $Profile) -WindowStyle Hidden
"Hindsight supervisor launch requested (profile $Profile). Status: $py $svc\supervisor.py status --profile $Profile"
