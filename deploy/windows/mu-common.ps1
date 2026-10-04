# Shared helpers for the deploy\windows scripts. Dot-source it:  . (Join-Path $PSScriptRoot 'mu-common.ps1')
# Windows PowerShell 5.1 compatible. ASCII only (5.1 reads a BOM-less file as ANSI, so no smart quotes or dashes).
# Nothing in here ever prints or logs an environment VALUE: only names and counts.

Set-StrictMode -Version 2

# ---------------------------------------------------------------- logging

# Append one timestamped line. Rotates first: when the file passes MaxBytes it becomes .1, .1 becomes .2 ... up to Keep files.
function Write-MuLog {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Message,
    [long]$MaxBytes = 5MB,
    [int]$Keep = 3
  )
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
  try {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Invoke-MuLogRotation -Path $Path -MaxBytes $MaxBytes -Keep $Keep
    [IO.File]::AppendAllText($Path, $line + "`r`n", (New-Object Text.UTF8Encoding($false)))
  } catch { }
  # Also to the console so a dry run, a test and a manual run show it. Never a value.
  Write-Host $line
}

function Invoke-MuLogRotation {
  param([string]$Path, [long]$MaxBytes = 5MB, [int]$Keep = 3)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if ((Get-Item -LiteralPath $Path).Length -le $MaxBytes) { return }
  for ($i = $Keep - 1; $i -ge 1; $i--) {
    $from = "$Path.$i"; $to = "$Path.$($i + 1)"
    if (Test-Path -LiteralPath $from) { Move-Item -LiteralPath $from -Destination $to -Force }
  }
  Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
  # Anything beyond Keep is dropped.
  $extra = "$Path.$($Keep + 1)"
  if (Test-Path -LiteralPath $extra) { Remove-Item -LiteralPath $extra -Force }
}

# ---------------------------------------------------------------- env file

# Parses KEY=VALUE lines. Ignores blank lines and # comments, accepts a leading `export `, strips matching
# single or double quotes, and drops a trailing ` # comment` from unquoted values. Returns an ordered
# hashtable (name -> value). It prints nothing.
function Read-MuEnvFile {
  param([Parameter(Mandatory)][string]$Path)
  $result = [ordered]@{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "env file not found: $Path" }
  $text = [IO.File]::ReadAllText($Path)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  foreach ($raw in ($text -split "`r?`n")) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line -match '^export\s+') { $line = $line -replace '^export\s+', '' }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $line.Substring(0, $eq).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_.-]*$') { continue }
    $value = $line.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    } else {
      $hash = $value.IndexOf(' #')
      if ($hash -ge 0) { $value = $value.Substring(0, $hash).TrimEnd() }
    }
    $result[$name] = $value
  }
  return $result
}

# Loads the file into THIS process's environment (children inherit it). Returns only the variable NAMES.
function Set-MuEnvFromFile {
  param([Parameter(Mandatory)][string]$Path)
  $vars = Read-MuEnvFile -Path $Path
  foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, [string]$vars[$k], 'Process') }
  return @($vars.Keys)
}

# ---------------------------------------------------------------- backoff / give-up

# Delay before restart number Attempt (1 = first retry). Past the end of the schedule it stays on the last value.
function Get-MuBackoffSeconds {
  param([Parameter(Mandatory)][int]$Attempt, [int[]]$Schedule = @(2, 5, 15, 60))
  if ($Attempt -lt 1) { $Attempt = 1 }
  $i = [Math]::Min($Attempt, $Schedule.Count) - 1
  return [int]$Schedule[$i]
}

# True when Max or more failures happened inside the last WindowSeconds. Times is a list of [datetime].
function Test-MuGiveUp {
  param([datetime[]]$Times = @(), [Parameter(Mandatory)][int]$Max, [Parameter(Mandatory)][int]$WindowSeconds, [datetime]$Now = (Get-Date))
  $cut = $Now.AddSeconds(-$WindowSeconds)
  $recent = @($Times | Where-Object { $_ -ge $cut })
  return ($recent.Count -ge $Max)
}

