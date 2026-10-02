# Installs the packaged Jarvis desktop shell (Tauri) for this Windows user, for real:
# runs the NSIS installer, points EVERY Jarvis shortcut (Startup, Start Menu, Desktop) at the
# installed app.exe, writes the runtime config the app reads, backs up what it replaces, and
# relaunches the app. No admin rights; nothing outside this user's own profile.
#
# RUN IT OUTSIDE CLAUDE DESKTOP'S SANDBOX. Processes started from a Claude desktop session are
# MSIX-virtualised: a NEW folder under %LOCALAPPDATA% (like Jarvis\) is silently redirected into
# %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\, where only that sandbox can see
# it. That is how the 27 Sep install "succeeded" while the real %LOCALAPPDATA%\Jarvis\app.exe never
# existed, the Start Menu shortcut pointed at nothing, and Startup pointed into the package cache.
# This script detects the redirect and refuses. From an agent session, launch it through WMI so it
# runs outside the sandbox (its output goes to the log it prints):
#
#   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine =
#     'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\scripts\windows\install-jarvis-desktop.ps1" -SkipBuild' }
#
# From a normal PowerShell window (the owner at the desk) just run it.
#
# Usage:
#   powershell -File scripts/windows/install-jarvis-desktop.ps1               # build + install
#   powershell -File scripts/windows/install-jarvis-desktop.ps1 -SkipBuild    # reuse the built installer
#   powershell -File scripts/windows/install-jarvis-desktop.ps1 -DryRun       # print the plan only
#   -RepoRoot <path>   the AgenticOS checkout the app runs (default ~\source\repos\AgenticOS-v4)
#   -NoLaunch          don't start the app afterwards
#   -HubUrl <url>      remote-hub mode: the app opens this hub (https://<machine>.<tailnet>.ts.net[:port])
#                      and never starts a local server. Written to config.json as hubUrl. Omit it for
#                      the normal local mode (an existing hubUrl in config.json is left as it is).
#   -LocalMode         remove hubUrl from config.json: the way back from remote-hub mode to a local server.
#                      An unparseable existing config.json stops the install and is left untouched.
#
# Rollback: every file this replaces is copied first to ~\.jarvis-desktop\backup\<timestamp>\
# (app.exe, the shortcuts, config.json) with manifest.txt listing each shortcut's old target.
# Copy the files back, or uninstall via Settings > Apps > Jarvis.

param(
  [switch]$SkipBuild,
  [switch]$DryRun,
  [switch]$NoLaunch,
  [string]$RepoRoot = (Join-Path $env:USERPROFILE 'source\repos\AgenticOS-v4'),
  [int]$Port = 8081,
  [string]$HubUrl = '',
  [switch]$LocalMode
)

$ErrorActionPreference = 'Stop'
# Same rule as desktop/src-tauri/src/config.rs parse_hub_url: https on a .ts.net host, or http on
# localhost / 127.0.0.1 (tests); origin only. Refuse here so a typo never reaches config.json.
$hubPattern = '^(https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.ts\.net|http://(localhost|127\.0\.0\.1))(:([1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?/?$'
function Hide-Userinfo([string]$u) { $u -replace '(://)[^/?#]*@', '$1<redacted>@' -replace '^[^/:]*:[^/@]*@', '<redacted>@' }
if ($HubUrl -and $LocalMode) {
  Write-Output 'FAILED: -HubUrl and -LocalMode contradict each other.'
  exit 1
}
if ($HubUrl -and $HubUrl -notmatch $hubPattern) {
  Write-Output "FAILED: -HubUrl '$(Hide-Userinfo $HubUrl)' is not allowed. Use https://<machine>.<tailnet>.ts.net[:port] (or http://localhost / http://127.0.0.1 for tests)."
  exit 1
}
$here = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts/windows -> repo holding this script
$desktop = Join-Path $here 'desktop'
$srcTauri = Join-Path $desktop 'src-tauri'
$stateDir = Join-Path $env:USERPROFILE '.jarvis-desktop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force $stateDir | Out-Null
$logFile = Join-Path $stateDir "install-$stamp.log"
Start-Transcript -Path $logFile -Force | Out-Null

function Write-Step($message) { Write-Output "==> $message" }

