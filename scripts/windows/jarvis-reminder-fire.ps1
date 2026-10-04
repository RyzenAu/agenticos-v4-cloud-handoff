# Fixed runner for a reminder's Windows-native backup Scheduled Task — see
# scripts/windows/reminder-tasks.ts, which registers one \MU\JarvisReminder-<id> task per
# reminder pointing at THIS SAME script every time. Every value below arrives as an ordinary
# -File argv parameter (data), never as a string spliced into a -Command, and this script is
# never regenerated per reminder — contrast with the Mark-LIV reference idea (CC BY-NC 4.0,
# non-commercial; see the 25 Sep 2026 Ministry review), whose actions/reminder.py writes a fresh
# per-reminder .py file with the message embedded as a JSON literal. One fixed script, message
# as data, is the stronger pattern the Ministry called for.
#
# Skips the toast if the in-process scheduler already delivered this reminder before the OS/
# Jarvis process went away or the task fired (recorded in $StateFile — see markDelivered() in
# reminder-tasks.ts) — that avoids showing the same reminder twice. Always tries to delete its
# own Scheduled Task afterwards: Task Scheduler's DeleteExpiredTaskAfter is only swept
# periodically, not immediately, so this is the reliable half of cleanup and that setting is
# just a backstop. cleanupStale() in reminder-tasks.ts mops up anything this step misses (e.g.
# after a crash mid-toast).
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$StateFile,
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$ToastScript
)

$ErrorActionPreference = 'Stop'

$delivered = $false
try {
  if (Test-Path -LiteralPath $StateFile) {
    $json = Get-Content -LiteralPath $StateFile -Raw -ErrorAction Stop
    if ($json) {
      $state = $json | ConvertFrom-Json -ErrorAction Stop
      if ($null -ne $state -and ($state.PSObject.Properties.Name -contains $Id)) { $delivered = $true }
    }
  }
} catch {
  # A missing/corrupt state file just means "nothing recorded as delivered yet" — toast as normal.
  $delivered = $false
}

if (-not $delivered) {
  try {
    & $ToastScript -Title 'Jarvis reminder' -Message $Text -AppId 'Jarvis'
  } catch {
    Write-Error "jarvis-reminder-fire: toast failed: $($_.Exception.Message)"
  }
}

try {
  schtasks.exe /Delete /TN $TaskName /F | Out-Null
} catch {
  # Best-effort self-delete; the startup stale-task sweep will catch it if this fails.
}
