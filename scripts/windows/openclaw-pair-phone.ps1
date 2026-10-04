# Pair a phone with Jarvis's OpenClaw relay. Run it yourself in a terminal at this PC: it shows a
# one-time setup QR (a credential, so it's never printed anywhere else), waits for the phone to
# ask, and lets you approve it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\openclaw-pair-phone.ps1
#
# Before: the phone has Tailscale (same tailnet) and the OpenClaw app (Play Store / App Store).
# The phone connects to wss://desktop-d8qctmg.tailnet-name.ts.net:8444 (tailnet-only Serve).
$node = Join-Path $env:USERPROFILE '.openclaw-node\node24\node.exe'
$cli = Join-Path $env:APPDATA 'npm\node_modules\openclaw\openclaw.mjs'
$env:PATH = "$(Split-Path $node);$env:PATH"
function OC { & $node $cli @args }

if (-not (Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue)) {
  & (Join-Path $PSScriptRoot 'openclaw-relay.ps1')
}
Write-Host "`n1. On the phone: OpenClaw app -> Scan QR or setup code, and scan this:`n" -ForegroundColor Cyan
OC qr
Read-Host "`n2. When the phone says it's waiting for approval, press Enter here"
OC devices list
$id = Read-Host "`n3. Paste the request ID of YOUR phone (leave blank to cancel)"
if ($id) {
  OC devices approve $id
  OC nodes list
  Write-Host "`nDone. Test it: ask Jarvis 'what's my phone's battery?'" -ForegroundColor Green
}
