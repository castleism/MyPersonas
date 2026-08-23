# AliaSpaces / MyPersonas — Roadmap

**Vision:** the home for every persona a person carries. A MySpace-style network where
each persona gets its own page (looks, music, Top 8, albums, feed, links), with the owner
identity private and personas unlinked by default (cross-links require explicit opt-in), with an AI layer
(models per persona and per task, an HQ assistant, character tooling) and an
extension ecosystem (Concept character studio, Personas desktop companion) that
carries personas beyond the site onto every platform they live on.

Current execution package: `SETUP-CONDUCTOR-HANDOFF.md`, `50-HOUR-COMMAND-BOARD.md`,
`AI-TOOLING-AND-SPRINT-PLAN.md`, `SECURITY-AND-ACCESS-RUNBOOK.md`, and
`REQUEST-REVIEW-SPEC.md`. These documents distinguish source, deployment, live proof, and
owner-gated external actions.

Current linked database: **the production ledger records 047–060, migration 060 was
applied/read back, and the sole owner has active global-administrator and technician
roles.** The matching source passed 284/284 Node tests, frontend syntax, migration 058's
role-switched runtime, and the frozen-059 → 060 → 060-reapply runtime. The public Pages
site and the four reviewed provenance functions are now live from commit `968e1ea`; CI,
deployment runs, and byte-for-byte public asset parity are recorded in the 2026-08-23
manifest. The current owner cleared TOTP and production owner-route QA verified
Overview/Persona, account handles, family editor/tree, page designer/console, business
draft workspace, staff queue, asset preview/**Save a copy**, friend policy, and the
deterministic intention plan at desktop and responsive-emulation sizes with zero console
errors. Signed-in real-phone QA and unrelated-account privacy proof remain separate.
`RELEASE-MANIFEST-2026-08-22.md` remains the historical ordered-release
authority; `RELEASE-MANIFEST-2026-08-23-AI-PROVENANCE.md` records the forward 060 apply.

---

## v0 — Foundation (current)

Shipped:

- Auth: Google social/federated OAuth plus email/password and magic link; TOTP enrollment
  and the current owner's post-login AAL2 challenge are verified. Recovery, other-account
  coverage, and enterprise SSO remain security work. Profiles are private,
  with no public linkage to personas by default (mailbox authorization is a separate connector)
- Personas: create/edit, quick-setup wizard (multi-category, merged suggestions),
  AI builder interview, purpose/voice/topics/audience/rules, per-persona AI model
- [x] Private Backup persona pairing is database/source-complete: one-level owner-only
      main → backup relationships, a collapsible desktop rail, grouped mobile picker,
      editor assignment, and relationship-aware export/restore. Migration 048 is recorded
      in production; the matching frontend is live from commit `968e1ea`, rendered after
      the current owner's TOTP challenge, and still requires unrelated-account checks in
      `PERSONA-BACKUP-RELATIONSHIPS.md`.
- [~] Persona page designer phase 1 is live: owner full-asset previews
      and bounded local-copy downloads; eleven-section declarative module
      ordering/width/shape/tone, including Family and Offers & reviews;
      escaped text/HTTPS-link boxes; and a read-only HTML/CSS/JSON learning console with
      owner-private reusable snippets. Migration 050 is recorded in production and the
      frontend matches production. Post-TOTP QA verified full previews, **Save a copy**,
      the designer, and its learning console. Image/video widgets and video backgrounds
      stay blocked until public
      asset URLs use opaque ids instead of correlatable owner UUID paths; arbitrary
      public JavaScript remains prohibited. New first-party uploads are content-addressed
      locally. Forward migration 060 snapshots preexisting external HTTPS assets once as visibly
      unverified and blocks new unregistered external media from publication. See
      `PERSONA-PAGE-LAYOUT-BUILDER.md`.
- [~] Overview / Persona view has its production database projection and live frontend: an account-scoped mode switch,
      exact acting-persona identity, bounded friends/requests/reviewed-family/follower/
      following circle, bounded feed and post panels, complete reviewed peer-page layout,
      private-request redaction/cancellation, and transaction-rechecked social mutations.
      Page-look source images now render whole and uncropped in the editor. Migration 058
      supplies the exact-actor server projection so a sibling's friendship or owner
      access cannot leak private content. Migration 058 is recorded and the matching public
      assets are live; the current owner verified Overview and Persona mode after TOTP,
      while unrelated-account interaction testing remains open.
      See `PERSONA-VIEW-MODE.md`.
- [~] Castleborn organization data is present in production storage with tested source:
      20 owner-confirmed parent
      edges, four confirmed partner pairs, derived sibling labels, an owner-private
      Castleborn project with WAIS as manager, project-resource boundaries, and draft-first
      business bios/missions/titles. Migration 049 is recorded, and the current owner
      verified the family editor/tree and business draft workspace after TOTP; Abel and
      Enki remain
      unresolved rather than invented. See `CASTLEBORN-RELATIONSHIPS-PROJECT-BUSINESS.md`.
- [~] Review-first persona publication and governance has its database and owner UI live: draft /
      review / publish / unpublish, transparent AI disclosure, exact-revision checks,
      owner-confirmed feature tickets, separate follow/friend policies, persona account
      sync preferences, account-level maintenance roles, inert extension submissions,
      progressive security state, and retention primitives. Profile, layout, post, link,
      album, family-edge, revenue/affiliate/request-intake, AI-backend credential, and
      fan-binding changes invalidate the reviewed revision; direct reads honor symmetric
      blocks; fan chat requires a currently published public persona; existing personas
      are backfilled `unpublished`; and all legacy business pages are returned to
      owner-only draft state. Follow-on migration 052 now supplies the dedicated,
      exact-revision, AAL2 business review/publish/unpublish phase locally.
      Exact-approved native drafts stage into page review rather than auto-publishing.
      Migration 051 is recorded and the matching owner UI is live behind AAL2. Provider
      workers, CAPTCHA, Auth hooks, SMTP, WAF, SSO, and log
      drains remain explicit owner/dashboard work. See
      `PUBLICATION-SOCIAL-SECURITY-GOVERNANCE.md`.
      Canonical 051 and its timestamped migration mirror are byte-identical locally; the
      linked apply is recorded; the staff queue, friend policy, and deterministic intention
      plan rendered after the current owner's TOTP challenge, while two-account and
      provider integration proof
      remains open.
- [~] Family presentation and editing are live for the owner and passed post-TOTP QA.
      Public family
      cards come from the reviewed one-hop dependency projection. The revenue module
      renders reviewed disclosures, affiliate offers, and a Request review CTA only when
      the exact current page and every database gate pass. The hardened phase-1
      `request-review` Edge source uses exact-origin CORS, bounded input, Turnstile,
      rotating HMAC identifiers, neutral receipts, and a service RPC; it remains
      undeployed, its global/persona gates default off, and its notification sender and
      owner evidence queue do not exist. A byte-identical timestamped migration-043 mirror
      now exists locally but remains unapplied. The local affiliate redirect now uses a
      separate required HMAC secret, bounded inputs, HTTPS-only reviewed destinations,
      atomic current-page resolution, click caps/deduplication, and bounded retention;
      those additions remain default-off and require the full linked staging chain,
      secret installation, destination review, and runtime proof before deployment.
- AI Models: add hosted OpenAI-compatible/Anthropic/Azure connections (key write-only in
  Vault); edit an existing connection's label, base URL, and model id in-place without
  re-entering the key (migration `042`; API key stays write-only — rotate by remove + re-add)
- Pages: banner/background/avatar/feed images (file picker + preview + SD generate),
  profile song, live embed (Twitch/YouTube/Kick), Top 8, 37-platform link chips,
  gallery & sponsored/affiliate albums (deep-link out), blog feed + reels,
  per-page search, section show/hide modules, theme color, share link
- Social: friend requests (pending/accepted), block/mute, private/unlisted/public
  visibility enforced by row-level security, discover filters (18+ default-hidden,
  topic mutes), age gate on NSFW pages
- AI: linked hosted text models through the server proxy; exact official provider host/path
  enforcement is still required before mass credential onboarding. HQ assistant with roster
  context, per-persona chatbots, tasks with model-per-task and one-click Run,
  SD character panel (local A1111/Forge), content drafts pipeline
  (chat/task output → draft → copy → post on platform; idea → ready → posted)
- Trust & safety: pixel-burned watermarks with page URL on uploads, right-click/drag
  guards, in-app error reporting (migration 051 replaces direct `error_logs` inserts with
  a bounded authenticated redacting RPC), session-timeout countdown popup, stale-page
  banner
- Platform: brand icon bank (SVG, hologram-blue), favicon, release-driven extensions
  catalog (GitHub Releases + extension.json), versioned repo layout + Pages workflow

## v0.5 — Agent control center and live network

An `[x]` here means the implementation exists in this repository, not necessarily that it
is pushed, deployed, configured, migrated, or provider-verified. Production state is called
out explicitly. `[~]` means a useful local slice exists but a release, live verification, or
larger product phase remains.

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
      Twenty-five pairs were recorded in the 2026-08-12 snapshot and the earlier owner-triggered
      FB/IG path was proven on an owner asset. The exact hardened replacement is local/unreleased;
      recurring publishing remains off.
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
- [~] Human-gated agent board hardening (migration 053 + local owner UI/endpoints):
      bounded allowlisted proposals, exact reviewed execution inputs, one-use capability,
      idempotent exact-request runs, result/audit visibility, and expired-run recovery.
      Proposals and execution default off; local concurrency, retry-ceiling, abuse, drift,
      idempotency, and recovery verification passed. Linked migration, provider
      configuration, and live AAL2 owner smoke remain open.
- [~] Owner research/content hardening (migration 054): bounded owner/service RPCs,
      durable daily/lifetime creation counters, server-authored provider receipts, and
      approval/provenance authority are recorded in the linked database. Saving over an
      approved or scheduled
      package is an explicit AAL2-gated downgrade after the exact package row is locked.
      No research provider, publication, or evidence-quality outcome is implied.
- [~] Agent audit retention hardening (migration 055): narrow service writers, reserved
      terminal-audit capacity, stored row/byte and mutation ceilings, and deletion/
      erasure serialization are recorded in the linked database. PostgreSQL lifecycle,
      upgrade, over-limit,
      direct-DML, and writer/erasure concurrency evidence passed; an approved linked
      retention/operations runbook and hosted-load evidence remain release gates.
- [~] Auth email attestation invalidation (migration 056): stale AliaSpaces-confirmed
      email attestations are revoked on Auth email change/unconfirmation without treating
      provider OAuth connections as the same proof. Migration 056 is recorded; an actual
      email-change/recovery exercise remains unverified.
- [x] Native AliaSpaces post bridge: L2 exact approvals wait for the owner to press
      Stage for page review. Migration 051 disables the legacy automatic native publisher;
      an unchanged staged post becomes public only when the owner reviews and publishes
      that exact persona-page revision. External provider queues remain separate gates.
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
- [~] Reddit connector (Order 4 code complete locally): official OAuth (identity/submit/read,
      server-completed callback, Vault-only tokens, username binding) plus reddit-post
      publishing to a tags-named subreddit or the account profile, with Queue button.
      Owner still reviews migration 021/config, sets credentials, deploys both functions,
      pushes Pages, and verifies OAuth, disconnect/erasure, and one low-stakes approved post.
- [x] Shared account managers: migration 020 `account_persona_links` lets many personas
      co-manage one ledger account (primary stays on the ledger row); share-aware
      editor checkboxes, targets, staging, and Discord publishing. Follow-up: teach
      `run-tasks` the share-join so schedules can run as co-managers
- [~] Discord channel-webhook source exists, but the current frontend has no Connect/Post
      controls and live migration/webhook state is unverified. `discord-post` is explicitly
      fail-closed/dormant in this release. Re-enable only after exact approval + immutable
      webhook/channel binding, pause/destination revalidation, provider-ID checkpointing,
      uncertain-outcome reconciliation, transactional audit/finalization, Vault erasure,
      and race/failure tests. Scheduled/L3 Discord posting remains excluded.
- [x] Connector build orders: CONNECTOR-BUILD-ORDERS.md documents, for every ledger
      platform, whether authentication and automated posting are physically possible,
      and specs Orders 1–6 (X write, FB Page, IG professional, Reddit, YouTube,
      Patreon identity) for follow-on build sessions
- [x] Persona website field: dedicated editor field stored as the first website link,
      rendered as a header chip on the public page (no migration needed)
- [x] Persona editor Managed accounts picker: assign or release saved Account Ledger
      accounts with checkboxes directly in the persona editor; accounts held by another
      persona show where they live before a move, and assignments apply on Save
- [~] Friend notifications: bounded, owner-persona-scoped Supabase Realtime subscriptions
      and focused badge refresh are complete locally. Apply migration 037, push Pages, and
      verify request/accept events plus reconnect/focus fallback under RLS.
- [x] Comments and reactions on feed posts
- [x] Feed pagination + hashtag browse pages
- [ ] Per-platform branded icons (extend the hologram icon bank beyond the orbit node)
- [x] Proper "act as persona" picker modal for social actions
- [~] Extensions page: full escaped/bounded catalog cards, GitHub release history, and
      checked-in fallbacks for Concept + Personas are complete locally. Publish real GitHub
      releases/manifests for the currently private or unavailable repositories, then verify
      the public catalog; the local fallback remains truthful when no release exists.
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
- [ ] Resolve the persona-save session bug from the verification round using redacted
      owner/staff telemetry. After migration 051 the browser reports through bounded
      `report_client_error`; it does not insert into or read `error_logs` directly.
- [ ] SEO: path-based routing + prerendered persona pages so Google indexes each
      persona individually, and per-persona OG images for rich link previews
      (today: hash routes = one indexable URL; JS-set titles/descriptions only)
- [ ] Auto-generated per-persona sitemap (Edge Function serving sitemap.xml
      from the personas table)
- [~] `gemini-image` is deployed from the hashed release source with exact native Google
      host/path enforcement, header-based key transport, bounded input, and a pinned image
      model. The post-TOTP UI QA did not spend provider tokens. Its controlled provider-
      account retest still needs exact Google host/path enforcement verified from the
      hosted request and a generated-media end-to-end result.
- [~] Migrate off legacy anon/service_role JWT keys to the new sb_publishable_/sb_secret_
      API keys. The browser already uses a publishable key; finish the function/secret
      inventory and production rotation before Supabase retires legacy keys.
- [~] Enforce MFA, not only enrollment: the reusable AAL2 credential boundary is deployed,
      unit tests prove AAL1 denial/AAL2 acceptance, and the current owner cleared TOTP before
      private owner routes rendered. Recovery, factor changes, unrelated-account coverage,
      provider credentials/OAuth, and future money actions still require dedicated proof.
- [ ] Move executable inline JS/CSS/event handlers into versioned assets and host behind verified
      CSP, frame denial, HSTS, nosniff, Referrer-Policy, and Permissions-Policy headers.
- [ ] Move OpenRouter OAuth exchange/Vault storage fully server-side and enforce code-owned exact
      host/path maps for every known provider. Custom endpoints require an owner-reviewed allowlist.
- [~] Per-backend AI budget guard is implemented locally in migration 057: durable
      owner/backend/mode daily and monthly request/token reservations, expiring concurrency
      leases, default-deny automated modes, narrow AAL2 policy mutation, and server-side
      reserve/finalize integration. Scheduled `run-tasks` now reuses its exact v2 audit
      action UUID as the automation-budget request key and fails closed before provider
      work. It stores no provider pricing, does not create a provider dashboard cap, and
      authorizes no spend. Queue/hop limits, a provider-price ledger, and a separately
      operated global emergency spend stop remain roadmap work.
- [ ] Configure/test production SMTP, exact redirects, CAPTCHA, confirmation, magic link, password
      recovery, security notices, unsubscribe, bounce, and suppression before public email flows.
- [~] Release workflows now require manual dispatch and the exact
      `MIGRATIONS-VERIFIED` confirmation; pushes validate but deploy nothing. The frozen
      local validation is green. Protected-environment reviewers, credential presence,
      complete linked predecessor inventory, and database → functions → frontend live
      evidence remain open.
- [x] Wire generated/uploaded public persona media into immutable `persona-media` paths;
      PNG/JPEG/WebP/GIF and MP4/WebM bytes are hashed after watermarking where applicable,
      written under owner/published scopes with `upsert:false`, and identical duplicates
      reuse the same address. External HTTPS and legacy URLs remain mutable and are not
      byte-integrity-bound.
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
- [x] P0 refactor: CI/CD scaffolded (2026-08-08) and production triggers hardened
      (2026-08-22). `.github/workflows/ci.yml` validates; function and Pages workflows are
      manual confirmation-gated. `SUPABASE_ACCESS_TOKEN`, protected reviewers, and a live
      dispatch remain owner-controlled setup, not local completion evidence.
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
- [~] P0: persona media/docs → Storage — new image paths use `persona-media`, and account/
      content erasure now verifies exact owner prefixes across all four media buckets.
      Inventory and migrate legacy `assets/personas/` art and old URLs with owner review;
      do not remove repo files until every replacement is reloaded and verified.
- [ ] Owner review: 97 of 156 account_ledger rows have no connection (inventory) —
      identify truly-abandoned ones for archive-then-delete in batches
- [ ] SQL editor housekeeping: archive useful named snippets to repo, clear the
      untitled scratch tabs (dashboard-side; do when the dashboard is stable)
- [ ] Review and push the current coordinated app/function release; follow
      `ROADMAP-EXECUTION-2026-08-13.md` and keep migration 036 dormant.
- [~] User-controlled persona media/data storage: move persona avatars/banners and any
      persona documents out of the website repo into owner-controlled storage.
      Best practice: Supabase Storage per-owner bucket (RLS + signed URLs) with
      in-app upload/download/delete wired to the existing erase-content and
      delete-account flows, plus optional links to owner cloud (Drive/OneDrive).
      The Supabase path and fail-closed four-prefix erasure are complete locally. Optional
      Drive/OneDrive links, legacy migration, and live erasure tests remain. The repo should
      ultimately keep only shared site chrome.
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
- [x] Security Advisor forward hardening 061 (2026-08-23): the installed Supabase GitHub
      App automatically applied the committed migration to production. Postflight verifies
      pinned trigger paths, removed accidental browser/PUBLIC function execution,
      authenticated-only owner research RPCs, preserved public RLS/projection contracts,
      fail-closed future postgres function defaults, and a two-column bounded waitlist.
      `pg_net` remains in `public` because provider version 0.20.3 is non-relocatable.
      CAPTCHA/WAF and same-origin waitlist intake remain open. Main-push auto-apply is now
      a documented release gate because it ran before GitHub unit tests completed.

## Persona / product direction (2026-08-10)

- [ ] REDEPLOY meta-oauth: account_type regression patched in repo (bare IG edge) —
      deploy to unblock Meta connect (dashboard editor was down; use CLI/CI)
- [~] Context-box feature: migration 030 APPLIED + verified. Manual editing, conflict-safe
      append/replace, persona-field change summaries, owner-reviewed chat takeaways, and a
      bounded 10-line/1,500-character AI prompt slice are complete locally. Deploy ai-proxy
      before Pages and live-test concurrent edits; remaining event hooks are documented.
- [ ] Apply persona update: Sherlock Chomes (cannabis podcast) — copy remains in
      persona-briefs/ and requires its own owner approval.
- [x] Correct the rejected Song/Rhythm warrior-sibling brief — Song now uses the
      Lifegiving Compassion identity and permanent no-donations boundary; the file
      makes no new Rhythm claim. No live persona write was authorized or performed.
- [ ] Personas = personalized AI news feed (owner vision): AI researches assigned
      interests, fact-checks, cites sources, serves tailored blurbs (feed_items +
      ai/research) instead of mindless scroll; later, projects = multi-persona
      collaboration. See V2-BLUEPRINT.md §6.
- [ ] "soulular" identity layer (parallel to cellular) — confirm intent
      (concepts/soulular.md); likely the persona follow/graph/discovery layer
- [x] V2 rebuild blueprint written (V2-BLUEPRINT.md) — incremental migration path,
      not a big-bang rewrite
- [~] Meta posting: owner-triggered FB/IG publishing was previously proven live for the
      owner's assets. The new draft claim, immutable destination/media snapshots, partial
      checkpoints, and exact scheduling path are code-complete locally but not deployed;
      apply 035 in its coordinated maintenance window. App Review is needed only to serve
      other users. Keep recurring migration 036 off until the activation checklist closes.
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
- [~] Native apps: the PWA manifest/install/public-offline shell is complete locally.
      Push notifications remain a separate permission/backend phase; Expo/React Native
      comes later for chat, approvals, share/camera, and the sourced AI feed.
- [~] Chat workspaces: migration 031 APPLIED + verified; owner-scoped list/create/rename/
      pin/resume, workspace messages, inclusion in the full account export, owner-reviewed Save context, and max-three
      distilled Attach context are complete locally. Deploy ai-proxy first, then Pages,
      and live-test RLS, conflict handling, resume, distillation, and export.

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
- [~] PWA: install/offline shell complete locally; real-device release verification and
      a separate push-notification permission/subscription/delivery phase remain
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
6. **AI media provenance is deployed** — immutable migration 059 supplies the historical
   baseline; forward-only migration 060 completes the removal of
   direct browser public-media writes, requires owner declarations, system-authors site
   generation evidence, and binds trusted server-created crop-last static-image watermarks
   to exact hashes. Generated raw pixels never reach the browser. AI-used animated media
   remains blocked until an isolated frame-by-frame transcode worker is implemented.
   Preexisting external embeds receive a one-time visibly-unverified snapshot and new
   external media fails page review. Safe external import, C2PA signing, and opaque
   public delivery remain gates. Current owner-route QA cleared TOTP and produced zero
   console errors, but did not spend provider tokens or prove generated-media output bytes.
7. **Production block behavior depends on migration state** — migration 051 and its
   matching frontend are live and add symmetric account/persona block checks to direct
   reads and public projections. The current owner's friend policy rendered after TOTP;
   adversarial unrelated-account block/privacy behavior remains unverified.
8. **Friend Realtime is local-only until migration 037 + Pages ship**; focus refresh remains
   the fallback for deletes/cancellations that cannot use the filtered event path.
9. **prompt()/confirm() dialogs remain for several settings/destructive confirms**, although
   social identity selection now uses the proper Act as persona modal.
10. **External publishing is connector-specific** — owner-triggered Meta is proven, Reddit is
    locally hardened but undeployed, and other destinations remain manual or gated until their
    official write scopes, assignment, caps, audit, and reconciliation are verified.
11. **GitHub Pages hosting** — free static host, ~10-minute cache, no server control.
12. **Error telemetry has a migration boundary** — migration 051 removes the historical
    insert-open policy and permits only a bounded authenticated redacting RPC plus staff
    reads. Until 051 is applied and read back, audit the linked project's legacy policy;
    insert-open telemetry is not acceptable release state.
13. **Top 8 is a jsonb array** on the persona row (no referential integrity).
14. **Extensions "Open" buttons target localhost ports** — tools must be installed
    and running locally; catalog reads GitHub API client-side (rate-limited) with a
    static releases.json fallback.
15. **Personas app zip remains a checked-in fallback**; the catalog now understands GitHub
    Releases for both desktop tools, but the owner still needs to publish public releases.
16. **Page age gate is honor-system** (button + session flag); NSFW hiding is default-on
    but client-side. Public fan chat therefore stays server-disabled for NSFW personas
    until server-verifiable age assurance exists.
17. **Google consent screen shows the Supabase domain** — cosmetic; fixed by the
    paid Supabase custom domain when it matters.
