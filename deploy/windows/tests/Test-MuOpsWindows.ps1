# Tests for the R9 ops scripts: mu-health-check.ps1, Install-MuHindsightTask.ps1, verify-after-reboot.ps1. Plain PowerShell, no Pester.
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-MuOpsWindows.ps1
# Exit code = number of failed checks. Touches only a scratch folder under %TEMP%; registers no scheduled task, writes no Event Log entry,
# sends no message (the alert evaluator runs with --no-send) and uses only loopback ports it finds free.
param([switch]$SkipBun)

$ErrorActionPreference = 'Stop'
$winDir = Split-Path -Parent $PSScriptRoot
$repo = (Resolve-Path (Join-Path $winDir '..\..')).Path
. (Join-Path $winDir 'mu-common.ps1')
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$script:passed = 0
$script:failed = 0
function Check([string]$name, $cond, [string]$detail = '') {
  if ($cond) { $script:passed++; Write-Host "  ok   $name" }
  else { $script:failed++; Write-Host "  FAIL $name  $detail" }
}
function Section([string]$t) { Write-Host ""; Write-Host "== $t" }
function Run-Script([string]$script, [string[]]$arguments, [int]$timeout = 180) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $winDir $script)) + $arguments
  $r = Invoke-MuProcess -FilePath $ps -ArgumentList $a -TimeoutSeconds $timeout
  return [pscustomobject]@{ Code = $r.ExitCode; Out = ($r.Stdout + $r.Stderr) }
}
function Get-FreePort {
  $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0); $l.Start()
  $p = ([Net.IPEndPoint]$l.LocalEndpoint).Port; $l.Stop(); return $p
}
function Get-TasksSnapshot { (@(Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TaskPath)$($_.TaskName)|$($_.State)" }) | Sort-Object) -join ';' }

# A tiny HTTP server on each given port: answers 200 with the body for every request, for $Seconds.
function Start-FakeHttp([int[]]$Ports, [string]$Body = '{"ok":true}', [int]$Seconds = 300) {
  Start-Job -ArgumentList ($Ports -join ','), $Body, $Seconds -ScriptBlock {
    param($portList, $body, $seconds)
    $ls = foreach ($p in ($portList -split ',')) { $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p); $l.Start(); $l }
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) {
      $any = $false
      foreach ($l in $ls) {
        if (-not $l.Pending()) { continue }
        $any = $true
        $c = $l.AcceptTcpClient(); $s = $c.GetStream(); $buf = New-Object byte[] 4096
        try { [void]$s.Read($buf, 0, 4096) } catch { }
        $b = [Text.Encoding]::ASCII.GetBytes($body)
        $h = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($b.Length)`r`nConnection: close`r`n`r`n")
        try { $s.Write($h, 0, $h.Length); $s.Write($b, 0, $b.Length) } catch { }
        $c.Close()
      }
      if (-not $any) { Start-Sleep -Milliseconds 30 }
    }
    foreach ($l in $ls) { $l.Stop() }
  }
}
function Wait-Port([int]$Port, [int]$Seconds = 15) {
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) { if (Test-MuPortInUse -Port $Port) { return $true }; Start-Sleep -Milliseconds 200 }
  return $false
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("mu-ops-tests-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $root | Out-Null
try { $root = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { }
$jobs = New-Object System.Collections.ArrayList
$marker = 'SESSION-HASH-MARKER-7Q'   # stands in for anything inside devices.json: it must never appear in any output
try {

# ------------------------------------------------------------------ 1. parse, ASCII, read-only by construction
Section 'the three scripts parse, are ASCII, and the read-only ones change nothing by construction'
foreach ($n in 'mu-health-check.ps1', 'Install-MuHindsightTask.ps1', 'verify-after-reboot.ps1') {
  $f = Join-Path $winDir $n
  $errs = $null; $tokens = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errs)
  Check "parses: $n" ($errs.Count -eq 0) (($errs | ForEach-Object { $_.Message }) -join '; ')
  Check "ascii only: $n" (-not ([IO.File]::ReadAllBytes($f) | Where-Object { $_ -gt 127 }))
}
$mutating = '(?im)^(?!\s*#).*\b(Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|Unregister-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Set-ScheduledTask|Stop-Process|Restart-Computer|Stop-Computer|Restart-Service|Stop-Service|Start-Service|taskkill|New-EventLog|Remove-Item)\b'
foreach ($n in 'verify-after-reboot.ps1', 'mu-health-check.ps1') {
  $src = Get-Content -Raw (Join-Path $winDir $n)
  $hits = @([regex]::Matches($src, $mutating) | ForEach-Object { $_.Value.Trim() })
  if ($n -eq 'mu-health-check.ps1') { $hits = @($hits | Where-Object { $_ -notmatch 'failMarker\) \{ Remove-Item$' }) }   # its own evaluator-failed marker file only
  Check "$n starts, stops, registers and deletes nothing" ($hits.Count -eq 0) ($hits -join ' | ')
  Check "$n never reads an env file" ($src -notmatch 'Read-MuEnvFile|Set-MuEnvFromFile|hub\.env')
}

# ------------------------------------------------------------------ 2. health check: facts
Section 'mu-health-check: facts from fakes'
$data = Join-Path $root 'data'; $logs = Join-Path $root 'logs'; $hsRun = Join-Path $root 'hsrun'
New-Item -ItemType Directory -Force -Path $data, $logs, $hsRun | Out-Null
[IO.File]::WriteAllText((Join-Path $data 'devices.json'), "{`"version`":1,`"sessions`":[{`"id`":`"a`",`"hash`":`"$marker`"},{`"id`":`"b`"}]}")
[IO.File]::WriteAllText((Join-Path $hsRun 'status.json'), '{"state":"running","supervisor_pid":1}')
@('2026-10-03 16:19:34 supervisor started (pid 1, repo x, port 8081, role server, bun x)', '2026-10-03 16:30:00 FAILURE: hub exited (code 255)', '2026-10-03 16:31:10 GIVING UP: 6 failures within 10 minutes. Not restarting again.') -join "`r`n" | Set-Content -LiteralPath (Join-Path $logs 'mu-hub-supervisor.log') -Encoding ASCII
'{ "ok": false, "time": "2026-10-03T03:15:16+10:00", "path": null, "files": 0, "verified": false, "error": "verify failed (exit 1): 2 files differ" }' | Set-Content -LiteralPath (Join-Path $logs 'last-backup.json') -Encoding ASCII
$pHub = Get-FreePort; $pHs = Get-FreePort; $pProxy = Get-FreePort; $pHermes = Get-FreePort; $pSearx = Get-FreePort; $pGw = Get-FreePort; $pSh = Get-FreePort
[void]$jobs.Add((Start-FakeHttp @($pHub, $pHs, $pProxy, $pHermes)))
Check 'fake services listening' ((Wait-Port $pHub) -and (Wait-Port $pHermes))
$common = @('-RepoRoot', $repo, '-DataDir', $data, '-LogDir', $logs, '-HindsightRunDir', $hsRun, '-HubPort', "$pHub", '-HindsightPort', "$pHs", '-HindsightProxyPort', "$pProxy", '-HermesPort', "$pHermes", '-SearxngPort', "$pSearx", '-StagingGatewayPort', "$pGw", '-StagingHubPort', "$pSh", '-Drives', 'C:', '-SkipWsl', '-SkipTasks', '-ProbeTimeoutSeconds', '3')
$out = Join-Path $data 'ops\host-health.json'

$r = Run-Script 'mu-health-check.ps1' ($common + @('-DryRun'))
Check '-DryRun exits 0 and prints the facts' ($r.Code -eq 0 -and $r.Out -match '"gaveUp":\s+true') "code $($r.Code): $($r.Out)"
Check '-DryRun writes nothing' (-not (Test-Path $out) -and -not (Test-Path (Join-Path $logs 'mu-health-check.log')))
$r = Run-Script 'mu-health-check.ps1' ($common + @('-DryRun', '-SkipSessionStore'))
Check '-SkipSessionStore leaves the sign-in records unopened (null, not guessed)' ($r.Code -eq 0 -and $r.Out -match '"sessionStore":\s+null') $r.Out

$r = Run-Script 'mu-health-check.ps1' ($common + @('-NoAlerts'))
Check '-NoAlerts exits 0' ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
$h = Get-Content -Raw $out | ConvertFrom-Json
Check 'report: version 1, host, checkedAt' ($h.version -eq 1 -and $h.host -eq $env:COMPUTERNAME -and $h.checkedAt)
Check 'hub answering, and the GIVING UP after its last start is seen with its time' ($h.facts.hub.answering -eq $true -and $h.facts.hub.gaveUp -eq $true -and $h.facts.hub.gaveUpAt -eq '2026-10-03 16:31:10')
Check 'Hindsight API and proxy answering, status running, no lock' ($h.facts.hindsight.answering -and $h.facts.hindsight.proxyAnswering -and $h.facts.hindsight.state -eq 'running' -and -not $h.facts.hindsight.crashloopLock)
Check 'search down, Hermes up' ($h.facts.searxng.answering -eq $false -and $h.facts.hermes.answering -eq $true)
Check 'staging reported (both down here)' ($h.facts.staging.gateway -eq $false -and $h.facts.staging.hub -eq $false)
Check 'backup: failed, not verified, error kept' ($h.facts.backup.present -and -not $h.facts.backup.ok -and -not $h.facts.backup.verified -and $h.facts.backup.error -match '2 files differ' -and $h.facts.backup.ageHours -gt 0)
Check 'disk C: as a list with free GB and %' (@($h.facts.disks).Count -eq 1 -and $h.facts.disks[0].drive -eq 'C:' -and $h.facts.disks[0].freePct -gt 0)
Check 'sign-in records readable, and nothing from the file is in the report' ($h.facts.sessionStore.readable -eq $true -and (Get-Content -Raw $out) -notmatch $marker)
Check 'tasks skipped are null, not guessed' ($null -eq $h.facts.hub.supervisorTask -and $null -eq $h.facts.wsl.running)

# A later supervisor start clears the give-up; a crash-loop lock and damaged sign-in records are seen.
Add-Content -LiteralPath (Join-Path $logs 'mu-hub-supervisor.log') -Value '2026-10-03 17:00:00 supervisor started (pid 2, repo x, port 8081, role server, bun x)'
[IO.File]::WriteAllText((Join-Path $hsRun 'crashloop.lock'), '{}')
[IO.File]::WriteAllText((Join-Path $data 'devices.json'), "{`"sessions`": [ `"$marker`"")
$r = Run-Script 'mu-health-check.ps1' ($common + @('-NoAlerts'))
$h = Get-Content -Raw $out | ConvertFrom-Json
Check 'a supervisor start after GIVING UP clears it' ($h.facts.hub.gaveUp -eq $false)
Check 'crash-loop lock seen' ($h.facts.hindsight.crashloopLock -eq $true)
Check 'damaged sign-in records: not readable, reason named, contents not copied' ($h.facts.sessionStore.readable -eq $false -and $h.facts.sessionStore.problem -match 'not valid JSON' -and (Get-Content -Raw $out) -notmatch $marker)

# ------------------------------------------------------------------ 3. health check: alerts through the real evaluator (no send, no event log)
if (-not $SkipBun) {
  Section 'mu-health-check: alerts (bun evaluator, --no-send, -NoEventLog)'
  $bunExe = $null
  try { $bunExe = (& bun -e "console.log(process.execPath)" 2>$null | Select-Object -Last 1) } catch { }
  if ($bunExe -and (Test-Path -LiteralPath $bunExe)) {
    # No disk in these runs (Q: does not exist): this machine's own free space must not decide the result.
    $common = $common -replace '^C:$', 'Q:'
    $r = Run-Script 'mu-health-check.ps1' ($common + @('-BunPath', $bunExe, '-NoTelegram', '-NoEventLog'))
    Check 'run with alerts exits 0' ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
    $st = Get-Content -Raw (Join-Path $data 'ops\host-alerts.json') | ConvertFrom-Json
    $alerted = @($st.conditions.PSObject.Properties | Where-Object { $_.Value.alertedAt } | ForEach-Object { $_.Name } | Sort-Object)
    Check 'immediate conditions alerted: backup, Hindsight crash-loop, sign-in records' (($alerted -join ',') -eq 'backup,hindsight_down,sign_in_records') ($alerted -join ',')
    $hl = Get-Content -Raw (Join-Path $logs 'mu-health-check.log')
    Check 'each alert becomes an Event Log entry 4101 (logged here, not written)' (@([regex]::Matches($hl, 'event 4101 \(Error\) not written')).Count -eq 3) $hl
    Check 'telegram reported as not sent' ($hl -match 'telegram: not-sent')
    $r = Run-Script 'mu-health-check.ps1' ($common + @('-BunPath', $bunExe, '-NoTelegram', '-NoEventLog'))
    $hl2 = Get-Content -Raw (Join-Path $logs 'mu-health-check.log')
    Check 'the next run raises nothing new (one alert per condition)' (@([regex]::Matches($hl2, 'event 4101')).Count -eq 3) $hl2
    Remove-Item -LiteralPath (Join-Path $hsRun 'crashloop.lock')
    [IO.File]::WriteAllText((Join-Path $data 'devices.json'), '{"sessions":[]}')
    $r = Run-Script 'mu-health-check.ps1' ($common + @('-BunPath', $bunExe, '-NoTelegram', '-NoEventLog'))
    $hl3 = Get-Content -Raw (Join-Path $logs 'mu-health-check.log')
    Check 'one clear run is not yet "resolved" (hysteresis: 3 clear runs)' (@([regex]::Matches($hl3, 'event 4103')).Count -eq 0) $hl3
    foreach ($i in 1, 2) { $r = Run-Script 'mu-health-check.ps1' ($common + @('-BunPath', $bunExe, '-NoTelegram', '-NoEventLog')) }
    $hl3 = Get-Content -Raw (Join-Path $logs 'mu-health-check.log')
    Check 'after 3 clear runs the cleared conditions are resolved once each (4103)' (@([regex]::Matches($hl3, 'event 4103 \(Information\)')).Count -eq 2) $hl3
    Check 'no log line carries anything from devices.json' ($hl3 -notmatch $marker)
    $r = Run-Script 'mu-health-check.ps1' ($common + @('-BunPath', (Join-Path $root 'no-bun.exe'), '-NoTelegram', '-NoEventLog'))
    $hl4 = Get-Content -Raw (Join-Path $logs 'mu-health-check.log')
    Check 'a missing evaluator is logged and becomes one 4199 entry, and the run still exits 0' ($r.Code -eq 0 -and $hl4 -match 'alert evaluator failed' -and @([regex]::Matches($hl4, 'event 4199')).Count -eq 1) $hl4
    $r = Run-Script 'mu-health-check.ps1' ($common + @('-BunPath', (Join-Path $root 'no-bun.exe'), '-NoTelegram', '-NoEventLog'))
    $hl5 = Get-Content -Raw (Join-Path $logs 'mu-health-check.log')
    Check '... at most once per 6 hours' (@([regex]::Matches($hl5, 'event 4199')).Count -eq 1)
  } else { Write-Host '  skip evaluator tests: bun not found' }
}

# ------------------------------------------------------------------ 4. Hindsight boot task installer
Section 'Install-MuHindsightTask -WhatIf'
$svc = Join-Path $root 'svc'; New-Item -ItemType Directory -Force -Path $svc | Out-Null
$py = Join-Path $root 'python.exe'; [IO.File]::WriteAllText($py, ''); [IO.File]::WriteAllText((Join-Path $svc 'supervisor.py'), '')
$before = Get-TasksSnapshot
$r = Run-Script 'Install-MuHindsightTask.ps1' @('-WhatIf', '-PythonPath', $py, '-ServiceDir', $svc)
Check '-WhatIf exits 0' ($r.Code -eq 0) "code $($r.Code): $($r.Out)"
Check 'plan: \Hindsight\Hindsight pilot supervisor, S4U' ($r.Out -match [regex]::Escape('Plan: \Hindsight\Hindsight pilot supervisor for') -and $r.Out -match 'S4U')
Check 'action runs the supervisor directly with the pilot profile' ($r.Out -match [regex]::Escape("`"$py`" `"$svc\supervisor.py`" run --profile pilot"))
Check 'boot trigger and a 5-minute watchdog' ($r.Out -match 'at startup \(\+30 s\); every 5 min')
Check '-WhatIf says nothing was changed, and nothing was' ($r.Out -match 'nothing was registered' -and (Get-TasksSnapshot) -eq $before)
$r = Run-Script 'Install-MuHindsightTask.ps1' @('-WhatIf', '-PythonPath', $py, '-ServiceDir', $svc, '-UserName', 'NT AUTHORITY\SYSTEM')
Check 'SYSTEM is refused (the proxy accepts writes only from the hub account)' ($r.Out -match 'PROBLEM: refusing SYSTEM')
$r = Run-Script 'Install-MuHindsightTask.ps1' @('-WhatIf', '-PythonPath', (Join-Path $root 'missing.exe'), '-ServiceDir', $svc)
Check 'a missing python is a named problem' ($r.Out -match 'PROBLEM: python not found')
$src = Get-Content -Raw (Join-Path $winDir 'Install-MuHindsightTask.ps1')
Check 'never passes --clear-alert to the supervisor' ($src -match '\$arguments = "`"\$supervisor`" run --profile \$Profile"' -and $src -notmatch 'run --profile \$Profile --clear-alert')
Check 'one instance at a time, no time limit, no restart-on-failure, S4U limited' ($src -match '-MultipleInstances IgnoreNew' -and $src -match 'ExecutionTimeLimit \(\[TimeSpan\]::Zero\)' -and $src -notmatch '-RestartCount' -and $src -match '-LogonType S4U -RunLevel Limited')
Check 'touches only its own task (no unregister, no wildcard)' ($src -notmatch 'Unregister-ScheduledTask' -and $src -match 'Register-ScheduledTask -InputObject \$def -TaskName \$TaskName -TaskPath \$TaskPath')

# ------------------------------------------------------------------ 5. reboot verification
Section 'verify-after-reboot: snapshot, then compare (read-only)'
$pVer = Get-FreePort
[void]$jobs.Add((Start-FakeHttp @($pVer) '{"version":"3.6.1","gitSha":"abc1234","dirty":false}'))
Check 'fake tailnet /__version listening' (Wait-Port $pVer)
[IO.File]::WriteAllText((Join-Path $data 'devices.json'), "{`"sessions`":[{`"hash`":`"$marker`"},{`"hash`":`"x`"}]}")
[IO.File]::WriteAllText((Join-Path $data 'devices-secret'), 'not-read-by-the-script')
$base = Join-Path $root 'baseline.json'
$vargs = @('-BaselineFile', $base, '-RepoRoot', $repo, '-DataDir', $data, '-LogDir', $logs, '-HindsightRunDir', $hsRun, '-BackupDir', (Join-Path $root 'nobk'), '-HindsightBackupDir', (Join-Path $root 'nohs'), '-PublicVersionUrl', "http://127.0.0.1:$pVer/__version", '-SkipTasks')
$beforeTasks = Get-TasksSnapshot
$r = Run-Script 'verify-after-reboot.ps1' ($vargs + @('-Snapshot'))
Check '-Snapshot exits 0 and writes the baseline' ($r.Code -eq 0 -and (Test-Path $base)) "code $($r.Code): $($r.Out)"
$b = Get-Content -Raw $base | ConvertFrom-Json
Check 'baseline: session COUNT, commit, secret stamp; nothing from the files' ($b.sessions -eq 2 -and $b.publicGitSha -eq 'abc1234' -and $b.devicesSecret -match 'bytes' -and (Get-Content -Raw $base) -notmatch $marker -and (Get-Content -Raw $base) -notmatch 'not-read-by-the-script')
$r = Run-Script 'verify-after-reboot.ps1' $vargs
Check 'check mode runs, exit code = number of FAIL lines' ($r.Code -eq @([regex]::Matches($r.Out, '(?m)^FAIL ')).Count) "code $($r.Code)"
Check 'no reboot since the baseline is a FAIL (the comparison works)' ($r.Out -match '(?m)^FAIL  the machine has rebooted since the baseline')
Check 'sessions preserved compares counts' ($r.Out -match '(?m)^PASS  sessions now 2, before the reboot 2')
Check 'devices-secret unchanged by size and date' ($r.Out -match '(?m)^PASS  devices-secret unchanged')
Check 'the version check reads gitSha over the given URL' ($r.Out -match '(?m)^PASS  tailnet /__version answers with a gitSha \(abc1234\)')
Check 'the health report written by the runs above counts as written since boot' ($r.Out -match '(?m)^PASS  health check report written since the boot')
Check 'nothing from devices.json is printed' ($r.Out -notmatch $marker)
[IO.File]::WriteAllText((Join-Path $data 'devices.json'), '{"sessions":[]}')
$r = Run-Script 'verify-after-reboot.ps1' $vargs
Check 'all sessions gone after a reboot is a FAIL' ($r.Out -match '(?m)^FAIL  sessions now 0, before the reboot 2')
Check 'scheduled tasks unchanged by the verify script' ((Get-TasksSnapshot) -eq $beforeTasks)

} finally {
  foreach ($j in $jobs) { Stop-Job $j -ErrorAction SilentlyContinue; Remove-Job $j -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "passed: $script:passed   failed: $script:failed"
exit $script:failed
