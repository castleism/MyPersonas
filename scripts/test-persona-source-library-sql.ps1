$ErrorActionPreference = "Stop"

$sourceRepo = Split-Path -Parent $PSScriptRoot
$sourceContainer = "mypersonas-persona-source-library-070-test"
$sourceCreated = $false

$sourceExisting = @(& docker ps -a --format "{{.Names}}")
if ($LASTEXITCODE -ne 0) {
  throw "Docker is required for the persona source-library SQL runtime test."
}
if ($sourceExisting -contains $sourceContainer) {
  throw "Container '$sourceContainer' already exists. Remove or rename it before running this disposable test."
}

try {
  & docker run --detach --name $sourceContainer --env POSTGRES_PASSWORD=postgres postgres:16 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not start the disposable PostgreSQL container." }
  $sourceCreated = $true

  $sourceReady = $false
  for ($sourceAttempt = 0; $sourceAttempt -lt 30; $sourceAttempt += 1) {
    & docker exec $sourceContainer pg_isready -U postgres | Out-Null
    if ($LASTEXITCODE -eq 0) { $sourceReady = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $sourceReady) { throw "Disposable PostgreSQL did not become ready." }
  Start-Sleep -Milliseconds 250

  $sourceFiles = @(
    "tests/sql/070-persona-source-library-seed.sql",
    "MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql",
    "MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql",
    "tests/sql/070-persona-source-library-runtime.sql"
  )
  foreach ($sourceRelative in $sourceFiles) {
    $sourcePath = Join-Path $sourceRepo $sourceRelative
    Get-Content -LiteralPath $sourcePath -Raw |
      & docker exec -i $sourceContainer psql -v ON_ERROR_STOP=1 -U postgres -d postgres
    if ($LASTEXITCODE -ne 0) {
      throw "SQL verification failed while applying $sourceRelative"
    }
  }

  Write-Output "Persona source-library migration 070 applied, replayed, and passed role-switched quota, privacy, study, retention, and byte-first-erasure assertions."
}
finally {
  if ($sourceCreated) {
    & docker rm --force $sourceContainer | Out-Null
  }
}
