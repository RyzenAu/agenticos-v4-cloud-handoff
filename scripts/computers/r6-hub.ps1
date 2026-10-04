# Start or stop the ROUND 6 TEST HUB: a separate hub (never the live one on 8081) that drives the real Ryzen-PC through the SSH adapter.
#   scripts/computers/r6-hub.ps1 start [-Port 8153] [-Scratch D:\AgenticOS-r6-data]
#   scripts/computers/r6-hub.ps1 stop  [-Scratch ...]
#   scripts/computers/r6-hub.ps1 kill  [-Scratch ...]      hard kill (the hub's process tree), for a "hub died mid-job" test
# It refuses 8081, binds 127.0.0.1 only, uses its OWN data folder (synthetic: nothing from the live OS), memory writes off, and sets the host
# settings (names only, none is a secret). The SSH key is never read here: the adapter uses the owner's ~/.ssh/config alias (ryzen-bots).
# Run from PowerShell: Git Bash would rewrite the /var/lib path below into a Windows path (see LAN-BOT-HOST.md).
param([Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'kill')][string]$Action, [int]$Port = 8153, [string]$Scratch = 'D:\AgenticOS-r6-data', [string]$Alias = 'ryzen-bots', [int]$RemotePort = 18153, [int]$DisplayBase = 60, [string]$DataDir = '', [string]$HostFile = '')
$ErrorActionPreference = 'Stop'
if ($Port -eq 8081) { throw 'Refusing 8081 (the live OS).' }
if ($Scratch -notmatch 'AgenticOS-r6') { throw "Scratch folder must be an AgenticOS-r6 folder, not $Scratch" }
$pidFile = Join-Path $Scratch 'hub.pid'
function Stop-Hub {
  if (Test-Path $pidFile) {
    $p = (Get-Content $pidFile).Trim()
    if ($p) { taskkill /PID $p /T /F 2>&1 | Out-Null }
    Remove-Item $pidFile -Force
  }
}
if ($Action -ne 'start') { Stop-Hub; return }
Stop-Hub
New-Item -ItemType Directory -Force (Join-Path $Scratch 'logs') | Out-Null
if (-not $DataDir) { New-Item -ItemType Directory -Force (Join-Path $Scratch 'data') | Out-Null }
$env:MU_HUB_ROLE = 'cloud'
$env:MU_DATA_DIR = if ($DataDir) { $DataDir } else { Join-Path $Scratch 'data' }
$env:HINDSIGHT_URL = 'off'
$env:MU_MEMORY_WRITES = 'off'
if (-not $HostFile) {
  $env:MU_COMPUTERS_SSH_WSL_DISTRO = 'kali-linux'
  $env:MU_COMPUTERS_SSH_RUN_AS_PREFIX = 'mu-'
  $env:MU_COMPUTERS_SSH_COMPUTERS_HOME = '/var/lib/mu-computers'
  $env:MU_COMPUTERS_SSH_REMOTE_PORT = "$RemotePort"
  $env:MU_COMPUTERS_DISPLAY_BASE = "$DisplayBase"
  $env:MU_COMPUTERS_HOST_LABEL_SSH = 'Ryzen-PC (real LAN host: Windows 11 + WSL2 kali-linux, one shared Kali environment)'
}
$env:MU_COMPUTERS_MONITOR_MS = '5000'
# -HostFile: the non-secret environment seed-gate-hub.ts wrote (gate-host.json: { host, env }). Only MU_COMPUTERS_* names are accepted.
if ($HostFile) {
  foreach ($k in 'MU_COMPUTERS_SSH_ALIAS', 'MU_COMPUTERS_SSH_WSL_DISTRO', 'MU_COMPUTERS_SSH_RUN_AS_PREFIX', 'MU_COMPUTERS_SSH_COMPUTERS_HOME', 'MU_COMPUTERS_SSH_REMOTE_PORT', 'MU_COMPUTERS_DISPLAY_BASE', 'MU_COMPUTERS_HOST_LABEL_SSH', 'MU_COMPUTERS_WSL_DISTRO') { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  $h = Get-Content -Raw $HostFile | ConvertFrom-Json
  foreach ($prop in $h.env.PSObject.Properties) {
    if ($prop.Name -notmatch '^MU_COMPUTERS_[A-Z_]+$') { throw "Refusing the environment name $($prop.Name)" }
    Set-Item -Path "Env:$($prop.Name)" -Value ([string]$prop.Value)
  }
} else {
  $env:MU_COMPUTERS_SSH_ALIAS = $Alias
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
# `bun` resolves to an npm shim here, which Start-Process cannot launch: use the real executable beside it.
$shim = (Get-Command bun.cmd -ErrorAction SilentlyContinue).Source
$bun = if ($shim) { Join-Path (Split-Path $shim) 'node_modules\bun\bin\bun.exe' } else { '' }
if (-not (Test-Path $bun)) { $bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe' }
if (-not (Test-Path $bun)) { throw 'bun.exe was not found.' }
$p = Start-Process -FilePath $bun -ArgumentList '--bun', 'node_modules/vite/bin/vite.js', 'dev', '--configLoader', 'native', '--port', $Port, '--strictPort', '--host', '127.0.0.1' `
  -RedirectStandardOutput (Join-Path $Scratch 'logs\hub.out.log') -RedirectStandardError (Join-Path $Scratch 'logs\hub.err.log') -PassThru -WindowStyle Hidden
$p.Id | Out-File $pidFile -Encoding ascii
Write-Output "r6 test hub starting on http://127.0.0.1:$Port (pid $($p.Id)); data $env:MU_DATA_DIR; host alias $Alias; remote port $RemotePort; displays from $DisplayBase"
