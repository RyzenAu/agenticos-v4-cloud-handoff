# Keeps Agentic OS (http://127.0.0.1:8081) and the Hermes gateway running: starts the OS
# at login and restarts either within about a minute if it stops. Launched hidden by the "Agentic OS.vbs" Startup item that
# install-autostart.ps1 creates. One copy only (named mutex). Log: .operator-data\supervisor.log
#
# Liveness, not just a listening port (28 Sep, services audit A4 item 3): every poll also GETs
# /__version with a timeout. A server that keeps its port open but stops answering (seen live:
# pages 21-37 s, a refused connection, the desktop app's "Recovering" screen every 1-2 min) is
# restarted only after MaxProbeFailures CONSECUTIVE failed probes (default 5, i.e. about five
# minutes unresponsive, so a busy or briefly stalled server is left alone), by killing the bun tree
# rooted at its `bun --bun run start`, never anything else. At most MaxHangRestarts such restarts in
# HangWindowMinutes; after that it stops restarting for a hung server until the window passes (a
# restart can't help a machine that is out of memory, and a loop would make it worse) and says so
# with a Windows notification, once per window.
#
# Only a connection that fails or times out counts as a failed probe (review T8 S-2): ANY HTTP answer,
# 401/403/404/5xx included, comes from a live process, so a future gate change can't get a healthy
# server killed six times an hour.
#
# One owner of starting the server (review T8 S-1). The Jarvis desktop app holds the named mutex
# Local\JarvisAppServer-<port> while a server it started is running or booting; this script then
# leaves starting, restarting and hang-killing to the app. The app, in turn, doesn't start a server
# while this script's own mutex (below) exists, unless it has waited out this script's worst case.
#
# Stop it:   Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
#              Where-Object CommandLine -match 'agentic-os-supervisor' | Invoke-CimMethod -MethodName Terminate
# Remove it: run install-autostart.ps1 -Remove
#
# Test copy (never 8081): -Port 8132 -Repo <folder> -NoGateway -PollSeconds 5 ... uses its own mutex
# (Local\AgenticOSSupervisor-8132), so it never collides with the live supervisor.
param(
  [int]$Port = 8081,
  [string]$Repo = '',
  [int]$PollSeconds = 60,
  [int]$ProbeTimeoutSeconds = 10,
  [int]$MaxProbeFailures = 5,
  [int]$MaxHangRestarts = 3,
  [int]$HangWindowMinutes = 30,
  [int]$BootWaitSeconds = 90,
  [switch]$NoGateway
)

$ErrorActionPreference = 'Continue'
$repo = if ($Repo) { $Repo } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$log = Join-Path $repo '.operator-data\supervisor.log'
$bun = Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'
if (-not (Test-Path $bun)) { $bun = 'bun' }

function Write-Log($message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message
  try {
    New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
    # Keep the log small: trim to the last 500 lines once it passes 1 MB.
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Get-Content $log -Tail 500 | Set-Content $log -Encoding utf8 }
    Add-Content -Path $log -Value $line -Encoding utf8
  } catch { }
}

# The desktop app looks for exactly this name to know the supervisor of 8081 is alive.
$mutexName = if ($Port -eq 8081) { 'Local\AgenticOSSupervisor' } else { "Local\AgenticOSSupervisor-$Port" }
$created = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$created)
if (-not $created) { exit 0 }

