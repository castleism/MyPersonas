$ErrorActionPreference = "Stop"

$opsRepo = Split-Path -Parent $PSScriptRoot
$opsContainer = "mypersonas-operational-alerts-069-test"
$opsCreated = $false

$opsExisting = @(& docker ps -a --format "{{.Names}}")
if ($LASTEXITCODE -ne 0) {
  throw "Docker is required for the operational-alert SQL runtime test."
}
if ($opsExisting -contains $opsContainer) {
  throw "Container '$opsContainer' already exists. Remove or rename it before running this disposable test."
}

try {
  & docker run --detach --name $opsContainer --env POSTGRES_PASSWORD=postgres postgres:16 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not start the disposable PostgreSQL container." }
  $opsCreated = $true

  $opsReady = $false
  for ($opsAttempt = 0; $opsAttempt -lt 30; $opsAttempt += 1) {
    & docker exec $opsContainer pg_isready -U postgres | Out-Null
    if ($LASTEXITCODE -eq 0) { $opsReady = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $opsReady) { throw "Disposable PostgreSQL did not become ready." }
  # Avoid the narrow startup handoff where pg_isready has succeeded but the
  # first independent docker exec reaches the postmaster before it accepts psql.
  Start-Sleep -Milliseconds 250

  $opsFiles = @(
    "tests/sql/069-operational-alert-inbox-seed.sql",
    "MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql",
    "MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql",
    "tests/sql/069-operational-alert-inbox-runtime.sql"
  )
  foreach ($opsRelative in $opsFiles) {
    $opsPath = Join-Path $opsRepo $opsRelative
    Get-Content -LiteralPath $opsPath -Raw |
      & docker exec -i $opsContainer psql -v ON_ERROR_STOP=1 -U postgres -d postgres
    if ($LASTEXITCODE -ne 0) {
      throw "SQL verification failed while applying $opsRelative"
    }
  }

  Write-Output "Operational-alert migration 069 applied before billing, reapplied, and passed AAL2, redaction, pagination, heartbeat, and bounded-retention assertions."
}
finally {
  if ($opsCreated) {
    & docker rm --force $opsContainer | Out-Null
  }
}
