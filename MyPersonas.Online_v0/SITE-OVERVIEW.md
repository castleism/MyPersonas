# AliaSpaces / MyPersonas — What the site does today, and where it's going

**Updated:** July 30, 2026 · mypersonas.online

**The idea in one line:** one home for every side of you — each persona you carry gets
its own MySpace-style page, fully anonymous by design, with its own AI layer and its
own set of managed accounts.

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
- **X / Twitter** — OAuth identity/read connector deployed (awaiting production client
  credentials); posting adapter is specced as the next build order
- **Facebook Pages + linked professional Instagram** — official Meta pairing:
  discovers Pages and Page-linked IG professional accounts, binds only owner-selected
  records, tokens in encrypted Vault; publishing intentionally off until app review
- **Discord** — channel-webhook posting is live in code: paste a webhook once (stored
  encrypted, never shown again), then approved drafts post to that channel with one
  press. No user-account automation, ever.
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

### Trust & safety

- Pixel-burned watermarks (your page URL) on uploads; right-click/drag guards
- Server-side AI proxy discards browser-supplied system prompts
- In-app error reporting; session-timeout countdown; stale-page banner
- Public Privacy, Terms, Data Deletion, and provider-setup pages

### Ecosystem

- **Personas** desktop companion: animated AI characters for your personas that live
  on your screen and react to your work
- **Concept** character studio (SD/LoRA tooling) with a releases-driven extension
  catalog

---

## What's on the roadmap

### Near term (v0.5 finish line)

- Outlook, Yahoo, iCloud, and Proton Inbox Concierge adapters (each via its official
  or app-password route; no password ever typed into the site)
- X **posting** adapter (Order 1) the moment production credentials are installed;
  then Reddit posting, YouTube uploads, and Meta publishing after app review — every
  buildable connector is specced in CONNECTOR-BUILD-ORDERS.md, and the impossible
  ones (OnlyFans, personal Snapchat, Twitch feed) are documented as permanently manual
- Adobe **Lightroom** integration: watched-folder import first, official Partner API
  connector after Adobe approval — cloud photos feeding pages and training sets
- Public **persona timeline module** (opt-in per account) and full provider post-history
  sync into the timeline
- Realtime notifications, feed comments/reactions, feed pagination + hashtag pages
- Proper "act as persona" picker modal, extensions catalog page
- SEO: path-based routing, prerendered persona pages, per-persona OG images and
  sitemaps so every persona is individually searchable

### v1 — the platform

- Persona-to-persona direct messages (privacy-preserving)
- Native live streaming (replacing embeds)
- Trending/discovery ranking, moderation pipeline with user reports
- Installable mobile PWA with push notifications
- Branded auth domain, profile analytics for owners

### v1.5+ — the ecosystem

- Concept cloud sync: LoRA-consistent persona imagery generated from the site
- Personas desktop ↔ site sync (personas, goals, chat history)
- Extension marketplace with third-party extensions
- Groups/communities; creator monetization (tips, gated albums)