# ---------------------------------------------------------------- network

# True when anything is listening on the TCP port (any address). Needs no admin rights.
function Test-MuPortInUse {
  param([Parameter(Mandatory)][int]$Port)
  $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  return [bool]($listeners | Where-Object { $_.Port -eq $Port })
}

# Name and pid of whatever listens on the port, for the log line. Best effort, never throws.
function Get-MuPortOwner {
  param([int]$Port)
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($p) { return "$($p.ProcessName) (pid $($c.OwningProcess))" }
    return "pid $($c.OwningProcess)"
  } catch { return 'unknown process' }
}

# HTTP GET with a hard timeout and no proxy. Answered = any HTTP status came back (a live process),
# false only when the connection fails or times out. Body is never kept.
# -HostHeader: send this Host instead of the URL's. The hub only answers names it knows (vite allowedHosts), and it decides
# "at the hub" from the Host, so a probe of the PUBLIC surface (Tailscale Serve or Funnel name) from this PC must connect to
# 127.0.0.1 but carry the public Host, or it tests something else (a loopback request that is never refused).
function Test-MuHttp {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 10, [string]$HostHeader = '')
  try {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
    if ($HostHeader) { $req.Host = $HostHeader }
    $req.Timeout = $TimeoutSeconds * 1000
    $req.ReadWriteTimeout = $TimeoutSeconds * 1000
    $req.Proxy = $null
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    return [pscustomobject]@{ Answered = $true; Status = $code }
  } catch [Net.WebException] {
    if ($_.Exception.Response) {
      $code = [int]$_.Exception.Response.StatusCode
      $_.Exception.Response.Close()
      return [pscustomobject]@{ Answered = $true; Status = $code }
    }
    return [pscustomobject]@{ Answered = $false; Status = 0 }
  } catch {
    return [pscustomobject]@{ Answered = $false; Status = 0 }
  }
}

# ---------------------------------------------------------------- mutex

# Returns the mutex when this process is the only holder, otherwise $null. Keep the returned object alive.
function Get-MuMutex {
  param([Parameter(Mandatory)][string]$Name)
  $created = $false
  $m = New-Object System.Threading.Mutex($true, $Name, [ref]$created)
  if (-not $created) { $m.Dispose(); return $null }
  return $m
}

# ---------------------------------------------------------------- processes

# Quote an argument list for a Windows command line (CreateProcess rules).
function ConvertTo-MuArgString {
  param([string[]]$ArgumentList = @())
  $parts = foreach ($a in $ArgumentList) {
    if ($null -eq $a) { $a = '' }
    if ($a -ne '' -and $a -notmatch '[\s"]') { $a; continue }
    $s = $a -replace '(\\*)"', '$1$1\"'
    $s = $s -replace '(\\+)$', '$1$1'
    '"' + $s + '"'
  }
  return ($parts -join ' ')
}

# Runs a program, captures stdout, stderr and the exit code, kills the tree on timeout. Inherits this process's environment.
function Invoke-MuProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory = '',
    [int]$TimeoutSeconds = 3600
  )
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ConvertTo-MuArgString -ArgumentList $ArgumentList
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  $p = [Diagnostics.Process]::Start($psi)
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $timedOut = $false
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    $timedOut = $true
    & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
    [void]$p.WaitForExit(5000)
  } else { $p.WaitForExit() }
  $code = if ($timedOut) { -1 } else { $p.ExitCode }
  return [pscustomobject]@{ ExitCode = $code; Stdout = $outTask.Result; Stderr = $errTask.Result; TimedOut = $timedOut }
}

# Kill a process and everything it started. Only ever called with a PID this script started.
function Stop-MuProcessTree {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return }
  try { & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null } catch { }   # a process that already exited is not an error (stderr becomes an exception under -ErrorAction Stop)
}

# ---------------------------------------------------------------- disks and ACLs