function Test-Listening { [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }

# Liveness: /__version is loopback-only, cached per process and carries no secret (unlike /__token).
# MU_HUB_ROLE=server: a loopback request needs the local-owner token for everything EXCEPT this probe: the gate answers an
# unproven loopback GET /__version with a data-free {"ok":true}, so this script needs no secret (scripts/identity/gate.ts).
# True for any HTTP answer (a live process); false only when the connection fails or times out.
function Test-Answering {
  $ProgressPreference = 'SilentlyContinue'
  try {
    [void](Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/__version" -Method Get -TimeoutSec $ProbeTimeoutSeconds)
    return $true
  } catch {
    # A non-2xx status still means the server answered.
    return [bool]($_.Exception.Response)
  }
}

# The desktop app started (and supervises) the server on this port.
function Test-AppOwnsServer {
  $m = $null
  if ([System.Threading.Mutex]::TryOpenExisting("Local\JarvisAppServer-$Port", [ref]$m)) { $m.Dispose(); return $true }
  return $false
}

$lastCapAlert = [DateTime]::MinValue
function Send-Alert($title, $message) {
  $toast = Join-Path $PSScriptRoot 'jarvis-toast.ps1'
  if (-not (Test-Path $toast)) { return }
  try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $toast -Title $title -Message $message | Out-Null } catch { }
}

# A copy that is already starting (the Jarvis desktop app starts one itself if this loop is slow
# to notice) gets time to open the port: on 28 Sep both started one 4 s apart and the loser ran
# ~8.5 min before exiting. `bun run start` runs `bun run dev --port 8081 ...` within a second.
function Get-BootingServer {
  Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "--port\s+$Port\b" -and $_.CreationDate -gt (Get-Date).AddMinutes(-3) } |
    Select-Object -First 1
}

# The root of the server's bun tree: from the port's listener, up through bun.exe parents.
function Get-ServerTreeRoot {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $null }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.Name -ne 'bun.exe') { return $null }
  for ($i = 0; $i -lt 6; $i++) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
    # A real parent was created before its child; a reused PID of an unrelated bun.exe wasn't (review S-7).
    if (-not $parent -or $parent.Name -ne 'bun.exe' -or $parent.CreationDate -gt $proc.CreationDate) { break }
    $proc = $parent
  }
  return $proc
}

function Start-Server {
  # BROWSER=none stops `vite dev --open` opening a new tab on every restart.
  $env:BROWSER = 'none'
  $serverArgs = if ($Port -eq 8081) { @('--bun', 'run', 'start') } else { @('--bun', 'run', 'dev', '--port', "$Port", '--strictPort') }
  try {
    Start-Process -FilePath $bun -ArgumentList $serverArgs -WorkingDirectory $repo -WindowStyle Hidden
  } catch { Write-Log "start failed: $($_.Exception.Message)" }
}

# The Hermes gateway (Telegram, WhatsApp) only starts at login; nothing restarted it
# after a crash. Look for its `gateway run` process and start it if it's gone.
$hermes = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
function Test-Gateway {
  # Runs as `python -m hermes_cli.main gateway run` (older builds: `...\hermes_cli\main.py gateway run`).
  [bool](Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'hermes_cli[.\\/]main(\.py)?"?\s+gateway\s+run' })
}
$lastGatewayStart = [DateTime]::MinValue
function Confirm-Gateway {
  if ($NoGateway -or -not (Test-Path $hermes) -or (Test-Gateway)) { return }
  # Leave it alone for 3 minutes after a start so a slow boot isn't started twice.
  if (((Get-Date) - $script:lastGatewayStart).TotalMinutes -lt 3) { return }
  $script:lastGatewayStart = Get-Date
  Write-Log 'Hermes gateway not running; starting it'
  try {
    $out = & $hermes gateway start 2>&1 | Out-String
    Write-Log ('hermes gateway start: ' + (($out -split "`n" | Where-Object { $_ -match 'Gateway|rror' }) -join ' | ').Trim())
  } catch { Write-Log "gateway start failed: $($_.Exception.Message)" }
}

