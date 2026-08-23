$ErrorActionPreference = "Stop"

$taskRepo = Split-Path -Parent $PSScriptRoot
$taskContainer = "mypersonas-legacy-media-064-test"
$taskCreated = $false

$taskExisting = @(& docker ps -a --format "{{.Names}}")
if ($LASTEXITCODE -ne 0) {
  throw "Docker is required for the legacy-media remediation SQL runtime test."
}
if ($taskExisting -contains $taskContainer) {
  throw "Container '$taskContainer' already exists. Remove or rename it before running this disposable test."
}

try {
  & docker run --detach --name $taskContainer --env POSTGRES_PASSWORD=postgres postgres:16 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not start the disposable PostgreSQL container."
  }
  $taskCreated = $true
  $taskReady = $false
  for ($taskAttempt = 0; $taskAttempt -lt 40; $taskAttempt += 1) {
    & docker exec $taskContainer pg_isready -U postgres | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $taskReady = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $taskReady) {
    throw "Disposable PostgreSQL did not become ready."
  }

  $taskFiles = @(
    "tests/sql/059-ai-content-provenance-seed.sql",
    "MyPersonas.Online_v0/sql-updates/059-ai-content-provenance-watermark.sql",
    "MyPersonas.Online_v0/sql-updates/060-ai-content-provenance-hardening.sql",
    "MyPersonas.Online_v0/sql-updates/060-ai-content-provenance-hardening.sql",
    "tests/sql/062-opaque-public-media-seed.sql",
    "MyPersonas.Online_v0/sql-updates/062-opaque-public-media-delivery.sql",
    "MyPersonas.Online_v0/sql-updates/062-opaque-public-media-delivery.sql",
    "tests/sql/063-opaque-approved-media-seed.sql",
    "MyPersonas.Online_v0/sql-updates/063-opaque-approved-media-delivery.sql",
    "MyPersonas.Online_v0/sql-updates/063-opaque-approved-media-delivery.sql",
    "tests/sql/064-legacy-media-remediation-seed.sql",
    "MyPersonas.Online_v0/sql-updates/064-legacy-media-remediation.sql",
    "MyPersonas.Online_v0/sql-updates/064-legacy-media-remediation.sql",
    "tests/sql/064-legacy-media-remediation-runtime.sql"
  )
  foreach ($taskRelative in $taskFiles) {
    $taskPath = Join-Path $taskRepo $taskRelative
    Get-Content -LiteralPath $taskPath -Raw |
      & docker exec -i $taskContainer psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres
    if ($LASTEXITCODE -ne 0) {
      throw "SQL verification failed while applying $taskRelative"
    }
  }
  Write-Output "Migrations 059-064, repeated 060/062/063/064 application, and legacy-media role, isolation, preview, idempotency, and erasure assertions passed."
}
finally {
  if ($taskCreated) {
    & docker rm --force $taskContainer | Out-Null
  }
}
