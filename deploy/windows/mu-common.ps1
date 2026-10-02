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
function Test-MuHttp {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSeconds = 10)
  try {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.Method = 'GET'
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
  & taskkill.exe /PID $ProcessId /T /F 2>&1 | Out-Null
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

# Pure data: the four tasks the installer registers. Tests read it too, so what is tested is what is installed.
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
  return @(
    [pscustomobject]@{ Name = 'MU Hub Supervisor'; Kind = 'AtStartup'; DelaySeconds = 45; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $hubArgs)); Restart = $true; Description = 'Runs the AgenticOS hub (bun) with bounded restarts. Installed by Install-MuHub.ps1.' }
    [pscustomobject]@{ Name = 'MU WSL KeepAlive'; Kind = 'AtStartup'; DelaySeconds = 0; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $wslArgs)); Restart = $true; Description = "Keeps the $Distro WSL distro running. Installed by Install-MuHub.ps1." }
    [pscustomobject]@{ Name = 'MU SearXNG'; Kind = 'AtStartup'; DelaySeconds = 60; At = $null; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $searxArgs)); Restart = $true; Description = "Starts and watches SearXNG inside $Distro. Installed by Install-MuHub.ps1." }
    [pscustomobject]@{ Name = 'MU Hub Backup'; Kind = 'Daily'; DelaySeconds = 0; At = $BackupTime; Execute = $ps; Arguments = (ConvertTo-MuArgString ($prefix + $backupArgs)); Restart = $false; Description = 'Daily verified backup of the hub data to a separate disk. Installed by Install-MuHub.ps1.' }
  )
}
