# Dot gateway STAGING pair on Ryzen-PC: a staging hub on SYNTHETIC data, run from a CLEAN export of a committed revision,
# plus the gateway in front of it serving the BUILT UI itself. Both loopback only.
#   powershell -NoProfile -ExecutionPolicy Bypass -File dot-gateway-staging.ps1 -Action export|seed|start|stop|status|mint-code ...
#
# export:    `git archive` of -Revision (a commit, never the working tree) into C:\mu-hub\dot-gateway-staging\app-<sha>,
#            then its OWN `bun install --frozen-lockfile` (NEEDS NETWORK ACCESS on Ryzen; production's node_modules is never
#            linked, so no staging build or dev-server cache is ever written into it), then the UI build.
#            The export holds no untracked, ignored or backup file of the source checkout.
# seed:      creates C:\mu-hub\data\dot-gateway-staging-synthetic with obviously fake records (scripts/gateway/seed-staging.ts).
# start:     refuses unless the export is clean (only files of the revision, plus node_modules and the build output) and the
#            data folder passes the synthetic check. Staging hub on 127.0.0.1:8086 (MU_HUB_ROLE=server, MU_GATEWAY_TRUST=1,
#            no background work) and the gateway on 127.0.0.1:8096 serving the export's built UI, pointing only at that hub.
#            Both start with a SCRUBBED environment: an explicit allow-list of names (system basics plus the inert staging
#            settings). Nothing is inherited, and a name matching KEY|TOKEN|SECRET|PASSWORD refuses the start.
#            -Operate (r11, docs/gateway/DOT-ACCESS.md): background work ON so the staging job stores are WRITABLE (Dot's tasks,
#            CRM writes and file drafts can be proven on the synthetic data), and MU_SYNTHETIC_HUB=1. Without it the staging hub
#            is a read-only copy and every gateway write answers 409.
#            -Memory: local shared memory ON for the synthetic hub (MU_MEMORY_WRITES=on, its own vault and state folders inside the
#            synthetic data folder; Hindsight stays off), so memory recall and saving can be proven on staging. Synthetic data only.
# mint-code: a one-time sign-in code for Dot with SHORT staging expiry (default: idle 2 min, absolute 10 min).
# stop / status.
#
# This script opens NO Tailscale Serve or Funnel port and NO firewall rule. Exposure is dot-gateway-funnel.ps1 (lead only).
param(
  [Parameter(Mandatory = $true)][ValidateSet('export', 'seed', 'start', 'stop', 'status', 'mint-code')][string]$Action,
  [string]$Revision = '',
  [string]$PublicOrigin = '',
  [string]$SourceRepo = 'C:\mu-hub\AgenticOS-v4',
  [string]$Git = 'git',
  [string]$Bun = 'C:\mu-hub\bin\bun.exe',
  [int]$HubPort = 8086,
  [int]$GatewayPort = 8096,
  [ValidateSet('usman', 'mehroz')][string]$By = 'usman',
  [double]$IdleMinutes = 2,
  [double]$SessionMinutes = 10,
  [double]$CodeMinutes = 10,
  [switch]$Operate,
  [switch]$Memory
)
$ErrorActionPreference = 'Stop'
$forbidden = @(8081, 8082, 8083, 8084, 8085, 8090, 8091, 8092, 8093, 8443, 8445)
foreach ($p in @($HubPort, $GatewayPort)) { if ($p -in $forbidden) { throw "Refusing port $p (production, rehearsal, acceptance, Serve or the production gateway port)." } }
if ($HubPort -eq $GatewayPort) { throw 'The hub and the gateway need different ports.' }

$root = 'C:\mu-hub\dot-gateway-staging'
$data = 'C:\mu-hub\data\dot-gateway-staging-synthetic'
$home2 = Join-Path $root 'home'
$state = Join-Path $root 'state.json'
$current = Join-Path $root 'current-export.txt'
New-Item -ItemType Directory -Force $root, $home2 | Out-Null

