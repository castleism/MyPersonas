# deploy-nooyouniverse.ps1 — one-shot morning deploy for nooyouniverse.com
# Prepared 2026-08-09 (overnight session). Run from anywhere in PowerShell:
#   & "$HOME\Documents\GitHub\MyPersonas\_ops\deploy-nooyouniverse.ps1"
#
# What it does:
#   1. Cleans stale git locks the sandbox left behind (known quirk).
#   2. Pushes MyPersonas main (contains site source + migration 027).
#   3. Pushes the ready-made deploy repo GitHub/nooyouniverse (creates it on
#      GitHub via `gh` if installed; otherwise prints the manual step).
#   4. Prints the 3 remaining dashboard steps (Supabase SQL, Cloudflare Pages,
#      custom domain) — about 5 minutes total.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # ...\GitHub\MyPersonas
$deploy = Join-Path (Split-Path -Parent $root) "nooyouniverse"

function Clear-StaleLocks($repo) {
  Get-ChildItem (Join-Path $repo ".git") -Filter "*.lock*" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem (Join-Path $repo ".git\objects") -Recurse -Filter "tmp_obj_*" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $repo ".git\claude-probe") -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $repo ".git\objects\maintenance.lock") -Force -ErrorAction SilentlyContinue
}

Write-Host "== 1/4 Pushing MyPersonas (site source) ==" -ForegroundColor Cyan
Clear-StaleLocks $root
Set-Location $root
git push origin main

Write-Host "== 2/4 Pushing deploy repo (castleism/nooyouniverse) ==" -ForegroundColor Cyan
Clear-StaleLocks $deploy
Set-Location $deploy
$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
  gh repo view castleism/nooyouniverse 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    gh repo create castleism/nooyouniverse --public --source . --push
  } else {
    git push -u origin main
  }
} else {
  git push -u origin main
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Remote missing. Create it at https://github.com/new (name: nooyouniverse, public, NO readme), then re-run this script." -ForegroundColor Yellow
    exit 1
  }
}

Write-Host "== 3/4 Supabase waitlist table ==" -ForegroundColor Cyan
Write-Host @"
Open: https://supabase.com/dashboard/project/nwsqyuucwzihruszocge/sql/new
Paste + Run: $root\MyPersonas.Online_v0\sql-updates\027-noo-waitlist.sql
(An editor tab from last night may already be open with this SQL typed partway.)
"@

Write-Host "== 4/4 Cloudflare Pages + domain (zone already on Cloudflare) ==" -ForegroundColor Cyan
Write-Host @"
Open: https://dash.cloudflare.com -> Workers & Pages -> Create -> Pages ->
  Connect to Git -> castleism/nooyouniverse
  Build command: (none)   Output dir: /   -> Deploy
Then: project -> Custom domains -> add nooyouniverse.com (DNS auto-creates)
       + add www.nooyouniverse.com if wanted.

Test after deploy:
  1. https://nooyouniverse.com loads with HTTPS, hero + Mission Log page work
  2. Waitlist form: submit an email -> 'You're aboard' -> row appears in
     Supabase Table Editor (noo_waitlist); submit same email -> 'already aboard'
"@
Write-Host "Done. Full details: $root\nooyouniverse.com\SITE-ROADMAP.md" -ForegroundColor Green
