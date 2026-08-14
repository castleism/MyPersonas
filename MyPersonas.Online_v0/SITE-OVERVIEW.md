# AliaSpaces / MyPersonas — What the site does today, and where it's going

**Updated:** August 13, 2026 · mypersonas.online

**The idea in one line:** one home for every side of you — each persona you carry gets
its own MySpace-style page, owner-private and unlinked from other personas by default,
with explicit opt-in cross-links, its own AI layer, and its own managed accounts.

This overview separates proven/live behavior from the coordinated next-release source.
Local code, a queued migration, or a passing test is never presented as a deployed feature.

---

## What the site can do right now

### Persona pages (the public face)

- Create unlimited personas, each with its own page at `mypersonas.online/#/p/handle`
- Full page customization: avatar, wide banner, page background, feed header image,
  theme color — upload files or generate images with the built-in SD character panel
- A **profile song** (YouTube / Spotify / SoundCloud / mp3) — the MySpace classic
- **Top 8** favorite personas, in order
- **Website field** — the persona's own site, shown as a chip at the top of the page
- 37-platform **link chips** (socials, gaming, storefronts)
- **Live embed**: set a Twitch/YouTube/Kick URL and the page shows a LIVE player
- **Albums**: gallery albums that deep-link out (OnlyFans post, IG, Snap…) and
  sponsored/affiliate albums with automatic "sponsored" labels
- Blog-style **feed with reels**, per-page search, and per-section show/hide modules
- **Linked personas**: optionally reveal your other personas ("More of me") — off by
  default, controlled per page
- Visibility per persona: public (discover + search), unlisted (direct link only), or
  private (accepted friends only), enforced by row-level security
- Age gate on NSFW-rated pages; 18+ hidden by default in discovery

### Anonymity model

- Your email and identity are never shown anywhere
- Personas are never connected to each other or to you unless you explicitly link them
- Private notes per persona (only you can ever read them)
- Business documents (plans, inventories) stay out of the public repo by policy

### Social network

- Friend requests (pending/accepted), block and mute
- Discover page with filters: topic mutes, NSFW default-hidden
- Share links and promo text generator per persona

### The Account Ledger (your alias inventory)

- Private inventory of every external account you run — 37 platform types — storing
  identifiers and links only, never passwords or secrets
- Batch add/edit, per-provider grouping, saved-account autofill
- Assign each account to a persona — from the Accounts tab or directly in the persona
  editor's **Managed accounts** checkboxes
- **Shared managers**: multiple personas can co-manage the same account (one primary
  plus any number of co-managers)
- Ownership verification (email match) kept strictly separate from provider
  authorization — a recorded account is never presented as a connected one

### Real provider connectors (official APIs only)

- **Gmail** — full OAuth; Inbox Concierge runs report-only or manual scans over up to
  100 years / 15,000 messages: subscription reports, account-evidence, receipts,
  protected-mail; optional AI classification; exact approval plans for label/archive/
  recoverable-trash with bounded Undo and a separate audit trail. Sending and
  permanent deletion are deliberately impossible.
- **X / Twitter** — OAuth identity/read connector deployed. The deployed posting function is
  not version-controlled and the current grant is read-only, so X publishing remains off
- **Facebook Pages + linked professional Instagram** — official Meta pairing:
  discovers Pages and Page-linked IG professional accounts, binds only owner-selected
  records, tokens in encrypted Vault. Owner-triggered FB/IG publishing was proven on the
  owner's assets; the new atomic/immutable approval hardening is local and scheduled cron is off
- **Reddit** — official OAuth, confirmed revocation, and owner-triggered approved-post code is
  complete locally, but credentials, deployment, OAuth round trip, and live post are still owner gates
- **Discord** — migration/function source exists, but the current UI has no connector/post
  controls and live state is unverified. The endpoint is deliberately dormant until its
  exact-approval, reconciliation, audit, and Vault-erasure rebuild is complete. User-account
  automation remains unsupported.
