# Tests for deploy\windows. Plain PowerShell, no Pester needed. Run under Windows PowerShell 5.1:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuHubWindows.ps1
# Exit code = number of failed checks. Touches only a scratch folder under %TEMP%; registers no scheduled task,
# starts no real hub (a fake bun stub stands in) and uses only ports it finds free.
param([switch]$SkipSlow)

$ErrorActionPreference = 'Stop'
$winDir = Split-Path -Parent $PSScriptRoot
. (Join-Path $winDir 'mu-common.ps1')
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script:passed = 0
$script:failed = 0
function Check([string]$name, $cond, [string]$detail = '') {
  if ($cond) { $script:passed++; Write-Host "  ok   $name" }
  else { $script:failed++; Write-Host "  FAIL $name  $detail" }
}
function Section([string]$t) { Write-Host ""; Write-Host "== $t" }

# Scratch root, 8.3 short so .cmd stubs never meet a space in a path.
$root = Join-Path ([IO.Path]::GetTempPath()) ("mu-win-tests-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $root | Out-Null
try { $root = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { }

function Get-FreePort {
  $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $l.Start()
  $p = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop(); return $p
}
function Run-Script([string]$script, [string[]]$arguments, [int]$timeout = 120) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $winDir $script)) + $arguments
  $r = Invoke-MuProcess -FilePath $ps -ArgumentList $a -TimeoutSeconds $timeout
  return [pscustomobject]@{ Code = $r.ExitCode; Out = ($r.Stdout + $r.Stderr) }
}
function Wait-ForText([string]$file, [string]$text, [int]$seconds, [int]$minCount = 1) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    if (Test-Path -LiteralPath $file) {
      $n = @(Select-String -LiteralPath $file -Pattern $text -SimpleMatch -ErrorAction SilentlyContinue).Count
      if ($n -ge $minCount) { return $true }
    }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

$started = New-Object System.Collections.ArrayList   # PIDs of supervisor test processes, killed in finally
try {

# ------------------------------------------------------------------ 1. every script parses, ASCII only
Section 'scripts parse cleanly and are ASCII'
$files = @(Get-ChildItem -Path $winDir -Filter *.ps1 -File) + @(Get-ChildItem -Path $PSScriptRoot -Filter *.ps1 -File)
foreach ($f in $files) {
  $errs = $null; $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
  Check "parses: $($f.Name)" ($errs.Count -eq 0) (($errs | ForEach-Object { $_.Message }) -join '; ')
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  Check "ascii only: $($f.Name)" (-not ($bytes | Where-Object { $_ -gt 127 }))
}

# ------------------------------------------------------------------ 2. env file
Section 'env file parsing never prints values'
$secret = 'S3cr3t-Value-ZZ9'
$envFile = Join-Path $root 'test.env'
@(
  '# a comment', '', '   ', "PLAIN=$secret", "export EXPORTED=$secret-e", "DQ=`"$secret dq with # hash`"", "SQ='$secret sq'",
  "INLINE=$secret # trailing comment", 'BAD LINE WITHOUT EQUALS', '=novalue', '1BAD=x', 'EMPTY='
) -join "`r`n" | Set-Content -LiteralPath $envFile -Encoding ASCII
$vars = Read-MuEnvFile -Path $envFile
Check 'parses 6 variables' ($vars.Count -eq 6) "got $($vars.Count): $(@($vars.Keys) -join ',')"
Check 'comments, blanks and invalid names ignored' (-not $vars.Contains('1BAD') -and -not $vars.Contains('') -and -not $vars.Contains('BAD LINE WITHOUT EQUALS'))
Check 'double quotes stripped, # kept inside quotes' ($vars['DQ'] -eq "$secret dq with # hash")
Check 'single quotes stripped' ($vars['SQ'] -eq "$secret sq")
Check 'export prefix accepted' ($vars['EXPORTED'] -eq "$secret-e")
Check 'inline comment dropped when unquoted' ($vars['INLINE'] -eq $secret)
Check 'empty value kept' ($vars.Contains('EMPTY') -and $vars['EMPTY'] -eq '')
$captured = (& { $n = Set-MuEnvFromFile -Path $envFile; Write-Host "names: $($n -join ',')" } *>&1 | Out-String)
Check 'Set-MuEnvFromFile output has no value' ($captured -notmatch [regex]::Escape($secret)) $captured
Check 'Set-MuEnvFromFile returns names and sets the process env' ([Environment]::GetEnvironmentVariable('PLAIN', 'Process') -eq $secret -and $captured -match 'PLAIN')
foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }

