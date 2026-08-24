[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Preflight','ApplyThrough061','Apply062AndLock','Apply063And064','Apply068And069','Verify','Verify068And069')]
  [string]$Phase,
  [Parameter(Mandatory = $true)][string]$StagingProjectRef,
  [Parameter(Mandatory = $true)][string]$ConfirmedStagingProjectRef,
  [Parameter(Mandatory = $true)][string]$DatabaseHost,
  [Parameter(Mandatory = $true)][string]$DatabaseUser,
  [int]$DatabasePort = 5432,
  [string]$BaselinePath,
  [string]$ExpectedBaselineSha256,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
  [string]$ConfigurationEvidence = '',
  [string]$LockEvidence = '',
  [string]$ReleaseChangeEvidence = '',
  [string]$ReleaseReviewEvidence = '',
  [string]$ApprovalToken = '',
  [string]$SupabaseCommand = 'supabase',
  [string]$PsqlCommand = 'psql',
  [string]$PgDumpCommand = 'pg_dump',
  [string]$NodeCommand = 'node'
)

. (Join-Path $PSScriptRoot 'Common.ps1')

Assert-ProjectRef -ProjectRef $StagingProjectRef
if ($ConfirmedStagingProjectRef -cne $StagingProjectRef) {
  throw 'Confirmed staging project ref does not exactly match the requested target.'
}
Assert-SupabaseDatabaseEndpoint -ProjectRef $StagingProjectRef -DatabaseHost $DatabaseHost -DatabaseUser $DatabaseUser
$supabaseOrigin = "https://$StagingProjectRef.supabase.co"
Assert-CanonicalStagingOrigins `
  -ProjectRef $StagingProjectRef `
  -SupabaseOrigin $supabaseOrigin `
  -PublicMediaOrigin $script:StagingMediaOrigin `
  -SiteOrigin $script:StagingSiteOrigins[0]

Assert-CommandAvailable -Command $PsqlCommand
Assert-CommandAvailable -Command $PgDumpCommand
Assert-CommandAvailable -Command $NodeCommand

$evidenceFull = [IO.Path]::GetFullPath($EvidenceDirectory)
[IO.Directory]::CreateDirectory($evidenceFull) | Out-Null
$phaseSlug = $Phase.ToLowerInvariant()
$runDirectory = Join-Path $evidenceFull ("{0}-{1}" -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')),$phaseSlug)
if (Test-Path -LiteralPath $runDirectory) { throw 'Phase evidence directory collision.' }
[IO.Directory]::CreateDirectory($runDirectory) | Out-Null

$databasePassword = Get-DatabasePassword -EnvironmentVariable 'SUPABASE_DB_PASSWORD' -Prompt 'Staging database password'
$sqlDirectory = Join-Path $PSScriptRoot 'sql'

function Get-PsqlVariableArguments {
  return @(
    '--set=environment_name=staging',
    "--set=supabase_origin=$supabaseOrigin",
    "--set=public_media_origin=$($script:StagingMediaOrigin)"
  )
}

function Invoke-PsqlEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$SqlPath,
    [Parameter(Mandatory = $true)][string]$OutputName,
    [string[]]$ExtraVariables = @()
  )
  Invoke-WithPostgresEnvironment `
    -DatabaseHost $DatabaseHost `
    -DatabaseUser $DatabaseUser `
    -DatabasePassword $databasePassword `
    -DatabasePort $DatabasePort `
    -Action {
      $arguments = @('--no-password','--set=ON_ERROR_STOP=1','--no-align','--tuples-only')
      $arguments += Get-PsqlVariableArguments
      $arguments += $ExtraVariables
      $arguments += @('--file', $SqlPath)
      $accessTokenForRedaction = [Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN','Process')
      Invoke-CapturedCommand `
        -Command $PsqlCommand `
        -Arguments $arguments `
        -OutputPath (Join-Path $runDirectory $OutputName) `
        -Redact @($databasePassword,$accessTokenForRedaction) | Out-Null
    }
}

function Export-StagingSchemaEvidence {
  param([Parameter(Mandatory = $true)][string]$Name)
  $rawSchemaPath = Join-Path $runDirectory "$Name.raw.sql"
  $schemaPath = Join-Path $runDirectory "$Name.sql"
  Invoke-WithPostgresEnvironment `
    -DatabaseHost $DatabaseHost `
    -DatabaseUser $DatabaseUser `
    -DatabasePassword $databasePassword `
    -DatabasePort $DatabasePort `
    -Action {
      Invoke-CapturedCommand -Command $PgDumpCommand -Arguments @(
        '--no-password','--format=plain','--encoding=UTF8','--schema-only',
        '--schema=public','--no-owner','--no-comments',"--file=$rawSchemaPath"
      ) -OutputPath (Join-Path $runDirectory "$Name.pg-dump.log") -Redact @($databasePassword) | Out-Null
    }
  try {
    Invoke-CapturedCommand -Command $NodeCommand -Arguments @(
      (Join-Path $PSScriptRoot 'validate-schema-snapshot.mjs'),
      '--input',$rawSchemaPath,
      '--normalize-to',$schemaPath,
      '--report',(Join-Path $runDirectory "$Name.validation.json")
    ) -OutputPath (Join-Path $runDirectory "$Name.validation.log") -Redact @($databasePassword) | Out-Null
  } finally {
    if (Test-Path -LiteralPath $rawSchemaPath) { Remove-Item -LiteralPath $rawSchemaPath -Force }
  }
  return @{ Path = $schemaPath; Sha256 = Get-Sha256 -Path $schemaPath }
}

