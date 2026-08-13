# AliaSpaces / MyPersonas — Roadmap

**Vision:** the home for every persona a person carries. A MySpace-style network where
each persona gets its own page (looks, music, Top 8, albums, feed, links), fully
anonymous by design — never linked to the owner or to each other — with an AI layer
(models per persona and per task, an HQ assistant, character tooling) and an
extension ecosystem (Concept character studio, Personas desktop companion) that
carries personas beyond the site onto every platform they live on.

---

## v0 — Foundation (current)

Shipped:

- Auth: Google OAuth + email magic link for AliaSpaces sign-in; profiles private, no
  public linkage to personas (mailbox authorization is a separate connector)
- Personas: create/edit, quick-setup wizard (multi-category, merged suggestions),
  AI builder interview, purpose/voice/topics/audience/rules, per-persona AI model
- Pages: banner/background/avatar/feed images (file picker + preview + SD generate),
  profile song, live embed (Twitch/YouTube/Kick), Top 8, 37-platform link chips,
  gallery & sponsored/affiliate albums (deep-link out), blog feed + reels,
  per-page search, section show/hide modules, theme color, share link
- Social: friend requests (pending/accepted), block/mute, private/unlisted/public
  visibility enforced by row-level security, discover filters (18+ default-hidden,
  topic mutes), age gate on NSFW pages
- AI: linked hosted text models on approved HTTPS provider hosts, HQ assistant with roster
  context, per-persona chatbots, tasks with model-per-task and one-click Run,
  SD character panel (local A1111/Forge), content drafts pipeline
  (chat/task output → draft → copy → post on platform; idea → ready → posted)
- Trust & safety: pixel-burned watermarks with page URL on uploads, right-click/drag
  guards, in-app error reporting to error_logs, session-timeout countdown popup,
  stale-page banner
- Platform: brand icon bank (SVG, hologram-blue), favicon, release-driven extensions
  catalog (GitHub Releases + extension.json), versioned repo layout + Pages workflow

## v0.5 — Agent control center and live network

An `[x]` here means the implementation exists in this repository. Migration 011, the five
release Edge Functions, production secrets, and both five-minute cron jobs were deployed
and smoke-tested on 2026-07-20. The Pages artifact is included in this release; signed-in
browser scenarios retain their own verification evidence.

- [x] Private Account Ledger batch mode: add many external accounts, keep them
      unassigned or bind each to an existing/quick-created private persona. Deployed
      with owner-only storage, saved-row Quick Create, and explicit connection states.
- [x] Provider management handoffs: every saved account has a Manage workspace for
      persona-assigned post/reply drafts, media links, planned times, copy/open-account
      handoff, and manual-completion tracking. OnlyFans and other record-only providers
      never receive a password, cookie, scraped session, or false “posted” state.
- [x] Provider OAuth connections: separate Gmail authorization with single-use state +
      PKCE, exact-mailbox validation, explicit cleanup re-consent, refresh credentials
      encrypted in Supabase Vault, and only server-attested connection state exposed to
      the browser. Ownership verification remains distinct from API connection.
- [x] Gmail Inbox Concierge: resumable manual and report-only scheduled scans,
      subscriptions/account-evidence/receipt/protected-mail reports, optional owner-chosen
      AI classification using bounded sender, subject, and short Gmail preview snippets,
      exact approval plans for labels/archive/recoverable Trash, bounded Undo, a separate
      audit trail, and manual unsubscribe offers that never fetch arbitrary links in the
      background.
- [x] Staged full-history Gmail reports: migration 017 and matching app/worker bounds
      support a 100-year lookback with a 15,000-message ceiling, visibly identify a
      cap-limited result, rotate active inboxes fairly, and show a suggested review action
      on every finding without granting automatic approval or mutation authority.
- [x] Meta identity/pairing foundation: migration 018 and `meta-oauth` discover
      Facebook Pages and Page-linked professional Instagram accounts, bind only
      owner-selected ledger records, keep tokens in Vault, and revoke the shared grant.
      Production connection remains configuration-gated and direct publishing is off.
- [x] Public provider-review foundation: deployable Privacy, Terms, Data Deletion, and
      owner setup pages with explicit official-API, app-review, manual-handoff, and
      connector-status boundaries.
- [ ] Outlook Inbox Concierge adapter through delegated Microsoft Graph `Mail.ReadWrite`
      after an Entra app, callback, credentials, consent, and live personal/tenant tests
      are installed.