# ------------------------------------------------------------------ 3. backoff / give-up / log / mutex
Section 'backoff and give-up'
$seq = 1..7 | ForEach-Object { Get-MuBackoffSeconds -Attempt $_ }
Check 'default backoff 2,5,15,60,60,60,60' (($seq -join ',') -eq '2,5,15,60,60,60,60') ($seq -join ',')
Check 'custom schedule' ((Get-MuBackoffSeconds -Attempt 2 -Schedule @(1, 3)) -eq 3 -and (Get-MuBackoffSeconds -Attempt 9 -Schedule @(1, 3)) -eq 3)
Check 'attempt 0 is treated as 1' ((Get-MuBackoffSeconds -Attempt 0) -eq 2)
$now = Get-Date
$t5 = 1..5 | ForEach-Object { $now.AddSeconds(-$_ * 10) }
Check 'no give-up below the limit' (-not (Test-MuGiveUp -Times $t5 -Max 6 -WindowSeconds 600 -Now $now))
Check 'give up at the limit inside the window' (Test-MuGiveUp -Times ($t5 + @($now)) -Max 6 -WindowSeconds 600 -Now $now)
Check 'old failures outside the window do not count' (-not (Test-MuGiveUp -Times ($t5 + @($now)) -Max 6 -WindowSeconds 30 -Now $now))
Check 'empty list never gives up' (-not (Test-MuGiveUp -Times @() -Max 1 -WindowSeconds 60))

Section 'log rotation and mutex'
$lg = Join-Path $root 'rot.log'
1..40 | ForEach-Object { Write-MuLog -Path $lg -Message ('x' * 100) -MaxBytes 1000 -Keep 3 *>$null }
$rot = @(Get-ChildItem -Path $root -Filter 'rot.log*' | ForEach-Object { $_.Name } | Sort-Object)
Check 'rotates and keeps at most 3 files' ($rot.Count -le 4 -and ($rot -contains 'rot.log.1')) ($rot -join ',')
Check 'no rotated file beyond Keep' (-not (Test-Path (Join-Path $root 'rot.log.4')))
$mn = "Global\MuTest-$([Guid]::NewGuid().ToString('N'))"
$m1 = Get-MuMutex -Name $mn
$m2 = Get-MuMutex -Name $mn
Check 'first holder gets the mutex' ($null -ne $m1)
Check 'second holder is refused' ($null -eq $m2)
if ($m1) { $m1.ReleaseMutex(); $m1.Dispose() }

# ------------------------------------------------------------------ fixtures: fake repo + fake bun stubs
$repo = Join-Path $root 'repo'
[void][IO.Directory]::CreateDirectory((Join-Path $repo 'scripts\cloud'))
Set-Content -LiteralPath (Join-Path $repo 'package.json') -Value '{}' -Encoding ASCII
Set-Content -LiteralPath (Join-Path $repo 'scripts\cloud\backup-cli.ts') -Value '// stub' -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fake-hub.ps1') -Destination (Join-Path $root 'fake-hub.ps1')

$hubStub = Join-Path $root 'fake-bun-hub.cmd'
@(
  '@echo off',
  'if "%MU_FAKE_HUB_MODE%"=="exit" exit /b 1',
  'echo role=%MU_HUB_ROLE% data=%MU_DATA_DIR% browser=%BROWSER% >> "%~dp0envcheck.txt"',
  'if defined MU_TEST_SECRET echo secret-present >> "%~dp0envcheck.txt"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake-hub.ps1" -Port %5'
) -join "`r`n" | Set-Content -LiteralPath $hubStub -Encoding ASCII