function Assert-BaselineInputs {
  if ([string]::IsNullOrWhiteSpace($BaselinePath) -or -not (Test-Path -LiteralPath $BaselinePath)) {
    throw 'A reviewed staging predecessor BaselinePath is required for apply phases.'
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedBaselineSha256)) {
    throw 'The independently recorded baseline SHA-256 is required for apply phases.'
  }
  Assert-ExpectedHash -Path $BaselinePath -ExpectedSha256 $ExpectedBaselineSha256
  if ([IO.Path]::GetFileName($BaselinePath) -cne "$($script:StagingBaselineVersion)_staging_predecessor_through_061.sql") {
    throw 'Baseline filename/version is not the reviewed staging-only predecessor.'
  }
}

function New-SupabasePhaseWorkdir {
  param([Parameter(Mandatory = $true)][int]$HighestMigration)
  Assert-CommandAvailable -Command $SupabaseCommand
  Assert-BaselineInputs
  $workdir = Join-Path $runDirectory 'supabase-workdir'
  $migrations = Join-Path $workdir 'supabase\migrations'
  [IO.Directory]::CreateDirectory($migrations) | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $workdir 'supabase\config.toml'),
    "project_id = `"$StagingProjectRef`"`n",
    [Text.UTF8Encoding]::new($false)
  )
  Copy-Item -LiteralPath $BaselinePath -Destination (Join-Path $migrations ([IO.Path]::GetFileName($BaselinePath)))

  $migrationEvidence = [ordered]@{ baseline = $ExpectedBaselineSha256 }
  $selectedMigrations = @('062','063','064','068','069') | Where-Object { [int]$_ -le $HighestMigration }
  $expectedFiles = @("$($script:StagingBaselineVersion)_staging_predecessor_through_061.sql")
  foreach ($number in $selectedMigrations) {
    if ([int]$number -gt $HighestMigration) { continue }
    $pair = Assert-MigrationMirrorParity -Migration $number
    Copy-Item -LiteralPath $pair.Mirror -Destination (Join-Path $migrations ([IO.Path]::GetFileName($pair.Mirror)))
    $migrationEvidence[$number] = $pair.Sha256
    $expectedFiles += [IO.Path]::GetFileName($pair.Mirror)
  }

  $found = @(Get-ChildItem -LiteralPath $migrations -Filter '*.sql' | Sort-Object Name | Select-Object -ExpandProperty Name)
  $expectedFiles = @($expectedFiles | Sort-Object)
  if ($found.Count -ne $expectedFiles.Count -or (Compare-Object -CaseSensitive $found $expectedFiles)) {
    throw 'Phase workdir is not the exact reviewed migration set; 065-067 are explicitly excluded.'
  }
  if ($found | Where-Object { $_ -match '^202608230(?:70000|80000|90000)|_06[5-7](?:-|_)' }) {
    throw 'Deferred migrations 065-067 must not enter a staging release workdir.'
  }

  [IO.File]::WriteAllText(
    (Join-Path $runDirectory 'phase-migration-hashes.json'),
    ($migrationEvidence | ConvertTo-Json -Depth 4) + "`n",
    [Text.UTF8Encoding]::new($false)
  )
  return $workdir
}

