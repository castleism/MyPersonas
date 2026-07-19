# MyPersonas - repair a corrupt git index if needed, then stage, commit, and push.
# Run from the repo root in PowerShell:
#   cd D:\GIT\MyPersonas.Online ; .\_ops\push.ps1
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

# 3. Identity (only sets if missing).
if (-not (git config user.email)) { git config user.email "christiancodyak@gmail.com" }
if (-not (git config user.name))  { git config user.name  "Christian" }

# 4. Stage exactly the two changed files.
Write-Host "Staging..." -ForegroundColor Cyan
git add MyPersonas.Online_v0/index.html MyPersonas.Online_v0/ROADMAP.md MyPersonas.Online_v0/VERIFICATION.md README.md supabase

Write-Host "Status:" -ForegroundColor Cyan
git status -s

Write-Host "Committing..." -ForegroundColor Cyan
git commit -F "_ops\COMMIT_MSG.txt"

Write-Host "Pushing..." -ForegroundColor Cyan
git push origin main

Write-Host ""
Write-Host "Done. If push was rejected as non-fast-forward, run:" -ForegroundColor Green
Write-Host "  git pull --rebase origin main ; git push origin main" -ForegroundColor Green