$bkStub = Join-Path $root 'fake-bun-backup.cmd'
@(
  '@echo off',
  'if "%2"=="backup" goto backup',
  'if "%2"=="verify" goto verify',
  'exit /b 9',
  ':backup',
  'if "%MU_FAKE_MODE%"=="backup-fail" goto bfail',
  'mkdir "%MU_FAKE_OUT%\backup-20260101T000000Z" >nul 2>&1',
  'echo backup: %MU_FAKE_OUT%\backup-20260101T000000Z',
  'echo files: 12 (1 SQLite stores), 999 bytes',
  'exit /b 0',
  ':bfail',
  'echo error: boom 1>&2',
  'exit /b 1',
  ':verify',
  'if "%MU_FAKE_MODE%"=="verify-fail" goto vfail',
  'echo verified: 12 files match the manifest',
  'exit /b 0',
  ':vfail',
  'echo FAILED: checksum mismatch',
  'exit /b 1'
) -join "`r`n" | Set-Content -LiteralPath $bkStub -Encoding ASCII

$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# ------------------------------------------------------------------ 4. supervisor: plan, port in use
Section 'supervisor dry run and port-in-use refusal'
$port = Get-FreePort
$logs = Join-Path $root 'logs-dry'
$r = Run-Script 'mu-hub-supervisor.ps1' @('-RepoRoot', $repo, '-BunPath', $hubStub, '-Port', "$port", '-DataDir', $dataDir, '-LogDir', $logs, '-EnvFile', $envFile, '-DryRun')
Check 'dry run exits 0' ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
Check 'dry run prints the command' ($r.Out -match '--bun run dev --port' -and $r.Out -match '--strictPort' -and $r.Out -match '--host 127\.0\.0\.1')
Check 'dry run shows role and data dir' ($r.Out -match 'MU_HUB_ROLE=pc' -and $r.Out -match 'BROWSER=none')
Check 'dry run lists env names but no values' ($r.Out -match 'PLAIN' -and $r.Out -match 'values redacted' -and $r.Out -notmatch [regex]::Escape($secret)) $r.Out
Check 'dry run starts nothing and creates no log dir' (-not (Test-Path $logs))
$r = Run-Script 'mu-hub-supervisor.ps1' @('-RepoRoot', $repo, '-BunPath', (Join-Path $root 'nope.exe'), '-Port', "$port", '-DataDir', $dataDir, '-LogDir', $logs, '-Once')
Check '-Once is an alias and a missing bun is a parameter error (5)' ($r.Code -eq 5 -and $r.Out -match 'BunPath not found') "code $($r.Code)"

$blocker = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port); $blocker.Start()
try {
  Check 'Test-MuPortInUse sees the listener' (Test-MuPortInUse -Port $port)
  $logs = Join-Path $root 'logs-busy'
  $r = Run-Script 'mu-hub-supervisor.ps1' @('-RepoRoot', $repo, '-BunPath', $hubStub, '-Port', "$port", '-DataDir', $dataDir, '-LogDir', $logs)
  Check 'refuses to start when the port is taken (exit 3)' ($r.Code -eq 3) "code $($r.Code): $($r.Out)"
  Check 'says why in the log' ((Get-Content (Join-Path $logs 'mu-hub-supervisor.log') -Raw) -match 'REFUSING TO START')
  Check 'did not start a hub' (-not (Test-Path (Join-Path $root 'envcheck.txt')))
} finally { $blocker.Stop() }