# Physical disk number(s) behind a path's drive letter, or $null if it cannot be worked out (UNC, mount point, no permission).
function Get-MuDiskNumber {
  param([Parameter(Mandatory)][string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($full)
  if ($root -notmatch '^[A-Za-z]:\\$') { return $null }
  $letter = $root.Substring(0, 1)
  try {
    $parts = @(Get-Partition -DriveLetter $letter -ErrorAction Stop)
    if ($parts.Count -gt 0) { return @($parts | ForEach-Object { [int]$_.DiskNumber } | Sort-Object -Unique) }
  } catch { }
  try {
    $ld = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" -ErrorAction Stop
    $part = @(Get-CimAssociatedInstance -InputObject $ld -Association Win32_LogicalDiskToPartition -ErrorAction Stop)
    $disks = foreach ($pt in $part) { Get-CimAssociatedInstance -InputObject $pt -Association Win32_DiskDriveToDiskPartition -ErrorAction Stop }
    $nums = @($disks | ForEach-Object { [int]$_.Index } | Sort-Object -Unique)
    if ($nums.Count -gt 0) { return $nums }
  } catch { }
  return $null
}

# $true = share a physical disk, $false = different disks, $null = cannot tell.
function Test-MuSameDisk {
  param([Parameter(Mandatory)][string]$PathA, [Parameter(Mandatory)][string]$PathB)
  $a = Get-MuDiskNumber -Path $PathA
  $b = Get-MuDiskNumber -Path $PathB
  if ($null -eq $a -or $null -eq $b) { return $null }
  return [bool](@($a | Where-Object { @($b) -contains $_ }).Count -gt 0)
}

# Only the running user, SYSTEM and Administrators keep access; inheritance from the parent is cut.
function Set-MuPrivateAcl {
  param([Parameter(Mandatory)][string]$Path)
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $admins = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  # Access section only: Get-Acl would also read the SACL, which needs SeSecurityPrivilege.
  $item = Get-Item -LiteralPath $Path
  $acl = $item.GetAccessControl('Access')
  $acl.SetAccessRuleProtection($true, $false)   # cut inheritance, drop inherited entries
  foreach ($r in @($acl.Access)) { [void]$acl.RemoveAccessRule($r) }
  $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach ($sid in @($me, $system, $admins)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  $item.SetAccessControl($acl)
}

# ---------------------------------------------------------------- WSL

# wsl.exe writes UTF-16 to a pipe; strip the NULs so -match works.
function Get-MuWslDistros {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  if (-not (Test-Path -LiteralPath $wsl)) { return @() }
  $out = (& $wsl -l -q 2>$null | Out-String) -replace "`0", ''
  return @($out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

# ---------------------------------------------------------------- scheduled task plan

# Pure data: the five tasks the installer registers. Tests read it too, so what is tested is what is installed.
function Get-MuTaskPlan {
  param(
    [Parameter(Mandatory)][string]$ScriptDir,
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$BunPath,
    [Parameter(Mandatory)][string]$DataDir,
    [Parameter(Mandatory)][string]$LogDir,
    [Parameter(Mandatory)][string]$BackupDir,
    [string]$EnvFile = '',
    [int]$Port = 8081,
    [string]$Distro = 'kali-linux',
    [int]$SearxngPort = 18888,
    [int]$BackupKeep = 14,
    [string]$BackupTime = '03:15'
  )
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $prefix = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File')
  $hubArgs = @((Join-Path $ScriptDir 'mu-hub-supervisor.ps1'), '-RepoRoot', $RepoRoot, '-BunPath', $BunPath, '-Port', "$Port", '-DataDir', $DataDir, '-LogDir', $LogDir)
  if ($EnvFile) { $hubArgs += @('-EnvFile', $EnvFile) }
  $wslArgs = @((Join-Path $ScriptDir 'mu-wsl-keepalive.ps1'), '-Distro', $Distro, '-LogDir', $LogDir)
  $searxArgs = @((Join-Path $ScriptDir 'mu-searxng.ps1'), '-Distro', $Distro, '-Port', "$SearxngPort", '-LogDir', $LogDir)
  $backupArgs = @((Join-Path $ScriptDir 'mu-hub-backup.ps1'), '-RepoRoot', $RepoRoot, '-BunPath', $BunPath, '-DataDir', $DataDir, '-OutDir', $BackupDir, '-Keep', "$BackupKeep", '-LogDir', $LogDir)
  $healthArgs = @((Join-Path $ScriptDir 'mu-health-check.ps1'), '-RepoRoot', $RepoRoot, '-BunPath', $BunPath, '-DataDir', $DataDir, '-LogDir', $LogDir, '-HubPort', "$Port", '-SearxngPort', "$SearxngPort", '-Distro', $Distro)
  return @(
    [pscustomobject]@{ Name = 'MU Hub Supervisor'; Kind = 'AtStartup'; DelaySeconds = 45; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $hubArgs)); Restart = $true; Description = 'Runs the AgenticOS hub (bun) with bounded restarts. Installed by Install-MuHub.ps1.' }
    [pscustomobject]@{ Name = 'MU WSL KeepAlive'; Kind = 'AtStartup'; DelaySeconds = 0; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $wslArgs)); Restart = $true; Description = "Keeps the $Distro WSL distro running. Installed by Install-MuHub.ps1." }
    [pscustomobject]@{ Name = 'MU SearXNG'; Kind = 'AtStartup'; DelaySeconds = 60; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $searxArgs)); Restart = $true; Description = "Starts and watches SearXNG inside $Distro. Installed by Install-MuHub.ps1." }
    [pscustomobject]@{ Name = 'MU Hub Backup'; Kind = 'Daily'; DelaySeconds = 0; At = $BackupTime; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $backupArgs)); Restart = $false; Description = 'Daily verified backup of the hub data to a separate disk. Installed by Install-MuHub.ps1.' }
    # R9 ops: at startup (+3 min) and every 5 minutes; read-only checks, then alerts (System/Home page, Event Log, owner's Telegram).
    [pscustomobject]@{ Name = 'MU Health Check'; Kind = 'Repeat'; DelaySeconds = 180; IntervalMinutes = 5; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $healthArgs)); Restart = $false; Description = 'Every 5 minutes: checks the hub, Hindsight, search, Hermes, backups, disks and sign-in records; raises alerts. Installed by Install-MuHub.ps1.' }
  )
}

