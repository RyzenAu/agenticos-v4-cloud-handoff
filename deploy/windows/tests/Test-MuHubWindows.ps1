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

# ------------------------------------------------------------------ sign-in records check (R8 F)
Section 'sign-in records: an unreadable devices.json is named, never read out'
$ssDir = Join-Path $root 'ss'; New-Item -ItemType Directory -Force -Path $ssDir | Out-Null
$ssFile = Join-Path $ssDir 'devices.json'
Check 'absent store: no problem' ($null -eq (Get-MuSessionStoreProblem -DataDir $ssDir))
[IO.File]::WriteAllText($ssFile, '{"version":1,"sessions":[{"personId":"usman","label":"' + $secret + '"}]}')
Check 'readable store: no problem' ($null -eq (Get-MuSessionStoreProblem -DataDir $ssDir))
[IO.File]::WriteAllText($ssFile, '{"version":1,"sessions":[]}')
Check 'empty sessions list is readable' ($null -eq (Get-MuSessionStoreProblem -DataDir $ssDir))
foreach ($bad in @('{ damaged', 'null', '[]', '{}', '{"sessions":5}')) {
  [IO.File]::WriteAllText($ssFile, $bad)
  $why = Get-MuSessionStoreProblem -DataDir $ssDir
  Check "unreadable store is reported: $bad" ($why -match 'devices\.json') "$why"
}
[IO.File]::WriteAllText($ssFile, '{"sessions": [ "' + $secret + '"')
Check 'the reason never quotes the file' ((Get-MuSessionStoreProblem -DataDir $ssDir) -notmatch [regex]::Escape($secret))

# ------------------------------------------------------------------ fixtures: fake repo + fake bun stubs
$repo = Join-Path $root 'repo'
[void][IO.Directory]::CreateDirectory((Join-Path $repo 'scripts\cloud'))
Set-Content -LiteralPath (Join-Path $repo 'package.json') -Value '{}' -Encoding ASCII
Set-Content -LiteralPath (Join-Path $repo 'scripts\cloud\backup-cli.ts') -Value '// stub' -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fake-hub.ps1') -Destination (Join-Path $root 'fake-hub.ps1')

