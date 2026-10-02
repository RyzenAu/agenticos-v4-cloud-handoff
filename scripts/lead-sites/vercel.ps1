# Deploys or takes down ONE founder-triggered lead preview on Vercel (team nahda). Called by
# scripts/lead-sites/deploy.ts through Windows PowerShell — never Git Bash, which rewrites
# arguments that start with "/". Mirrors the Bianca deploy: link a staging copy, delete any
# .env.local that linking creates (without reading it), deploy to production, attach the domain.
# The wildcard *.muventures.com.au already points at Vercel, so no DNS record is touched.
param(
  [Parameter(Mandatory = $true)][ValidateSet('deploy', 'takedown')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Project,
  [string]$Stage = '',
  [string]$Domain = '',
  [string]$Scope = 'nahda'
)
$ErrorActionPreference = 'Continue'
if ($Project -notmatch '^mu-preview-[a-z0-9-]{1,80}$') { Write-Output 'MU_ERROR project name must be mu-preview-<slug>'; exit 2 }

function Run([string[]]$VercelArgs) {
  # Run the CLI and return plain text; PowerShell 5.1 wraps native stderr in ErrorRecords.
  $text = & vercel @VercelArgs 2>&1 | ForEach-Object { "$_" } | Out-String
  return @{ Text = $text; ExitCode = $LASTEXITCODE }
}

function Step([string]$Name, $Result) {
  Write-Output "MU_STEP ${Name}: $($Result.Text.Trim() -replace '\s+', ' ')"
  if ($Result.ExitCode -ne 0) { Write-Output "MU_ERROR $Name failed"; exit 1 }
}

function AttachDomain {
  # Use the authenticated CLI API with explicit JSON. `domains add` can send a body
  # the server rejects with 415. Check this project's exact domain first so retries
  # don't fail because it was already attached during an earlier upload.
  $path = "/v9/projects/$Project/domains/$Domain"
  $existing = Run @('api', $path, '--scope', $Scope)
  if ($existing.ExitCode -eq 0) {
    try { $value = $existing.Text | ConvertFrom-Json -ErrorAction Stop } catch {
      Write-Output 'MU_ERROR domain lookup returned an invalid response'; exit 1
    }
    if ($value.name -ne $Domain) { Write-Output 'MU_ERROR domain lookup returned a different domain'; exit 1 }
    Write-Output 'MU_STEP domain: already attached to the expected project'
    return
  }
  if ($existing.Text -notmatch '\b404\b|not found|could not be found') { Step 'domain lookup' $existing }
  $added = Run @('api', "/v10/projects/$Project/domains", '-X', 'POST', '-F', "name=$Domain", '-H', 'Content-Type: application/json', '--scope', $Scope)
  Step 'domain' $added
  try { $value = $added.Text | ConvertFrom-Json -ErrorAction Stop } catch {
    Write-Output 'MU_ERROR domain assignment returned an invalid response'; exit 1
  }
  if ($value.name -ne $Domain) { Write-Output 'MU_ERROR domain assignment returned a different domain'; exit 1 }
}

if ($Action -eq 'deploy') {
  if ($Domain -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.muventures\.com\.au$') { Write-Output 'MU_ERROR domain must be <slug>.muventures.com.au'; exit 2 }
  if (-not (Test-Path -LiteralPath (Join-Path $Stage 'index.html'))) { Write-Output 'MU_ERROR nothing staged to deploy'; exit 2 }
  Set-Location -LiteralPath $Stage
  $inspect = Run @('project', 'inspect', $Project, '--scope', $Scope)
  if ($inspect.ExitCode -ne 0) {
    $add = Run @('project', 'add', $Project, '--scope', $Scope)
    Step 'project add' $add
  }
  # Re-link explicitly: a staging folder's previous project must not choose the upload target.
  $link = Run @('link', '--yes', '--project', $Project, '--scope', $Scope)
  Step 'link' $link
  # Linking can pull environment files. Delete, never read.
  Get-ChildItem -LiteralPath $Stage -Force -Filter '.env*' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $deploy = Run @('deploy', '--prod', '--yes', '--scope', $Scope)
  Step 'deploy' $deploy
  $urls = [regex]::Matches($deploy.Text, 'https://[a-z0-9-]+\.vercel\.app\b')
  $deployment = @($urls | ForEach-Object { $_.Value } | Where-Object { $_ -like "https://${Project}-*" -or $_ -eq "https://${Project}.vercel.app" }) | Select-Object -Last 1
  if (-not $deployment) { Write-Output 'MU_ERROR no deployment URL returned for the expected project'; exit 1 }
  # Both are needed: adding makes this a production domain (public under standard protection),
  # and alias set overrides the main site's wildcard routing to this exact deployment.
  AttachDomain
  $alias = Run @('alias', 'set', $deployment, $Domain, '--scope', $Scope)
  Step 'alias' $alias
  Get-ChildItem -LiteralPath $Stage -Force -Filter '.env*' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Output 'MU_DONE'
  exit 0
}

if ($Action -eq 'takedown') {
  # Removing the project removes its deployments and detaches the preview's subdomain. Never
  # `vercel domains remove` — that would act on the whole muventures.com.au domain.
  # The CLI has no --yes here, so answer its prompt on stdin. PowerShell 5.1 prefixes piped text
  # with a BOM, which the prompt reads as "no" — cmd's echo doesn't. $Project is validated above.
  $rm = cmd.exe /d /c "echo y| vercel project remove $Project --scope $Scope" 2>&1 | ForEach-Object { "$_" } | Out-String
  Write-Output "MU_STEP remove: $($rm.Trim() -replace '\s+', ' ')"
  # Never trust the prompt: confirm the project is really gone.
  $check = Run @('project', 'inspect', $Project, '--scope', $Scope)
  if ($check.ExitCode -eq 0 -and $check.Text -notmatch 'not found|could not be found|No such project') { Write-Output 'MU_ERROR the project still exists after remove'; exit 1 }
  Write-Output 'MU_DONE'
  exit 0
}
