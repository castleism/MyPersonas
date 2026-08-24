Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:MyPersonasProductionProjectRef = 'nwsqyuucwzihruszocge'
$script:StagingSiteOrigins = @(
  'https://mypersonas-staging.pages.dev',
  'https://staging.mypersonas.online'
)
$script:StagingMediaOrigin = 'https://media-staging.mypersonas.online'
$script:StagingBaselineVersion = '20260823035000'
$script:Opaque062Version = '20260823040000'
$script:Opaque063Version = '20260823050000'
$script:Opaque064Version = '20260823060000'
$script:Billing068Version = '20260823100000'
$script:Operations069Version = '20260823110000'
$script:StagingProtectedEnvironment = 'supabase-staging'

function Get-MyPersonasRepositoryRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Assert-ProjectRef {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRef,
    [switch]$AllowProduction
  )

  if ($ProjectRef -cnotmatch '^[a-z0-9]{20}$') {
    throw 'Supabase project ref must be exactly 20 lowercase letters or digits.'
  }
  if (-not $AllowProduction -and $ProjectRef -ceq $script:MyPersonasProductionProjectRef) {
    throw 'The production Supabase project is forbidden as a staging target.'
  }
}

function Assert-SupabaseDatabaseEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRef,
    [Parameter(Mandatory = $true)][string]$DatabaseHost,
    [Parameter(Mandatory = $true)][string]$DatabaseUser
  )

  Assert-ProjectRef -ProjectRef $ProjectRef -AllowProduction:($ProjectRef -ceq $script:MyPersonasProductionProjectRef)
  if ($DatabaseHost -cne $DatabaseHost.ToLowerInvariant() -or $DatabaseHost -match '[/:@\s]') {
    throw 'Database host must be one exact lowercase hostname, without a URL, port, credentials, or whitespace.'
  }

  $directHost = "db.$ProjectRef.supabase.co"
  $directUserAllowed = $DatabaseUser -ceq 'postgres' -or $DatabaseUser -ceq "postgres.$ProjectRef"
  $poolerHostAllowed = $DatabaseHost -cmatch '^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pooler\.supabase\.com$'
  $poolerUserAllowed = $DatabaseUser -ceq "postgres.$ProjectRef"

  if (($DatabaseHost -ceq $directHost -and $directUserAllowed) -or ($poolerHostAllowed -and $poolerUserAllowed)) {
    return
  }
  throw 'Database host/user are not cryptographically bound to the requested Supabase project ref. Use db.<ref>.supabase.co or a Supabase session pooler with user postgres.<ref>.'
}

function Assert-CanonicalStagingOrigins {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRef,
    [Parameter(Mandatory = $true)][string]$SupabaseOrigin,
    [Parameter(Mandatory = $true)][string]$PublicMediaOrigin,
    [Parameter(Mandatory = $true)][string]$SiteOrigin
  )

  Assert-ProjectRef -ProjectRef $ProjectRef
  if ($SupabaseOrigin -cne "https://$ProjectRef.supabase.co") {
    throw 'Staging Supabase origin must be the exact canonical origin for the non-production project ref.'
  }
  if ($PublicMediaOrigin -cne $script:StagingMediaOrigin) {
    throw "Staging media origin must be exactly $($script:StagingMediaOrigin)."
  }
  if ($script:StagingSiteOrigins -cnotcontains $SiteOrigin) {
    throw "Staging site origin must be one exact reviewed host: $($script:StagingSiteOrigins -join ' or ')."
  }
  if ($SupabaseOrigin -ceq "https://$($script:MyPersonasProductionProjectRef).supabase.co" -or
      $PublicMediaOrigin -ceq 'https://media.mypersonas.online' -or
      $SiteOrigin -ceq 'https://mypersonas.online') {
    throw 'Production and staging origins may not overlap.'
  }
}

function Assert-CommandAvailable {
  param([Parameter(Mandatory = $true)][string]$Command)
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "Required command is not available: $Command"
  }
}

function Get-RequiredEnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required protected-environment value is missing: $Name"
  }
  return $value
}

function Get-DatabasePassword {
  param(
    [Parameter(Mandatory = $true)][string]$EnvironmentVariable,
    [string]$Prompt = 'Database password'
  )

  $existing = [Environment]::GetEnvironmentVariable($EnvironmentVariable, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    return $existing
  }
  if ([Console]::IsInputRedirected) {
    throw "Set $EnvironmentVariable in the protected environment; password prompting is unavailable."
  }

  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
  if ([string]::IsNullOrWhiteSpace($plain)) { throw 'Database password cannot be empty.' }
  return $plain
}

