# deploy-nooyouniverse.ps1 — publish nooyouniverse.com
#
# Run from anywhere in PowerShell:
#   & "$HOME\Documents\GitHub\MyPersonas\_ops\deploy-nooyouniverse.ps1"
# The default is a read-only preview. Add -Publish only after the release scope
# has been reviewed and approved.
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
  [string]$Message = "nooyouniverse.com: content update",
  [switch]$Publish,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Preview = -not $Publish
if ($Publish -and $DryRun) { throw "Choose either -Publish or -DryRun, not both." }
if ($DryRun) { $Preview = $true }
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

function Push-Repo($repo, $msg, [string[]]$paths) {
  Clear-StaleLocks $repo
  Push-Location $repo
  try {
    git add -- $paths
    if (git status --porcelain -- $paths) {
      git commit -m $msg -- $paths
    } else {
      Write-Host "  (nothing to commit)" -ForegroundColor DarkGray
    }
    git push
    Write-Host "  pushed: $(git rev-parse --short HEAD)" -ForegroundColor Green
  } finally { Pop-Location }
}

function Get-FileHashOrMissing($path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "MISSING" }
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
}

# --- 1. Sync source -> deploy repo -------------------------------------------
Write-Host "== Syncing site into deploy repo ==" -ForegroundColor Cyan
if (-not (Test-Path $src -PathType Container)) { throw "Source directory not found: $src" }
if (-not (Test-Path $deploy -PathType Container)) { throw "Deploy repository not found: $deploy" }
if (-not (Test-Path $pub)) {
  if ($Preview) { throw "Deploy public directory is missing: $pub" }
  New-Item -ItemType Directory -Path $pub -Force | Out-Null
}

$resolvedDeploy = (Resolve-Path -LiteralPath $deploy).Path.TrimEnd('\')
$resolvedPub = (Resolve-Path -LiteralPath $pub).Path.TrimEnd('\')
if (-not $resolvedPub.StartsWith($resolvedDeploy + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to sync outside the deploy repository: $resolvedPub"
}

# Everything published lives in public\. Docs (SITE-ROADMAP.md) stay out.
$pages = @("index.html","log.html","sources.html","corrections.html",
           "404.html","robots.txt","sitemap.xml","CNAME")
foreach ($f in $pages) {
  $from = Join-Path $src $f
  $to = Join-Path $pub $f
  if (Test-Path $from) {
    if ($Preview) {
      $state = if ((Get-FileHashOrMissing $from) -eq (Get-FileHashOrMissing $to)) { "unchanged" } else { "would sync" }
      Write-Host "  [$state] $f"
    } else {
      Copy-Item $from $to -Force
      Write-Host "  $f"
    }
  }
  else { Write-Host "  (missing, skipped) $f" -ForegroundColor Yellow }
}
$srcAssets = Join-Path $src "assets"
if (-not (Test-Path $srcAssets -PathType Container)) { throw "Source assets directory not found: $srcAssets" }
if ($Preview) {
  $sourceAssetCount = @(Get-ChildItem -LiteralPath $srcAssets -Recurse -File).Count
  $deployAssetCount = @(Get-ChildItem -LiteralPath (Join-Path $pub "assets") -Recurse -File -ErrorAction SilentlyContinue).Count
  Write-Host "  [preview] assets\ — source $sourceAssetCount file(s), deploy $deployAssetCount file(s)"
  Write-Host ""
  Write-Host "Preview complete. No files copied, staged, committed, pushed, or deployed." -ForegroundColor Green
  Write-Host "To publish this exact scope after approval, rerun with -Publish and an explicit -Message." -ForegroundColor Yellow
  exit 0
}
Copy-Item $srcAssets $pub -Recurse -Force
Write-Host "  assets\"

# --- 2. Push deploy repo (triggers Cloudflare build) -------------------------
Write-Host "== Pushing deploy repo (castleism/nooyouniverse) ==" -ForegroundColor Cyan
Push-Repo $deploy $Message @("public")

# --- 3. Push source repo -----------------------------------------------------
Write-Host "== Pushing MyPersonas source ==" -ForegroundColor Cyan
Push-Repo $root $Message @("nooyouniverse.com", "_ops/deploy-nooyouniverse.ps1")

Write-Host ""
Write-Host "Cloudflare builds automatically (~1 min). Watch:" -ForegroundColor Green
Write-Host "  https://dash.cloudflare.com/?to=/:account/workers/services/view/nooyouniverse/production/deployments"
Write-Host "Then check: https://nooyouniverse.com  /log  /sources  /corrections"