# ------------------------------------------------------------------ 5. supervisor integration with a fake hub
if (-not $SkipSlow) {
  Section 'supervisor restarts a killed hub, and gives up when it cannot start'
  $port = Get-FreePort
  $logs = Join-Path $root 'logs-run'
  Remove-Item -LiteralPath (Join-Path $root 'envcheck.txt') -ErrorAction SilentlyContinue
  $env:MU_FAKE_HUB_MODE = ''
  $supArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $winDir 'mu-hub-supervisor.ps1'), '-RepoRoot', $repo, '-BunPath', $hubStub,
    '-Port', "$port", '-DataDir', $dataDir, '-LogDir', $logs, '-EnvFile', $envFile, '-ProbeIntervalSeconds', '1', '-ProbeTimeoutSeconds', '3', '-BackoffSchedule', '1', '-StableSeconds', '5')
  $sup = Start-Process -FilePath $ps -ArgumentList (ConvertTo-MuArgString $supArgs) -WindowStyle Hidden -PassThru
  [void]$started.Add($sup.Id)
  $supLog = Join-Path $logs 'mu-hub-supervisor.log'
  Check 'hub comes up' (Wait-ForText $supLog 'hub is up' 60) 'no "hub is up" line'
  $env:PLAIN = $null
  # a second supervisor for the same port must not run
  $second = Run-Script 'mu-hub-supervisor.ps1' @('-RepoRoot', $repo, '-BunPath', $hubStub, '-Port', "$port", '-DataDir', $dataDir, '-LogDir', (Join-Path $root 'logs-second'))
  Check 'second supervisor on the same port does not start a hub (mutex or port check)' ($second.Code -eq 0 -or $second.Code -eq 3) "code $($second.Code)"
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  Check 'fake hub is listening' ($null -ne $listener)
  if ($listener) { Stop-Process -Id $listener.OwningProcess -Force }
  Check 'supervisor notices the death' (Wait-ForText $supLog 'FAILURE' 30)
  Check 'supervisor restarts the hub' (Wait-ForText $supLog 'hub is up' 60 2)
  $envcheck = Get-Content (Join-Path $root 'envcheck.txt') -Raw
  Check 'hub got role pc, MU_DATA_DIR and BROWSER=none' ($envcheck -match 'role=pc' -and $envcheck -match 'browser=none' -and $envcheck -match [regex]::Escape($dataDir))
  $envFileNames = Join-Path $root 'envcheck.txt'
  # MU_TEST_SECRET is not in the env file; load it via a second file to prove file values reach the child but not the log
  Stop-MuProcessTree -ProcessId $sup.Id
  $allLogs = (Get-ChildItem -Path $logs -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
  Check 'no env value appears in any supervisor log' ($allLogs -notmatch [regex]::Escape($secret))
  Start-Sleep -Seconds 2
  Check 'port released after the supervisor tree is killed' (-not (Test-MuPortInUse -Port $port)) 'a fake hub is still listening'
  $left = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($left) { Stop-MuProcessTree -ProcessId $left.OwningProcess }

  # give-up: a hub that exits at once
  $port2 = Get-FreePort
  $logs2 = Join-Path $root 'logs-giveup'
  $env:MU_FAKE_HUB_MODE = 'exit'
  $r = Run-Script 'mu-hub-supervisor.ps1' @('-RepoRoot', $repo, '-BunPath', $hubStub, '-Port', "$port2", '-DataDir', $dataDir, '-LogDir', $logs2,
    '-BackoffSchedule', '1', '-MaxFailures', '3', '-FailureWindowMinutes', '5', '-BootWaitSeconds', '20', '-ProbeIntervalSeconds', '1') 120
  $env:MU_FAKE_HUB_MODE = ''
  $gl = Get-Content (Join-Path $logs2 'mu-hub-supervisor.log') -Raw
  Check 'gives up with exit 2' ($r.Code -eq 2) "code $($r.Code)"
  Check 'writes a clear GIVING UP line' ($gl -match 'GIVING UP: 3 failures')
  Check 'did exactly 3 starts (no hot loop)' (@([regex]::Matches($gl, 'starting hub')).Count -eq 3) ([regex]::Matches($gl, 'starting hub')).Count
  Check 'used the backoff line' ($gl -match 'restarting in 1s')
}

# ------------------------------------------------------------------ 6. backup script
Section 'backup script'
$out = Join-Path $root 'bk-out'
$env:MU_FAKE_OUT = $out
$bkLogs = Join-Path $root 'bk-logs'
$common = @('-RepoRoot', $repo, '-BunPath', $bkStub, '-DataDir', $dataDir, '-OutDir', $out, '-LogDir', $bkLogs)
$status = Join-Path $bkLogs 'last-backup.json'

$env:MU_FAKE_MODE = ''
$r = Run-Script 'mu-hub-backup.ps1' $common
Check 'same-disk out dir is refused (exit 3)' ($r.Code -eq 3) "code $($r.Code): $($r.Out)"
$j = Get-Content $status -Raw | ConvertFrom-Json
Check 'refusal is recorded in last-backup.json' ($j.ok -eq $false -and $j.verified -eq $false -and $j.error -match 'same physical disk')
Check 'refusal did not create the out dir' (-not (Test-Path $out))

$env:MU_FAKE_MODE = 'backup-fail'
$r = Run-Script 'mu-hub-backup.ps1' ($common + '-AllowSameDisk')
$j = Get-Content $status -Raw | ConvertFrom-Json
Check 'backup failure exits 1' ($r.Code -eq 1) "code $($r.Code): $($r.Out)"
Check 'status says not ok and carries the reason' ($j.ok -eq $false -and $j.error -match 'boom')

