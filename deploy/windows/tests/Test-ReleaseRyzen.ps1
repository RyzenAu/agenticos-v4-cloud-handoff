# Static checks for deploy\windows\release-ryzen.ps1 (the reference copy of the Ryzen release script). Plain PowerShell, no Pester.
# It PARSES the script and reads its text; it never runs it, starts nothing and touches no task, repo or folder.
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy\windows\tests\Test-ReleaseRyzen.ps1
# Exit code = number of failed checks.
$ErrorActionPreference = 'Stop'
$path = Join-Path (Split-Path -Parent $PSScriptRoot) 'release-ryzen.ps1'
$script:passed = 0; $script:failed = 0
function Check([string]$name, $cond, [string]$detail = '') {
  if ($cond) { $script:passed++; Write-Host "  ok   $name" } else { $script:failed++; Write-Host "  FAIL $name $detail" }
}

$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
$text = [IO.File]::ReadAllText($path)
Check 'parses with no errors' ($errors.Count -eq 0) (($errors | ForEach-Object { $_.Message }) -join '; ')
Check 'ASCII only (Windows PowerShell 5.1 reads a BOM-less file as ANSI)' (-not ($text.ToCharArray() | Where-Object { [int]$_ -gt 127 }))
Check 'no stray carriage return inside a line' (-not ($text -match "`r[^`n]"))

$params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
foreach ($p in 'Target', 'TagName', 'MigrateCrm', 'AdoptCommit', 'FailAfterStart') { Check "has parameter -$p" ($params -contains $p) ($params -join ',') }
$target = $ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Target' }
Check '-Target is mandatory' ([bool]($target.Attributes | Where-Object { $_.Extent.Text -match 'Mandatory' }))
Check 'FailAfterStart is refused against production (\MU\ or 8081)' ($text -match "if \(\`$FailAfterStart -and \(\`$TaskPath -eq '\\MU\\' -or \`$Port -eq 8081\)\) \{ throw")

# Order of the success path, by position in the file.
function At([string]$needle) { $text.IndexOf($needle) }
$firstStart = At '$code = Start-HubAndWait 5'
$settle = At 'Start-Sleep 75'
$receiptWrite = At '$receipt | ConvertTo-Json'
$released = At 'Step "RELEASED:'
$catch = At "} catch {`r`n  Step `"FAILED in phase"
Check 'settle: waits 75 s after the first answer' ($firstStart -gt 0 -and $settle -gt $firstStart)
$settleBlock = if ($settle -gt 0 -and $released -gt $settle) { $text.Substring($settle, $released - $settle) } else { '' }
Check 'settle: probes /__version again' ($settleBlock -match '/__version')
Check 'settle: requires 200 or 401 and a live listener, else throws (rollback)' ($settleBlock -match '\$code2 -ne 200 -and \$code2 -ne 401' -and $settleBlock -match '\(Hub-Pids\)\.Count' -and $settleBlock -match 'throw')
Check 'receipt: written after the settle and before RELEASED' ($receiptWrite -gt $settle -and $released -gt $receiptWrite)
Check 'receipt: goes to <LogDir>\release-<stamp>.json' ($settleBlock -match 'Join-Path \$LogDir "release-\$stamp\.json"')
foreach ($k in 'oldHead', 'newHead', 'rollbackTag', 'backup', 'envCopy', 'crmMigrated') { Check "receipt: records $k" ($settleBlock -match "\b$k\s*=") }
Check 'success path is inside try (a settle failure reaches the rollback)' ($catch -gt $released)

# Recovery path
Check 'rollback restores data with --keep-sessions (nobody signed out)' ($text -match 'backup-cli\.ts restore --from \$backupPath --to \$restore --keep-sessions')
Check 'rollback resets with --keep (owner files kept)' ($text -match 'git reset -q --keep \$before')
Check 'rollback puts hub.env back from its copy' ($text -match 'Copy-Item \$envCopy \$envFile -Force')
Check 'backup is verified and fresh before the code changes' ($text.IndexOf('-not $bs.verified') -gt 0 -and $text.IndexOf('-not $bs.verified') -lt (At 'git merge -q --ff-only'))

# Overlay check after a rollback compares with the ORIGINAL snapshot (before adoption), not the post-adoption one
Check 'overlay: the original snapshot is taken before any adoption' ((At '$overlayOriginal = Overlay') -gt 0 -and (At '$overlayOriginal = Overlay') -lt (At '$adopted += $p'))
Check 'overlay: $overlayOriginal is assigned exactly once (never recomputed after adoption)' (([regex]::Matches($text, '\$overlayOriginal\s*=')).Count -eq 1)
Check 'overlay: the post-adoption recompute only feeds $overlayBefore' (([regex]::Matches($text, '\$overlayBefore\s*=\s*Overlay')).Count -eq 1)
Check 'overlay: the rollback warning compares with $overlayOriginal' ($text -match "if \(\(Overlay\) -ne \`$overlayOriginal\) \{ Step 'WARNING")
Check 'overlay: the rollback warning never compares with the post-adoption $overlayBefore' ($text -notmatch "\(Overlay\) -ne \`$overlayBefore\) \{ Step 'WARNING")
Check 'no dead pre-update Restore-Adopted (adoption only happens in the update phase)' ($text -notmatch "phase -eq 'pre-update' -and \`$adopted")

# PowerShell 5.1 traps
$nativeRedirect = [regex]::Matches($text, '(?m)^\s*git [^\r\n]*2>\$null')
Check 'no git call with 2>$null (throws under Stop in 5.1)' ($nativeRedirect.Count -eq 0) (($nativeRedirect | ForEach-Object { $_.Value.Trim() }) -join ' | ')
Check 'never appends to an env file with Add-Content' ($text -notmatch 'Add-Content')

Write-Host ""
Write-Host "passed: $script:passed   failed: $script:failed"
exit $script:failed