- [ ] Yahoo and iCloud Inbox Concierge adapters through a dedicated encrypted IMAP
      worker using user-created app-specific passwords; never collect either account's
      normal password in the website.
- [ ] Proton Inbox Concierge companion that runs locally beside Proton Mail Bridge;
      hosted Supabase functions cannot directly reach Bridge's loopback-only IMAP service.
- [x] Persona agent control center: strategic direction, L0–L3 autonomy, global and
      per-persona pauses, destination modes, exact daily/weekly schedules, time zones,
      lead times, caps, quiet hours, approval queue, synchronized owner chat, and audit log
- [x] Auto-running scheduled tasks: five-minute pg_cron polling, UUID task leases, and
      atomic per-owner daily model-call reservations generate only due drafts without
      duplicate provider calls or self-approval
- [x] Server-side AI proxy: browser system prompts are discarded, persona context and
      controls are loaded server-side, model keys migrate into Supabase Vault, and browser
      model CRUD is limited to owner-authenticated RPCs that never read a key back
- [x] Native AliaSpaces post bridge: L2 exact approvals wait for the owner to press
      Publish now; L3 may publish only exact-approved native drafts on an enabled auto
      target when due
- [x] Optional SFW fan chat: fixed AI disclosure, atomic session/quota/response leasing,
      bounded session memory, owner transcript review, and escalation flags that promise
      neither an owner reply nor takeover. NSFW stays unavailable pending server-verifiable
      age assurance
- [x] X connector check unblocked: ledgerId:null crashed the Edge Function worker
      mid-request (null bypasses JS parameter defaults → null.trim() throw); client
      now omits null ids and the function coerces non-string ids to "" defensively
- [x] Connector capability hardening: forced checks on owner action, retry-with-backoff
      on transient failures, and an explicit unreachable state so a platform blip is
      never reported to the owner as missing credentials
- [x] X API cost guard: per-draft cost badge, link-cost confirmation before approval,
      and month-to-date + projected spend on Targets. Automated drafts are barred from
      linking to the persona's own AliaSpaces page (run-tasks system rule)
- [x] Reddit connector (Order 4 complete): official OAuth (identity/submit/read,
      server-completed callback, Vault-only tokens, username binding) plus reddit-post
      publishing to a tags-named subreddit or the account profile, with Queue button
- [x] Shared account managers: migration 020 `account_persona_links` lets many personas
      co-manage one ledger account (primary stays on the ledger row); share-aware
      editor checkboxes, targets, staging, and Discord publishing. Follow-up: teach
      `run-tasks` the share-join so schedules can run as co-managers
- [x] Discord channel-webhook posting connector: migration 019 stores an owner-pasted
      channel webhook in Vault (never returned to a browser), the discord-post Edge
      Function publishes one approved draft per owner press with an atomic publishing
      lease, and the Queue gains a "Post to Discord now" button. Owner still runs the
      SQL + deploys the function. Scheduled/L3 Discord posting deliberately excluded.
- [x] Connector build orders: CONNECTOR-BUILD-ORDERS.md documents, for every ledger
      platform, whether authentication and automated posting are physically possible,
      and specs Orders 1–6 (X write, FB Page, IG professional, Reddit, YouTube,
      Patreon identity) for follow-on build sessions
- [x] Persona website field: dedicated editor field stored as the first website link,
      rendered as a header chip on the public page (no migration needed)
- [x] Persona editor Managed accounts picker: assign or release saved Account Ledger
      accounts with checkboxes directly in the persona editor; accounts held by another
      persona show where they live before a move, and assignments apply on Save
- [ ] Notifications: Supabase Realtime for friend requests/accepts (replace
      load-time polling badge)
- [ ] Comments and reactions on feed posts
- [ ] Feed pagination + hashtag browse pages
- [ ] Per-platform branded icons (extend the hologram icon bank beyond the orbit node)
- [ ] Proper "act as persona" picker modal (replace prompt() dialogs)
- [ ] Extensions page: full catalog view with release notes + version history;
      Personas app switched to the same releases-driven model as Concept
- [ ] Lightroom watched-folder import (free path): Lightroom auto-export/synced
      folder watched by the Personas/Concept desktop app, new exports uploaded to
      Supabase Storage tagged to a persona for page images and training sets
- [x] Persona cross-account timeline (free path, owner view): Timeline tab in the agent
      studio merging the persona's native posts and posted external drafts into one
      chronological owner-private history with native/external badges and account links