function Invoke-WithPostgresEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$DatabaseHost,
    [Parameter(Mandatory = $true)][string]$DatabaseUser,
    [Parameter(Mandatory = $true)][string]$DatabasePassword,
    [int]$DatabasePort = 5432,
    [string]$DatabaseName = 'postgres',
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )

  $names = @('PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSSLMODE', 'PGPASSWORD')
  $saved = @{}
  foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
  try {
    [Environment]::SetEnvironmentVariable('PGHOST', $DatabaseHost, 'Process')
    [Environment]::SetEnvironmentVariable('PGPORT', $DatabasePort.ToString(), 'Process')
    [Environment]::SetEnvironmentVariable('PGUSER', $DatabaseUser, 'Process')
    [Environment]::SetEnvironmentVariable('PGDATABASE', $DatabaseName, 'Process')
    [Environment]::SetEnvironmentVariable('PGSSLMODE', 'verify-full', 'Process')
    [Environment]::SetEnvironmentVariable('PGPASSWORD', $DatabasePassword, 'Process')
    & $Action
  } finally {
    foreach ($name in $names) {
      [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
  }
}

function Invoke-CapturedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$OutputPath,
    [string[]]$Redact = @()
  )

  $lines = @(& $Command @Arguments 2>&1 | ForEach-Object { $_.ToString() })
  $exitCode = $LASTEXITCODE
  $text = $lines -join [Environment]::NewLine
  foreach ($secret in $Redact) {
    if (-not [string]::IsNullOrEmpty($secret)) { $text = $text.Replace($secret, '[REDACTED]') }
  }
  if ($OutputPath) {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    [IO.File]::WriteAllText($OutputPath, $text + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  }
  if ($exitCode -ne 0) {
    if ($text) { Write-Error $text }
    throw "$Command exited with code $exitCode."
  }
  return $text
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    return (($hasher.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $hasher.Dispose()
    $stream.Dispose()
  }
}

function Assert-ExpectedHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256
  )
  if ($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Expected SHA-256 must be 64 lowercase hexadecimal characters.' }
  $actual = Get-Sha256 -Path $Path
  if ($actual -cne $ExpectedSha256) {
    throw "Artifact hash mismatch for $Path. Expected $ExpectedSha256; found $actual."
  }
}

function Assert-MigrationMirrorParity {
  param([Parameter(Mandatory = $true)][ValidateSet('062', '063', '064', '068', '069')][string]$Migration)
  $root = Get-MyPersonasRepositoryRoot
  $pairs = @{
    '062' = @('MyPersonas.Online_v0\sql-updates\062-opaque-public-media-delivery.sql', 'supabase\migrations\20260823040000_opaque_public_media_delivery.sql')
    '063' = @('MyPersonas.Online_v0\sql-updates\063-opaque-approved-media-delivery.sql', 'supabase\migrations\20260823050000_opaque_approved_media_delivery.sql')
    '064' = @('MyPersonas.Online_v0\sql-updates\064-legacy-media-remediation.sql', 'supabase\migrations\20260823060000_legacy_media_remediation.sql')
    '068' = @('MyPersonas.Online_v0\sql-updates\068-account-subscription-entitlements.sql', 'supabase\migrations\20260823100000_account_subscription_entitlements.sql')
    '069' = @('MyPersonas.Online_v0\sql-updates\069-operational-alert-inbox.sql', 'supabase\migrations\20260823110000_operational_alert_inbox.sql')
  }
  $canonical = Join-Path $root $pairs[$Migration][0]
  $mirror = Join-Path $root $pairs[$Migration][1]
  $canonicalHash = Get-Sha256 -Path $canonical
  $mirrorHash = Get-Sha256 -Path $mirror
  if ($canonicalHash -cne $mirrorHash) {
    throw "Migration $Migration canonical/timestamp mirror parity failed."
  }
  return @{ Canonical = $canonical; Mirror = $mirror; Sha256 = $canonicalHash }
}

function Assert-BoundedEvidence {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($Value.Length -lt 8 -or $Value.Length -gt 200 -or $Value -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:/# -]*$') {
    throw "$Name must be 8-200 characters and contain only bounded ticket/evidence characters."
  }
}
