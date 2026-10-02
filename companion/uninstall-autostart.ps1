<#
  Remove the M&U companion's logon entry for the CURRENT USER (the inverse of install-autostart.ps1).

    powershell -NoProfile -ExecutionPolicy Bypass -File companion\uninstall-autostart.ps1 [-DryRun] [-Stop] [-KeepFiles]

  Removes <Startup>\MU Companion.vbs and <ConfigDir>\run-companion.cmd. It never touches companion.json (the pairing),
  the command ledger or the log: use `bun companion\main.ts forget` and revoke the PC in the OS to drop the pairing.
  -Stop also ends a companion that is running right now (its launcher first, so it does not restart it).
  -KeepFiles leaves run-companion.cmd in place. -DryRun says what would happen and changes nothing.
#>
param(
  [string]$ConfigDir = (Join-Path $env:LOCALAPPDATA 'mu-companion'),
  [string]$StartupDir = [Environment]::GetFolderPath('Startup'),
  [switch]$DryRun,
  [switch]$Stop,
  [switch]$KeepFiles
)
$ErrorActionPreference = 'Stop'
$runCmd = Join-Path $ConfigDir 'run-companion.cmd'
$vbs = Join-Path $StartupDir 'MU Companion.vbs'

Write-Output "Companion autostart removal for $env:USERNAME"
$targets = @($vbs)
if (-not $KeepFiles) { $targets += $runCmd }
foreach ($t in $targets) {
  if (Test-Path $t) { Write-Output ($(if ($DryRun) { '  would remove: ' } else { '  removing    : ' }) + $t) }
  else { Write-Output "  not present : $t" }
}

$running = @()
if ($Stop) {
  # Only THIS user's companion: the launcher .cmd (by its path) and the bun process running companion\main.ts run.
  $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and (($_.CommandLine -like "*$runCmd*") -or ($_.CommandLine -match 'companion[\\/]main\.ts"? run'))
  })
  foreach ($p in $running) { Write-Output ($(if ($DryRun) { '  would stop  : ' } else { '  stopping    : ' }) + "pid $($p.ProcessId) $($p.Name)") }
  if (-not $running.Count) { Write-Output '  no running companion found.' }
}

if ($DryRun) { Write-Output 'DRY RUN: nothing was changed.'; exit 0 }

if ($Stop) {
  # Launchers (cmd) before the program they restart.
  foreach ($p in ($running | Sort-Object { $_.Name -ne 'cmd.exe' })) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
foreach ($t in $targets) { if (Test-Path $t) { Remove-Item -LiteralPath $t -Force } }
Write-Output 'Removed. The companion will not start at logon.'
