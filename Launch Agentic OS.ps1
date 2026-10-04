# One-click Agentic OS launcher.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8081
$url = "http://localhost:$port/setup"

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $listener) {
  $bun = Join-Path $env:APPDATA 'npm\bun.cmd'
  if (-not (Test-Path -LiteralPath $bun)) { throw 'Bun is not installed. Run Start Agentic OS.ps1 once after installing Bun.' }
  Start-Process -FilePath $bun -ArgumentList @('--bun', 'run', 'start') -WorkingDirectory $root -WindowStyle Hidden
}

for ($i = 0; $i -lt 40; $i++) {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $chrome = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
      ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
      if ($chrome) { Start-Process -FilePath $chrome -ArgumentList @($url) }
      else { Start-Process $url }
      exit 0
    }
  } catch { }
  Start-Sleep -Milliseconds 500
}

throw "Agentic OS did not become ready at $url"
