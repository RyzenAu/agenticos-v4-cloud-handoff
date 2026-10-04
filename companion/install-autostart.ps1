<#
  Run the M&U companion at logon for the CURRENT USER only. No admin, no service, no scheduled task:
  a hidden launcher in this user's own Startup folder.

    powershell -NoProfile -ExecutionPolicy Bypass -File companion\install-autostart.ps1 [-DryRun]

  What it creates (nothing else, nothing machine-wide):
    1. <ConfigDir>\run-companion.cmd   restarts the companion if it crashes, stops for good when the pairing was
                                       revoked (exit code 3), appends to <ConfigDir>\companion.log (rotated at 1 MB)
    2. <Startup>\MU Companion.vbs      starts that .cmd hidden at this user's logon

  -DryRun prints exactly what would be written and where, and changes nothing. Pair first:
    bun companion\main.ts pair --hub <url> --code <code>
  Remove with companion\uninstall-autostart.ps1.
#>
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$ConfigDir = (Join-Path $env:LOCALAPPDATA 'mu-companion'),
  [string]$StartupDir = [Environment]::GetFolderPath('Startup'),
  [string]$Bun = '',
  # A packaged companion (mu-companion.exe): run it directly. No Bun and no checkout are needed on this PC.
  [string]$Exe = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

if ($Exe) {
  if (-not (Test-Path $Exe)) { Write-Output "mu-companion.exe was not found at $Exe."; exit 1 }
  $Exe = (Resolve-Path $Exe).Path
  $Bun = $Exe
  $main = ''
} elseif (-not $Bun) {
  # The real bun.exe: npm's bun.cmd / bun.ps1 shims can't be started from a hidden launcher reliably.
  foreach ($c in @(Get-Command bun -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -like '*.exe') { $Bun = $c.Source; break }
    $shim = Join-Path (Split-Path -Parent $c.Source) 'node_modules\bun\bin\bun.exe'
    if (Test-Path $shim) { $Bun = $shim; break }
  }
  if (-not $Bun) { $home1 = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'; if (Test-Path $home1) { $Bun = $home1 } }
}
if (-not $Bun -or -not (Test-Path $Bun)) { Write-Output 'bun.exe was not found. Install Bun, or pass -Bun <full path to bun.exe>, or use -Exe <path to mu-companion.exe>.'; exit 1 }
if (-not $Exe) {
  $main = Join-Path $Repo 'companion\main.ts'
  if (-not (Test-Path $main)) { Write-Output "Not a repo with the companion in it: $Repo (no companion\main.ts)."; exit 1 }
}

$runCmd = Join-Path $ConfigDir 'run-companion.cmd'
$log = Join-Path $ConfigDir 'companion.log'
$vbs = Join-Path $StartupDir 'MU Companion.vbs'

$cmdText = @"
@echo off
rem M&U companion, started at logon by the Startup entry. Restarts after a crash; stops for good if its pairing was revoked (exit 3).
cd /d "$(if ($Exe) { Split-Path -Parent $Exe } else { $Repo })"
for %%F in ("$log") do if exist "%%~F" if %%~zF GTR 1048576 move /y "%%~F" "%%~F.old" >nul
:loop
"$Bun" $(if ($Exe) { '' } else { '"' + $main + '"' }) run >> "$log" 2>&1
if %ERRORLEVEL%==3 goto end
timeout /t 15 /nobreak >nul
goto loop
:end
"@
$vbsText = @"
' M&U companion: start the launcher hidden at logon (per-user Startup entry; remove with uninstall-autostart.ps1).
Set sh = CreateObject("WScript.Shell")
sh.Run """$runCmd""", 0, False
"@

Write-Output "Companion autostart for $env:USERNAME (per-user, no admin)"
Write-Output "  repo         : $(if ($Exe) { '(packaged exe)' } else { $Repo })"
Write-Output "  program      : $Bun"
Write-Output "  launcher     : $runCmd"
Write-Output "  log          : $log"
Write-Output "  startup entry: $vbs"
if (-not (Test-Path (Join-Path $ConfigDir 'companion.json'))) { Write-Output "  note         : this PC is not paired yet (no companion.json in $ConfigDir); pair it before the next logon." }

if ($DryRun) {
  Write-Output ''
  Write-Output 'DRY RUN: nothing was written. It would write this launcher:'
  Write-Output $cmdText
  Write-Output 'and this Startup entry:'
  Write-Output $vbsText
  exit 0
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
Set-Content -Path $runCmd -Value $cmdText -Encoding ASCII
Set-Content -Path $vbs -Value $vbsText -Encoding ASCII
Write-Output ''
Write-Output 'Installed. The companion starts at your next logon. To start it now without logging off:'
Write-Output "  wscript.exe `"$vbs`""
