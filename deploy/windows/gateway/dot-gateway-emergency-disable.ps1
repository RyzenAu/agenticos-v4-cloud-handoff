# EMERGENCY: cut Dot off everywhere, now. Safe to run at any time, more than once, by either founder or the lead.
#   powershell -NoProfile -ExecutionPolicy Bypass -File dot-gateway-emergency-disable.ps1
#
# In this order (each step is independent; a failing step does not stop the next):
#   1. KILL switch file in every gateway data folder that exists (staging and production): the gateway answers 503 to
#      everything, closes open streams and sockets within about a second, and the hub refuses any gateway assertion.
#   2. Tailscale Funnel off for 443 (the internet edge). Production Serve (8443, 8445: tailnet only) is a different port.
#   3. Stops the staging pair's gateway process (and a gateway on the production gateway port, if one runs).
#   4. Prints what is left, so you can see it worked.
# Undo (only after you know why you pulled it): delete the KILL file(s) or run `bun scripts/gateway/cli.ts kill off`
# with MU_DATA_DIR set to that data folder; turning the Funnel back on is dot-gateway-funnel.ps1 -Action on.
param(
  [string[]]$DataDirs = @('C:\mu-hub\data\dot-gateway-staging-synthetic', 'C:\mu-hub\data\production'),
  [string]$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe',
  [int[]]$GatewayPorts = @(8096, 8092)
)
$ErrorActionPreference = 'Continue'
$stamp = (Get-Date).ToString('o')

foreach ($d in $DataDirs) {
  if (Test-Path -LiteralPath $d) {
    $g = Join-Path $d 'gateway'
    New-Item -ItemType Directory -Force $g | Out-Null
    [IO.File]::WriteAllText((Join-Path $g 'KILL'), "$stamp emergency-disable`n")
    "1. KILL switch ON in $g"
  }
}

if (Test-Path -LiteralPath $Tailscale) {
  & $Tailscale funnel --https=443 off 2>&1 | Out-Null
  "2. Funnel off requested for 443. Current Funnel status:"
  & $Tailscale funnel status
} else { "2. tailscale.exe not found at $($Tailscale): turn the Funnel off by hand (tailscale funnel --https=443 off)" }

$state = 'C:\mu-hub\dot-gateway-staging\state.json'
if (Test-Path $state) {
  try { $s = Get-Content $state -Raw | ConvertFrom-Json; if ($s.gatewayPid) { taskkill /PID $s.gatewayPid /T /F 2>&1 | Out-Null; "3. stopped the staging gateway (pid $($s.gatewayPid))" } } catch { '3. could not read the staging state file' }
}
foreach ($p in $GatewayPorts) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
    if ($proc.CommandLine -match 'scripts[\\/]gateway[\\/]main\.ts') { taskkill /PID $c.OwningProcess /T /F 2>&1 | Out-Null; "3. stopped the gateway on port $p (pid $($c.OwningProcess))" }
    else { "3. port $p is held by something that is not the gateway; left alone" }
  } catch { "3. nothing listening on $p" }
}

'4. Done. The kill switch stays on until a founder removes it. Record when and why in the gateway audit notes.'
