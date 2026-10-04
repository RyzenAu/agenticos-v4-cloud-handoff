# Nightly Hindsight database backup (M&U, 28 Sep 2026). See docs/HINDSIGHT-OPS.md section 15.
#
# Production: runs as SYSTEM from a PROTECTED copy (D:\hindsight-backups\bin\backup.ps1, installed by
# install-backup-task.ps1) with pg_dump from D:\hindsight-backups\bin\pgsql, writing into
# D:\hindsight-backups\<profile>, which Usman's account can read but not change or delete.
# Tests: the same script runs as the current user against the SYNTHETIC instance into a scratch folder.
#
# The DB password is read from its file into THIS process's environment only (PGPASSWORD) and removed
# afterwards. The status file records the failing STEP and PATH on error, never a secret value.
param(
  [string]$Profile = 'pilot',
  [int]$Port = 5432,
  [string]$Database = 'hindsight',
  [string]$User = 'hindsight',
  [string]$PasswordFile = 'D:\hindsight\service\secrets\pilot.db',
  [string]$OutDir = 'D:\hindsight-backups\pilot',
  [string]$PgBin = 'D:\hindsight-backups\bin\pgsql',
  [int]$KeepDays = 14
)
$ErrorActionPreference = 'Stop'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$status = [ordered]@{ profile = $Profile; started = (Get-Date).ToString('o'); ran_as = [Security.Principal.WindowsIdentity]::GetCurrent().Name;
  ok = $false; file = $null; bytes = 0; entries = 0; removed_old = 0; step = $null; path = $null; note = $null }
function Save-Status {
  $status.finished = (Get-Date).ToString('o')
  $status | ConvertTo-Json | Set-Content (Join-Path $OutDir 'last-backup.json') -Encoding utf8
}

$step = 'create output folder'; $target = $OutDir
try {
  New-Item -ItemType Directory -Force $OutDir | Out-Null
  $step = 'check database listener'; $target = "127.0.0.1:$Port"
  $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in '127.0.0.1', '::1' }
  if (-not $listening) { $status.note = 'skipped: database not running'; Save-Status; return }
  $step = 'read password file'; $target = $PasswordFile
  $env:PGPASSWORD = (Get-Content -Raw $PasswordFile).Trim()
  $partial = Join-Path $OutDir "hindsight-$ts.dump.partial"
  $final = Join-Path $OutDir "hindsight-$ts.dump"
  $step = 'pg_dump'; $target = $partial
  & (Join-Path $PgBin 'pg_dump.exe') -Fc -Z 6 -h 127.0.0.1 -p $Port -U $User -d $Database -f $partial 2>$null
  if ($LASTEXITCODE -ne 0) { throw "pg_dump exit $LASTEXITCODE" }
  $step = 'verify dump (pg_restore --list)'
  $list = & (Join-Path $PgBin 'pg_restore.exe') --list $partial 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $list) { throw 'pg_restore --list could not read the dump' }
  $step = 'finalise dump file'; $target = $final
  Move-Item $partial $final
  $status.ok = $true
  $status.file = Split-Path $final -Leaf
  $status.bytes = (Get-Item $final).Length
  $status.entries = @($list | Where-Object { $_ -and $_ -notmatch '^;' }).Count
  $step = 'remove dumps older than retention'; $target = $OutDir
  $old = Get-ChildItem $OutDir -Filter 'hindsight-*.dump*' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }
  $status.removed_old = @($old).Count
  $old | Remove-Item -Force
  $step = $null; $target = $null
} catch {
  $status.note = "failed: $($_.Exception.GetType().Name)"
  $status.step = $step
  $status.path = $target
  Get-ChildItem $OutDir -Filter '*.partial' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  try { Save-Status } catch { }
}