- [ ] Persona timeline public page module: opt-in per-account public display feeding a
      page timeline section (accounts stay private unless explicitly shown; needs a
      public-readable posted-history table, not owner-only drafts)
- [x] Persona deletion unblocked: migration 022 makes destination audit inserts
      cascade-safe (was aborting deletes via agent_actions binding FK)
- [ ] Resolve persona-save session bug from verification round (error_logs driven)
- [ ] SEO: path-based routing + prerendered persona pages so Google indexes each
      persona individually, and per-persona OG images for rich link previews
      (today: hash routes = one indexable URL; JS-set titles/descriptions only)
- [ ] Auto-generated per-persona sitemap (Edge Function serving sitemap.xml
      from the personas table)
- [x] gemini-image Edge Function deployed (2026-08-08): server-side Gemini image
      generation/editing with the owner's Vault key; registered in supabase/config.toml
- [ ] Migrate off legacy anon/service_role JWT keys to the new sb_publishable_/sb_secret_
      API keys (dashboard marks legacy keys deprecated; they still work and are
      auto-injected today — schedule before Supabase retires them)
- [ ] Wire externally generated persona images into personas (image generation
      delegated to ChatGPT/Gemini; wiring + storage on our side)
- [ ] Second Castleborn doc link from owner (pending input)
- [x] Meta cleanup "Could not lock" root-caused and fixed (2026-08-08): migration 025
      (#variable_conflict use_column in the claim function); safe modal close + Escape
      fix + auto-dismiss shipped in app code
- [x] Deployed meta-oauth: `dismiss` action + claim-error logging + inline IG
      field-expansion fix (2026-08-08, editor hash-verified against repo)
- [x] Fixed linked Instagram not offered for pairing: inline
      instagram_business_account{...} expansion replaces the rejected per-page
      GET /{ig-id} (migration-free; deployed)
- [x] Architecture review + prioritized refactor plan written (ARCHITECTURE-REVIEW.md,
      2026-08-08): achievements, lessons, target architecture, P0–P3 backlog
- [x] Data hygiene audit (2026-08-08): transient tables already clean (0 rows);
      archived+removed 1 stale error_log; `archive` schema backup convention set
- [x] P0 refactor: CI/CD scaffolded (2026-08-08). `.github/workflows/ci.yml`
      (tests + deno check + frontend syntax) and `supabase-deploy.yml` (function
      deploy on merge); `CI-CD-SETUP.md`. Owner to add `SUPABASE_ACCESS_TOKEN`
      secret to enable auto-deploy. Local CI dry-run green (17 fns, 7 tests).
- [x] P1: unit test suite for pure helpers (`tests/`, `npm test`, 7 passing) +
      frontend syntax check script
- [x] P1: email normalized (trim+lowercase) at ledger write in both save paths
      (guards the casing/whitespace class of exact-match failures)
- [x] P0: retention-jobs migration WRITTEN (028-retention-jobs.sql) — pg_cron
      pruning for mailbox_findings/refs, error_logs, expired transient state.
      REVIEW + APPLY pending (not run against prod; excludes oauth candidates).
- [x] P2 docs: KEY-ROTATION.md (sb_* keys), CONNECTOR-CORE-DESIGN.md,
      029-anon-execute-review.DRAFT.sql (review-only, REVOKEs commented)
- [x] P2 connector-core (slice 1): extracted pure helpers to
      supabase/functions/_shared/connector/pure.ts, tested directly via Node
      type-stripping (tests/pure-core.test.mjs). ADDITIVE — not yet imported by any
      function, so zero deployed-behavior change. Adoption guide in that dir's README.
- [ ] P2 connector-core (next): adopt pure.ts per connector (reddit-oauth first),
      then extract http.ts/respond.ts/leases.ts/revocation.ts — needs per-function
      deploy + verify
- [x] APPLIED migration 028 (2026-08-09): run_data_retention() created + weekly
      pg_cron job 'data-retention-weekly' scheduled (Sun 04:15 UTC); dry run
      returned 0 deletions across all categories (DB already clean). 029
      anon-EXECUTE reviewed → no action (see above).
- [ ] P0: persona media/docs → Storage — upload art to persona-media bucket,
      repoint app to Storage URLs, remove assets/personas/ from repo (needs
      dashboard upload + verify; not safe to do unattended)
- [ ] Owner review: 97 of 156 account_ledger rows have no connection (inventory) —
      identify truly-abandoned ones for archive-then-delete in batches
- [ ] SQL editor housekeeping: archive useful named snippets to repo, clear the
      untitled scratch tabs (dashboard-side; do when the dashboard is stable)
- [ ] Push app changes to GitHub Pages (modal close/Escape/auto-dismiss) — owner push;
      clear stale .git/index.lock first if a git tool is holding it
- [ ] User-controlled persona media/data storage: move persona avatars/banners and any
      persona documents out of the website repo into owner-controlled storage.
      Best practice: Supabase Storage per-owner bucket (RLS + signed URLs) with
      in-app upload/download/delete wired to the existing erase-content and
      delete-account flows, plus optional links to owner cloud (Drive/OneDrive).
      Free version: same Supabase Storage (free tier, 1 GB) — no new cost; repo keeps
      only site chrome (bg, favicon, hero). Added 2026-08-08 after owner privacy review.
- [x] Root .gitignore guard added (2026-08-08): /outputs/, roadmap-prompt docs,
      dossiers, backups can no longer be committed even by git add -A
- [x] Security Advisor safe fixes (2026-08-08, migration 027): removed public
      bucket file-listing on media + persona-media; pinned concept_touch search_path
- [x] Enable leaked-password protection (2026-08-12): turned on via Auth → email
      provider (HaveIBeenPwned); badge reads ENABLED after a full reload
- [x] Security Advisor anon-EXECUTE review COMPLETE (2026-08-09): audited the 5
      anon-executable definer functions. Conclusion — no change: owns_persona is an
      RLS helper that already returns false for anon (revoking risks RLS breakage);
      can_request is an unreferenced core-schema helper needing a usage trace before
      any grant change; the other three power public pages. Documented in 029.

## Persona / product direction (2026-08-10)

- [ ] REDEPLOY meta-oauth: account_type regression patched in repo (bare IG edge) —
      deploy to unblock Meta connect (dashboard editor was down; use CLI/CI)
- [~] Context-box feature: migration 030 APPLIED + verified (personas.context_log,
      20k cap, 2026-08-12). NEXT: wire `eContext` textarea + appendContextLog in
      index.html, fold bounded slice into ai-proxy prompt (CONTEXT-BOX-SPEC.md) —
      UI deferred (auto-deploys on push; needs logged-in verify)
- [ ] Apply persona updates: Sherlock Chomes (cannabis podcast), Song/Rhythm
      (warrior-gamer siblings) — copy ready in persona-briefs/
- [ ] Personas = personalized AI news feed (owner vision): AI researches assigned
      interests, fact-checks, cites sources, serves tailored blurbs (feed_items +
      ai/research) instead of mindless scroll; later, projects = multi-persona
      collaboration. See V2-BLUEPRINT.md §6.
- [ ] "soulular" identity layer (parallel to cellular) — confirm intent
      (concepts/soulular.md); likely the persona follow/graph/discovery layer
- [x] V2 rebuild blueprint written (V2-BLUEPRINT.md) — incremental migration path,
      not a big-bang rewrite
- [~] Meta posting: meta-post scaffold in repo (gated) + APP-REVIEW-META.md. NEXT:
      owner starts Meta App Review (long pole); then apply meta-oauth PUBLISH_SCOPES
      opt-in, finish meta-post token/queue wiring, live tests
- [~] Pull drifted prod functions into repo — CONFIRMED 8 live 2026-08-12
      (daily-discovery, gemini-models, gemini-probe, image-probe, meta-ig-attach,
      meta-ig-discover, split-post, twitter-post). Blocked from here (dashboard
      "deploy status unavailable" / body API returns eszip / inline secrets);
      `supabase functions download` checklist + secret-scrub in functions/DRIFT.md
- [~] Responsive: SHIPPED 2026-08-12 — safe-area insets (viewport-fit=cover; header,
      stale bar, main, overlay, fanbox/sdPanel) + tablet tier (768–1024px → studio
      `.cols` 280px/1fr). Additive, no-op on desktop, all rules parse valid in Blink,
      syntax check passes, backup in _to_delete/backups/. PENDING: sticky mobile CTA
      (needs logged-in visual verify) — MOBILE-BLUEPRINT.md
- [ ] Native apps: PWA-first (manifest + SW + push) → Expo/React Native; surfaces =
      persona chat, post approvals, AI news feed (MOBILE-BLUEPRINT.md)
- [~] Chat workspaces: migration 031 APPLIED + verified (chat_workspaces + owner RLS +
      agent_messages.workspace_id, 2026-08-12). NEXT: Save/Attach-context UI actions
      that distill into context_log — MOBILE-BLUEPRINT.md §3

## v1 — The platform (major milestone)

- [ ] Persona-to-persona direct messages (privacy-preserving)
- [ ] Native live streaming (Cloudflare Stream/Mux) replacing embed-only
- [ ] External provider write connectors: publish through official APIs only
      (for example Facebook/Instagram Graph or TikTok Content Posting), after required
      write scopes, app review, verified account assignment, and reconciliation are in place
- [ ] Synced post history (official path): per-provider read connectors importing real
      post history into a synced_posts table feeding the persona timeline — Meta Page
      posts via Graph after review, Bluesky/YouTube/RSS public feeds (free), X read
      tier (paid) — with per-account public/private display control
- [ ] Adobe Lightroom read connector (official path): Lightroom Partner API OAuth
      integration after Adobe grants a production API key — browse catalogs/albums,
      pull renditions into the image picker and SD panel, opt-in per-asset training-set
      flag for Concept LoRA sets (verify Adobe ToS on ML use of API-pulled assets)
- [ ] Discovery: trending personas/tags, better ranking than recency
- [ ] Moderation pipeline: user reports on content/personas, review queue
- [ ] PWA: installable mobile experience, push notifications
- [ ] Custom auth domain (auth.aliaspaces.com) for branded OAuth consent
- [ ] Profile analytics for owners (views, clicks on links/albums)

## v1.5+ — The ecosystem

- [ ] Concept cloud sync: LoRA-consistent persona imagery generated from the site
- [ ] Personas desktop ↔ site sync (personas, goals, chat history)
- [ ] Extension marketplace: third-party extensions, in-site install flows
- [ ] Groups/communities around topics
- [ ] Creator monetization: tips, gated albums

---

## Detours & PoC shortcuts (deliberate, to revisit)

1. **Single-file app** — one index.html, no framework/bundler. Fastest iteration;
   revisit when the file's size hurts (split modules + build step).
2. **Limited server layer** — ordinary owner data still flows browser ↔ Supabase under
   RLS; credentials, persona-controlled AI, scheduled work, publishing, and public fan
   chat use Edge Functions.
3. **Legacy `ai_backends.api_key` remains as an empty compatibility column** — migration
   011 moves non-empty values to Vault and browser CRUD uses RPCs. Remove the old column
   after the staged transition no longer needs schema compatibility.
4. **Schedules use five-minute polling** — exact local times are stored and UUID leases
   plus atomic daily call reservations prevent overlapping workers, but normal dispatch may
   occur up to about five minutes after a due time.
5. **"Live" is an embed** of the persona's Twitch/YouTube/Kick, not native streaming.
6. **Watermarking is client-side** canvas burn (images only; videos get an overlay);
   screenshots are unpreventable — treated as attribution/deterrence.
7. **Blocks/mutes/topic filters are partly client-side** — a blocked user can't
   friend you (RLS-enforced) but public content hiding is UX-level, not server-level.
8. **Notifications poll at page load** only (no realtime).
9. **prompt()/confirm() dialogs** for persona picking and destructive confirms.
10. **External drafts still post manually** — native AliaSpaces publishing is implemented,
    but every external destination remains hard-gated until its official write connector,
    scopes, provider approval, assignment, caps, and reconciliation are implemented.
11. **GitHub Pages hosting** — free static host, ~10-minute cache, no server control.
12. **error_logs is insert-open** (anyone can file) — spam-able; fine pre-launch.
13. **Top 8 is a jsonb array** on the persona row (no referential integrity).
14. **Extensions "Open" buttons target localhost ports** — tools must be installed
    and running locally; catalog reads GitHub API client-side (rate-limited) with a
    static releases.json fallback.
15. **Personas app zip lives in the site repo** — small today; moves to GitHub
    Releases like Concept in v0.5.
16. **Page age gate is honor-system** (button + session flag); NSFW hiding is default-on
    but client-side. Public fan chat therefore stays server-disabled for NSFW personas
    until server-verifiable age assurance exists.
17. **Google consent screen shows the Supabase domain** — cosmetic; fixed by the
    paid Supabase custom domain when it matters.
