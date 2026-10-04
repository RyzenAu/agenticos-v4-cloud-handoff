# Hindsight operations (M&U, 28 Sep 2026). Source: AgenticOS-v4 scripts/hindsight/. See docs/HINDSIGHT-OPS.md.
#
#   hindsightctl.ps1 deploy                  back up, copy scripts to D:\hindsight\service, patch the claude-code
#                                            provider (v3: no credential copies, fail closed), create missing
#                                            keys. Starts nothing.
#   hindsightctl.ps1 harden-acl              D:\hindsight -> Usman + SYSTEM only, inheritance from D:\ removed
#                                            (DB, service scripts, venv, logs). Saves the old ACLs first.
#   hindsightctl.ps1 rotate-db-password [-Profile p]  random Postgres password (supervisor must be stopped)
#   hindsightctl.ps1 start  [-Profile p]     launch the supervisor via WMI (outside any agent session job)
#   hindsightctl.ps1 stop   [-Profile p]     clean shutdown: proxy, then API, then Postgres
#   hindsightctl.ps1 status [-Profile p]     sanitised JSON status
#   hindsightctl.ps1 writes -State on|off|show [-Profile p]   memory writes through the proxy (default OFF)
#   hindsightctl.ps1 init-key [-Profile p]   random API key + approval secret into user-only files (never printed)
#   hindsightctl.ps1 clear-alert [-Profile p]
#   hindsightctl.ps1 acl-guard               remove any Codex-sandbox ALLOW entry under D:\hindsight, re-assert the denies
#   hindsightctl.ps1 scrub-logs              scrub credentials and query text from logs written before 28 Sep
#   hindsightctl.ps1 install-watchdog        NOT INSTALLED (lead decision); kept for later
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('deploy', 'harden-acl', 'rotate-db-password', 'start', 'stop', 'status', 'writes', 'init-key', 'install-watchdog', 'remove-watchdog', 'clear-alert', 'sweep', 'scrub-logs', 'acl-guard')]
  [string]$Command,
  [string]$Profile = 'pilot',
  [ValidateSet('on', 'off', 'show')][string]$State = 'show'
)
$ErrorActionPreference = 'Stop'
$svc  = 'D:\hindsight\service'
$py   = 'D:\hindsight\venv\Scripts\python.exe'
$sup  = Join-Path $svc 'supervisor.py'
$provider = 'D:\hindsight\venv\Lib\site-packages\hindsight_api\engine\providers\claude_code_llm.py'
$src  = $PSScriptRoot
$user = "$env:USERDOMAIN\$env:USERNAME"

function Invoke-Supervisor([string[]]$ArgList) { & $py $sup @ArgList; if ($LASTEXITCODE) { exit $LASTEXITCODE } }

switch ($Command) {
  'deploy' {
    if ((Resolve-Path $src).Path.TrimEnd('\') -ieq $svc) { throw "run deploy from the repo copy (AgenticOS-v4 scripts\hindsight), not from $svc" }
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bk = "D:\hindsight\_backups\$ts"
    New-Item -ItemType Directory -Force "$bk\service", "$bk\providers" | Out-Null
    Get-ChildItem $svc -File | Copy-Item -Destination "$bk\service\"
    Copy-Item $provider "$bk\providers\"
    Get-ChildItem $bk -Recurse -File | ForEach-Object {
      '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.FullName.Substring($bk.Length + 1)
    } | Set-Content "$bk\SHA256SUMS.txt" -Encoding ascii
    New-Item -ItemType Directory -Force (Join-Path $svc 'tests') | Out-Null
    foreach ($f in 'supervisor.py', 'proxy.py', 'api_launch.py', 'hindsight.profiles.json', 'hindsight.vbs', 'hindsight.ps1', 'hindsightctl.ps1', 'patch_provider.py', 'backup.ps1', 'install-backup-task.ps1', 'tests\hang_sim.py') {
      Copy-Item (Join-Path $src $f) (Join-Path $svc $f) -Force
    }
    & $py (Join-Path $svc 'patch_provider.py') --file $provider
    if ($LASTEXITCODE) { throw "provider patch failed ($LASTEXITCODE); restore from $bk\providers" }
    & $py $sup init-key --profile pilot
    "deployed to $svc (backup: $bk). Nothing was started."
  }
  'harden-acl' {
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    New-Item -ItemType Directory -Force "D:\hindsight\_backups\$ts-acl" | Out-Null
    icacls D:\hindsight /save "D:\hindsight\_backups\$ts-acl\hindsight-acls.txt" /T /C /Q | Out-Null
    # Top level: no inheritance from D:\ (which grants Authenticated Users Modify), Usman + SYSTEM only;
    # then every child re-inherits from it. D:\hindsight contains no junctions (checked 28 Sep).
    icacls D:\hindsight /inheritance:r /grant:r "${user}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /C /Q
    icacls "D:\hindsight\*" /reset /T /C /Q
    "ACLs restricted to $user + SYSTEM (previous ACLs saved in D:\hindsight\_backups\$ts-acl)"
  }
  'rotate-db-password' { Invoke-Supervisor @('rotate-db-password', '--profile', $Profile) }
  'start' {
    # WMI: the new process is parented outside this shell, so it survives the calling session.
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = "wscript.exe `"$svc\hindsight.vbs`" $Profile"
    }
    if ($r.ReturnValue -ne 0) { throw "WMI create failed: $($r.ReturnValue)" }
    "supervisor launch requested for profile $Profile"
  }
  'stop'        { Invoke-Supervisor @('stop', '--profile', $Profile) }
  'status'      { Invoke-Supervisor @('status', '--profile', $Profile) }
  'writes'      { Invoke-Supervisor @('writes', '--profile', $Profile, '--state', $State) }
  'init-key'    { Invoke-Supervisor @('init-key', '--profile', $Profile) }
  'sweep'       { Invoke-Supervisor @('sweep', '--profile', $Profile) }
  'scrub-logs'  { Invoke-Supervisor @('scrub-logs', '--profile', $Profile) }
  'acl-guard'   { Invoke-Supervisor @('acl-guard', '--profile', $Profile) }
  'clear-alert' { Invoke-Supervisor @('clear-alert', '--profile', $Profile) }
  'install-watchdog' {
    $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$svc\hindsight.vbs`" pilot"
    $logon    = New-ScheduledTaskTrigger -AtLogOn -User $user
    $repeat   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskPath '\MU\' -TaskName 'Hindsight supervisor' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Principal $principal -Force | Out-Null
    'Scheduled task \MU\Hindsight supervisor registered.'
  }
  'remove-watchdog' { Unregister-ScheduledTask -TaskPath '\MU\' -TaskName 'Hindsight supervisor' -Confirm:$false; 'removed' }
}