$hubStub = Join-Path $root 'fake-bun-hub.cmd'
@(
  '@echo off',
  'echo fake hub starting',
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
  'echo role=%MU_HUB_ROLE%> "%~dp0bkrole.txt"',
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
  [IO.File]::WriteAllText((Join-Path $dataDir 'devices.json'), '{ damaged')   # R8 F: the supervisor names it in its log
  $sup = Start-Process -FilePath $ps -ArgumentList (ConvertTo-MuArgString $supArgs) -WindowStyle Hidden -PassThru
  [void]$started.Add($sup.Id)
  $supLog = Join-Path $logs 'mu-hub-supervisor.log'
  Check 'hub comes up' (Wait-ForText $supLog 'hub is up' 60) 'no "hub is up" line'
  Check 'supervisor logs that the sign-in records cannot be read' ((Get-Content -LiteralPath $supLog -Raw) -match "sign-in records can't be read: devices\.json is not valid JSON")
  Remove-Item -LiteralPath (Join-Path $dataDir 'devices.json') -Force
  $env:PLAIN = $null
  # a second supervisor for the same port must not run
  $second = Run-Script 'mu-hub-supervisor.ps1' @('-RepoRoot', $repo, '-BunPath', $hubStub, '-Port', "$port", '-DataDir', $dataDir, '-LogDir', (Join-Path $root 'logs-second'))
  Check 'second supervisor on the same port does not start a hub (mutex or port check)' ($second.Code -eq 0 -or $second.Code -eq 3) "code $($second.Code)"
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  Check 'fake hub is listening' ($null -ne $listener)
  if ($listener) { Stop-Process -Id $listener.OwningProcess -Force }
  Check 'supervisor notices the death' (Wait-ForText $supLog 'FAILURE' 30)
  Check 'supervisor restarts the hub' (Wait-ForText $supLog 'hub is up' 60 2)
  # R8 F: Start-Process truncates its redirect files, so the dead hub's output used to be erased by the restart.
  $kept = Join-Path $logs 'hub-stdout.log.1'
  Check 'the dead hub''s output survives the restart (hub-stdout.log.1)' ((Test-Path -LiteralPath $kept) -and ((Get-Content -LiteralPath $kept -Raw) -match 'fake hub starting'))
  Check 'the supervisor log says where the failed hub''s output is' ((Get-Content -LiteralPath $supLog -Raw) -match "failed hub's output is kept")
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

# R8 F: the manifest's hubRole comes from MU_HUB_ROLE; a server hub's backups were all labelled 'pc'.
Check 'backup runs as role pc by default' ((Get-Content (Join-Path $root 'bkrole.txt') -Raw) -match 'role=pc')
$r = Run-Script 'mu-hub-backup.ps1' ($common + @('-AllowSameDisk', '-HubRole', 'server'))
Check '-HubRole server reaches the backup command' ($r.Code -eq 0 -and (Get-Content (Join-Path $root 'bkrole.txt') -Raw) -match 'role=server') "code $($r.Code): $($r.Out)"

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
Check 'plan has five tasks' ($plan.Count -eq 5)
Check 'task names' ((($plan | ForEach-Object { $_.Name }) -join '|') -eq 'MU Hub Supervisor|MU WSL KeepAlive|MU SearXNG|MU Hub Backup|MU Health Check')
Check 'health check: at startup +3 min, then every 5 min, its own script' (($plan[4].Kind -eq 'Repeat') -and ($plan[4].IntervalMinutes -eq 5) -and ($plan[4].DelaySeconds -eq 180) -and ($plan[4].Arguments -match 'mu-health-check\.ps1'))
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
  Check "-WhatIf $lt lists all five tasks under \MU\" (($r.Out -match '\\MU\\MU Hub Supervisor') -and ($r.Out -match '\\MU\\MU WSL KeepAlive') -and ($r.Out -match '\\MU\\MU SearXNG') -and ($r.Out -match '\\MU\\MU Hub Backup') -and ($r.Out -match '\\MU\\MU Health Check  \[at startup \(\+180 s\), then every 5 min\]'))
  Check "-WhatIf $lt names the Event Log source and registers nothing" (($r.Out -match "Event Log source: 'MU Hub'") -and ($r.Out -notmatch 'Registered Event Log source'))
  Check "-WhatIf $lt says nothing was changed" ($r.Out -match 'nothing was registered')
  Check "-WhatIf $lt prints no env value" ($r.Out -notmatch [regex]::Escape($secret))
}
$r = Run-Script 'Install-MuHub.ps1' @('-WhatIf', '-HubRole', 'server', '-RepoRoot', $repo, '-BunPath', $hubStub, '-DataDir', $dataDir, '-LogDir', (Join-Path $root 'whatif-logs'), '-BackupDir', 'D:\mu-hub-backups	est')
Check '-HubRole server reaches both the supervisor and the backup task' (($r.Out -match 'mu-hub-supervisor\.ps1.* -HubRole server') -and ($r.Out -match 'mu-hub-backup\.ps1.* -HubRole server')) $r.Out
Section 'installer refuses to drop what the live tasks carry (R9)'
$liveSearx = '-NoProfile -File C:\x\mu-searxng.ps1 -Distro kali-linux -Port 18888 -LogDir C:\l -WslUser searx'
Check 'a dropped -WslUser is named' ((@(Get-MuDroppedTaskArgs -Planned '-NoProfile -File C:\x\mu-searxng.ps1 -Distro kali-linux -Port 18888 -LogDir C:\l' -Live $liveSearx) -join '|') -eq '-WslUser searx would be dropped')
Check 'the same -WslUser kept: nothing to report' (@(Get-MuDroppedTaskArgs -Planned $liveSearx -Live $liveSearx).Count -eq 0)
$liveHub = '-File C:\x\mu-hub-supervisor.ps1 -RepoRoot C:\r -EnvFile "C:\mu hub\config\hub.env" -HubRole server'
$d = @(Get-MuDroppedTaskArgs -Planned '-File C:\x\mu-hub-supervisor.ps1 -RepoRoot C:\r' -Live $liveHub)
Check 'dropped -EnvFile (quoted path) and -HubRole are both named' ($d.Count -eq 2 -and ($d -join '|') -match [regex]::Escape('-HubRole server would be dropped') -and ($d -join '|') -match [regex]::Escape('-EnvFile C:\mu hub\config\hub.env would be dropped')) ($d -join '|')
Check 'a changed role is named' ((@(Get-MuDroppedTaskArgs -Planned '-HubRole pc -EnvFile "C:\mu hub\config\hub.env"' -Live $liveHub) -join '|') -eq '-HubRole would change from server to pc')
Check 'a new argument the live task lacks is not a problem' (@(Get-MuDroppedTaskArgs -Planned '-HubRole server' -Live '-File x.ps1').Count -eq 0)
$inst = Get-Content (Join-Path $winDir 'Install-MuHub.ps1') -Raw
Check 'installer compares against each live task, refuses without -Force, warns with it' ($inst -match 'Get-MuDroppedTaskArgs -Planned \$t\.Arguments -Live \$liveArgs' -and $inst -match '\[switch\]\$Force' -and $inst -match 'if \(\$Force\) \{ "  WARNING' -and $inst -match '\$problems \+= ')
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

