[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$StagingProjectRef,
  [ValidateSet('https://mypersonas-staging.pages.dev','https://staging.mypersonas.online')]
  [string]$StagingSiteOrigin = 'https://mypersonas-staging.pages.dev',
  [string]$AnonKeyEnvironmentVariable = 'MP_STAGING_SUPABASE_ANON_KEY',
  [string]$TurnstileSiteKeyEnvironmentVariable = 'MP_STAGING_TURNSTILE_SITE_KEY'
)

. (Join-Path $PSScriptRoot 'Common.ps1')

Assert-ProjectRef -ProjectRef $StagingProjectRef
$supabaseOrigin = "https://$StagingProjectRef.supabase.co"
Assert-CanonicalStagingOrigins `
  -ProjectRef $StagingProjectRef `
  -SupabaseOrigin $supabaseOrigin `
  -PublicMediaOrigin $script:StagingMediaOrigin `
  -SiteOrigin $StagingSiteOrigin

$anonKey = Get-RequiredEnvironmentValue -Name $AnonKeyEnvironmentVariable
$turnstileSiteKey = Get-RequiredEnvironmentValue -Name $TurnstileSiteKeyEnvironmentVariable
if ($anonKey -cnotmatch '^[A-Za-z0-9._-]{20,4096}$' -or
    $anonKey -ceq 'sb_publishable_vN6BdSvBKf_yTJt0eeK20w_afKz1Df2') {
  throw 'Staging anon/publishable key is malformed or equals the production key.'
}
if ($turnstileSiteKey -cnotmatch '^[A-Za-z0-9_-]{10,200}$') {
  throw 'Staging Turnstile site key is malformed.'
}

