# Adds (or with -Remove, removes) the Startup item that runs agentic-os-supervisor.ps1
# hidden at login, then starts the supervisor now. Per-user only; no admin, no service.
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'Agentic OS.vbs'
$supervisor = Join-Path $PSScriptRoot 'agentic-os-supervisor.ps1'

if ($Remove) {
  Remove-Item $vbs -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -match 'agentic-os-supervisor' } |
    Invoke-CimMethod -MethodName Terminate | Out-Null
  "Removed $vbs and stopped the supervisor. Agentic OS itself was left running."
  return
}

# Same pattern as Hermes_Gateway.vbs: wscript runs PowerShell with no window.
# Chr(34) quotes the path (it has spaces) without nested-quote escaping.
$lines = @(
  'Set shell = CreateObject("WScript.Shell")',
  ('shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & "' + $supervisor + '" & Chr(34), 0, False')
)
$script = ($lines -join "`r`n") + "`r`n"
[IO.File]::WriteAllText($vbs, $script, (New-Object Text.UTF8Encoding($false)))
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`""
"Installed $vbs and started the supervisor."