# ---------------------------------------------------------------- re-registering a live task (R9 ops)

# What re-registering would lose: for each of -WslUser, -SearxngWslUser, -HubRole, -EnvFile present in the LIVE task's arguments, a line
# when the PLANNED arguments drop it or change its value. Empty = safe. Values are names and paths only (never an env value).
function Get-MuDroppedTaskArgs {
  param([AllowEmptyString()][string]$Planned = '', [AllowEmptyString()][string]$Live = '')
  $out = @()
  foreach ($name in 'WslUser', 'SearxngWslUser', 'HubRole', 'EnvFile') {
    $rx = '(?i)(?:^|\s)-' + $name + '\s+("[^"]*"|\S+)'
    $lm = [regex]::Match($Live, $rx)
    if (-not $lm.Success) { continue }
    $lv = $lm.Groups[1].Value.Trim('"')
    $pm = [regex]::Match($Planned, $rx)
    if (-not $pm.Success) { $out += "-$name $lv would be dropped"; continue }
    $pv = $pm.Groups[1].Value.Trim('"')
    if ($pv -ne $lv) { $out += "-$name would change from $lv to $pv" }
  }
  return @($out)
}

# ---------------------------------------------------------------- env file writing (R7 G, 3 Oct 2026)

# Why this exists: hub.env was written without a final newline, and an append with the plain Add-Content cmdlet glued the new setting onto the
# last line (LASTKEY=valueNEW=1): two settings lost, no error. Never append with Add-Content. Use this, which returns only
# 'added', 'replaced' or 'unchanged' (never a value) and keeps the file's own line endings.
function Set-MuEnvSetting {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value
  )
  if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw "not a valid setting name: $Name" }
  if ($Value -match "[`r`n]") { throw "the value for $Name has a line break; refusing" }
  $text = ''
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $text = [IO.File]::ReadAllText($Path)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  }
  $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines = New-Object System.Collections.ArrayList
  if ($text.Length -gt 0) { foreach ($l in ($text -split "`r?`n")) { [void]$lines.Add($l) } }
  # A final newline makes the split end with one empty element: drop it, it is re-added on write.
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  $outcome = 'added'
  $placed = $false
  $result = New-Object System.Collections.ArrayList
  foreach ($l in $lines) {
    $t = $l.Trim()
    if ($t -cmatch ('^(export\s+)?' + [regex]::Escape($Name) + '\s*=')) {   # names are case-sensitive: api_key is not API_KEY
      if (-not $placed) {
        $current = (Read-MuEnvLine $t)
        $outcome = if ($current -ceq $Value) { 'unchanged' } else { 'replaced' }
        [void]$result.Add("$Name=$(Format-MuEnvValue $Value)")
        $placed = $true
      } else { $outcome = 'replaced' }   # a duplicate of the same name: dropped
      continue
    }
    [void]$result.Add($l)
  }
  if (-not $placed) { [void]$result.Add("$Name=$(Format-MuEnvValue $Value)") }
  $new = ($result -join $eol) + $eol
  if ($outcome -ne 'unchanged') {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = "$Path.tmp-$PID"
    $bak = "$Path.bak-$PID"
    try {
      [IO.File]::WriteAllText($tmp, $new, (New-Object Text.UTF8Encoding($false)))
      if (Test-Path -LiteralPath $Path) {
        # File.Replace swaps the contents in one step and keeps the destination's ACL and attributes (a Move would give the file the
        # folder's ACL instead). PowerShell 5.1 needs the backup name; it is deleted again below (it would hold every secret).
        [IO.File]::Replace($tmp, $Path, $bak)
      } else {
        [IO.File]::Move($tmp, $Path)
      }
    } finally {
      foreach ($leftover in @($tmp, $bak)) { if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Force -ErrorAction SilentlyContinue } }
    }
  }
  return $outcome
}