# ------------------------------------------------------------------ 8. R7 G: env file writes, SSH sessions, public Host probe
Section 'env file writes: a missing final newline never glues two settings'
$hubEnv = Join-Path $root 'hub.env'
[IO.File]::WriteAllText($hubEnv, "FIRST=one`nLASTKEY=lastvalue", (New-Object Text.UTF8Encoding($false)))   # no final newline: the 2 Oct 2026 shape
$before = Get-MuEnvFileProblems -Path $hubEnv
Check 'a file with no final newline is reported' (@($before | Where-Object { $_ -match 'no newline at the end' }).Count -eq 1) ($before -join '; ')
$glued = Join-Path $root 'glued.env'
[IO.File]::WriteAllText($glued, "FIRST=one`nLASTKEY=lastvalueNEWSETTING_A=1`nGOOD=ok`n", (New-Object Text.UTF8Encoding($false)))
$gp = Get-MuEnvFileProblems -Path $glued
Check 'two settings glued onto one line are reported by name, with no value' (@($gp | Where-Object { $_ -match 'LASTKEY looks like two settings' }).Count -eq 1 -and ($gp -join ' ') -notmatch 'lastvalue') ($gp -join '; ')
$out = Set-MuEnvSetting -Path $hubEnv -Name 'NEW_SETTING' -Value 'S3cr3t-New-Value'
$text = [IO.File]::ReadAllText($hubEnv)
Check 'appending reports "added" and never the value' ($out -eq 'added' -and $out -notmatch 'S3cr3t')
Check 'the old last line is intact and the new setting is on its own line' ($text -eq "FIRST=one`nLASTKEY=lastvalue`nNEW_SETTING=S3cr3t-New-Value`n") ($text -replace "`n", '|')
$parsed = Read-MuEnvFile -Path $hubEnv
Check 'all three settings parse after the write' ($parsed.Count -eq 3 -and $parsed['LASTKEY'] -eq 'lastvalue' -and $parsed['NEW_SETTING'] -eq 'S3cr3t-New-Value')
Check 'the file now has no problems' (@(Get-MuEnvFileProblems -Path $hubEnv).Count -eq 0)
Check 'writing the same value again is "unchanged"' ((Set-MuEnvSetting -Path $hubEnv -Name 'NEW_SETTING' -Value 'S3cr3t-New-Value') -eq 'unchanged')
Check 'a new value replaces in place ("replaced"), once' ((Set-MuEnvSetting -Path $hubEnv -Name 'NEW_SETTING' -Value 'changed') -eq 'replaced' -and ([IO.File]::ReadAllText($hubEnv)) -eq "FIRST=one`nLASTKEY=lastvalue`nNEW_SETTING=changed`n")
$crlf = Join-Path $root 'crlf.env'
[IO.File]::WriteAllText($crlf, "A=1`r`nB=2", (New-Object Text.UTF8Encoding($false)))
[void](Set-MuEnvSetting -Path $crlf -Name 'C' -Value '3')
Check 'a CRLF file stays CRLF' ([IO.File]::ReadAllText($crlf) -eq "A=1`r`nB=2`r`nC=3`r`n")
$dup = Join-Path $root 'dup.env'
[IO.File]::WriteAllText($dup, "X=1`nKEEP=k`nX=2`n", (New-Object Text.UTF8Encoding($false)))
[void](Set-MuEnvSetting -Path $dup -Name 'X' -Value '9')
Check 'a duplicated name collapses to one line' ([IO.File]::ReadAllText($dup) -eq "X=9`nKEEP=k`n")
$fresh = Join-Path $root 'sub\fresh.env'
Check 'a missing file (and folder) is created' ((Set-MuEnvSetting -Path $fresh -Name 'ONLY' -Value 'v') -eq 'added' -and ([IO.File]::ReadAllText($fresh)) -eq "ONLY=v`n")
$threw = $false; try { [void](Set-MuEnvSetting -Path $hubEnv -Name 'BAD NAME' -Value 'x') } catch { $threw = $true }
Check 'an invalid name is refused' $threw
$threw = $false; try { [void](Set-MuEnvSetting -Path $hubEnv -Name 'OK' -Value "a`nb=c") } catch { $threw = $true }
Check 'a value with a line break is refused' $threw
Check 'no leftover temp file' (@(Get-ChildItem -LiteralPath $root -Filter '*.tmp-*' -Recurse -ErrorAction SilentlyContinue).Count -eq 0)
$allSrc = (@($files | Where-Object { $_.DirectoryName -eq $winDir }) | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
Check 'no deploy script appends to an env file with Add-Content' ($allSrc -notmatch '(?i)Add-Content[^\r\n]*\.env')

Section 'env file writes: names are case-sensitive, values round-trip, replace is atomic and keeps the ACL'
$ci = Join-Path $root 'case.env'
[IO.File]::WriteAllText($ci, "API_KEY=original-upper`n", (New-Object Text.UTF8Encoding($false)))
Check 'a lower-case name is a different setting: "added", not a replace of API_KEY' ((Set-MuEnvSetting -Path $ci -Name 'api_key' -Value 'lower') -eq 'added')
$ciLines = @(Get-Content -LiteralPath $ci)   # (Read-MuEnvFile's table is case-insensitive, so read the lines)
Check 'API_KEY is untouched and api_key sits beside it' ($ciLines.Count -eq 2 -and $ciLines[0] -ceq 'API_KEY=original-upper' -and $ciLines[1] -ceq 'api_key=lower') ($ciLines -join '|')
Check 'replacing API_KEY exactly still replaces it' ((Set-MuEnvSetting -Path $ci -Name 'API_KEY' -Value 'new-upper') -eq 'replaced' -and (@(Get-Content -LiteralPath $ci) -join '|') -ceq 'API_KEY=new-upper|api_key=lower')

function Write-Env([string]$name, [string]$text) { $f = Join-Path $root $name; [IO.File]::WriteAllText($f, $text, (New-Object Text.UTF8Encoding($false))); return $f }
$nl = "`n"
$g1 = Get-MuEnvFileProblems -Path (Write-Env 'g1.env' ("LASTKEY=valueNEW=1" + $nl))
Check 'LASTKEY=valueNEW=1 (the documented failure) is reported' (@($g1 | Where-Object { $_ -match 'LASTKEY looks like two settings' }).Count -eq 1) ($g1 -join '; ')
$g2 = Get-MuEnvFileProblems -Path (Write-Env 'g2.env' ("LASTKEY=valueNEW_KEY=1" + $nl))
Check 'LASTKEY=valueNEW_KEY=1 is reported' (@($g2 | Where-Object { $_ -match 'LASTKEY looks like two settings' }).Count -eq 1) ($g2 -join '; ')
$g3 = Get-MuEnvFileProblems -Path (Write-Env 'g3.env' ("A=1" + $nl + "LASTKEY=value-then-A=2" + $nl))
Check 'a name defined elsewhere in the file appearing inside a value is reported' (@($g3 | Where-Object { $_ -match 'LASTKEY looks like two settings' }).Count -eq 1) ($g3 -join '; ')
$ok1 = Get-MuEnvFileProblems -Path (Write-Env 'ok1.env' ("URL=https://x/?a=1&ab_cd=2" + $nl + "TOK=abcDEFghi==" + $nl + "Q=https://x/?Id=1&Name=2" + $nl + "QUOTED=" + '"' + "keep NAME=1 inside" + '"' + $nl))
Check 'a URL with &ab_cd=2, base64 padding and quoted text are not flagged' (@($ok1).Count -eq 0) ($ok1 -join '; ')

$rt = Join-Path $root 'roundtrip.env'
$cases = @{ HASH = 'a # b'; DQ = '"quoted"'; SQ = "'single'"; SPACES = '  lead and trail  '; PLAIN = 'plain-value'; INNER = 'x"y'; EMPTY = ''; EQ = 'a=b=c'; ENDQ = 'ends with "' }
foreach ($k in $cases.Keys) { [void](Set-MuEnvSetting -Path $rt -Name $k -Value $cases[$k]) }
$back = Read-MuEnvFile -Path $rt
$bad = @($cases.Keys | Where-Object { $back[$_] -cne $cases[$_] })
Check 'values with " #", quotes, edge spaces, = and the empty string read back exactly' ($bad.Count -eq 0) ("differ: " + ($bad -join ','))
Check 'rewriting a quoted value is "unchanged"' ((Set-MuEnvSetting -Path $rt -Name 'HASH' -Value 'a # b') -eq 'unchanged')

$aclFile = Join-Path $root 'acl.env'
[IO.File]::WriteAllText($aclFile, "ONE=1" + $nl, (New-Object Text.UTF8Encoding($false)))
& icacls.exe $aclFile /inheritance:r /grant:r "$($env:USERNAME):(F)" "*S-1-5-32-545:(R)" | Out-Null
$aclBefore = (& icacls.exe $aclFile) -join ';'
[void](Set-MuEnvSetting -Path $aclFile -Name 'TWO' -Value '2')
$aclAfter = (& icacls.exe $aclFile) -join ';'
Check 'the env file keeps its own ACL (inheritance cut, the Users read grant) after a write' ($aclBefore -eq $aclAfter -and $aclAfter -match 'S-1-5-32-545|BUILTIN\\Users') "$aclBefore  ->  $aclAfter"
Check 'no temp or backup file is left beside any env file' (@(Get-ChildItem -LiteralPath $root -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(tmp|bak)-\d+$' }).Count -eq 0)
$lockFile = Join-Path $root 'locked.env'
[IO.File]::WriteAllText($lockFile, "KEEP=1" + $nl, (New-Object Text.UTF8Encoding($false)))
$fs = [IO.File]::Open($lockFile, 'Open', 'Read', 'None')
$threw = $false; try { [void](Set-MuEnvSetting -Path $lockFile -Name 'NEW' -Value '2') } catch { $threw = $true } finally { $fs.Close() }
Check 'a write that cannot replace the file fails and leaves the original and no temp file' ($threw -and ([IO.File]::ReadAllText($lockFile)) -eq ("KEEP=1" + $nl) -and @(Get-ChildItem -LiteralPath $root | Where-Object { $_.Name -like 'locked.env.*' -and $_.Name -ne 'locked.env' }).Count -eq 0)

Section 'SSH sessions: a process started inside one dies with it'
$saved = $env:SSH_CONNECTION
Remove-Item Env:\SSH_CONNECTION, Env:\SSH_CLIENT, Env:\SSH_TTY -ErrorAction SilentlyContinue
Check 'no SSH variables: not an ssh session' (-not (Test-MuSshSession))
$env:SSH_CONNECTION = '100.64.0.1 50000 100.64.0.2 22'
Check 'SSH_CONNECTION set: an ssh session' (Test-MuSshSession)
if ($saved) { $env:SSH_CONNECTION = $saved } else { Remove-Item Env:\SSH_CONNECTION -ErrorAction SilentlyContinue }
$marker = Join-Path $root 'detached.txt'
$dpid = Start-MuDetached -FilePath $ps -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', "Set-Content -LiteralPath '$marker' -Value ready; Start-Sleep -Seconds 2")
Check 'Start-MuDetached returns a pid' ($dpid -gt 0)
Check 'the detached program ran' (Wait-ForText $marker 'ready' 20)
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$dpid" -ErrorAction SilentlyContinue)
Check 'its parent is not this session (so ending this session does not end it)' ((-not $parent) -or ($parent.ParentProcessId -ne $PID)) "parent $($parent.ParentProcessId), me $PID"
$crm = Get-Content (Join-Path $winDir 'crm-rehearsal.ps1') -Raw
$exitedBy = (Get-Date).AddSeconds(15); while ((Get-Date) -lt $exitedBy -and (Get-Process -Id $dpid -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }
$ok = $true; try { Stop-MuProcessTree -ProcessId 2147480000 } catch { $ok = $false }
Check 'stopping a process that is already gone is not an error (taskkill stderr must not become an exception)' $ok
$ok = $true; $ErrorActionPreference = 'Stop'; try { Stop-MuProcessTree -ProcessId $dpid } catch { $ok = $false }
Check 'stopping the (already exited) detached pid is harmless, and the cleanup list never held it' ($ok -and -not $started.Contains($dpid))
Check 'crm-rehearsal start relaunches outside an ssh session' ($crm -match 'Test-MuSshSession' -and $crm -match 'Start-MuDetached')

Section 'probing the public surface needs the public Host'
$probePort = Get-FreePort
$job = Start-Job -ArgumentList $probePort -ScriptBlock {
  param($port)
  $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port); $l.Start()
  $end = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $end) {
    if (-not $l.Pending()) { Start-Sleep -Milliseconds 50; continue }
    $c = $l.AcceptTcpClient(); $s = $c.GetStream(); $buf = New-Object byte[] 4096
    $n = $s.Read($buf, 0, 4096); $req = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    $code = if ($req -match '(?im)^Host:\s*public\.example\.ts\.net\s*$') { '200 OK' } else { '403 Forbidden' }
    $bytes = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $code`r`nContent-Length: 0`r`nConnection: close`r`n`r`n"); $s.Write($bytes, 0, $bytes.Length); $c.Close()
  }
  $l.Stop()
}
Start-Sleep -Milliseconds 800
$plain = Test-MuHttp -Url "http://127.0.0.1:$probePort/__health" -TimeoutSeconds 5
$withHost = Test-MuHttp -Url "http://127.0.0.1:$probePort/__health" -TimeoutSeconds 5 -HostHeader 'public.example.ts.net'
Check 'a plain loopback probe carries the loopback Host (the hub treats it as the owner at the PC)' ($plain.Answered -and $plain.Status -eq 403) "$($plain.Status)"
Check '-HostHeader sends the public Host to the same listener' ($withHost.Answered -and $withHost.Status -eq 200) "$($withHost.Status)"
Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue

} finally {
  foreach ($id in $started) { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-MuProcessTree -ProcessId $id } }
  Remove-Item Env:\MU_FAKE_HUB_MODE, Env:\MU_FAKE_MODE, Env:\MU_FAKE_OUT -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed: $script:passed   failed: $script:failed"
exit $script:failed

