# Isolated, inert CRM migration rehearsal instance on Ryzen-PC (CRM-INTEGRATION-RUNBOOK.md section 3).
#   powershell -NoProfile -ExecutionPolicy Bypass -File crm-rehearsal.ps1 -Action create|start|stop|status [-Backup <dir>] [-Repo <checkout>]
# create: restores the newest verified nightly backup (or -Backup) into an EMPTY C:\mu-hub\data\crm-rehearsal (refuses if not empty).
# start:  hub on 127.0.0.1:8084 with its own HOME, no background work, no memory, no triggers. Never touches production (8081).
# Loopback only: no Tailscale Serve port is opened by this script.
param(
  [Parameter(Mandatory = $true)][ValidateSet('create', 'start', 'stop', 'status')][string]$Action,
  [string]$Backup = '',
  [string]$Repo = 'C:\mu-hub\AgenticOS-v4',
  [string]$Bun = 'C:\mu-hub\bin\bun.exe',
  [int]$Port = 8084,
  [switch]$InDetached
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-common.ps1')
if ($Port -in 8081, 8082, 8083, 8091, 8093) { throw "Refusing port $Port (production, staging or acceptance)." }
$root = 'C:\mu-hub\crm-rehearsal'; $data = 'C:\mu-hub\data\crm-rehearsal'; $home2 = Join-Path $root 'home'; $pidFile = Join-Path $root 'pid'
New-Item -ItemType Directory -Force $root, $home2 | Out-Null
switch ($Action) {
  'create' {
    if ((Test-Path $data) -and @(Get-ChildItem $data -Force).Count -gt 0) { throw "$data is not empty; this script never overwrites a data folder." }
    if (-not $Backup) {
      $Backup = (Get-ChildItem 'D:\mu-hub-backups\production' -Directory -Filter 'backup-*' | Sort-Object Name | Select-Object -Last 1).FullName
    }
    if (-not $Backup) { throw 'No backup found.' }
    New-Item -ItemType Directory -Force $data | Out-Null
    Push-Location $Repo
    try {
      & $Bun scripts/cloud/backup-cli.ts verify --from $Backup
      if ($LASTEXITCODE) { throw 'backup verify failed' }
      & $Bun scripts/cloud/backup-cli.ts restore --from $Backup --to $data --fresh-sessions
      if ($LASTEXITCODE) { throw 'restore failed' }
    } finally { Pop-Location }
    "created from $Backup"
  }
  'start' {
    if (Test-Path $pidFile) { throw "already started (pid file $pidFile)" }
    if ((Test-MuSshSession) -and -not $InDetached) {
      # A process started inside an SSH login dies with it (3 Oct 2026: the rehearsal hub vanished when the connection closed).
      # Relaunch this same action outside the session, then wait for the pid file it writes.
      $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $launcher = Start-MuDetached -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Action', 'start', '-InDetached', '-Repo', $Repo, '-Bun', $Bun, '-Port', "$Port") -WorkingDirectory $root
      for ($i = 0; $i -lt 40 -and -not (Test-Path $pidFile); $i++) { Start-Sleep -Milliseconds 500 }
      if (-not (Test-Path $pidFile)) { throw "launched outside the ssh session (launcher pid $launcher) but no pid file appeared; read $root\err.log" }
      return "started outside the ssh session on http://127.0.0.1:$Port (pid $((Get-Content $pidFile | Select-Object -First 1).Trim())); data $data"
    }
    $env:MU_HUB_ROLE = 'server'; $env:MU_DATA_DIR = $data; $env:HOME = $home2; $env:USERPROFILE = $home2
    $env:AGENTIC_OS_NO_BACKGROUND = '1'; $env:HINDSIGHT_URL = 'off'; $env:MU_MEMORY_WRITES = 'off'; $env:MU_TRIGGERS = 'off'
    $env:MU_PREVIEW_PORT = [string]($Port + 10); $env:BROWSER = 'none'
    $p = Start-Process -FilePath $Bun -WorkingDirectory $Repo -ArgumentList '--bun', 'node_modules/vite/bin/vite.js', 'dev', '--port', $Port, '--strictPort', '--host', '127.0.0.1' `
      -RedirectStandardOutput (Join-Path $root 'out.log') -RedirectStandardError (Join-Path $root 'err.log') -PassThru -WindowStyle Hidden
    $p.Id | Out-File $pidFile -Encoding ascii
    "started on http://127.0.0.1:$Port (pid $($p.Id)); data $data"
  }
  'stop' {
    if (Test-Path $pidFile) { $id = (Get-Content $pidFile | Select-Object -First 1).Trim(); taskkill /PID $id /T /F 2>&1 | Out-Null; [IO.File]::Delete($pidFile) }
    'stopped'
  }
  'status' {
    "data: $data exists=$(Test-Path $data)"
    try { "version: $((Invoke-RestMethod -TimeoutSec 4 "http://127.0.0.1:$Port/__version" | ConvertTo-Json -Compress))" } catch { 'not running' }
  }
}
