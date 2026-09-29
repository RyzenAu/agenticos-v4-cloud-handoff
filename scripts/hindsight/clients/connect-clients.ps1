# Point the memory clients at AgenticOS (M&U, 28 Sep 2026; Stage D, REVIEW-STAGE-D B3).
#
# Claude Code, Hermes and the hindsight-ask skill save AND recall through AgenticOS' memory API
# (http://127.0.0.1:8081/__memory), never straight into Hindsight: every save is then screened (no
# passwords, keys, bank or card details, TFNs or codes), visible on the Memory page and to Jarvis,
# forgettable through the approval path, and has its processing model recorded. The Hindsight proxy
# (8878) lets these clients read only (its write_images rule). AgenticOS takes local agent processes
# as the owner at this PC (Stage B1 identity: no page token needed on the agent routes, no key, no
# header in any config).
#
#   connect-clients.ps1 -Client hermes|claude|skill [-Apply] [-OsPort 8081]
#
# Without -Apply it prints the redacted diff only. With -Apply it first copies the file to
# <file>.bak-hindsight-<timestamp>, then writes the change.
param(
  [Parameter(Mandatory = $true)][ValidateSet('hermes', 'claude', 'skill')][string]$Client,
  [switch]$Apply,
  [int]$OsPort = 8081
)
$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$OsPort/__memory/mcp"
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

function Show-Diff([string]$before, [string]$after) {
  $a = $before -split "`r?`n"; $b = $after -split "`r?`n"
  Compare-Object $a $b | ForEach-Object {
    $line = $_.InputObject -replace '(?i)(bearer\s+)\S+', '$1<redacted>' -replace '(?i)((api[_-]?key|token|password)\W{0,3}[:=]\s*)\S+', '$1<redacted>'
    '{0} {1}' -f ($(if ($_.SideIndicator -eq '=>') { '+' } else { '-' })), $line
  }
}

function Write-Utf8NoBom([string]$path, [string]$text) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
}

switch ($Client) {
  'hermes' {
    $file = Join-Path $env:LOCALAPPDATA 'hermes\config.yaml'
    $before = [IO.File]::ReadAllText($file)
    $after = $before -replace '(?m)^(  hindsight:\r?\n    url: )http://127\.0\.0\.1:\d+/(mcp/[^/\s]+/|__memory/mcp)', "`${1}$url"
    # AgenticOS' tools: remember, save_to_vault, recall and forget (which only asks; a person approves on
    # the Memory page). The Hindsight write tools go: an agent never rewrites a stored fact.
    $nl = if ($before -match "`r`n") { "`r`n" } else { "`n" }
    $after = $after -replace '(?m)^        - (sync_retain|update_memory|invalidate_memory|retain)\s*\r?\n', ''
    if ($after -notmatch '(?m)^        - remember\s*$') {
      $after = $after -replace '(?m)^(      include:\r?\n)(        - recall\r?\n)', "`${1}`${2}        - remember$nl        - save_to_vault$nl        - forget$nl"
    }
  }
  'claude' {
    $file = Join-Path $env:USERPROFILE '.claude.json'
    $before = [IO.File]::ReadAllText($file)
    $after = $before -replace '("hindsight":\s*\{\s*"type":\s*"http",\s*"url":\s*")http://127\.0\.0\.1:\d+/(mcp/[^/"]+/|__memory/mcp)(")', "`${1}$url`${3}"
  }
  'skill' {
    $file = Join-Path $env:USERPROFILE '.claude\skills\hindsight-ask\SKILL.md'
    $before = [IO.File]::ReadAllText($file)
    # Recall through AgenticOS (facts with their sources); the body's extra max_tokens is ignored there.
    $after = $before -replace 'http://127\.0\.0\.1:\d+/v1/default/banks/[A-Za-z0-9_.-]+/memories/recall', "http://127.0.0.1:$OsPort/__memory/recall"
    $after = $after -replace 'curl -sf http://127\.0\.0\.1:\d+/health', "curl -sf http://127.0.0.1:$OsPort/__memory/status"
    $after = $after -replace 'powershell -File D:\\hindsight\\service\\hindsight\.ps1 start', 'powershell -File D:\hindsight\service\hindsightctl.ps1 start'
  }
}
if ($before -eq $after) { "no change needed for $Client ($file)"; return }
"--- $file (redacted diff)"
Show-Diff $before $after
if ($Apply) {
  Copy-Item $file "$file.bak-hindsight-$ts"
  Write-Utf8NoBom $file $after
  "applied; backup: $file.bak-hindsight-$ts"
} else {
  'dry run (use -Apply to write)'
}
