[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$SourceProjectRef = 'nwsqyuucwzihruszocge',
  [string]$ProductionDatabaseHost = 'db.nwsqyuucwzihruszocge.supabase.co',
  [string]$ProductionDatabaseUser = 'postgres',
  [int]$ProductionDatabasePort = 5432,
  [string]$PasswordEnvironmentVariable = 'MP_PRODUCTION_DB_PASSWORD',
  [string]$PgDumpCommand = 'pg_dump',
  [string]$NodeCommand = 'node',
  [Parameter(Mandatory = $true)][switch]$IConfirmReadOnlyProductionSchemaExport,
  [switch]$IConfirmIsolatedThrough061ProductionSnapshot
)

. (Join-Path $PSScriptRoot 'Common.ps1')

if (-not $IConfirmReadOnlyProductionSchemaExport) {
  throw 'Pass -IConfirmReadOnlyProductionSchemaExport after confirming a read-only, through-061 production source.'
}
Assert-ProjectRef -ProjectRef $SourceProjectRef -AllowProduction
if ($SourceProjectRef -cne $script:MyPersonasProductionProjectRef -and -not $IConfirmIsolatedThrough061ProductionSnapshot) {
  throw 'A non-production source ref is allowed only for an explicitly confirmed isolated through-061 production snapshot.'
}
Assert-SupabaseDatabaseEndpoint `
  -ProjectRef $SourceProjectRef `
  -DatabaseHost $ProductionDatabaseHost `
  -DatabaseUser $ProductionDatabaseUser
Assert-CommandAvailable -Command $PgDumpCommand
Assert-CommandAvailable -Command $NodeCommand

$root = Get-MyPersonasRepositoryRoot
$outputFull = [IO.Path]::GetFullPath($OutputDirectory)
if ($outputFull -ceq $root -or $outputFull.StartsWith((Join-Path $root '.git'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Evidence output cannot be the repository root or its .git directory.'
}
if (Test-Path -LiteralPath $outputFull) {
  if ((Get-ChildItem -LiteralPath $outputFull -Force | Measure-Object).Count -ne 0) {
    throw 'Output directory must be new or empty so evidence cannot be mixed across runs.'
  }
} else {
  [IO.Directory]::CreateDirectory($outputFull) | Out-Null
}

$rawPath = Join-Path $outputFull 'source-public-schema.raw.sql'
$normalizedPath = Join-Path $outputFull 'source-public-schema.through-061.sql'
$validationPath = Join-Path $outputFull 'source-public-schema.validation.json'
$baselineName = "$($script:StagingBaselineVersion)_staging_predecessor_through_061.sql"
$baselinePath = Join-Path $outputFull $baselineName
$manifestPath = Join-Path $outputFull 'capture-manifest.json'
$password = Get-DatabasePassword -EnvironmentVariable $PasswordEnvironmentVariable -Prompt 'Production database password for schema-only pg_dump'

try {
  Invoke-WithPostgresEnvironment `
    -DatabaseHost $ProductionDatabaseHost `
    -DatabaseUser $ProductionDatabaseUser `
    -DatabasePassword $password `
    -DatabasePort $ProductionDatabasePort `
    -Action {
      Invoke-CapturedCommand -Command $PgDumpCommand -Arguments @(
        '--no-password',
        '--format=plain',
        '--encoding=UTF8',
        '--schema-only',
        '--schema=public',
        '--no-owner',
        '--no-comments',
        "--file=$rawPath"
      ) -OutputPath (Join-Path $outputFull 'pg-dump.log') -Redact @($password) | Out-Null
    }

  Invoke-CapturedCommand -Command $NodeCommand -Arguments @(
    (Join-Path $PSScriptRoot 'validate-schema-snapshot.mjs'),
    '--input', $rawPath,
    '--normalize-to', $normalizedPath,
    '--report', $validationPath,
    '--require-through-061',
    '--reject-062-plus'
  ) -OutputPath (Join-Path $outputFull 'schema-validation.log') -Redact @($password) | Out-Null

  $segments = @(
    (Join-Path $PSScriptRoot 'sql\00-preflight-fresh-staging.sql'),
    (Join-Path $PSScriptRoot 'sql\01-safe-defaults-and-prerequisites.sql'),
    $normalizedPath,
    (Join-Path $PSScriptRoot 'sql\02-empty-platform-config-through-061.sql'),
    (Join-Path $PSScriptRoot 'sql\03-verify-through-061.sql')
  )
  $header = @(
    '-- STAGING-ONLY BASELINE. NEVER APPLY TO PRODUCTION.',
    "-- Generated for protected review at Git commit $(git -C $root rev-parse HEAD).",
    '-- The source component is pg_dump --schema-only --schema=public. The only',
    '-- rows created are deterministic empty staging bucket configuration.',
    'begin;',
    ''
  ) -join "`n"
  $body = $header + (($segments | ForEach-Object {
    "`n-- BEGIN $([IO.Path]::GetFileName($_))`n" + [IO.File]::ReadAllText($_) + "`n-- END $([IO.Path]::GetFileName($_))`n"
  }) -join '') + "`ncommit;`n"
  [IO.File]::WriteAllText($baselinePath, $body, [Text.UTF8Encoding]::new($false))

  $migrationHashes = [ordered]@{}
  foreach ($number in @('062','063','064')) {
    $pair = Assert-MigrationMirrorParity -Migration $number
    $migrationHashes[$number] = $pair.Sha256
  }
  $gitCommit = (git -C $root rev-parse HEAD).Trim()
  $pgDumpVersion = (& $PgDumpCommand --version 2>&1 | Out-String).Trim()
  $validation = Get-Content -Raw -LiteralPath $validationPath | ConvertFrom-Json
  $manifest = [ordered]@{
    artifact_type = 'mypersonas-staging-schema-only-predecessor'
    created_at_utc = [DateTime]::UtcNow.ToString('o')
    source_project_ref = $SourceProjectRef
    source_kind = if ($SourceProjectRef -ceq $script:MyPersonasProductionProjectRef) { 'production' } else { 'isolated-production-through-061-snapshot' }
    source_phase = 'through-061-required'
    source_git_commit = $gitCommit
    pg_dump_version = $pgDumpVersion
    pg_dump_contract = @('--schema-only','--schema=public','--no-owner','--no-comments')
    excludes = @('table data','auth users','storage objects','vault secrets','custom roles','migration history','provider credentials','cron jobs')
    raw_schema_sha256 = Get-Sha256 -Path $rawPath
    normalized_schema_sha256 = Get-Sha256 -Path $normalizedPath
    baseline_filename = $baselineName
    baseline_sha256 = Get-Sha256 -Path $baselinePath
    validation = $validation
    release_migration_sha256 = $migrationHashes
    production_write_performed = $false
    external_deployment_performed = $false
  }
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))

  Write-Host "Schema-only predecessor is ready for human review: $baselinePath"
  Write-Host "Approved baseline SHA-256 must be recorded before staging apply: $($manifest.baseline_sha256)"
} catch {
  # If validation detects a possible credential or data section, do not retain
  # the SQL artifact. The JSON report names only the failed rule, not its value.
  foreach ($unsafePath in @($rawPath,$normalizedPath,$baselinePath)) {
    if (Test-Path -LiteralPath $unsafePath) { Remove-Item -LiteralPath $unsafePath -Force }
  }
  throw
} finally {
  $password = $null
}
