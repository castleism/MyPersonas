$ErrorActionPreference = "Stop"

$taskRepo = Split-Path -Parent $PSScriptRoot
$taskContainer = "mypersonas-persona-view-058-test"
$taskCreated = $false

$taskExisting = @(& docker ps -a --format "{{.Names}}")
if ($LASTEXITCODE -ne 0) {
  throw "Docker is required for the persona-view SQL runtime test."
}
if ($taskExisting -contains $taskContainer) {
  throw "Container '$taskContainer' already exists. Remove or rename it before running this disposable test."
}

try {
  & docker run --detach --name $taskContainer --env POSTGRES_PASSWORD=postgres postgres:16 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not start the disposable PostgreSQL container." }
  $taskCreated = $true

  $taskReady = $false
  for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt += 1) {
    & docker exec $taskContainer pg_isready -U postgres | Out-Null
    if ($LASTEXITCODE -eq 0) { $taskReady = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $taskReady) { throw "Disposable PostgreSQL did not become ready." }

  $taskFiles = @(
    "tests/sql/058-persona-view-mode-seed.sql",
    "MyPersonas.Online_v0/sql-updates/058-persona-view-mode.sql",
    "MyPersonas.Online_v0/sql-updates/058-persona-view-mode.sql",
    "tests/sql/058-persona-view-mode-runtime.sql"
  )
  foreach ($taskRelative in $taskFiles) {
    $taskPath = Join-Path $taskRepo $taskRelative
    Get-Content -LiteralPath $taskPath -Raw | & docker exec -i $taskContainer psql -U postgres -d postgres
    if ($LASTEXITCODE -ne 0) { throw "SQL verification failed while applying $taskRelative" }
  }

  Write-Output "Persona-view migration 058 applied, reapplied, and passed its role-switched runtime assertions."
}
finally {
  if ($taskCreated) {
    & docker rm --force $taskContainer | Out-Null
  }
}
