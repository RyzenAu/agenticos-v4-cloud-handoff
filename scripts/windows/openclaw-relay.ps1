# Start OpenClaw as Jarvis's device relay: gateway on 127.0.0.1:18789 only, token auth,
# no chat channels, no OpenClaw agent. Hermes drives paired devices through
# `openclaw nodes invoke` (skill: openclaw-nodes). Safe to run repeatedly.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\openclaw-relay.ps1          start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\openclaw-relay.ps1 -Stop    stop
#
# Uses a portable Node 24 (%USERPROFILE%\.openclaw-node\node24; not under AppData\Local, where the
# Claude desktop app's MSIX sandbox hides new folders from other programs): OpenClaw 2026.9.x needs
# Node >=24.16 <25, and the system Node 23.5 lacks node:sqlite StatementSync.columns().
param([switch]$Stop)

$node = Join-Path $env:USERPROFILE '.openclaw-node\node24\node.exe'
$cli = Join-Path $env:APPDATA 'npm\node_modules\openclaw\openclaw.mjs'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$log = Join-Path $root '.operator-data\openclaw-gateway.log'

function Listener { Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }

if ($Stop) {
  $l = Listener
  if ($l) { taskkill /PID $l.OwningProcess /T /F | Out-Null; 'OpenClaw relay stopped' } else { 'OpenClaw relay was not running' }
  return
}
if (-not (Test-Path $node) -or -not (Test-Path $cli)) { throw 'Node 24 (~\.openclaw-node\node24) or OpenClaw is missing' }

$config = Get-Content (Join-Path $env:USERPROFILE '.openclaw\openclaw.json') -Raw | ConvertFrom-Json
if ($config.gateway.bind -ne 'loopback' -or $config.gateway.auth.mode -ne 'token') {
  throw 'Refusing to start: OpenClaw gateway must be bind=loopback with token auth'
}
$l = Listener
if ($l) {
  if ($l.LocalAddress -ne '127.0.0.1') { throw "Port 18789 is listening on $($l.LocalAddress), not loopback" }
  'OpenClaw relay already running on 127.0.0.1:18789'
  return
}
Start-Process $node -ArgumentList @("`"$cli`"", 'gateway', 'run') -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
foreach ($i in 1..30) { Start-Sleep 1; if (Listener) { 'OpenClaw relay running on 127.0.0.1:18789'; return } }
throw "OpenClaw gateway did not start; see $log"