try {
  # 0. Refuse inside the MSIX sandbox (see header): make a probe folder and see where it landed.
  $probeName = "jarvis-sandbox-probe-$stamp"
  $probe = Join-Path $env:LOCALAPPDATA $probeName
  New-Item -ItemType Directory -Force $probe | Out-Null
  $redirected = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName "LocalCache\Local\$probeName") })
  Remove-Item $probe -Force -ErrorAction SilentlyContinue
  if ($redirected.Count -gt 0) {
    throw ("This shell's %LOCALAPPDATA% writes are redirected into $($redirected[0].FullName)\LocalCache " +
      '(Claude desktop''s MSIX sandbox), so an install here would be invisible to Windows. Re-run it ' +
      'outside the sandbox (Invoke-CimMethod Win32_Process Create, see this script''s header).')
  }
  Write-Step "Not sandboxed: %LOCALAPPDATA% writes land in $env:LOCALAPPDATA"

  # 0b. Read the existing runtime config now, before anything is installed. An unparseable file is
  # never reset (that would silently drop hubUrl and every other key): stop and leave it untouched.
  $configPath = Join-Path $stateDir 'config.json'
  $existingConfig = [pscustomobject]@{}
  if (Test-Path $configPath) {
    try { $existingConfig = Get-Content $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "$configPath exists but can't be parsed as JSON. It was left untouched. Fix it, or delete it, then run the installer again." }
    if ($null -eq $existingConfig -or $existingConfig -isnot [pscustomobject]) { throw "$configPath is not a JSON object. It was left untouched. Fix it, or delete it, then run the installer again." }
  }
  $existingHub = $existingConfig.PSObject.Properties['hubUrl']
  $existingHubValid = $existingHub -and ($existingHub.Value -is [string]) -and ($existingHub.Value -match $hubPattern)
  # Remote-only when -HubUrl is given, or the config already holds a valid hubUrl and -LocalMode isn't.
  $remoteOnly = [bool]($HubUrl -or ($existingHubValid -and -not $LocalMode))

  # 1. Build (unless reusing an existing installer).
  if (-not $SkipBuild) {
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
      $env:PATH = (Join-Path $env:USERPROFILE '.cargo\bin') + ';' + $env:PATH
    }
    Write-Step 'Building the packaged app (npm install + npx tauri build in desktop/)'
    if (-not $DryRun) {
      Push-Location $desktop
      try {
        npm install --no-audit --no-fund
        npx tauri build
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
      } finally { Pop-Location }
    }
  }

  $nsisDir = Join-Path $srcTauri 'target\release\bundle\nsis'
  # Only the installer for THIS checkout's version (desktop/src-tauri/tauri.conf.json): the newest file
  # in the folder could be an older build, and -SkipBuild would then install it over a newer app (review
  # T8 F3: it would have put the 23 Sep 0.1.0 installer over the installed 0.2.0).
  $expectedVersion = (Get-Content (Join-Path $srcTauri 'tauri.conf.json') -Raw | ConvertFrom-Json).version
  $installer = Get-ChildItem $nsisDir -Filter "Jarvis_${expectedVersion}_*-setup.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $installer) { throw "No Jarvis $expectedVersion installer under $nsisDir. Run without -SkipBuild to build it." }
  Write-Step "Installer: $($installer.FullName) ($([Math]::Round($installer.Length / 1MB, 2)) MB, $($installer.LastWriteTime))"

  # 2. Sanity-check the checkout the app will run.
  if ($remoteOnly) {
    $hubShown = if ($HubUrl) { $HubUrl } else { $existingHub.Value }
    Write-Step "Remote hub mode: the app will open $hubShown and never start a local server (no checkout needed)"
  } else {
    foreach ($needed in 'package.json', 'vite.config.ts', '.git\HEAD') {
      if (-not (Test-Path (Join-Path $RepoRoot $needed))) {
        throw "$RepoRoot has no $needed. -RepoRoot must be the main AgenticOS checkout (not a worktree)."
      }
    }
    $head = (Get-Content (Join-Path $RepoRoot '.git\HEAD') -Raw).Trim()
    Write-Step "App will run $RepoRoot ($head) on port $Port"
  }

  # 3. Back up what gets replaced.
  $installDir = Join-Path $env:LOCALAPPDATA 'Jarvis'
  $installedExe = Join-Path $installDir 'app.exe'
  $shell = New-Object -ComObject WScript.Shell
  $shortcuts = [ordered]@{
    Startup   = Join-Path ([Environment]::GetFolderPath('Startup')) 'Jarvis.lnk'
    StartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Jarvis.lnk'
    Desktop   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Jarvis.lnk'
  }
  $backup = Join-Path $stateDir "backup\$stamp"
  $manifest = @("Jarvis desktop backup $stamp")
  if (-not $DryRun) { New-Item -ItemType Directory -Force $backup | Out-Null }
  foreach ($name in $shortcuts.Keys) {
    $lnk = $shortcuts[$name]
    if (Test-Path $lnk) {
      $target = $shell.CreateShortcut($lnk).TargetPath
      $manifest += "$name shortcut $lnk -> $target (target exists: $(Test-Path $target))"
      if (-not $DryRun) { Copy-Item $lnk (Join-Path $backup "$name-Jarvis.lnk") -Force }
    } else {
      $manifest += "$name shortcut $lnk : absent"
    }
  }
  $oldCopies = @($installedExe) + @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'LocalCache\Local\Jarvis\app.exe' } | Where-Object { Test-Path $_ })
  $i = 0
  foreach ($exe in $oldCopies) {
    if (Test-Path $exe) {
      $i++
      $manifest += "app.exe copy $i : $exe ($((Get-Item $exe).Length) bytes, $((Get-Item $exe).LastWriteTime))"
      if (-not $DryRun) { Copy-Item $exe (Join-Path $backup "app-$i.exe") -Force }
    }
  }
  $configPath = Join-Path $stateDir 'config.json'
  if ((Test-Path $configPath) -and -not $DryRun) { Copy-Item $configPath (Join-Path $backup 'config.json') -Force }
  $manifest | ForEach-Object { Write-Output "    $_" }
  if (-not $DryRun) { $manifest | Set-Content (Join-Path $backup 'manifest.txt') -Encoding utf8 }
  Write-Step "Backed up to $backup"

  # 4. Stop a running Jarvis app (never the OS server: that is bun.exe, not app.exe).
  $running = @(Get-CimInstance Win32_Process -Filter "Name='app.exe'" |
    Where-Object { $_.ExecutablePath -and ($oldCopies -contains $_.ExecutablePath -or $_.ExecutablePath -like '*\Jarvis\app.exe') })
  foreach ($p in $running) {
    Write-Step "Stopping running Jarvis app pid $($p.ProcessId) ($($p.ExecutablePath))"
    if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  if ($running.Count -and -not $DryRun) { Start-Sleep -Seconds 2 }

  # 5. Install silently (per-user, no admin: installMode currentUser).
  Write-Step "Running the installer silently"
  if (-not $DryRun) {
    $proc = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -PassThru -Wait
    if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)" }
  }

  $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Jarvis' } | Select-Object -First 1
  if ($entry -and $entry.InstallLocation) {
    $candidate = Join-Path $entry.InstallLocation.Trim('"') 'app.exe'
    if (Test-Path $candidate) { $installedExe = $candidate }
  }
  if (-not $DryRun) {
    if (-not (Test-Path $installedExe)) { throw "Installer ran but $installedExe does not exist." }
    if ((Get-Item $installedExe).FullName -like '*\Packages\*') { throw "Installed into a package cache: $installedExe" }
    $installedVersion = (Get-Item $installedExe).VersionInfo.ProductVersion
    if ($installedVersion -ne $expectedVersion) { throw "Installed app.exe reports $installedVersion, expected $expectedVersion." }
    Write-Step "Installed: $installedExe ($((Get-Item $installedExe).Length) bytes, version $installedVersion); registry: $($entry.DisplayName) $($entry.DisplayVersion)"
    Write-Step "Build check: once it starts, %LOCALAPPDATA%\au.com.muventures.jarvis\logs\Jarvis.log says 'shell $expectedVersion (<sha>)', and <sha> must be this checkout's commit (git rev-parse --short HEAD)."
  }

  # 6. Runtime config the app reads (config.rs): which checkout, which port.
  $config = $existingConfig
  $config | Add-Member -NotePropertyName repoRoot -NotePropertyValue $RepoRoot -Force
  $config | Add-Member -NotePropertyName port -NotePropertyValue $Port -Force
  if ($HubUrl) { $config | Add-Member -NotePropertyName hubUrl -NotePropertyValue $HubUrl.TrimEnd('/') -Force }
  if ($LocalMode -and $config.PSObject.Properties['hubUrl']) { $config.PSObject.Properties.Remove('hubUrl'); Write-Step 'Local mode: removed hubUrl from the config' }
  Write-Step "Config $configPath : keys $($config.PSObject.Properties.Name -join ', ') (values not logged: env may hold secrets)"
  if (-not $DryRun) {
    # UTF-8 without BOM (serde_json also tolerates a BOM, but keep it clean).
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  }

  # 7. Point every Jarvis shortcut at the installed exe (Startup and Start Menu always; Desktop if present).
  foreach ($name in $shortcuts.Keys) {
    $lnk = $shortcuts[$name]
    if ($name -eq 'Desktop' -and -not (Test-Path $lnk)) { continue }
    Write-Step "$name shortcut -> $installedExe"
    if (-not $DryRun) {
      $s = $shell.CreateShortcut($lnk)
      $s.TargetPath = $installedExe
      $s.WorkingDirectory = Split-Path $installedExe
      $s.IconLocation = "$installedExe,0"
      $s.Description = 'Jarvis (Agentic OS)'
      $s.Save()
    }
  }

  # 8. Verify.
  if (-not $DryRun) {
    Write-Step 'Verification'
    Write-Output "    app.exe exists: $(Test-Path $installedExe)"
    foreach ($name in $shortcuts.Keys) {
      $lnk = $shortcuts[$name]
      if (Test-Path $lnk) {
        $t = $shell.CreateShortcut($lnk).TargetPath
        $ok = (Test-Path $t) -and ($t -eq $installedExe)
        Write-Output "    $name : $t  [$(if ($ok) { 'OK' } else { 'WRONG' })]"
        if (-not $ok) { throw "$name shortcut is wrong: $t" }
      }
    }
  }

  # 9. Relaunch so the owner is never left without the app.
  if (-not $NoLaunch -and -not $DryRun) {
    Start-Process -FilePath $installedExe -WorkingDirectory (Split-Path $installedExe)
    Write-Step 'Launched the installed app'
  }
  Write-Step "Done. Log: $logFile"
} catch {
  Write-Output "FAILED: $($_.Exception.Message)"
  Stop-Transcript | Out-Null
  exit 1
}
Stop-Transcript | Out-Null
