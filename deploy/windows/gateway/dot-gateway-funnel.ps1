# The TEMPORARY public edge for the Dot gateway STAGING pair: Tailscale Funnel on 443 -> the staging gateway ONLY.
#   powershell -NoProfile -ExecutionPolicy Bypass -File dot-gateway-funnel.ps1 -Action on|off|status
#
# on:     refuses unless the staging pair is running from dot-gateway-staging.ps1 (its state file), the target port is the
#         staging gateway (never 8081 or any hub port), and the gateway answers its health check. Then:
#             tailscale funnel --bg --https=443 http://127.0.0.1:<staging gateway port>
# off:    tailscale funnel --https=443 off   (production Serve on 8443/8445 is a different port and is not touched)
# status: tailscale funnel status
#
# Owner approval (2 Oct 2026): a temporary Funnel pointing only at the STAGING gateway, after the design passes independent
# review. Production stays private; a production Funnel is a separate, later decision. The lead runs this, nobody else.
# Verify the exact CLI syntax on Ryzen first: `tailscale funnel --help` (Tailscale 1.52+ syntax is used here).
param(
  [Parameter(Mandatory = $true)][ValidateSet('on', 'off', 'status')][string]$Action,
  [string]$Tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Tailscale)) { throw "tailscale.exe not found at $Tailscale" }
$state = 'C:\mu-hub\dot-gateway-staging\state.json'

switch ($Action) {
  'on' {
    if (-not (Test-Path $state)) { throw 'The staging pair is not running (no state file). Start it with dot-gateway-staging.ps1 -Action start first.' }
    $s = Get-Content $state -Raw | ConvertFrom-Json
    $port = [int]$s.gatewayPort
    if ($port -in @(8081, 8082, 8083, 8084, 8085, 8086, 8090, 8091, 8092, 8093, 8443, 8445, [int]$s.hubPort)) { throw "Refusing: port $port is a hub, Serve or production port, never the target of this Funnel." }
    if ($s.data -notmatch 'dot-gateway-staging-synthetic$') { throw 'Refusing: the staging pair is not on the synthetic data folder.' }
    # The process listening on the port must be the gateway this pair started, running scripts/gateway/main.ts, and nothing else.
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { throw "Refusing: nothing listens on $port." }
    foreach ($l in $listeners) {
      if ($l.LocalAddress -notin @('127.0.0.1', '::1')) { throw "Refusing: port $port listens on $($l.LocalAddress), not loopback only." }
      if ([int]$l.OwningProcess -ne [int]$s.gatewayPid) { throw "Refusing: port $port is held by pid $($l.OwningProcess), not the staging gateway (pid $($s.gatewayPid))." }
    }
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$s.gatewayPid)").CommandLine
    if ($cmd -notmatch 'scripts[\\/]gateway[\\/]main\.ts') { throw "Refusing: pid $($s.gatewayPid) is not running scripts/gateway/main.ts." }
    # The gateway answers only for its public Host (anything else is 421), so the probe names it.
    try {
      $req = [Net.HttpWebRequest]::Create("http://127.0.0.1:$port/gw/health"); $req.Host = ([uri]$s.publicOrigin).Host; $req.Timeout = 5000
      $resp = $req.GetResponse(); $health = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json; $resp.Close()
    } catch { throw "Refusing: the staging gateway on $port is not answering /gw/health." }
    if ($health.ok -ne $true) { throw 'Refusing: the staging gateway reports it is disabled (kill switch on?).' }
    & $Tailscale funnel --bg --https=443 "http://127.0.0.1:$port"
    if ($LASTEXITCODE) { throw "tailscale funnel failed (exit $LASTEXITCODE)" }
    & $Tailscale funnel status
    "Funnel ON: public 443 -> staging gateway 127.0.0.1:$port only. Turn it off with: dot-gateway-funnel.ps1 -Action off"
  }
  'off' {
    & $Tailscale funnel --https=443 off
    $code = $LASTEXITCODE
    & $Tailscale funnel status
    if ($code) { "tailscale funnel off returned $($code): check the status above (an already-off Funnel also reports an error)" } else { 'Funnel OFF for 443.' }
  }
  'status' { & $Tailscale funnel status }
}
