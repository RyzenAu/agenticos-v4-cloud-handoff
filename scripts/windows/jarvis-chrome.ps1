# Starts "Jarvis Chrome": a separate Chrome profile that Hermes drives over the Chrome
# DevTools Protocol on 127.0.0.1:9222. Your normal Chrome profile is never touched (and
# Chrome 136+ refuses remote debugging on the default profile anyway).
#
# Safe to run any time: if Jarvis Chrome is already up it does nothing. Exits 0 once the
# debugging endpoint answers, 1 if it didn't come up.
#
# Anything running on this PC can drive this profile while it is open, so sign in only
# to the sites you want Jarvis to use. Profile: %LOCALAPPDATA%\Jarvis Chrome
param([string]$Url = '')

$profileDir = Join-Path $env:LOCALAPPDATA 'Jarvis Chrome'
$port = 9222
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Output 'Google Chrome is not installed.'; exit 1 }

function Test-Endpoint {
  try { (Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2).Browser } catch { $null }
}

if (-not (Test-Endpoint)) {
  New-Item -ItemType Directory -Force $profileDir | Out-Null
  $arguments = @(
    "--user-data-dir=`"$profileDir`"",
    "--remote-debugging-port=$port",
    # Loopback only; this is Chrome's default, stated so it can't drift.
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check'
  )
  if ($Url) { $arguments += $Url }
  Start-Process -FilePath $chrome -ArgumentList $arguments
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; if (Test-Endpoint) { break } }
} elseif ($Url) {
  # Already running: open the page in it rather than in the everyday Chrome.
  try { Invoke-RestMethod -Method Put -Uri ("http://127.0.0.1:$port/json/new?" + [uri]::EscapeDataString($Url)) -TimeoutSec 5 | Out-Null } catch { }
}

$browser = Test-Endpoint
if ($browser) { Write-Output "Jarvis Chrome is ready ($browser) on 127.0.0.1:$port."; exit 0 }
Write-Output "Jarvis Chrome did not start its debugging endpoint on port $port."
exit 1
