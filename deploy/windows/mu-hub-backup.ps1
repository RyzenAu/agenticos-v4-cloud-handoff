<#
.SYNOPSIS
  Verified backup of the hub data directory to a separate physical disk.

.DESCRIPTION
  1. REFUSES (exit 3) if -OutDir is on the same physical disk as -DataDir (a backup on the disk that dies is not a
     backup). Disk numbers come from Get-Partition (CIM fallback). If they cannot be determined it also refuses.
     -AllowSameDisk overrides this; it exists for tests and throwaway runs only.
  2. Creates -OutDir if needed and restricts its ACL to the running user, SYSTEM and Administrators (backups hold credentials).
  3. bun scripts\cloud\backup-cli.ts backup --data-dir <DataDir> --out <OutDir> --keep <Keep>
  4. bun scripts\cloud\backup-cli.ts verify --from <the new backup folder>
  5. Appends one line to <LogDir>\mu-hub-backup.log and writes <LogDir>\last-backup.json
     {ok, time, path, files, verified, error}. No secrets are written to either.
  Exit codes: 0 ok, 1 backup failed, 2 verify failed, 3 refused (same or unknown disk), 4 bad parameters.

  Restore (always into an EMPTY, isolated folder; see README.md):
     bun scripts\cloud\backup-cli.ts restore --from <backup folder> --to <empty folder>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepoRoot,
  [Parameter(Mandatory)][string]$BunPath,
  [Parameter(Mandatory)][string]$DataDir,
  [Parameter(Mandatory)][string]$OutDir,
  [int]$Keep = 14,
  [Parameter(Mandatory)][string]$LogDir,
  [string]$StatusFile = '',
  [int]$TimeoutMinutes = 60,
  [switch]$AllowSameDisk
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'mu-common.ps1')

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'mu-hub-backup.log'
if (-not $StatusFile) { $StatusFile = Join-Path $LogDir 'last-backup.json' }

function Write-Status($ok, $path, $files, $verified, $error) {
  $obj = [ordered]@{
    ok       = [bool]$ok
    time     = (Get-Date).ToString('o')
    path     = $path
    files    = $files
    verified = [bool]$verified
    error    = $error
  }
  $tmp = "$StatusFile.tmp"
  [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $StatusFile -Force
}

function Finish($code, $ok, $path, $files, $verified, $message) {
  $err = if ($ok) { $null } else { $message }
  Write-Status $ok $path $files $verified $err
  Write-MuLog -Path $logFile -Message ("backup {0}: {1}" -f $(if ($ok) { 'OK' } else { 'FAILED' }), $message)
  exit $code
}

# ---- parameters
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'scripts\cloud\backup-cli.ts'))) { Finish 4 $false $null 0 $false "RepoRoot has no scripts\cloud\backup-cli.ts: $RepoRoot" }
if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { Finish 4 $false $null 0 $false "BunPath not found: $BunPath" }
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { Finish 4 $false $null 0 $false "DataDir not found: $DataDir" }
if ($Keep -lt 1) { Finish 4 $false $null 0 $false "Keep must be at least 1" }

# ---- same-disk refusal
$same = Test-MuSameDisk -PathA $DataDir -PathB $OutDir
if (-not $AllowSameDisk) {
  if ($null -eq $same) { Finish 3 $false $null 0 $false "REFUSED: cannot tell which physical disks hold $DataDir and $OutDir (UNC path, mount point or no permission). Use a drive-letter path on a separate disk." }
  if ($same) { Finish 3 $false $null 0 $false "REFUSED: $OutDir is on the same physical disk as the data dir $DataDir. Point -OutDir at the separate backup disk." }
} elseif ($same) {
  Write-MuLog -Path $logFile -Message "warning: -AllowSameDisk given and out dir shares a disk with the data dir (test use only)"
}

# ---- out dir + ACL
try {
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Set-MuPrivateAcl -Path $OutDir
} catch {
  Finish 4 $false $null 0 $false "could not create or secure $OutDir : $($_.Exception.Message)"
}

# ---- backup
$env:MU_DATA_DIR = $DataDir
if (-not $env:MU_HUB_ROLE) { $env:MU_HUB_ROLE = 'pc' }
$cli = 'scripts/cloud/backup-cli.ts'
$b = Invoke-MuProcess -FilePath $BunPath -ArgumentList @($cli, 'backup', '--data-dir', $DataDir, '--out', $OutDir, '--keep', "$Keep") -WorkingDirectory $RepoRoot -TimeoutSeconds ($TimeoutMinutes * 60)
if ($b.ExitCode -ne 0) {
  $why = (($b.Stderr + ' ' + $b.Stdout) -replace '\s+', ' ').Trim()
  if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }
  Finish 1 $false $null 0 $false "backup command failed (exit $($b.ExitCode), timed out: $($b.TimedOut)): $why"
}
$dir = $null; $files = 0
if ($b.Stdout -match '(?m)^backup:\s*(.+?)\s*$') { $dir = $Matches[1] }
if ($b.Stdout -match '(?m)^files:\s*(\d+)') { $files = [int]$Matches[1] }
if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) {
  Finish 1 $false $dir $files $false "backup command exited 0 but its folder was not reported or does not exist"
}

# ---- verify
$v = Invoke-MuProcess -FilePath $BunPath -ArgumentList @($cli, 'verify', '--from', $dir) -WorkingDirectory $RepoRoot -TimeoutSeconds ($TimeoutMinutes * 60)
if ($v.ExitCode -ne 0) {
  $why = (($v.Stdout + ' ' + $v.Stderr) -replace '\s+', ' ').Trim()
  if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }
  Finish 2 $false $dir $files $false "verify failed (exit $($v.ExitCode)): $why"
}

Finish 0 $true $dir $files $true "$dir ($files files, verified, keep $Keep)"
