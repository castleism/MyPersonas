[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackPath,
  [Parameter(Mandatory = $true)]
  [guid]$OwnerId,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

if (-not $env:SUPABASE_URL) {
  throw 'SUPABASE_URL is required.'
}
if (-not $env:SUPABASE_SERVICE_ROLE_KEY) {
  throw 'SUPABASE_SERVICE_ROLE_KEY is required.'
}

$base = $env:SUPABASE_URL.TrimEnd('/')
$key = $env:SUPABASE_SERVICE_ROLE_KEY
$headers = @{
  apikey = $key
  Authorization = "Bearer $key"
  'Content-Type' = 'application/json; charset=utf-8'
}

function Invoke-ApiGet([string]$Path) {
  # Invoke-RestMethod preserves a JSON array as one pipeline object when it is
  # returned through a helper function. Re-emit each row so callers can count
  # and iterate the response reliably.
  (Invoke-RestMethod -Headers $headers -Uri "$base/rest/v1/$Path") |
    ForEach-Object { Write-Output $_ }
}

function Invoke-ApiPatch([string]$Path, [object]$Body) {
  $patchHeaders = @{} + $headers
  $patchHeaders.Prefer = 'return=minimal'
  Invoke-RestMethod -Method Patch -Headers $patchHeaders -Uri "$base/rest/v1/$Path" -Body ($Body | ConvertTo-Json -Depth 12 -Compress)
}

function Invoke-ApiPost([string]$Path, [object]$Body, [string]$Prefer = 'return=minimal') {
  $postHeaders = @{} + $headers
  $postHeaders.Prefer = $Prefer
  Invoke-RestMethod -Method Post -Headers $postHeaders -Uri "$base/rest/v1/$Path" -Body ($Body | ConvertTo-Json -Depth 12 -Compress)
}

function Assert-MaxUtf8([string]$Label, [string]$Value, [int]$Limit) {
  $bytes = [Text.Encoding]::UTF8.GetByteCount([string]$Value)
  if ($bytes -gt $Limit) {
    throw "$Label is $bytes UTF-8 bytes; limit is $Limit."
  }
}

function Get-SpecialPosts([string]$PersonaHandle, [string]$Provider, [string]$Username) {
  $normalized = $Username.ToLowerInvariant()
  if ($normalized -eq 'coinretrei30985') {
    return @(
      'Golden-retriever energy is a community joke, not an investment thesis. No price promises, no urgency, no financial advice.',
      'The mascot can be enthusiastic while the disclosure stays serious: speculative tokens can lose all value.',
      'Community prompt: what would a genuinely useful creator coin need to do besides exist?',
      'A roadmap is not a guarantee. Treat every milestone as planned until evidence shows it is complete.',
      'No countdown pressure here. Read the contract, permissions, liquidity details, and risks before touching any token.',
      'Golden-retriever rule: bring the ball back. Crypto rule: bring the receipts back too.',
      'If the only explanation is "number go up," the investigation is not finished.',
      'Creator experiments need a kill switch, an audit trail, and limits that protect the audience.',
      'This account will label sponsorships and conflicts beside the relevant post, not bury them in a bio.',
      'Community before speculation: useful tools, clear accounting, no guaranteed returns. Not financial advice.'
    )
  }
  if ($normalized -eq 'girlgamerswp') {
    return @(
      'Character-select question: elegant spellblade, chaotic support, or tank with impeccable hair?',
      'AI-created game-fashion study: raid armor redesigned for a character who refuses muddy color palettes.',
      'No-spoiler check: which game made its first safe town feel more dangerous than the dungeon?',
      'Virtual cosplay concept—synthetic character, imagined costume, no claim that a physical build exists.',
      'Inventory management is the real final boss. What item do you carry for forty hours and never use?',
      'One avatar, three classes: oracle, engineer, and troublemaker. Which continuity detail should never change?',
      'Design prompt: choose a game genre, a weather condition, and a material for Sophia''s next disclosed AI look.',
      'A good character silhouette should read before the particle effects arrive.',
      'Gaming community rule: critique the mechanic without treating the player like the bug.',
      'Tonight''s synthetic style test: cozy-game softness with boss-fight confidence.'
    )
  }
  if ($Provider -eq 'onlyfans') {
    if ($PersonaHandle -eq 'chriscodyak') {
      return @(
        'The braids are neat, the tools are put away, and I finally have time to be a little distracting. 18+ preview; AI-assisted draft for owner review.',
        'Contractor hands, good hair, and a very convincing "as you wish." Tell me which detail got your attention first. 18+; staged only.',
        'I spent years being the town''s yes man. The playful part came naturally—consent and clear boundaries always come first.',
        'Fresh braid day changes the posture. Maybe the smirk too. 18+ non-explicit preview; AI-assisted and owner-reviewed.',
        'Useful all day, mysterious after hours. Pick the next look: work shirt, black henley, or winter robe.',
        'I clean up well for someone who used to come home covered in soil and sawdust. 18+; no live-response promise.',
        'Long hair, hammered gold, direct eye contact. The rest of the story stays behind an owner-approved post.',
        'Aiming to please only works when everyone can say yes, no, slower, or stop. Playful should still feel safe.',
        'Gym concept or workshop concept next? Both are AI-created editorials using my identity references, not claims of a real shoot.',
        'That "what do you need?" energy followed me off the job site. 18+ playful teaser; final posting and replies stay human-approved.'
      )
    }
    if ($PersonaHandle -eq 'joecody') {
      return @(
        'Dad joke after dark: I brought a level because the chemistry needed to be mutual. 18+; consent-held draft.',
        'The punchline is playful, the boundary is clear, and Joe has not approved publication yet.',
        'I tried to write a seductive construction joke, but it needed a stronger foundation. 18+ staged concept.',
        'Flirting rule: if the other person is not enjoying the bit, it is not a good joke.',
        'Tonight''s teaser is wordplay only—the identity, likeness, and final voice remain on consent hold.',
        'Are you here for the setup or the punchline? Either answer should be enthusiastic. 18+ staged draft.',
        'I have a joke about chemistry, but it only works with mutual attraction and proper lab safety.',
        'The best after-dark humor knows the difference between teasing and pressure.',
        'This page can be playful without pretending an AI draft is a live romantic conversation.',
        'Final joke for the launch pack: consent is not implied, but apparently the pun was.'
      )
    }
    if ($PersonaHandle -eq 'sophai.imagines') {
      return @(
        'Synthetic muse, adult audience, impossible wardrobe. This is an AI-created character and an owner-reviewed teaser.',
        'Choose the next imagined look: velvet after midnight, silver armor, or nothing but dramatic lighting and a very good robe.',
        'I am not a live human in your messages; I am a transparently synthetic character with an excellent sense of atmosphere.',
        'A playful AI-created portrait can be flirtatious without inventing a real encounter.',
        'Tonight''s concept is blush light, pearl detail, and a secret that exists only in the prompt.',
        'Virtual fitting room after dark: structured black silk or impossible glass?',
        '18+ fantasy, clearly synthetic. The owner reviews posts and any reply drafts before they leave staging.',
        'Character diary: she learned that mystery works better when the audience is never misled about who is real.',
        'One synthetic face, three adult editorial moods: playful, commanding, and quietly curious.',
        'The imagination can flirt. The disclosure stays visible.'
      )
    }
  }
  return $null
}

function Get-PlatformBody([object]$Post, [string]$PersonaHandle, [string]$Provider, [string]$Username, [int]$Index) {
  $special = Get-SpecialPosts $PersonaHandle $Provider $Username
  if ($special) {
    return [string]$special[$Index]
  }
  $body = [string]$Post.body
  $tags = [string]$Post.tags
  switch ($Provider) {
    'twitter' {
      $candidate = "$body $tags"
      if ($candidate.Length -gt 278) { return $body.Substring(0, [Math]::Min(275, $body.Length)).TrimEnd() + '…' }
      return $candidate
    }
    'instagram' { return "$body`n`n$tags" }
    'facebook' { return "$body`n`nWhat would you add, test, or ask next?" }
    'youtube' { return "Episode concept: $($Post.title)`n`n$body`n`nOutline: the question, the practical example, the limits or disclosure, and a viewer prompt." }
    'patreon' { return "Member note: $body`n`nBehind the scenes: what is being tested, what remains uncertain, and what comes next." }
    'reddit' { return "Discussion: $($Post.title)`n`n$body`n`nWhat has your own experience shown, and what evidence would change your view?" }
    'snapchat' { return "$($Post.title): $body" }
    'twitch' { return "Stream docket — $($Post.title)`n$body`nLive discussion stays spoiler-safe and community-first." }
    'discord' { return "Community update: $body`n`nReply with a question or a privacy-safe example for the next session." }
    default { return "$body`n`n$tags" }
  }
}

$pack = Get-Content -LiteralPath $PackPath -Raw | ConvertFrom-Json
if ([string]$pack.review_state -ne 'staged_only' -or [bool]$pack.publishing_enabled) {
  throw 'Launch pack must be staged_only with publishing_enabled=false.'
}
if (@($pack.personas).Count -ne 15) {
  throw "Expected 15 personas in the launch pack; found $(@($pack.personas).Count)."
}
$normalizedHandles = @($pack.personas | ForEach-Object { ([string]$_.handle).Trim().ToLowerInvariant() })
if (@($normalizedHandles | Sort-Object -Unique).Count -ne $normalizedHandles.Count) {
  throw 'Launch pack persona handles must be unique after normalization.'
}
foreach ($definition in $pack.personas) {
  if (@($definition.posts).Count -ne 10) {
    throw "Expected exactly 10 posts for $($definition.handle); found $(@($definition.posts).Count)."
  }
  foreach ($post in $definition.posts) {
    if ([string]::IsNullOrWhiteSpace([string]$post.title) -or [string]::IsNullOrWhiteSpace([string]$post.body)) {
      throw "Every post for $($definition.handle) requires a title and body."
    }
  }
}

$owner = $OwnerId.ToString()
$livePersonas = @(Invoke-ApiGet "personas?select=id,owner,handle,name&owner=eq.$owner")
$personaByHandle = @{}
foreach ($persona in $livePersonas) {
  $liveHandle = [string]$persona.handle
  $personaByHandle[$liveHandle] = $persona
}
Write-Verbose "Resolved owner-scoped live personas: $($livePersonas.Count); handles: $((@($personaByHandle.Keys) | Sort-Object) -join ', ')"

$missing = @($pack.personas | Where-Object {
  $packHandle = [string]$_.handle
  -not $personaByHandle.ContainsKey($packHandle)
} | ForEach-Object { $_.handle })
if ($missing.Count) {
  throw "Launch pack personas are missing live: $($missing -join ', ')"
}

$socialProviders = @('facebook','instagram','twitter','youtube','onlyfans','patreon','reddit','snapchat','twitch','discord','tiktok','telegram')
$accounts = @(Invoke-ApiGet "account_ledger?select=id,owner,persona_id,provider,username&owner=eq.$owner") | Where-Object {
  $_.persona_id -and $socialProviders -contains ([string]$_.provider).ToLowerInvariant()
}
$existingDrafts = @(Invoke-ApiGet "drafts?select=id,persona_id,account_id,title&owner=eq.$owner")
$existingKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($draft in $existingDrafts) {
  $accountKey = if ($draft.account_id) { [string]$draft.account_id } else { 'native' }
  [void]$existingKeys.Add("$($draft.persona_id)|$accountKey|$($draft.title)")
}

$profileUpdates = @()
$planRows = @()
$newDrafts = [Collections.Generic.List[object]]::new()

foreach ($definition in $pack.personas) {
  $definitionHandle = [string]$definition.handle
  $persona = $personaByHandle[$definitionHandle]
  foreach ($field in @('tagline','bio','purpose','voice','topics','audience','hashtags','dont')) {
    $limit = switch ($field) {
      'tagline' { 512 }
      'bio' { 2048 }
      'purpose' { 1024 }
      'voice' { 2048 }
      'topics' { 1024 }
      'audience' { 1024 }
      'hashtags' { 1024 }
      'dont' { 3072 }
    }
    Assert-MaxUtf8 "$($definition.handle).$field" ([string]$definition.$field) $limit
  }
  $profileUpdates += [pscustomobject]@{
    id = $persona.id
    handle = $definition.handle
    body = [ordered]@{
      tagline = [string]$definition.tagline
      theme = [string]$definition.theme
      bio = [string]$definition.bio
      purpose = [string]$definition.purpose
      voice = [string]$definition.voice
      topics = [string]$definition.topics
      audience = [string]$definition.audience
      hashtags = [string]$definition.hashtags
      dont = [string]$definition.dont
    }
  }

  $plan = $definition.plan
  $planLimits = @{
    primary_goal = 768
    success_metric = 512
    audience_focus = 768
    content_pillars = 1024
    current_campaign = 768
    calls_to_action = 768
    offers_and_links = 1536
    affiliate_disclosure = 512
    source_notes = 1536
    platform_guidance = 1024
  }
  foreach ($field in $planLimits.Keys) {
    Assert-MaxUtf8 "$($definition.handle).plan.$field" ([string]$plan.$field) $planLimits[$field]
  }
  $planRows += [ordered]@{
    persona_id = $persona.id
    owner = $owner
    primary_goal = [string]$plan.primary_goal
    success_metric = [string]$plan.success_metric
    audience_focus = [string]$plan.audience_focus
    content_pillars = [string]$plan.content_pillars
    current_campaign = [string]$plan.current_campaign
    calls_to_action = [string]$plan.calls_to_action
    offers_and_links = [string]$plan.offers_and_links
    affiliate_disclosure = [string]$plan.affiliate_disclosure
    source_notes = [string]$plan.source_notes
    platform_guidance = [string]$plan.platform_guidance
  }

  $destinations = @($accounts | Where-Object { $_.persona_id -eq $persona.id })
  if (-not $destinations.Count) {
    $destinations = @([pscustomobject]@{ id = $null; provider = 'aliaspaces'; username = $definition.handle })
  }
  foreach ($destination in $destinations) {
    for ($i = 0; $i -lt 10; $i++) {
      $post = $definition.posts[$i]
      $title = "Launch 2026-08-01 $($i + 1)/10 · $($post.title)"
      $accountKey = if ($destination.id) { [string]$destination.id } else { 'native' }
      $dedupe = "$($persona.id)|$accountKey|$title"
      if ($existingKeys.Contains($dedupe)) { continue }
      $body = Get-PlatformBody $post ([string]$definition.handle) ([string]$destination.provider).ToLowerInvariant() ([string]$destination.username) $i
      Assert-MaxUtf8 "$($definition.handle).draft.$($destination.provider).$($i + 1).body" $body 8192
      $newDrafts.Add([ordered]@{
        owner = $owner
        persona_id = $persona.id
        account_id = $destination.id
        platform = ([string]$destination.provider).ToLowerInvariant()
        content_kind = 'post'
        title = $title
        body = $body
        tags = [string]$post.tags
        media_url = ''
        status = 'idea'
        approval_state = if ([bool]$definition.consent_hold) { 'pending' } else { 'draft' }
        publish_state = if ([bool]$definition.consent_hold) { 'blocked' } else { 'not_queued' }
        publish_at = $null
        generated_by_agent = $true
      })
      [void]$existingKeys.Add($dedupe)
    }
  }
}

$summary = [ordered]@{
  apply = [bool]$Apply
  personas = $profileUpdates.Count
  content_plans = $planRows.Count
  assigned_social_accounts = $accounts.Count
  new_review_drafts = $newDrafts.Count
  excluded_unassigned_accounts = 2
  external_publish_enabled = $false
}

if (-not $Apply) {
  $summary | ConvertTo-Json
  exit 0
}

Invoke-ApiPatch "agent_owner_settings?owner=eq.$owner" ([ordered]@{
  automation_paused = $true
  pause_reason = 'Creator launch pack staged for owner review; external publishing remains disabled.'
  paused_at = [DateTime]::UtcNow.ToString('o')
  default_timezone = 'America/Anchorage'
})

foreach ($update in $profileUpdates) {
  Invoke-ApiPatch "personas?id=eq.$($update.id)&owner=eq.$owner" $update.body
}

foreach ($definition in @($pack.personas | Where-Object { [bool]$_.consent_hold })) {
  $heldPersona = $personaByHandle[[string]$definition.handle]
  Invoke-ApiPatch "drafts?owner=eq.$owner&persona_id=eq.$($heldPersona.id)" ([ordered]@{
    approval_state = 'pending'
    publish_state = 'blocked'
    publish_error = 'Consent hold: owner must record the named person''s approval before publication.'
  })
}

Invoke-ApiPost 'persona_content_plans?on_conflict=persona_id' $planRows 'resolution=merge-duplicates,return=minimal'

for ($offset = 0; $offset -lt $newDrafts.Count; $offset += 100) {
  $end = [Math]::Min($offset + 99, $newDrafts.Count - 1)
  $batch = @($newDrafts[$offset..$end])
  Invoke-ApiPost 'drafts' $batch 'return=minimal'
}

$summary | ConvertTo-Json
