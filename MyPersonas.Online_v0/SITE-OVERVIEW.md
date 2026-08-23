# AliaSpaces / MyPersonas — What the site does today, and where it's going

**Updated:** August 23, 2026 · mypersonas.online

**The idea in one line:** one home for every side of you — each persona you carry gets
its own MySpace-style page, owner-private and unlinked from other personas by default,
with explicit opt-in cross-links, its own AI layer, and its own managed accounts.

This overview separates proven/live behavior from the coordinated next-release source.
Local code, a queued migration, or a passing test is never presented as a deployed feature.

Current package: **migration 060 is applied/read back in the linked production database
and the owner staff roles are active; matching function/frontend deployment and live
integration verification remain separate at this source freeze.**
The prior release boundary is `RELEASE-MANIFEST-2026-08-22.md`; the coordinated
AI-provenance follow-on preserves 059 as immutable history and introduces forward-only 060
under `RELEASE-MANIFEST-2026-08-23-AI-PROVENANCE.md`.

---

## Coordinated next release (database applied; matching source not yet claimed live)

- **AI content provenance:** immutable migration 059 plus forward-only hardening migration
  060 and the matching frontend/functions require an
  AI-use declaration for every upload, automatically classify site-generated images,
  return generated media only after trusted server watermarking, burn the pinned
  MyPersonas AI mark into AI-used static image bytes, and watermark final social crops
  after cropping. New media writes are service-only and bind exact hashes and immutable
  provenance IDs into page review and social approval. AI-used animated media is blocked
  until frame-by-frame transcoding exists. External media present at the first successful
  060 hardening apply receives a
  one-time visibly-unverified snapshot; new external media cannot pass review without
  secure intake. The 060 database apply/readback is recorded, but matching deployment and
  live parity are not yet claimed here;
  see `AI-CONTENT-PROVENANCE.md`.

- **Private Backup personas:** an owner can attach one persona as another persona's
  private backup. The desktop owner rail expands the backup under its main; the mobile
  picker keeps them adjacent. This never creates a public “More of me” link.
- Migration 048, export/restore support, and local tests are present. The database change
  is not applied and the matching page is not deployed or live-verified yet. See
  `PERSONA-BACKUP-RELATIONSHIPS.md` for the security contract and release order.
- **Castleborn organization:** migration 049 records confirmed private family canon,
  derives sibling labels, groups the existing Castleborn roster into one owner-private
  project managed by WAIS, and adds draft-first business/mission/title foundations. It
  does not attach a database, publish a business, or grant WAIS account authority. The
  matching local owner settings and public Family module exist, but family cards render
  only from a reviewed current-page projection after release.
- **Page design and assets:** migration 050 and the matching owner UI add full previews,
  bounded downloads, declarative layout controls, escaped text/HTTPS boxes, a read-only
  HTML/CSS/JSON learning console, and private reusable code notes across eleven built-in
  modules, including Family and Offers & review requests. New first-party uploads are
  content-addressed by their final bytes; forward migration 060 creates one-time legacy external HTTPS snapshots that are
  visibly unverified and new external media is blocked from publication. New public
  media widgets and video backgrounds stay blocked until an opaque-id migration and
  backfill ensure public asset paths no longer reveal a stable owner UUID.
- **Publication and governance:** migration 051 and the owner UI add exact-revision page
  review, AI disclosure, publication controls, confirmed feature tickets, separate follow
  and friend behavior, account-sync preferences, inert extension review, staff-role
  foundations, bounded authenticated error reporting, and security/retention primitives.
  It backfills all existing personas to `unpublished` and all legacy businesses to an
  owner-only draft. Profile, content, family, layout, revenue, and reviewed account/AI
  configuration changes invalidate the exact revision. Exact-approved native drafts stage
  into page review; they no longer auto-publish through the legacy native function.
- **Reviewed business pages:** migration 052 adds AAL2 exact-revision review, publish,
  and unpublish controls. Mission/profile/title edits return the business to draft.
