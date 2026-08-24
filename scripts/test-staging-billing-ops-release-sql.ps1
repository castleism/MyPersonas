$ErrorActionPreference = 'Stop'

$releaseRepo = Split-Path -Parent $PSScriptRoot
$releaseContainer = 'mypersonas-staging-068-069-test'
$releaseCreated = $false
$releaseVariables = @(
  '-v','ON_ERROR_STOP=1',
  '-v','environment_name=staging',
  '-v','supabase_origin=https://abcdefghijklmnopqrst.supabase.co',
  '-v','public_media_origin=https://media-staging.mypersonas.online'
)

$releaseExisting = @(& docker ps -a --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) { throw 'Docker is required for the staging 068-069 SQL release test.' }
if ($releaseExisting -contains $releaseContainer) {
  throw "Container '$releaseContainer' already exists. Remove or rename it before running this disposable test."
}

try {
  & docker run --detach --name $releaseContainer --env POSTGRES_PASSWORD=postgres postgres:16 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the disposable PostgreSQL container.' }
  $releaseCreated = $true
  $releaseReady = $false
  for ($releaseAttempt = 0; $releaseAttempt -lt 30; $releaseAttempt += 1) {
    & docker exec $releaseContainer pg_isready -U postgres | Out-Null
    if ($LASTEXITCODE -eq 0) { $releaseReady = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $releaseReady) { throw 'Disposable PostgreSQL did not become ready.' }
  Start-Sleep -Milliseconds 250

  $releaseFiles = @(
    'tests/sql/068-account-subscription-seed.sql',
    'tests/sql/068-069-staging-release-seed.sql',
    'scripts/staging-bootstrap/sql/verify-063-064.sql',
    'scripts/staging-bootstrap/sql/preflight-068-069.sql',
    'MyPersonas.Online_v0/sql-updates/068-account-subscription-entitlements.sql',
    'MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql'
  )
  foreach ($releaseRelative in $releaseFiles) {
    $releasePath = Join-Path $releaseRepo $releaseRelative
    Get-Content -LiteralPath $releasePath -Raw |
      & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres
    if ($LASTEXITCODE -ne 0) {
      throw "SQL verification failed while applying $releaseRelative"
    }
  }

  @"
insert into supabase_migrations.schema_migrations(version,name) values
  ('20260823100000','account_subscription_entitlements'),
  ('20260823110000','operational_alert_inbox');
"@ | & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres
  if ($LASTEXITCODE -ne 0) { throw 'Could not record the disposable test ledger state.' }

  $releaseVerifyPath = Join-Path $releaseRepo 'scripts/staging-bootstrap/sql/verify-068-069.sql'
  Get-Content -LiteralPath $releaseVerifyPath -Raw |
    & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres
  if ($LASTEXITCODE -ne 0) { throw 'Post-release 068-069 readback failed.' }

  "insert into supabase_migrations.schema_migrations(version,name) values('20260823070000','deferred_065_must_fail');" |
    & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not stage the disposable deferred-migration negative test.' }
  $releaseSavedErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    Get-Content -LiteralPath $releaseVerifyPath -Raw |
      & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres *> $null
    $releaseNegativeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $releaseSavedErrorAction
  }
  if ($releaseNegativeExitCode -eq 0) { throw '068-069 readback accepted forbidden migration 065.' }
  "delete from supabase_migrations.schema_migrations where version='20260823070000';" |
    & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not reset the disposable deferred-migration negative test.' }

  "update private.billing_runtime_config set enforcement_enabled=true,updated_by=gen_random_uuid() where singleton;" |
    & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not stage the disposable activation negative test.' }
  $releaseSavedErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    Get-Content -LiteralPath $releaseVerifyPath -Raw |
      & docker exec -i $releaseContainer psql @releaseVariables -U postgres -d postgres *> $null
    $releaseNegativeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $releaseSavedErrorAction
  }
  if ($releaseNegativeExitCode -eq 0) { throw '068-069 readback accepted activated billing enforcement.' }

  Write-Output 'Staging release preflight, 062-064 prerequisite, 068/069 apply, exact ledger, shadow billing, grants, operations inbox, no-scheduler readbacks, and fail-closed negative probes passed.'
}
finally {
  if ($releaseCreated) { & docker rm --force $releaseContainer | Out-Null }
}