# How a value is written so that Read-MuEnvFile gives back exactly the same string: bare when that is safe, otherwise in double quotes (the reader
# strips one matching pair at the ends and keeps everything inside, so inner quotes and ' #' survive).
function Format-MuEnvValue {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  if ($Value -match '^\s|\s$' -or $Value.Contains(' #') -or $Value -match '^["'']|["'']$') { return '"' + $Value + '"' }
  return $Value
}

# The value of one KEY=VALUE line, parsed the way Read-MuEnvFile parses it.
function Read-MuEnvLine {
  param([Parameter(Mandatory)][string]$Line)
  $line = $Line.Trim() -replace '^export\s+', ''
  $eq = $line.IndexOf('=')
  if ($eq -lt 1) { return '' }
  $value = $line.Substring($eq + 1).Trim()
  if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') -or ($value[0] -eq "'" -and $value[$value.Length - 1] -eq "'"))) { return $value.Substring(1, $value.Length - 2) }
  $hash = $value.IndexOf(' #')
  if ($hash -ge 0) { $value = $value.Substring(0, $hash).TrimEnd() }
  return $value
}

# Problems in an env file that make a setting silently disappear. Returns strings naming the LINE NUMBER and the setting NAME only
# (never a value). Empty = nothing found.
function Get-MuEnvFileProblems {
  param([Parameter(Mandatory)][string]$Path)
  $problems = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @("file not found") }
  $text = [IO.File]::ReadAllText($Path)
  if ($text.Length -gt 0 -and -not ($text.EndsWith("`n"))) { [void]$problems.Add('no newline at the end: the next appended setting would be glued onto the last line') }
  $definedNames = New-Object System.Collections.ArrayList
  foreach ($raw in ($text -split "`r?`n")) {
    $l0 = ($raw.Trim() -replace '^export\s+', '')
    $e0 = $l0.IndexOf('=')
    if ($e0 -ge 1 -and -not $l0.StartsWith('#')) { [void]$definedNames.Add($l0.Substring(0, $e0).Trim()) }
  }
  $n = 0
  foreach ($raw in ($text -split "`r?`n")) {
    $n++
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $line = $line -replace '^export\s+', ''
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { [void]$problems.Add("line ${n}: not KEY=VALUE"); continue }
    $name = $line.Substring(0, $eq).Trim()
    $value = $line.Substring($eq + 1)
    # A second NAME= inside an unquoted value: the shape a plain append leaves behind (LASTKEY=valueNEW=1, LASTKEY=valueNEW_KEY=1). Case-sensitive: a
    # setting name is upper case and starts right after a lower-case letter, digit or quote, and is followed by a value (so base64 padding, "&ab_cd=2" and
    # "?A=1" in a URL are not flagged). Also flagged: any NAME defined elsewhere in this file appearing inside this value.
    $glued = ($value -notmatch '^\s*["'']') -and ($value -cmatch '[a-z0-9"''][A-Z][A-Z0-9_]+=[^=\s]')
    if (-not $glued -and $value -notmatch '^\s*["'']') { foreach ($other in $definedNames) { if ($other -cne $name -and $value.Contains($other + '=')) { $glued = $true; break } } }
    if ($glued) { [void]$problems.Add("line ${n}: $name looks like two settings glued together") }
  }
  return @($problems)
}