- **OnlyFans and other record-only platforms** — safe manual staging: prepare the
  package, copy it, open the official site, mark it posted yourself. The site never
  asks for a password, cookie, or scraped session.

### The AI layer

- Link hosted text models (OpenAI-compatible, Anthropic, Azure, OpenRouter, Groq,
  Gemini, and more); keys go through a server-side proxy into Supabase Vault and are
  never readable back in a browser
- Per-persona dedicated model, plus model-per-task overrides
- **HQ assistant** with your full roster context
- Per-persona chatbots that speak in that persona's voice card
- AI persona builder interview and quick-setup wizard
- **Agent control center** per persona: strategic direction brief, L0–L3 autonomy
  ladder (co-writer → scheduled drafts → owner-published → bounded native autopost),
  destination modes, exact schedules with time zones and lead times, daily caps,
  quiet hours, global pause, approval queue, synchronized owner chat, and audit log
- Auto-running scheduled tasks server-side (five-minute polling, atomic leases, daily
  model-call reservations — no duplicate provider calls, no self-approval)
- Content drafts pipeline: idea → draft → approve → publish (native) or copy/handoff
  (external), with a **cross-account Timeline** per persona showing everything posted
- Optional SFW **fan chat**: visitors talk to a persona's AI (always disclosed as AI),
  with quotas, owner transcript review, and escalation flags

### Coordinated next-release source (not yet claimed live)

- Conflict-safe persona context, bounded AI continuity, content-plan change summaries, and
  owner-reviewed Save/Attach context
- Resumable owner chat workspaces with create/rename/pin, full-account export inclusion, and distilled attachments
- Friend-request Realtime, while focus refresh remains a fallback
- Installable PWA manifest/public offline shell (no push permission or subscription yet)
- Full release-history extension cards with truthful local fallbacks
- Fail-closed Reddit and four-prefix owner-storage erasure hardening

### Trust & safety

- Pixel-burned watermarks (your page URL) on uploads; right-click/drag guards
- Server-side AI proxy discards browser-supplied system prompts
- In-app error reporting; session-timeout countdown; stale-page banner
- Public Privacy, Terms, Data Deletion, and provider-setup pages

### Ecosystem

- **Personas** desktop companion: animated AI characters for your personas that live
  on your screen and react to your work
- **Concept** character studio (SD/LoRA tooling) with a releases-driven extension
  catalog. The local catalog now supports history for both tools; public GitHub releases
  still need to be published and verified

---

## What's on the roadmap

### Near term (v0.5 finish line)

- Outlook, Yahoo, iCloud, and Proton Inbox Concierge adapters (each via its official
  or app-password route; no password ever typed into the site)
- Pull, scrub, and version X **posting** (Order 1), then explicitly obtain write/media
  authorization; release and live-test the already-versioned Reddit connector — every
  buildable connector is specced in CONNECTOR-BUILD-ORDERS.md, and the impossible
  ones (OnlyFans, personal Snapchat, Twitch feed) are documented as permanently manual
- Adobe **Lightroom** integration: watched-folder import first, official Partner API
  connector after Adobe approval — cloud photos feeding pages and training sets
- Public **persona timeline module** (opt-in per account) and full provider post-history
  sync into the timeline
- Release and verify friend Realtime; comments/reactions, feed pagination/hashtags, and
  the Act as persona modal already exist in source
- Publish real Concept/Personas GitHub releases for the new catalog history view
- SEO: path-based routing, prerendered persona pages, per-persona OG images and
  sitemaps so every persona is individually searchable

### v1 — the platform

- Persona-to-persona direct messages (privacy-preserving)
- Native live streaming (replacing embeds)
- Trending/discovery ranking, moderation pipeline with user reports
- Verify the installable PWA/offline shell; design push notifications as a separate phase
- Branded auth domain, profile analytics for owners

### v1.5+ — the ecosystem

- Concept cloud sync: LoRA-consistent persona imagery generated from the site
- Personas desktop ↔ site sync (personas, goals, chat history)
- Extension marketplace with third-party extensions
- Groups/communities; creator monetization (tips, gated albums)