function Invoke-Bun([string]$Dir, [string[]]$BunArgs) {
  Push-Location $Dir
  # Output goes to the console; ONLY the exit code is returned (returning both made every "-ne 0" check true).
  try { & $Bun @BunArgs | Out-Host; return $LASTEXITCODE } finally { Pop-Location }
}
function Get-Export {
  if (-not (Test-Path $current)) { throw 'No export yet: run -Action export -Revision <commit> first.' }
  $dir = (Get-Content $current -Raw).Trim()
  if (-not (Test-Path (Join-Path $dir 'package.json'))) { throw "The export $dir is missing." }
  return $dir
}
# The export must hold exactly the revision's files: anything else (an untracked file, a .bak, a copied data file) refuses.
function Assert-CleanExport([string]$Dir) {
  $rev = (Get-Content (Join-Path $Dir '.staging-revision') -Raw).Trim()
  $tracked = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($f in (& $Git -C $SourceRepo ls-tree -r --name-only $rev)) { [void]$tracked.Add($f.Replace('/', '\')) }
  if ($LASTEXITCODE -or $tracked.Count -eq 0) { throw "Cannot list the files of $rev in $SourceRepo." }
  $allowedTop = @('node_modules', 'dist', '.staging-revision')
  $bad = @()
  Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -Attributes !ReparsePoint | ForEach-Object {
    $rel = $_.FullName.Substring($Dir.Length + 1)
    $top = $rel.Split('\')[0]
    if ($top -in $allowedTop) { return }
    if (-not $tracked.Contains($rel)) { $bad += $rel }
  }
  # Backup-looking files: refused when they are NOT part of the commit, and always refused inside the served bundle. (The repository
  # itself tracks fifteen *.bak-* / *.orig files; those are the commit's own files and are never served: the gateway serves only dist\client.)
  $bak = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -Attributes !ReparsePoint | Where-Object {
    $r = $_.FullName.Substring($Dir.Length + 1)
    $_.Name -match '\.bak|~$|\.orig$|\.rej$' -and $_.FullName -notmatch '\\node_modules\\' -and ($r -like 'dist\client\*' -or -not $tracked.Contains($r))
  })
  if ($bak.Count) { $bad += ($bak | ForEach-Object { $_.FullName }) }
  if ($bad.Count) { throw "The export is not clean ($($bad.Count) file(s) that are not part of $rev, first: $($bad[0])). Make a new export." }
  if (-not (Test-Path (Join-Path $Dir 'dist\client\gateway-ui-manifest.json'))) { throw 'The export has no built UI (dist\client\gateway-ui-manifest.json).' }
}
function Assert-Synthetic([string]$Dir) {
  if ((Invoke-Bun $Dir @('scripts/gateway/seed-staging.ts', 'check', '--data', $data)) -ne 0) { throw 'The staging data folder is not the seeded synthetic one. Run -Action seed first (into a NEW folder).' }
}
# The ONLY variables a staging child process gets. System basics are copied by NAME from this shell; everything else is set here.
$systemNames = @('SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME')
function New-ScrubbedEnv([hashtable]$Settings) {
  $child = [ordered]@{}
  foreach ($n in $systemNames) { $v = [Environment]::GetEnvironmentVariable($n, 'Process'); if ($null -ne $v -and $v -ne '') { $child[$n] = $v } }
  foreach ($k in $Settings.Keys) { $child[$k] = [string]$Settings[$k] }
  $bad = @($child.Keys | Where-Object { $_ -match 'KEY|TOKEN|SECRET|PASSWORD' })
  if ($bad.Count) { throw "Refusing to start: the child environment would carry secret-looking variable name(s): $($bad -join ', ') (names only; values are never printed)." }
  return $child
}
# Start a process with EXACTLY that environment (nothing inherited), output to two log files.
function Start-Scrubbed([string]$Dir, [string[]]$BunArgs, $ChildEnv, [string]$OutLog, [string]$ErrLog) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $ChildEnv['ComSpec']
  $quoted = ($BunArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  $psi.Arguments = "/d /c `"`"$Bun`" $quoted > `"$OutLog`" 2> `"$ErrLog`"`""
  $psi.WorkingDirectory = $Dir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables.Clear()
  foreach ($k in $ChildEnv.Keys) { $psi.EnvironmentVariables[$k] = $ChildEnv[$k] }
  return [Diagnostics.Process]::Start($psi)
}
function Read-State { if (Test-Path $state) { return Get-Content $state -Raw | ConvertFrom-Json } return $null }

switch ($Action) {
  'export' {
    if ($Revision -notmatch '^[0-9a-f]{7,40}$') { throw '-Revision must be a commit id (the reviewed one), never a branch name or the working tree.' }
    $sha = (& $Git -C $SourceRepo rev-parse --verify "$Revision^{commit}").Trim()
    if ($LASTEXITCODE) { throw "Unknown commit $Revision in $SourceRepo." }
    $dir = Join-Path $root ("app-" + $sha.Substring(0, 12))
    if (Test-Path $dir) { throw "$dir already exists; an export is never reused or overwritten. Remove it by hand (it is not a junction) or pick another revision." }
    $zip = Join-Path $root ("app-" + $sha.Substring(0, 12) + '.zip')
    & $Git -C $SourceRepo archive --format=zip -o $zip $sha
    if ($LASTEXITCODE) { throw 'git archive failed.' }
    Expand-Archive -LiteralPath $zip -DestinationPath $dir
    [IO.File]::Delete($zip)
    [IO.File]::WriteAllText((Join-Path $dir '.staging-revision'), $sha)
    # Its own dependencies (needs network): production's node_modules is never linked or written to.
    if ((Invoke-Bun $dir @('install', '--frozen-lockfile')) -ne 0) { throw 'bun install --frozen-lockfile failed (it needs network access; nothing was started).' }
    if ((Get-Item -LiteralPath (Join-Path $dir 'node_modules')).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'node_modules in the export is a link; it must be the export own folder.' }
    $env:AGENTIC_OS_VITE_CACHE_DIR = (Join-Path $root 'vite-cache')
    if ((Invoke-Bun $dir @('scripts/gateway/build-ui.ts')) -ne 0) { throw 'The UI build failed.' }
    [IO.File]::WriteAllText($current, $dir)
    Assert-CleanExport $dir
    "exported $sha to $dir and built its UI"
  }
  'seed' {
    $dir = Get-Export
    if ((Invoke-Bun $dir @('scripts/gateway/seed-staging.ts', 'seed', '--data', $data)) -ne 0) { throw 'seed refused or failed (see above).' }
    Assert-Synthetic $dir
    "seeded $data"
  }
  'start' {
    if (-not $PublicOrigin) { throw '-PublicOrigin is required (the https origin Dot will use, e.g. https://ryzen-pc.tailnet-name.ts.net).' }
    if ($PublicOrigin -notmatch '^https://[a-z0-9.-]+$') { throw '-PublicOrigin must be a bare https origin, no port and no path.' }
    if (Read-State) { throw "already started (state file $state); run -Action stop first" }
    $dir = Get-Export
    Assert-CleanExport $dir
    Assert-Synthetic $dir
    foreach ($p in @($HubPort, $GatewayPort)) {
      if ([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $p }) { throw "port $p is already in use" }
    }
    if ((Get-Item -LiteralPath (Join-Path $dir 'node_modules')).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'node_modules in the export is a link; make a new export.' }
    # SCRUBBED environments: only these names reach the children. Values are set here and never printed.
    $common = @{ MU_DATA_DIR = $data; HOME = $home2; USERPROFILE = $home2; APPDATA = (Join-Path $home2 'AppData\Roaming'); LOCALAPPDATA = (Join-Path $home2 'AppData\Local') }
    New-Item -ItemType Directory -Force $common.APPDATA, $common.LOCALAPPDATA, (Join-Path $root 'vite-cache') | Out-Null
    $hubEnv = New-ScrubbedEnv ($common + @{
        MU_HUB_ROLE = 'server'; MU_GATEWAY_TRUST = '1'; HINDSIGHT_URL = 'off'; MU_MEMORY_WRITES = 'off'; MU_TRIGGERS = 'off'
        MU_PREVIEW_PORT = [string]($HubPort + 20); BROWSER = 'none'; AGENTIC_OS_VITE_CACHE_DIR = (Join-Path $root 'vite-cache')
      })
    # A read-only copy unless -Operate: then the synthetic stores are writable so Dot's operating proof can run (synthetic data only).
    if ($Operate) { $hubEnv['MU_SYNTHETIC_HUB'] = '1' } else { $hubEnv['AGENTIC_OS_NO_BACKGROUND'] = '1' }
    # Memory on, confined to the synthetic folder (the synthetic guard refuses a vault outside it); Hindsight stays off.
    if ($Memory) {
      $hubEnv['MU_MEMORY_WRITES'] = 'on'; $hubEnv['MU_SYNTHETIC_HUB'] = '1'
      $hubEnv['MU_WIKI_ROOT'] = (Join-Path $data 'synthetic-vault'); $hubEnv['MEMORY_STATE_DIR'] = (Join-Path $data 'memory')
      New-Item -ItemType Directory -Force $hubEnv['MU_WIKI_ROOT'], $hubEnv['MEMORY_STATE_DIR'] | Out-Null
    }
    # Funnel's X-Forwarded-For is UNVERIFIED: off, so sign-in relies on the per-code limit (DOT-GATEWAY-DESIGN.md).
    $gwEnv = New-ScrubbedEnv ($common + @{
        MU_GATEWAY_PORT = [string]$GatewayPort; MU_GATEWAY_UPSTREAM = "http://127.0.0.1:$HubPort"; MU_GATEWAY_PUBLIC_ORIGIN = $PublicOrigin
        MU_GATEWAY_UI_DIR = (Join-Path $dir 'dist\client'); MU_GATEWAY_FORWARDED_FOR = '0'
      })
    "child environment names (hub): $(@($hubEnv.Keys) -join ', ')"
    "child environment names (gateway): $(@($gwEnv.Keys) -join ', ')"
    $hub = Start-Scrubbed $dir @('--bun', 'node_modules/vite/bin/vite.js', 'dev', '--port', "$HubPort", '--strictPort', '--host', '127.0.0.1') $hubEnv (Join-Path $root 'hub-out.log') (Join-Path $root 'hub-err.log')
    $gw = Start-Scrubbed $dir @('scripts/gateway/main.ts') $gwEnv (Join-Path $root 'gateway-out.log') (Join-Path $root 'gateway-err.log')
    # The processes above are cmd.exe wrappers (for the log redirection); the Funnel check needs the gateway's own pid.
    $gwPid = $null
    for ($i = 0; $i -lt 60 -and -not $gwPid; $i++) {
      Start-Sleep -Milliseconds 500
      $l = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($l) { $gwPid = [int]$l.OwningProcess }
    }
    if (-not $gwPid) { taskkill /PID $hub.Id /T /F 2>&1 | Out-Null; taskkill /PID $gw.Id /T /F 2>&1 | Out-Null; throw "The gateway did not start listening on $GatewayPort (see gateway-err.log). Both were stopped." }
    @{ hubPid = $hub.Id; gatewayWrapperPid = $gw.Id; gatewayPid = $gwPid; hubPort = $HubPort; gatewayPort = $GatewayPort; publicOrigin = $PublicOrigin; data = $data; export = $dir; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Out-File $state -Encoding ascii
    "started: staging hub http://127.0.0.1:$HubPort (pid $($hub.Id)), gateway http://127.0.0.1:$GatewayPort (pid $gwPid) for $PublicOrigin; export $dir; data $data"
    'Nothing is exposed. The Funnel is a separate step: dot-gateway-funnel.ps1 -Action on (lead only, after review).'
  }
  'mint-code' {
    $dir = Get-Export
    Assert-Synthetic $dir
    $s = Read-State
    $env:MU_DATA_DIR = $data
    $origin = if ($s) { $s.publicOrigin } else { $PublicOrigin }
    $cliArgs = @('scripts/gateway/cli.ts', 'enrol-code', '--by', $By, '--minutes', "$CodeMinutes", '--idle-minutes', "$IdleMinutes", '--session-minutes', "$SessionMinutes")
    if ($origin) { $cliArgs += @('--origin', $origin) }
    [void](Invoke-Bun $dir $cliArgs)
  }
  'stop' {
    $s = Read-State
    if ($s) {
      foreach ($id in @($s.gatewayPid, $s.gatewayWrapperPid, $s.hubPid)) { if ($id) { taskkill /PID $id /T /F 2>&1 | Out-Null } }
      [IO.File]::Delete($state)
    }
    'stopped (the Funnel, if it was on, is NOT changed by this; use dot-gateway-funnel.ps1 -Action off)'
  }
  'status' {
    $s = Read-State
    if (-not $s) { 'not started' } else { "started $($s.startedAt): hub $($s.hubPort), gateway $($s.gatewayPort), origin $($s.publicOrigin), export $($s.export)" }
    try { "gateway health: $((Invoke-RestMethod -TimeoutSec 4 "http://127.0.0.1:$GatewayPort/gw/health" | ConvertTo-Json -Compress))" } catch { 'gateway: not answering' }
    try { [void](Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:$HubPort/__version"); 'staging hub: answering' } catch { if ($_.Exception.Response) { 'staging hub: answering' } else { 'staging hub: not answering' } }
    if (Test-Path $current) { $env:MU_DATA_DIR = $data; [void](Invoke-Bun (Get-Export) @('scripts/gateway/cli.ts', 'status')) }
  }
}