Write-Log "supervisor started (pid $PID, repo $repo, port $Port, probe /__version ${ProbeTimeoutSeconds}s x $MaxProbeFailures)"
$failures = 0
$probeFailures = 0
$hangRestarts = New-Object System.Collections.ArrayList
$lastListener = $null
while ($true) {
  $listenerPid = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
  # A new server process starts with a clean slate of failed probes.
  if ($listenerPid -and $listenerPid -ne $lastListener) { $probeFailures = 0; $lastListener = $listenerPid }
  if (-not (Test-Listening)) {
    $probeFailures = 0
    if (Test-AppOwnsServer) {
      Write-Log "Agentic OS not listening on $Port; the Jarvis app started this server and is bringing it back, so leaving it to the app"
      Start-Sleep -Seconds 15
      continue
    }
    $booting = Get-BootingServer
    if ($booting) {
      Write-Log "Agentic OS not listening on $Port yet; pid $($booting.ProcessId) (started $('{0:HH:mm:ss}' -f $booting.CreationDate)) is starting, so not starting a second copy"
      Start-Sleep -Seconds 15
      continue
    }
    Write-Log "Agentic OS not listening on $Port; starting it"
    Start-Server
    $up = $false
    for ($i = 0; $i -lt [Math]::Ceiling($BootWaitSeconds / 2); $i++) { Start-Sleep -Seconds 2; if (Test-Listening) { $up = $true; break } }
    if ($up) { Write-Log 'Agentic OS is up'; $failures = 0 }
    else {
      $failures++
      Write-Log "Agentic OS did not come up (attempt $failures)"
      # Back off so a broken build doesn't spin: 1, 2, 4 … up to 15 minutes.
      Start-Sleep -Seconds ([Math]::Min(900, 60 * [Math]::Pow(2, $failures - 1)))
      continue
    }
  } elseif (Test-Answering) {
    if ($probeFailures -gt 0) { Write-Log "Agentic OS answering again on $Port after $probeFailures failed probe(s)" }
    $probeFailures = 0
  } else {
    $probeFailures++
    Write-Log "Agentic OS listening on $Port but /__version didn't answer within ${ProbeTimeoutSeconds}s ($probeFailures of $MaxProbeFailures)"
    if ($probeFailures -ge $MaxProbeFailures -and (Test-AppOwnsServer)) {
      Write-Log "Agentic OS unresponsive, but the Jarvis app started this server and handles its hangs; leaving it to the app"
      $probeFailures = 0
    } elseif ($probeFailures -ge $MaxProbeFailures) {
      $cutoff = (Get-Date).AddMinutes(-$HangWindowMinutes)
      @($hangRestarts | Where-Object { $_ -lt $cutoff }) | ForEach-Object { [void]$hangRestarts.Remove($_) }
      if ($hangRestarts.Count -ge $MaxHangRestarts) {
        Write-Log "Agentic OS unresponsive, but it was already restarted $($hangRestarts.Count) times in $HangWindowMinutes min; not restarting again until the window passes (check memory and CPU)"
        if (((Get-Date) - $lastCapAlert).TotalMinutes -ge $HangWindowMinutes) {
          $lastCapAlert = Get-Date
          Send-Alert 'Agentic OS keeps hanging' "It was restarted $($hangRestarts.Count) times in $HangWindowMinutes minutes and still isn't answering, so the supervisor has stopped restarting it for now. Check memory and CPU, then restart it from the Jarvis tray."
        }
      } else {
        $root = Get-ServerTreeRoot
        if ($root) {
          Write-Log "Agentic OS unresponsive for $probeFailures probes; restarting it (killing bun tree pid $($root.ProcessId), restart $($hangRestarts.Count + 1) of $MaxHangRestarts in $HangWindowMinutes min)"
          & taskkill.exe /PID $root.ProcessId /T /F 2>&1 | Out-Null
          if ($LASTEXITCODE -ne 0) { Write-Log "taskkill of pid $($root.ProcessId) returned $LASTEXITCODE" }
          [void]$hangRestarts.Add((Get-Date))
          $probeFailures = 0
          for ($i = 0; $i -lt 15 -and (Test-Listening); $i++) { Start-Sleep -Seconds 1 }
          # Wait and re-check before starting a replacement (review T8 S-1): the app may be starting
          # one, and the not-listening path below then leaves it to the app.
          Start-Sleep -Seconds 5
          continue
        }
        Write-Log "Agentic OS unresponsive, but port $Port isn't held by a bun tree; leaving it alone"
      }
      $probeFailures = 0
    }
  }
  Confirm-Gateway
  Start-Sleep -Seconds $PollSeconds
}
