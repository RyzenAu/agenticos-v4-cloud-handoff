# Start or stop a LOCAL cloud-role hub on an isolated data folder, to rehearse the VM behaviour on this PC (round 3 proof).
#   deploy/local/cloud-rehearsal.ps1 start [-Port 8113] [-Scratch D:\prog-scratch\cloud-8113]
#   deploy/local/cloud-rehearsal.ps1 stop  [-Scratch ...]
#   deploy/local/cloud-rehearsal.ps1 reset [-Scratch ...]   stop and empty the scratch data and home folders
# Then: bun scripts/cloud/role-proof.ts check --cookie-file <Scratch>\owner.cookie --out <Scratch>\check.json
# It refuses 8081, binds 127.0.0.1 only, sets MU_HUB_ROLE=cloud, its own MU_DATA_DIR and HOME, memory off. It reads no .env.
param([Parameter(Mandatory = $true)][ValidateSet('start', 'stop', 'reset')][string]$Action, [int]$Port = 8113, [string]$Scratch = 'D:\prog-scratch\cloud-8113')
$ErrorActionPreference = 'Stop'
if ($Port -eq 8081) { throw 'Refusing 8081 (the live OS).' }
$pidFile = Join-Path $Scratch 'pid'
function Stop-Hub { if (Test-Path $pidFile) { $p = (Get-Content $pidFile).Trim(); if ($p) { taskkill /PID $p /T /F | Out-Null }; Remove-Item $pidFile -Force } }
if ($Action -ne 'start') {
  Stop-Hub
  if ($Action -eq 'reset') { foreach ($d in 'data', 'home') { $path = Join-Path $Scratch $d; if (Test-Path $path) { Get-ChildItem $path -Force | Remove-Item -Recurse -Force } } }
  return
}
New-Item -ItemType Directory -Force (Join-Path $Scratch 'data'), (Join-Path $Scratch 'home') | Out-Null
$env:MU_HUB_ROLE = 'cloud'; $env:MU_DATA_DIR = Join-Path $Scratch 'data'; $env:HINDSIGHT_URL = 'off'; $env:MU_MEMORY_WRITES = 'off'
$env:HOME = Join-Path $Scratch 'home'; $env:USERPROFILE = $env:HOME
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$bun = (Get-Command bun).Source
$p = Start-Process -FilePath $bun -ArgumentList '--bun', 'node_modules/vite/bin/vite.js', 'dev', '--port', $Port, '--strictPort', '--host', '127.0.0.1' -RedirectStandardOutput (Join-Path $Scratch 'out.log') -RedirectStandardError (Join-Path $Scratch 'err.log') -PassThru -WindowStyle Hidden
$p.Id | Out-File $pidFile -Encoding ascii
Write-Output "cloud-role hub starting on http://127.0.0.1:$Port (pid $($p.Id)); data $env:MU_DATA_DIR"