function Invoke-SupabasePush {
  param([Parameter(Mandatory = $true)][string]$Workdir)
  $accessToken = Get-RequiredEnvironmentValue -Name 'SUPABASE_ACCESS_TOKEN'
  Get-RequiredEnvironmentValue -Name 'SUPABASE_DB_PASSWORD' | Out-Null
  $redact = @($accessToken,$databasePassword)

  Invoke-CapturedCommand -Command $SupabaseCommand -Arguments @(
    '--workdir',$Workdir,'--yes','link','--project-ref',$StagingProjectRef
  ) -OutputPath (Join-Path $runDirectory 'supabase-link.log') -Redact $redact | Out-Null
  Invoke-CapturedCommand -Command $SupabaseCommand -Arguments @(
    '--workdir',$Workdir,'migration','list','--linked'
  ) -OutputPath (Join-Path $runDirectory 'supabase-migration-list-before.log') -Redact $redact | Out-Null
  Invoke-CapturedCommand -Command $SupabaseCommand -Arguments @(
    '--workdir',$Workdir,'--yes','db','push','--linked','--dry-run'
  ) -OutputPath (Join-Path $runDirectory 'supabase-db-push-dry-run.log') -Redact $redact | Out-Null
  Invoke-CapturedCommand -Command $SupabaseCommand -Arguments @(
    '--workdir',$Workdir,'--yes','db','push','--linked'
  ) -OutputPath (Join-Path $runDirectory 'supabase-db-push.log') -Redact $redact | Out-Null
  Invoke-CapturedCommand -Command $SupabaseCommand -Arguments @(
    '--workdir',$Workdir,'migration','list','--linked'
  ) -OutputPath (Join-Path $runDirectory 'supabase-migration-list-after.log') -Redact $redact | Out-Null
}

function Assert-ApprovalToken {
  param([Parameter(Mandatory = $true)][string]$Expected)
  if ($ApprovalToken -cne $Expected) {
    throw "Protected-environment reviewer token mismatch. Expected exact token: $Expected"
  }
}

function Assert-ProtectedBillingOperationsReleaseContext {
  $environmentName = Get-RequiredEnvironmentValue -Name 'MP_STAGING_PROTECTED_ENVIRONMENT'
  $approvedProjectRef = Get-RequiredEnvironmentValue -Name 'MP_STAGING_APPROVED_PROJECT_REF'
  if ($environmentName -cne $script:StagingProtectedEnvironment) {
    throw "Billing/operations staging apply requires the exact protected environment $($script:StagingProtectedEnvironment)."
  }
  if ($approvedProjectRef -cne $StagingProjectRef) {
    throw 'Protected-environment project ref does not exactly match the requested staging target.'
  }
  Assert-BoundedEvidence -Value $ReleaseChangeEvidence -Name 'ReleaseChangeEvidence'
  Assert-BoundedEvidence -Value $ReleaseReviewEvidence -Name 'ReleaseReviewEvidence'
  if ($ReleaseChangeEvidence -ceq $ReleaseReviewEvidence) {
    throw 'Change and independent review evidence must be different references.'
  }

  $githubActions = [Environment]::GetEnvironmentVariable('GITHUB_ACTIONS','Process')
  if ($githubActions -ceq 'true') {
    $protectedRef = [Environment]::GetEnvironmentVariable('GITHUB_REF_PROTECTED','Process')
    if ($protectedRef -cne 'true') {
      throw 'GitHub Actions staging apply requires a protected release ref in addition to the protected environment.'
    }
  }

  return [ordered]@{
    environment = $environmentName
    approved_project_ref = $approvedProjectRef
    change_evidence = $ReleaseChangeEvidence
    independent_review_evidence = $ReleaseReviewEvidence
    github_ref_protected = if ($githubActions -ceq 'true') { $true } else { $null }
  }
}

