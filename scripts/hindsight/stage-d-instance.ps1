# A DEDICATED synthetic Hindsight instance for the Stage D memory acceptance (28 Sep 2026), so it
# never collides with the shared `synth` profile other agents test on, or with the pilot.
#
#   API 127.0.0.1:8893, client proxy 127.0.0.1:8883, Postgres 127.0.0.1:5437
#   everything under D:\hindsight\stage-d (config, run, logs, secrets, db); banks mu-shared + syn-*
#
# It uses the DEPLOYED supervisor and proxy unchanged (D:\hindsight\service, rev 3) with its own config
# file. Secrets are random values written to user-only files (D:\hindsight ACLs) and never printed; no
# credential is copied. The LLM chain is the deployed default (keys by reference, as for synth).
#
#   stage-d-instance.ps1 create    one-time: config, initdb, roles, keys, writes on (synthetic only)
#   stage-d-instance.ps1 start     launch the supervisor for this profile (hidden, outside this session)
#   stage-d-instance.ps1 stop      proxy, API, Postgres
#   stage-d-instance.ps1 status
#   stage-d-instance.ps1 harden    least-privilege app role once the schema exists (after one start)
param([Parameter(Mandatory = $true)][ValidateSet('create', 'start', 'stop', 'status', 'harden')][string]$Command)
$ErrorActionPreference = 'Stop'
$root = 'D:\hindsight\stage-d'
$cfg = Join-Path $root 'hindsight.stage-d.json'
$py = 'D:\hindsight\venv\Scripts\python.exe'
$sup = 'D:\hindsight\service\supervisor.py'
$bin = 'D:\hindsight\pgsql\18.1.0\bin'
$sec = Join-Path $root 'secrets'
$data = Join-Path $root 'db'
function Sup([string[]]$a) { & $py $sup @a --profile stage-d --config $cfg; if ($LASTEXITCODE) { throw "supervisor $($a[0]) failed ($LASTEXITCODE)" } }
function New-Secret([string]$path) {
  $b = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [IO.File]::WriteAllText($path, (($b | ForEach-Object { $_.ToString('x2') }) -join ''))
}

switch ($Command) {
  'create' {
    if (Test-Path (Join-Path $root 'CREATED')) { throw "already created ($root)" }
    foreach ($d in $root, "$root\run", "$root\logs", $sec) { New-Item -ItemType Directory -Force $d | Out-Null }
    $c = Get-Content 'D:\hindsight\service\hindsight.profiles.json' -Raw | ConvertFrom-Json
    $profile = [ordered]@{
      _comment = 'Stage D dedicated synthetic instance (memory acceptance). Never the pilot, never synth.'
      port = 8893; run_dir = "$root\run"; log_dir = "$root\logs"; key_file = "$sec\stage-d.key"; api_key_env = 'HINDSIGHT_STAGE_D_API_KEY'
      proxy = [ordered]@{ port = 8883; read_banks = @('mu-shared', 'syn-*'); write_banks = @('mu-shared', 'syn-*'); docdelete_secret_file = "$sec\stage-d-docdelete.key"; doc_deletes_per_hour = 20 }
      db = [ordered]@{ data_dir = $data; port = 5437; password_file = "$sec\stage-d.db"; admin_password_file = "$sec\stage-d-pgadmin.db" }
    }
    $c.profiles = [pscustomobject]@{ 'stage-d' = [pscustomobject]$profile }
    [IO.File]::WriteAllText($cfg, ($c | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
      New-Secret "$sec\stage-d-bootstrap.db"; New-Secret "$sec\stage-d.db"
      & "$bin\initdb.exe" -D $data -U postgres -A scram-sha-256 "--pwfile=$sec\stage-d-bootstrap.db" -E UTF8 --locale=C | Out-Null
      if ($LASTEXITCODE) { throw "initdb failed" }
      New-Item -ItemType Directory -Force "$data\log" | Out-Null
    }
    # pg_ctl start leaves Postgres holding inherited handles, so its output goes to a FILE (never a pipe).
    if (-not (Get-NetTCPConnection -State Listen -LocalPort 5437 -ErrorAction SilentlyContinue)) {
      cmd /c "`"$bin\pg_ctl.exe`" start -D `"$data`" -w -t 120 -l `"$data\log\pg_ctl.log`" -o `"-p 5437 -c listen_addresses=127.0.0.1`" > `"$root\run\pg_ctl-start.out`" 2>&1"
    }
    $env:PGPASSWORD = (Get-Content "$sec\stage-d-bootstrap.db" -Raw).Trim()
    $app = (Get-Content "$sec\stage-d.db" -Raw).Trim()
    # First start runs Hindsight's migrations (extensions included) as the app role; `harden` then
    # takes superuser away, exactly as rev 3 does for synth and pilot.
    "CREATE ROLE hindsight LOGIN SUPERUSER PASSWORD '$app';`nCREATE DATABASE hindsight OWNER hindsight;" | & "$bin\psql.exe" -h 127.0.0.1 -p 5437 -U postgres -d postgres -q -v ON_ERROR_STOP=1 | Out-Null
    $rc = $LASTEXITCODE
    "CREATE EXTENSION IF NOT EXISTS vector;" | & "$bin\psql.exe" -h 127.0.0.1 -p 5437 -U postgres -d hindsight -q -v ON_ERROR_STOP=1 | Out-Null
    Remove-Item Env:PGPASSWORD; $app = $null
    & "$bin\pg_ctl.exe" stop -D $data -m fast -w | Out-Null
    if ($rc) { throw "role/database creation failed" }
    Sup @('init-key')
    Sup @('writes', '--state', 'on')
    Set-Content (Join-Path $root 'CREATED') (Get-Date -Format o)
    'created (secrets written to user-only files, not shown)'
  }
  'start' {
    $vbs = Join-Path $root 'launch.vbs'
    $qq = '""'
    $line = 'CreateObject("WScript.Shell").Run "' + $qq + $py + $qq + ' ' + $qq + $sup + $qq + ' run --profile stage-d --config ' + $qq + $cfg + $qq + '", 0, False'
    [IO.File]::WriteAllText($vbs, $line)
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "wscript.exe `"$vbs`"" }
    if ($r.ReturnValue -ne 0) { throw "WMI create failed: $($r.ReturnValue)" }
    'supervisor launch requested for profile stage-d'
  }
  'stop' { Sup @('stop') }
  'status' { Sup @('status') }
  'harden' { Sup @('harden-db', '--bootstrap-password-file', "$sec\stage-d-bootstrap.db") }
}
