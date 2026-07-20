# AliaSpaces / MyPersonas - repair a corrupt git index if needed, then stage, commit, and push.
# Run from the repo root in PowerShell:
#   .\_ops\push.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)   # repo root (parent of _ops)

# 1. Clear any stale lock the sandbox left behind.
Remove-Item ".git\index.lock" -Force -ErrorAction SilentlyContinue

# 2. If the index is corrupt ("cache entry has null sha1" / phantom deletions),
#    rebuild it cleanly from HEAD. Safe: only touches the staging area, not files.
$bad = $false
try { git status -s 1>$null 2>$null; if ($LASTEXITCODE -ne 0) { $bad = $true } } catch { $bad = $true }
if ($bad) {
  Write-Host "Index looks corrupt - rebuilding from HEAD..." -ForegroundColor Yellow
  Remove-Item ".git\index" -Force -ErrorAction SilentlyContinue
  git reset -q
}

# 3. Require a configured identity without putting a private address in the repo.
if (-not (git config user.email) -or -not (git config user.name)) {
  throw "Configure git user.name and user.email before using this release helper."
}

# 4. Stage the complete site/server release. This includes ordered migrations and
#    newly added Edge Function directories; omitting either can leave the live client
#    incompatible with its database or server tier.
Write-Host "Staging..." -ForegroundColor Cyan
git add -- MyPersonas.Online_v0 README.md supabase .github _ops

Write-Host "Status:" -ForegroundColor Cyan
git status -s

Write-Host "Committing..." -ForegroundColor Cyan
git commit -F "_ops\COMMIT_MSG.txt"

Write-Host "Pushing..." -ForegroundColor Cyan
git push origin main

Write-Host ""
Write-Host "Done. If push was rejected as non-fast-forward, run:" -ForegroundColor Green
Write-Host "  git pull --rebase origin main ; git push origin main" -ForegroundColor Green