$root = Get-MyPersonasRepositoryRoot
$sourceDirectory = Join-Path $root 'MyPersonas.Online_v0'
$productionAnonKey = 'sb_publishable_vN6BdSvBKf_yTJt0eeK20w_afKz1Df2'
$productionMediaOrigin = 'https://media.mypersonas.online'
$outputFull = [IO.Path]::GetFullPath($OutputDirectory)
$fileManifestPath = "$outputFull.staging-artifact-files.json"
$artifactManifestPath = "$outputFull.staging-artifact-manifest.json"
if ($outputFull -ceq $sourceDirectory `
    -or $outputFull.StartsWith($sourceDirectory + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) `
    -or $sourceDirectory.StartsWith($outputFull + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Staging artifact output cannot overwrite or contain the source site.'
}
foreach ($evidencePath in @($fileManifestPath,$artifactManifestPath)) {
  if (Test-Path -LiteralPath $evidencePath) {
    throw "Staging artifact evidence path already exists: $evidencePath"
  }
}
if (Test-Path -LiteralPath $outputFull) {
  if ((Get-ChildItem -LiteralPath $outputFull -Force | Measure-Object).Count -ne 0) {
    throw 'Staging artifact output must be new or empty.'
  }
} else {
  [IO.Directory]::CreateDirectory($outputFull) | Out-Null
}

$publicFiles = @(
  'index.html','owner-app.css','owner-app.js','persona-view.css','persona-view.js',
  'platform-governance.css','platform-governance.js','billing.css','billing.js',
  'ai-content-provenance.css','ai-content-provenance.js',
  'profile-image-crop.css','profile-image-crop.js','agent-board.css','agent-board.js',
  'persona-library.css','persona-library.js',
  'manifest.webmanifest','service-worker.js','pwa.js','offline.html','.nojekyll',
  'robots.txt','privacy.html','terms.html','data-deletion.html','provider-setup.html'
)
foreach ($relative in $publicFiles) {
  $source = Join-Path $sourceDirectory $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Reviewed public artifact file is missing: $relative" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $outputFull $relative)
}

# This is intentionally an exact allowlist, not an extension-based copy. A new
# source asset therefore cannot enter the public staging package without code
# review. Persona fixtures, design previews, marketing drafts, documentation,
# and the production-configured desktop release archive are excluded.
$publicAssetFiles = @(
  'assets\bg.png',
  'assets\favicon.svg',
  'assets\hero.png',
  'assets\MyPersonas-AI-Watermark.png',
  'assets\Extensions\Concept\releases.json',
  'assets\Extensions\registry.json',
  'brand\app-icon\favicon.ico',
  'brand\app-icon\icon.svg',
  'brand\app-icon\icon-180.png',
  'brand\app-icon\icon-192.png',
  'brand\app-icon\icon-512.png',
  'brand\app-icon\icon-maskable-512.png'
)
foreach ($relative in $publicAssetFiles) {
  $source = Join-Path $sourceDirectory $relative
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Reviewed public artifact asset is missing: $relative" }
  $destination = Join-Path $outputFull $relative
  [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination
}

# The checked-in Personas desktop ZIP is production-configured. Staging must
# neither offer that download nor let the extension catalog route a tester to
# it. Keep the visible navigation target as a no-download staging explanation.
$registryPath = Join-Path $outputFull 'assets\Extensions\registry.json'
$registryDocument = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json
$registry = @($registryDocument | ForEach-Object { $_ })
$stagingRegistry = @($registry | Where-Object { $_.id -cne 'personas' })
if ($registry.Count -ne ($stagingRegistry.Count + 1) -or @($registry | Where-Object { $_.id -ceq 'personas' }).Count -ne 1) {
  throw 'Expected exactly one production-configured Personas desktop catalog entry.'
}
[IO.File]::WriteAllText($registryPath,(ConvertTo-Json -InputObject $stagingRegistry -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
$downloadDirectory = Join-Path $outputFull 'assets\Downloads\Personas'
[IO.Directory]::CreateDirectory($downloadDirectory) | Out-Null
$downloadStub = @"
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
<title>Desktop download unavailable in isolated staging</title></head>
<body><main><h1>Desktop download unavailable in staging</h1><p>The checked-in desktop release is configured for production and is intentionally excluded from this isolated test artifact.</p><p><a href="$StagingSiteOrigin/">Return to AliaSpaces staging</a></p></main></body></html>
"@
[IO.File]::WriteAllText((Join-Path $downloadDirectory 'index.html'),$downloadStub,[Text.UTF8Encoding]::new($false))

if (Test-Path -LiteralPath (Join-Path $outputFull 'CNAME')) {
  throw 'Production CNAME must never enter a staging Pages artifact.'
}
$indexPath = Join-Path $outputFull 'index.html'
$html = [IO.File]::ReadAllText($indexPath)

function Replace-ExactlyOnce {
  param([string]$Text,[string]$Needle,[string]$Replacement,[string]$Label)
  $count = ([regex]::Matches($Text,[regex]::Escape($Needle))).Count
  if ($count -ne 1) { throw "Expected exactly one $Label marker; found $count." }
  return $Text.Replace($Needle,$Replacement)
}

$html = Replace-ExactlyOnce $html `
  'SUPABASE_URL:"https://nwsqyuucwzihruszocge.supabase.co"' `
  "SUPABASE_URL:`"$supabaseOrigin`"" `
  'production Supabase CONFIG'
$html = Replace-ExactlyOnce $html `
  "SUPABASE_ANON_KEY:`"$productionAnonKey`"" `
  "SUPABASE_ANON_KEY:`"$anonKey`"" `
  'production anon CONFIG'
$html = Replace-ExactlyOnce $html `
  'PUBLIC_MEDIA_ORIGIN:"https://media.mypersonas.online"' `
  "PUBLIC_MEDIA_ORIGIN:`"$($script:StagingMediaOrigin)`"" `
  'production media CONFIG'

$turnstilePattern = 'TURNSTILE_SITE_KEY:"[^"]*"'
$turnstileMatches = [regex]::Matches($html,$turnstilePattern)
if ($turnstileMatches.Count -ne 1) { throw "Expected exactly one Turnstile CONFIG marker; found $($turnstileMatches.Count)." }
$html = [regex]::Replace($html,$turnstilePattern,"TURNSTILE_SITE_KEY:`"$turnstileSiteKey`"",1)

$metadataCount = ([regex]::Matches($html,[regex]::Escape('https://mypersonas.online/'))).Count
if ($metadataCount -ne 5) { throw "Expected five production metadata origins; found $metadataCount." }
$html = $html.Replace('https://mypersonas.online/',"$StagingSiteOrigin/")

$guardAnchor = "// ============================================================================`nconst PLATS="
if (-not $html.Contains($guardAnchor)) {
  $guardAnchor = "// ============================================================================`r`nconst PLATS="
}
if (([regex]::Matches($html,[regex]::Escape($guardAnchor))).Count -ne 1) {
  throw 'Could not locate the unique CONFIG guard insertion point.'
}
$newline = if ($guardAnchor.Contains("`r`n")) { "`r`n" } else { "`n" }
$guard = @(
  '// STAGING ARTIFACT GUARD — generated, not repository source.',
  "const STAGING_RUNTIME_ORIGIN=`"$StagingSiteOrigin`";",
  "const STAGING_SUPABASE_ORIGIN=`"$supabaseOrigin`";",
  "const STAGING_MEDIA_ORIGIN=`"$($script:StagingMediaOrigin)`";",
  'if(window.location.origin!==STAGING_RUNTIME_ORIGIN||',
  '   CONFIG.SUPABASE_URL!==STAGING_SUPABASE_ORIGIN||',
  '   CONFIG.PUBLIC_MEDIA_ORIGIN!==STAGING_MEDIA_ORIGIN){',
  '  document.documentElement.innerHTML="<body><main><h1>Staging configuration blocked</h1><p>This artifact is not running on its reviewed isolated origin.</p></main></body>";',
  '  throw new Error("Staging origin/project crossover blocked");',
  '}',
  'Object.freeze(CONFIG);',
  '// ============================================================================'
) -join $newline
$html = $html.Replace($guardAnchor,"// ============================================================================$newline$guard$newline" + 'const PLATS=')

foreach ($forbidden in @(
  'SUPABASE_URL:"https://nwsqyuucwzihruszocge.supabase.co"',
  "SUPABASE_ANON_KEY:`"$productionAnonKey`"",
  'PUBLIC_MEDIA_ORIGIN:"https://media.mypersonas.online"'
)) {
  if ($html.Contains($forbidden)) { throw 'Generated artifact retained a production runtime value.' }
}
[IO.File]::WriteAllText($indexPath,$html,[Text.UTF8Encoding]::new($false))

# Rewrite every copied HTML absolute production link, add page-level noindex,
# and keep canonical/legal routes on the one exact staging host.
$htmlFiles = @(Get-ChildItem -LiteralPath $outputFull -Filter '*.html' -File -Recurse)
$headPattern = [regex]::new('<head(?:\s[^>]*)?>',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
$robotsMetaPattern = [regex]::new('<meta\b(?=[^>]*\bname\s*=\s*["'']robots["''])[^>]*>',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
foreach ($file in $htmlFiles) {
  $content = [IO.File]::ReadAllText($file.FullName).Replace('https://mypersonas.online/',"$StagingSiteOrigin/")
  if (-not $headPattern.IsMatch($content)) { throw "Public HTML lacks a head element: $($file.FullName)" }
  $content = $robotsMetaPattern.Replace($content,'')
  $content = $headPattern.Replace($content,('$0' + $newline + '<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">'),1)
  [IO.File]::WriteAllText($file.FullName,$content,[Text.UTF8Encoding]::new($false))
}

$webManifestPath = Join-Path $outputFull 'manifest.webmanifest'
$webManifest = Get-Content -Raw -LiteralPath $webManifestPath | ConvertFrom-Json
$webManifest.id = "$StagingSiteOrigin/"
$webManifest.name = "AliaSpaces Staging - isolated test environment"
$webManifest.short_name = 'AliaSpaces Staging'
$webManifest.start_url = "$StagingSiteOrigin/"
$webManifest.scope = "$StagingSiteOrigin/"
foreach ($shortcut in $webManifest.shortcuts) {
  $route = if ($shortcut.url -match '#/[^\s]+$') { $Matches[0] } else { '' }
  $shortcut.url = "$StagingSiteOrigin/$route"
}
[IO.File]::WriteAllText($webManifestPath,($webManifest | ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))

[IO.File]::WriteAllText(
  (Join-Path $outputFull 'robots.txt'),
  "User-agent: *`nDisallow: /`n",
  [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
  (Join-Path $outputFull '_headers'),
  "/*`n  X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`n  Referrer-Policy: no-referrer`n  Cache-Control: no-store`n",
  [Text.UTF8Encoding]::new($false)
)

# Disable PWA caching in staging. Registering this teardown worker replaces any
# accidentally cached production-named worker on the staging origin, clears only
# that origin's shell caches, claims the clients, and unregisters itself.
$teardownWorker = @'
"use strict";
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((name) =>
    name.startsWith("aliaspaces-public-shell-") || name.startsWith("aliaspaces-staging-")
  ).map((name) => caches.delete(name)));
  await self.clients.claim();
  await self.registration.unregister();
})()));
'@
[IO.File]::WriteAllText((Join-Path $outputFull 'service-worker.js'),$teardownWorker,[Text.UTF8Encoding]::new($false))
$teardownRegistration = @'
(() => {
  "use strict";
  if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;
  window.addEventListener("load", async () => {
    try {
      const url = new URL("./service-worker.js", document.baseURI);
      if (url.origin !== location.origin) return;
      await navigator.serviceWorker.register(url.href, { scope: "./", updateViaCache: "none" });
    } catch (error) {
      console.warn("Staging PWA cache teardown failed.", error);
    }
  });
})();
'@
[IO.File]::WriteAllText((Join-Path $outputFull 'pwa.js'),$teardownRegistration,[Text.UTF8Encoding]::new($false))

# Scan text and downloadable archives before hashing. Public anon/Turnstile keys
# are allowed only because they are the exact supplied staging values; service
# credentials, private keys, password URLs, and unrelated JWTs are rejected.
$secretPatterns = @(
  '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
  'postgres(?:ql)?://[^\s:''"/]+:[^\s@''"/]+@',
  '\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b',
  '\bwhsec_[A-Za-z0-9]{16,}\b',
  '\bsb_secret_[A-Za-z0-9_-]{16,}\b',
  '\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'
)
function Assert-PublicTextSafe {
  param([string]$Text,[string]$Label,[switch]$AllowStagingPublicKeys)
  foreach ($pattern in $secretPatterns) {
    if ([regex]::IsMatch($Text,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
      throw "Potential service credential in reviewed public artifact: $Label"
    }
  }
  $jwtMatches = [regex]::Matches($Text,'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b')
  foreach ($match in $jwtMatches) {
    if (-not $AllowStagingPublicKeys -or $match.Value -cne $anonKey) {
      throw "Unreviewed JWT-like value in public artifact: $Label"
    }
  }
}

function Assert-NoProductionCrossover {
  param([string]$Text,[string]$Label)
  foreach ($marker in @(
    $script:MyPersonasProductionProjectRef,
    $productionAnonKey,
    $productionMediaOrigin,
    'https://mypersonas.online'
  )) {
    if ($Text.Contains($marker)) {
      throw "Production runtime/site marker remains in staging artifact: $Label"
    }
  }
}

$textExtensions = @('.html','.js','.css','.json','.webmanifest','.svg','.txt','.xml')
foreach ($file in Get-ChildItem -LiteralPath $outputFull -File -Recurse) {
  if ($textExtensions -ccontains $file.Extension.ToLowerInvariant() -or $file.Name -eq '_headers') {
    $text = [IO.File]::ReadAllText($file.FullName)
    $text = $text.Replace($script:MyPersonasProductionProjectRef,$StagingProjectRef)
    $text = $text.Replace($productionAnonKey,$anonKey)
    $text = $text.Replace($productionMediaOrigin,$script:StagingMediaOrigin)
    $text = $text.Replace('https://mypersonas.online',$StagingSiteOrigin)
    [IO.File]::WriteAllText($file.FullName,$text,[Text.UTF8Encoding]::new($false))
    Assert-PublicTextSafe -Text $text -Label $file.FullName -AllowStagingPublicKeys
    Assert-NoProductionCrossover -Text $text -Label $file.FullName
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($archive in Get-ChildItem -LiteralPath $outputFull -Filter '*.zip' -File -Recurse) {
  $zip = [IO.Compression.ZipFile]::OpenRead($archive.FullName)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName -match '(^|/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|private[-_]?key)[^/]*)' -or
          $entry.FullName.Contains('..')) {
        throw "Unsafe archive entry in reviewed public artifact: $($archive.Name)"
      }
      if ([IO.Path]::GetExtension($entry.FullName).ToLowerInvariant() -in @('.js','.json','.html','.css','.md','.txt','.yml','.yaml')) {
        $stream = $entry.Open()
        $reader = [IO.StreamReader]::new($stream,[Text.Encoding]::UTF8,$true,4096,$false)
        try {
          $archiveText = $reader.ReadToEnd()
          Assert-PublicTextSafe -Text $archiveText -Label "$($archive.Name):$($entry.FullName)"
          Assert-NoProductionCrossover -Text $archiveText -Label "$($archive.Name):$($entry.FullName)"
        }
        finally { $reader.Dispose() }
      }
    }
  } finally { $zip.Dispose() }
}

$contentFiles = @(Get-ChildItem -LiteralPath $outputFull -File -Recurse | Sort-Object FullName)
$fileManifest = @($contentFiles | ForEach-Object {
  [ordered]@{
    path = $_.FullName.Substring($outputFull.Length + 1).Replace('\','/')
    bytes = $_.Length
    sha256 = Get-Sha256 -Path $_.FullName
  }
})
[IO.File]::WriteAllText($fileManifestPath,($fileManifest | ConvertTo-Json -Depth 5)+"`n",[Text.UTF8Encoding]::new($false))

$hasher = [Security.Cryptography.SHA256]::Create()
try {
  $anonHash = ($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($anonKey)) | ForEach-Object { $_.ToString('x2') }) -join ''
} finally { $hasher.Dispose() }
$manifest = [ordered]@{
  artifact_type = 'mypersonas-isolated-staging-frontend'
  created_at_utc = [DateTime]::UtcNow.ToString('o')
  source_git_commit = (git -C $root rev-parse HEAD).Trim()
  exact_site_origin = $StagingSiteOrigin
  exact_supabase_origin = $supabaseOrigin
  exact_media_origin = $script:StagingMediaOrigin
  anon_key_sha256 = $anonHash
  turnstile_configured = $true
  service_secret_included = $false
  index_sha256 = Get-Sha256 -Path $indexPath
  file_count = $contentFiles.Count
  file_manifest_sha256 = Get-Sha256 -Path $fileManifestPath
  cname_included = $false
  production_desktop_download_included = $false
  asset_copy_contract = 'exact-reviewed-file-allowlist'
  robots_policy = 'noindex,nofollow,noarchive,nosnippet; disallow all'
  pwa_cache_policy = 'teardown-and-unregister'
  deploy_performed = $false
}
[IO.File]::WriteAllText(
  $artifactManifestPath,
  ($manifest | ConvertTo-Json -Depth 5) + "`n",
  [Text.UTF8Encoding]::new($false)
)

$anonKey = $null
$turnstileSiteKey = $null
Write-Host "Fail-closed staging frontend artifact generated at $outputFull"
Write-Host "Upload allowlist evidence: $fileManifestPath"
Write-Host "Artifact evidence: $artifactManifestPath"
Write-Host 'This command did not create a Pages project, upload, deploy, change DNS, or configure provider redirects.'