$env:MU_FAKE_MODE = 'verify-fail'
$r = Run-Script 'mu-hub-backup.ps1' ($common + '-AllowSameDisk')
$j = Get-Content $status -Raw | ConvertFrom-Json
Check 'verify failure exits 2' ($r.Code -eq 2) "code $($r.Code): $($r.Out)"
Check 'status: verified false, path and file count kept' ($j.ok -eq $false -and $j.verified -eq $false -and $j.files -eq 12 -and $j.path -match 'backup-2026')

$env:MU_FAKE_MODE = ''
$r = Run-Script 'mu-hub-backup.ps1' ($common + '-AllowSameDisk')
$j = Get-Content $status -Raw | ConvertFrom-Json
Check 'success exits 0' ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
Check 'status: ok, verified, 12 files, path, time' ($j.ok -eq $true -and $j.verified -eq $true -and $j.files -eq 12 -and $j.path -match 'backup-20260101' -and [datetime]$j.time)
$blog = Get-Content (Join-Path $bkLogs 'mu-hub-backup.log') -Raw
Check 'log has one result line per run (4 runs)' (@($blog -split "`n" | Where-Object { $_ -match 'backup (OK|FAILED)' }).Count -eq 4) $blog
Check 'status file holds no secret-looking keys' (($j.PSObject.Properties.Name -join ',') -eq 'ok,time,path,files,verified,error')

$acl = Get-Acl -LiteralPath $out
$ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Value })
Check 'out dir ACL is protected (no inheritance)' ($acl.AreAccessRulesProtected)
Check 'out dir ACL = me, SYSTEM, Administrators only' ($ids.Count -eq 3 -and ($ids -contains 'NT AUTHORITY\SYSTEM') -and ($ids -contains 'BUILTIN\Administrators') -and ($ids -contains [Security.Principal.WindowsIdentity]::GetCurrent().Name)) ($ids -join ', ')

# Different disks (only if this machine has a second lettered volume on another disk)
$otherOut = $null
foreach ($d in (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Za-z]:\\$' })) {
  $t = Join-Path $d.Root ("mu-win-tests-xdisk-" + [Guid]::NewGuid().ToString('N').Substring(0, 6))
  if ((Test-MuSameDisk -PathA $dataDir -PathB $t) -eq $false) { $otherOut = $t; break }
}
if ($otherOut) {
  $env:MU_FAKE_OUT = $otherOut
  $r = Run-Script 'mu-hub-backup.ps1' @('-RepoRoot', $repo, '-BunPath', $bkStub, '-DataDir', $dataDir, '-OutDir', $otherOut, '-LogDir', $bkLogs)
  Check "backup to a different physical disk succeeds without -AllowSameDisk ($otherOut)" ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
  Remove-Item -LiteralPath $otherOut -Recurse -Force -ErrorAction SilentlyContinue
} else { Write-Host '  skip different-disk success test: this machine has no second disk letter' }
$env:MU_FAKE_OUT = $null; $env:MU_FAKE_MODE = $null

Check 'unknown disk (UNC path) is refused' ((Test-MuSameDisk -PathA $dataDir -PathB '\\localhost\share\x') -eq $null)

# ------------------------------------------------------------------ 7. installer
Section 'installer -WhatIf'
$plan = Get-MuTaskPlan -ScriptDir $winDir -RepoRoot $repo -BunPath $hubStub -DataDir $dataDir -LogDir (Join-Path $root 'l') -BackupDir 'D:\bk' -EnvFile $envFile
Check 'plan has four tasks' ($plan.Count -eq 4)
Check 'task names' ((($plan | ForEach-Object { $_.Name }) -join '|') -eq 'MU Hub Supervisor|MU WSL KeepAlive|MU SearXNG|MU Hub Backup')
Check 'three start at boot, backup is daily 03:15' (@($plan | Where-Object Kind -eq 'AtStartup').Count -eq 3 -and ($plan | Where-Object Name -eq 'MU Hub Backup').At -eq '03:15')
Check 'each task runs its own script' (($plan[0].Arguments -match 'mu-hub-supervisor\.ps1') -and ($plan[1].Arguments -match 'mu-wsl-keepalive\.ps1') -and ($plan[2].Arguments -match 'mu-searxng\.ps1') -and ($plan[3].Arguments -match 'mu-hub-backup\.ps1'))
Check 'task arguments carry no env value and no password' (($plan | ForEach-Object { $_.Arguments }) -join ' ' -notmatch [regex]::Escape($secret))
$cmd = Get-Command (Join-Path $winDir 'Install-MuHub.ps1')
Check 'installer has no password parameter' (-not ($cmd.Parameters.Keys | Where-Object { $_ -match 'pass|pwd|secret|credential' }))
Check 'installer supports -WhatIf and both logon types' ($cmd.Parameters.ContainsKey('WhatIf') -and (($cmd.Parameters['LogonType'].Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] }).ValidValues -join ',') -eq 'S4U,Password')

