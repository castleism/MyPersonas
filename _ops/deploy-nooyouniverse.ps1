# deploy-nooyouniverse.ps1 — publish nooyouniverse.com
#
# Run from anywhere in PowerShell:
#   & "$HOME\Documents\GitHub\MyPersonas\_ops\deploy-nooyouniverse.ps1"
#
# What it does, in order:
#   1. Sweeps stale git locks the sandbox leaves behind (known mount quirk).
#   2. Syncs the site from the source of truth (MyPersonas\nooyouniverse.com)
#      into the deploy repo's public\ folder.
#   3. Commits + pushes the deploy repo -> Cloudflare auto-builds and deploys.
#   4. Commits + pushes the MyPersonas source copy.
#
# Live: https://nooyouniverse.com  (also www.)
# Architecture + gotchas: MyPersonas\nooyouniverse.com\SITE-ROADMAP.md

param(
  [string]$Message = "nooyouniverse.com: content update"
)

$ErrorActionPreference = "Stop"
$root   = Split-Path -Parent $PSScriptRoot                        # ...\GitHub\MyPersonas
$src    = Join-Path $root "nooyouniverse.com"                     # source of truth
$deploy = Join-Path (Split-Path -Parent $root) "nooyouniverse"    # deploy repo
$pub    = Join-Path $deploy "public"

function Clear-StaleLocks($repo) {
  $git = Join-Path $repo ".git"
  if (-not (Test-Path $git)) { return }
  Get-ChildItem $git -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -like "*.lock*" -or $_.Name -like "stale-*" -or
      $_.Name -like "tmp_obj_*" -or $_.Name -eq "claude-probe"
    } | Remove-Item -Force -ErrorAction SilentlyContinue
}

function Push-Repo($repo, $msg) {
  Clear-StaleLocks $repo
  Push-Location $repo
  try {
    git add -A
    if (git status --porcelain) {
      git commit -m $msg
    } else {
      Write-Host "  (nothing to commit)" -ForegroundColor DarkGray
    }
    git push
    Write-Host "  pushed: $(git rev-parse --short HEAD)" -ForegroundColor Green
  } finally { Pop-Location }
}

# --- 1. Sync source -> deploy repo -------------------------------------------
Write-Host "== Syncing site into deploy repo ==" -ForegroundColor Cyan
if (-not (Test-Path $pub)) { New-Item -ItemType Directory -Path $pub -Force | Out-Null }

# Everything published lives in public\. Docs (SITE-ROADMAP.md) stay out.
$pages = @("index.html","log.html","sources.html","corrections.html",
           "404.html","robots.txt","sitemap.xml","CNAME")
foreach ($f in $pages) {
  $from = Join-Path $src $f
  if (Test-Path $from) { Copy-Item $from (Join-Path $pub $f) -Force; Write-Host "  $f" }
  else { Write-Host "  (missing, skipped) $f" -ForegroundColor Yellow }
}
Copy-Item (Join-Path $src "assets") $pub -Recurse -Force
Write-Host "  assets\"

# --- 2. Push deploy repo (triggers Cloudflare build) -------------------------
Write-Host "== Pushing deploy repo (castleism/nooyouniverse) ==" -ForegroundColor Cyan
Push-Repo $deploy $Message

# --- 3. Push source repo -----------------------------------------------------
Write-Host "== Pushing MyPersonas source ==" -ForegroundColor Cyan
Push-Repo $root $Message

Write-Host ""
Write-Host "Cloudflare builds automatically (~1 min). Watch:" -ForegroundColor Green
Write-Host "  https://dash.cloudflare.com/?to=/:account/workers/services/view/nooyouniverse/production/deployments"
Write-Host "Then check: https://nooyouniverse.com  /log  /sources  /corrections"