# ---------------------------------------------------------------- sessions that end

# True inside an SSH login. A process started from one is in that session's job: when the ssh connection closes (or the client
# disconnects), Windows ends it, and the hub or rehearsal you just started dies with no log line. Long-running things belong to
# a scheduled task (the MU tasks, S4U) or to Start-MuDetached below.
function Test-MuSshSession {
  return [bool]($env:SSH_CONNECTION -or $env:SSH_CLIENT -or $env:SSH_TTY)
}

# Starts a program OUTSIDE this session (through WMI Win32_Process.Create), so it survives the end of an SSH login. Returns its PID.
# It does NOT inherit this process's environment (WMI's own is used): the program must set what it needs itself.
function Start-MuDetached {
  param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @(), [string]$WorkingDirectory = '')
  $cmd = '"' + $FilePath + '" ' + (ConvertTo-MuArgString -ArgumentList $ArgumentList)
  $args2 = @{ CommandLine = $cmd }
  if ($WorkingDirectory) { $args2['CurrentDirectory'] = $WorkingDirectory }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $args2
  if ($r.ReturnValue -ne 0) { throw "Win32_Process Create failed (return value $($r.ReturnValue))" }
  return [int]$r.ProcessId
}

# ---------------------------------------------------------------- sign-in records (R8 F)

# $null when <DataDir>\devices.json is absent or is a readable sign-in record (a JSON object with a sessions list); otherwise one line
# saying why it can't be read. The hub refuses to overwrite such a file, so pairing and sign-in fail until the owner restores it; this
# puts the reason in the supervisor log. Reads with full sharing (never blocks the hub's own write); prints nothing from the file.
function Get-MuSessionStoreProblem {
  param([Parameter(Mandatory)][string]$DataDir)
  $path = Join-Path $DataDir 'devices.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite,Delete')
    try { $text = (New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding($false)))).ReadToEnd() } finally { $fs.Dispose() }
  } catch { return "devices.json could not be opened ($($_.Exception.GetType().Name))" }
  try { $o = $text | ConvertFrom-Json -ErrorAction Stop } catch { return 'devices.json is not valid JSON' }
  $props = if ($null -eq $o -or $o -is [array] -or $o -isnot [pscustomobject]) { @() } else { @($o.PSObject.Properties | ForEach-Object { $_.Name }) }
  if (($props -notcontains 'sessions') -or -not ($o.sessions -is [array])) {
    return 'devices.json is not a sign-in record (expected an object with a sessions list)'
  }
  return $null
}