- **Human-gated AI work:** migration 053 and the local Agent Board owner view add bounded
  proposal/review/execution/result controls. Migration 057 adds default-deny per-backend/
  mode request-token budgets and expiring concurrency leases. No provider is enabled and
  no model spend is authorized by these controls.
- **Research, audit, and identity hardening:** migration 054 narrows owner research/content
  writes and quotas; 055 reserves terminal audit capacity and serializes agent writers
  with erasure; 056 invalidates stale AliaSpaces confirmed-email attestations without
  conflating them with provider OAuth connections.
- **Revenue and request review:** the local public revenue module displays reviewed
  disclosures and offers and can expose a Request review CTA only after all current-page,
  mailbox, binding, global, and per-persona gates pass. The public Edge intake is
  fail-closed around one exact CORS origin, bounded streamed JSON, Turnstile action and
  hostname, HTTPS/non-internal URL validation, rotating HMAC identifiers, and neutral
  receipts. It is not deployed or configured; the global/persona gates default off and no
  notification sender or owner evidence queue exists. Hardened migration 043 now has an
  ordered local timestamped mirror. The local affiliate redirect is likewise
  fail-closed around a separate HMAC secret, bounded attribution, HTTPS-only reviewed
  destinations, atomic current-page/cap/deduplication checks, and bounded retention.
  Canonical 051 and its timestamped mirror are synchronized locally; final freeze hashes
  and linked/deployed parity remain pending.
- No provider, SSO, hook, CAPTCHA, email, WAF, logging service, payment processor, or
  external publication was configured by this local work.
- The full apply/approval boundary is in
  `OWNER-APPROVAL-QUEUE-2026-08-22.md`; the coordinated 047–057 package, Edge functions,
  and matching frontend remain unapplied/undeployed unless explicitly noted elsewhere.
  Migration 047's exact production name update is separate historical evidence documented
  in `VERIFICATION.md`; it does not approve or prove this release package.

---

## Existing deployed baseline (reverify before release)

This section summarizes the earlier deployed/verified baseline. Provider grants,
function versions, and live policies can drift; reread them before relying on the claim.
The coordinated 047–057 source described above is not part of this baseline.

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

- The public UI does not intentionally display the owner's email or account identity.
  Current public Storage URLs can nevertheless expose a stable owner UUID path and
  correlate otherwise unlinked personas; opaque public asset delivery remains a release
  blocker.
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
- Historical **Agent control center** source per persona: strategic direction brief, L0–L3 autonomy
  ladder for drafting and external-provider policy, destination modes, exact schedules
  with time zones and lead times, daily caps,
  quiet hours, global pause, approval queue, synchronized owner chat, and audit log
- In the coordinated migration-051 source—not the deployed baseline—native-feed drafts
  stage into an owner-reviewed page revision instead of auto-publishing
- Historical scheduled-task implementation used five-minute polling, atomic leases, and
  daily reservations. Reverify current cron/function/schema state before relying on it;
  the new board and budget paths remain default-off and separately gated.
- Content drafts pipeline: idea → draft → owner approval. External destinations remain
  copy/handoff unless a separately approved connector exists; coordinated 051 routes
  native content through exact persona-page review/publication. The owner-private
  **cross-account Timeline** shows recorded completion history.
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

- The coordinated immutable-059/forward-060 source replaces the historical page-URL
  watermark with required AI-use declarations and a subtle, pinned MyPersonas AI mark on AI-used static
  derivatives. Site generation is system-declared; crop-specific social files are marked
  after cropping; unsupported AI-used motion media fails closed. This is not live evidence.
- Server-side AI proxy discards browser-supplied system prompts
- In-app error reporting; session-timeout countdown; stale-page banner
- The coordinated 051 source replaces historical direct error-log insertion with a
  bounded authenticated redacting RPC. That policy is not live until the migration and
  matching page are deployed and read back.
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