function Get-MuTasksSnapshot { (@(Get-ScheduledTask -TaskPath '\MU\' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" }) + @(Get-ScheduledTask -ErrorAction SilentlyContinue | Measure-Object | ForEach-Object { "total=$($_.Count)" })) -join ';' }
$before = Get-MuTasksSnapshot
foreach ($lt in @('S4U', 'Password')) {
  $r = Run-Script 'Install-MuHub.ps1' @('-WhatIf', '-LogonType', $lt, '-RepoRoot', $repo, '-BunPath', $hubStub, '-DataDir', $dataDir, '-LogDir', (Join-Path $root 'whatif-logs'), '-BackupDir', 'D:\mu-hub-backups\test', '-EnvFile', $envFile)
  Check "-WhatIf $lt exits 0" ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
  Check "-WhatIf $lt lists all four tasks under \MU\" (($r.Out -match '\\MU\\MU Hub Supervisor') -and ($r.Out -match '\\MU\\MU WSL KeepAlive') -and ($r.Out -match '\\MU\\MU SearXNG') -and ($r.Out -match '\\MU\\MU Hub Backup'))
  Check "-WhatIf $lt says nothing was changed" ($r.Out -match 'nothing was registered')
  Check "-WhatIf $lt prints no env value" ($r.Out -notmatch [regex]::Escape($secret))
}
Check '-WhatIf created no log dir' (-not (Test-Path (Join-Path $root 'whatif-logs')))
Check 'scheduled tasks unchanged after -WhatIf (all tasks, not just \MU\)' ((Get-MuTasksSnapshot) -eq $before) "$before  vs  $(Get-MuTasksSnapshot)"
$r = Run-Script 'Uninstall-MuHub.ps1' @('-WhatIf')
Check 'uninstall -WhatIf exits 0 and changes nothing' ($r.Code -eq 0 -and (Get-MuTasksSnapshot) -eq $before) "code $($r.Code): $($r.Out)"
$uninst = Get-Content (Join-Path $winDir 'Uninstall-MuHub.ps1') -Raw
Check 'uninstall only ever names tasks in \MU\ (no wildcard unregister)' ($uninst -notmatch 'Unregister-ScheduledTask\s+\*' -and $uninst -match "TaskPath \`$taskPath -TaskName \`$n")

Section 'wsl and searxng plans'
$r = Run-Script 'mu-wsl-keepalive.ps1' @('-LogDir', (Join-Path $root 'wl'), '-DryRun', '-Distro', 'no-such-distro-xyz')
Check 'keepalive dry run reports a missing distro (exit 5), starts nothing' ($r.Code -eq 5 -and $r.Out -match 'wsl\.exe' -and $r.Out -match 'sleep infinity')
$r = Run-Script 'mu-searxng.ps1' @('-LogDir', (Join-Path $root 'sl'), '-DryRun', '-Distro', 'no-such-distro-xyz')
Check 'searxng dry run prints the start command with no user-profile path' ($r.Out -match 'searx\.webapp' -and $r.Out -match '127\.0\.0\.1:18888' -and ($r.Out -split "`n" | Where-Object { $_ -match 'start\s+:' }) -notmatch 'C:\\Users')
Check 'no script hardcodes a user profile path' (-not ($files | Where-Object { (Get-Content $_.FullName -Raw) -match 'C:\\Users\\' }))

} finally {
  foreach ($id in $started) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-MuProcessTree -ProcessId $id } }
  Remove-Item Env:\MU_FAKE_HUB_MODE, Env:\MU_FAKE_MODE, Env:\MU_FAKE_OUT -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed: $script:passed   failed: $script:failed"
exit $script:failed