try {
  switch ($Phase) {
    'Preflight' {
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory '00-preflight-fresh-staging.sql') -OutputName 'preflight.txt'
      Export-StagingSchemaEvidence -Name 'preflight-public-schema' | ConvertTo-Json | Out-File (Join-Path $runDirectory 'preflight-schema-hash.json') -Encoding utf8
    }
    'ApplyThrough061' {
      Assert-BaselineInputs
      Assert-ApprovalToken -Expected "APPLY-THROUGH-061:${StagingProjectRef}:$($ExpectedBaselineSha256.Substring(0,12))"
      $before = Export-StagingSchemaEvidence -Name 'before-through-061'
      $workdir = New-SupabasePhaseWorkdir -HighestMigration 61
      Invoke-SupabasePush -Workdir $workdir
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory '03-verify-through-061.sql') -OutputName 'through-061-readback.json'
      $after = Export-StagingSchemaEvidence -Name 'after-through-061'
    }
    'Apply062AndLock' {
      Assert-BaselineInputs
      Assert-BoundedEvidence -Value $ConfigurationEvidence -Name 'ConfigurationEvidence'
      Assert-BoundedEvidence -Value $LockEvidence -Name 'LockEvidence'
      if ($ConfigurationEvidence -ceq $LockEvidence) { throw 'Configuration and lock evidence must be independently named.' }
      Assert-ApprovalToken -Expected "APPLY-062-AND-LOCK:$StagingProjectRef"
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory '03-verify-through-061.sql') -OutputName 'pre-062-readback.json'
      $before = Export-StagingSchemaEvidence -Name 'before-062'
      $workdir = New-SupabasePhaseWorkdir -HighestMigration 62
      Invoke-SupabasePush -Workdir $workdir
      Invoke-PsqlEvidence `
        -SqlPath (Join-Path $sqlDirectory 'configure-and-lock-062.sql') `
        -OutputName 'configure-and-lock-062.txt' `
        -ExtraVariables @(
          "--set=configuration_evidence=$ConfigurationEvidence",
          "--set=lock_evidence=$LockEvidence"
        )
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-062.sql') -OutputName '062-readback.json'
      $after = Export-StagingSchemaEvidence -Name 'after-062-locked'
    }
    'Apply063And064' {
      Assert-BaselineInputs
      Assert-ApprovalToken -Expected "APPLY-063-064:$StagingProjectRef"
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-062.sql') -OutputName 'pre-063-readback.json'
      $before = Export-StagingSchemaEvidence -Name 'before-063-064'
      $workdir = New-SupabasePhaseWorkdir -HighestMigration 64
      Invoke-SupabasePush -Workdir $workdir
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-063-064.sql') -OutputName '063-064-readback.json'
      $after = Export-StagingSchemaEvidence -Name 'after-063-064'
    }
    'Apply068And069' {
      Assert-BaselineInputs
      $protectedReleaseContext = Assert-ProtectedBillingOperationsReleaseContext
      $billingPair = Assert-MigrationMirrorParity -Migration '068'
      $operationsPair = Assert-MigrationMirrorParity -Migration '069'
      Assert-ApprovalToken -Expected "APPLY-068-069:${StagingProjectRef}:$($billingPair.Sha256.Substring(0,12)):$($operationsPair.Sha256.Substring(0,12))"
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-063-064.sql') -OutputName 'pre-068-069-opaque-readback.json'
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'preflight-068-069.sql') -OutputName 'pre-068-069-release-readback.json'
      $before = Export-StagingSchemaEvidence -Name 'before-068-069'
      $workdir = New-SupabasePhaseWorkdir -HighestMigration 69
      Invoke-SupabasePush -Workdir $workdir
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-068-069.sql') -OutputName '068-069-readback.json'
      $after = Export-StagingSchemaEvidence -Name 'after-068-069'
    }
    'Verify' {
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-063-064.sql') -OutputName '063-064-readback.json'
      $after = Export-StagingSchemaEvidence -Name 'verified-063-064'
    }
    'Verify068And069' {
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-063-064.sql') -OutputName '063-064-readback.json'
      Invoke-PsqlEvidence -SqlPath (Join-Path $sqlDirectory 'verify-068-069.sql') -OutputName '068-069-readback.json'
      $after = Export-StagingSchemaEvidence -Name 'verified-068-069'
    }
  }

  $record = [ordered]@{
    phase = $Phase
    completed_at_utc = [DateTime]::UtcNow.ToString('o')
    staging_project_ref = $StagingProjectRef
    staging_supabase_origin = $supabaseOrigin
    staging_public_media_origin = $script:StagingMediaOrigin
    source_git_commit = (git -C (Get-MyPersonasRepositoryRoot) rev-parse HEAD).Trim()
    baseline_sha256 = $ExpectedBaselineSha256
    production_target_rejected = $true
    automatic_rollback_attempted = $false
    deferred_migrations_065_067_excluded = $true
    evidence_directory = $runDirectory
  }
  if (Get-Variable protectedReleaseContext -ErrorAction SilentlyContinue) {
    $record.protected_release_context = $protectedReleaseContext
    $record.applied_migrations = @('068','069')
    $record.billing_enforcement_activated = $false
    $record.checkout_activated = $false
    $record.edge_functions_deployed_by_phase = $false
    $record.provider_scheduling_changed_by_phase = $false
    $record.external_provider_state_verified = $false
  }
  if (Get-Variable before -ErrorAction SilentlyContinue) { $record.before_schema_sha256 = $before.Sha256 }
  if (Get-Variable after -ErrorAction SilentlyContinue) { $record.after_schema_sha256 = $after.Sha256 }
  [IO.File]::WriteAllText((Join-Path $runDirectory 'phase-result.json'),($record | ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))
  Write-Host "Phase $Phase completed. Evidence: $runDirectory"
} finally {
  $databasePassword = $null
}
