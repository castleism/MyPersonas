# Changelog — AliaSpaces / MyPersonas

Versioning per VERSIONING.md: majors are milestones, `.x` are roadmap items,
trailing letters are hotfixes. Releases are git tags.

## Weekly approval scheduling + queue hardening (code complete locally, activation blocked) (2026-08-13)

- **Composer approval-day UI:** drafts are grouped by `week_start`, show the exact owner-time-zone
  schedule, and expose guarded Save, Approve & schedule, Unschedule, immediate Meta publish,
  partial retry, and Delete actions. Scheduled/publishing/posted rows are locked; X has a live
  character counter and remains draft-only until its publisher is versioned and write-authorized.
- **Migration 035 (not applied):** adds an exact approval hash and security-definer save/schedule/
  unschedule/delete RPCs, invalidates legacy unhashed schedules, validates owned/paired Meta
  destinations and images, snapshots the actual FB/IG asset IDs + approval time zone, removes direct
  browser mutation of provider/approval state, blocks project-policy destinations, and writes audit events.
- **Immediate Meta publish hardening (not deployed):** `meta-post` now accepts only an owner-scoped
  `draftId`, atomically claims it, checkpoints each provider ID server-side, and leaves uncertain
  provider outcomes locked for reconciliation. The browser no longer performs provider-result writes.
- **Scheduled worker hardening (not deployed):** claims and publishes the current due row, verifies
  exact approval + paired asset snapshots, filters paused owners before its two-row batch, fails
  missing/unsupported targets, retains/skips completed provider IDs, detects missing Instagram
  linkage, and applies an advisory local rolling safety guard.
  The shared interactive Meta path now applies the same project-policy destination gate.
- **Cron remains dormant:** the opt-in schedule moved to migration 036. Do not apply it yet. X source/
  write authorization, provider timeout reconciliation, automation-level contract, and queue tests
  remain activation blockers. See `POST-QUEUE-ACTIVATION.md` for the deploy, pilot, stop, and recovery
  checklist. No push, SQL application, Supabase change, or live post was performed in this pass.

## 3-part pipeline proven live + composer UI (2026-08-13)

- **End-to-end verified live:** `compose-post` staged a real draft (persona-voice FB/IG/X
  captions + landscape/square/portrait transform crops), and `meta-post` published the tailored
  FB + IG pair to the Christian Cody page (FB `postId`, IG `mediaId` both 200 — **Instagram
  posting confirmed**). `meta-post` delete then removed the FB test post. Nothing needed the
  cron; the whole flow is proven.
- **Composer UI** (isolated: 9 new functions + one Menu entry "Compose posts (3-part)"): an
  overlay to pick a persona + Facebook page, enter a brief, stage a 3-part draft (calls
  `compose-post`), then review/edit the three captions, preview the three crops, **Publish now**
  (FB+IG via `meta-post`), Save, or Delete. Owner-scoped via RLS. Frontend syntax check passes;
  additive and self-contained so it can't affect the rest of the app.

## Scheduled publisher + shared publish module (2026-08-13)

- **`_shared/meta-publish.ts`:** extracted the FB/IG publish primitives (Graph helpers,
  `resolvePageContext`, `publishFacebook`/`publishInstagram`, `publishToMeta`) so the
  interactive publisher and the cron share identical owner-scoped, scope-gated logic.
  `meta-post` is now a thin HTTP wrapper over it.
- **`run-post-queue`** (new cron, `--no-verify-jwt` + `CRON_SECRET`): finds owner-approved,
  due `post_drafts`, **atomically claims each** (`scheduled` → `publishing`, so overlapping
  runs can't double-post), publishes each platform's own image+caption to Facebook + Instagram,
  writes back `fb_post_id`/`ig_media_id` + status, and defers X. Bounded batch (15/run, under
  IG's ~25/24h cap).
- **`compose-post`** now stores the draft's target Facebook account (`facebook_ledger_id`).
- **Migration 034** (applied): `post_drafts.facebook_ledger_id` + a `publishing` claim status +
  due-work index. The pg_cron schedule is now migration 036 and remains opt-in/unapplied.
- 20 functions compile; 18/18 tests pass. This completes the 3-part backend pipeline
  (compose → stage → approve → publish); only the approval/compose UI and X wiring remain.

## Posting build: compose-post + meta-post delete (2026-08-13)

- **`compose-post`** (new edge function): stages a 3-part draft for a persona. Owner-scoped;
  drafts the FB/IG/X captions in the persona's voice via the hardened `ai-proxy` (persona's
  linked model, no history replay), derives the three image crops as Supabase image-transform
  URLs (FB 1200×628 / IG 1080×1080 / X 1080×1350, resize=cover), and writes a `post_drafts` row
  (status=draft). Accepts supplied captions too; 422 if a persona has no linked model and none
  supplied. Compiles clean.
- **`meta-post` delete action** + shared `resolvePageContext` resolver: `{action:"delete",
  facebookLedgerId, postId}` removes an owner's Facebook Page post (IG API can't delete published
  media). Publish path unchanged. Compiles clean.
- **config.toml:** added `[functions.compose-post] verify_jwt = true`.

## 3-part staged posting system + pet-project field (2026-08-13)

- **Live FB posting verified:** real test post published to the "Jokes from Dads" page and
  confirmed, then deleted. The full pipeline works.
- **3-part staged posting system** (`POSTING-3PART-SPEC.md` + migration 033 `post_drafts`,
  applied + verified): one post authored once, staged as three platform-tailored variants —
  Facebook landscape 1.91:1 / detailed caption, Instagram square 1:1 / optimal caption, X
  portrait 4:5 / ≤280 caption — grouped into a weekly schedule reviewed/edited and approved on
  approval day, then published via meta-post (FB+IG) and twitter-post (X). Persona AI drafts all
  three captions. `post_drafts` is owner-scoped (RLS), 23 columns incl. per-platform captions +
  image crops + results + scheduling.
- **Pet-project field** (migration 032 `personas.pet_project`, applied + verified): a short
  product/project label shown as a ★ chip next to the persona's name + handle on the profile
  header and roster cards, editable in the persona form. Saved via the same post-bundle pattern
  as title/focus (owner-scoped update on the resolved persona id). Frontend syntax check passes.

## Meta FB/IG posting enabled (code complete, deploy pending) (2026-08-13)

- **Discovery:** the Meta app (App ID 2042281049742621) is fully configured. Login config
  "MyPersonas Portfolio SU" (28345689651788755) already includes pages_manage_posts,
  instagram_content_publish, business_management (standard access). Verified in the DB: all
  25 connected Facebook pages + 25 Instagram accounts already GRANTED those 3 scopes. So
  posting to the owner's OWN accounts works in dev mode — **no App Review / reconnect needed**
  (App Review is only for posting on behalf of other people).
- **meta-post finished:** real publisher — owner-scoped, verifies publish scopes on the grant,
  pulls the durable user token via `meta_get_grant_token_bundle`, derives a fresh Page token,
  posts to FB `/{page}/photos` and IG (create container -> media_publish). Removed the scaffold
  gate. Compiles clean (esbuild + node strip-types).
- **meta-oauth:** `capabilities.postingEnabled` now derives from the grant's scopes
  (`hasPublishScopes`) instead of hardcoded false.
- **config.toml:** added `[functions.meta-post] verify_jwt = true`.
- **Deploy:** push to main -> supabase-deploy Action auto-deploys. Then a single owner-approved
  test post before any wider use. Backups in _to_delete/backups/.

## Applied migrations + auth hardening + responsive polish (2026-08-12)

- **Migrations 030 + 031 applied and verified live:** `personas.context_log` (context
  box, 20k-char cap) and `chat_workspaces` (owner-scoped RLS) + nullable
  `agent_messages.workspace_id`. All four schema checks return present=1.
- **Leaked-password protection ENABLED** (Auth → email provider → HaveIBeenPwned); the
  badge reads ENABLED after a full reload — the previously-unconfirmed toggle is now on.
- **Responsive:** `viewport-fit=cover` + safe-area insets (header, stale bar, main,
  overlay, fanbox/sdPanel) and a tablet tier (768–1024px → studio `.cols` 280px/1fr).
  Additive and no-op on desktop (env insets resolve to 0); all 6 rules parse valid in
  Blink and the frontend syntax check passes. Pre-edit backup in `_to_delete/backups/`.
- **Function drift documented → `supabase/functions/DRIFT.md`:** confirmed 8
  deployed-but-unversioned functions live (daily-discovery, gemini-models, gemini-probe,
  image-probe, meta-ig-attach, meta-ig-discover, split-post, twitter-post). Can't be
  pulled from here (dashboard "deploy status unavailable"; body API returns an eszip
  bundle; source carries inline secrets). Checklist with `supabase functions download`
  + secret-scrub steps written for the next CLI session.
- Prior accumulated batch (persona briefs, 030/031 files, meta-post scaffold,
  App-Review + V2/mobile blueprints, soulular note) committed as 55d80a5.

## Meta posting scaffold + mobile/app blueprints (2026-08-10)

- **Meta posting build started (App-Review-gated):** `supabase/functions/meta-post/`
  scaffold — shape-correct IG two-step publish + FB Page photo post, but **gated OFF**
  (returns 409 until the grant carries the publish scopes), so it's safe to deploy.
  `APP-REVIEW-META.md` = the full path to live posting (business verification →
  request pages_manage_posts/instagram_content_publish/business_management → screencast
  script → the meta-oauth opt-in scope change to apply AFTER approval). App Review is
  the long pole — start it first. Cannabis personas can't publish via Meta regardless
  (content policy). Compiles; not deployed.
- **MOBILE-BLUEPRINT.md:** responsive-web tuning + a missing tablet tier (site already
  has 10 breakpoints + 44px targets, so it's optimization not a rebuild); native apps
  via PWA-first → Expo/React Native, focused on persona chat + post approvals + the AI
  news feed; and **chat workspaces** (saved conversations that distill into the persona
  `context_log` to build context over time). Sequenced, backend reused, no rewrite.
- **Flagged:** repo↔prod function drift (meta-post, meta-ig-attach, meta-ig-discover,
  daily-discovery, gemini-models/probe, image-probe exist in prod, not in repo) — pull
  them into source control (`supabase functions download <name>`).
- Verify green: 18 functions + pure.ts compile, 18/18 tests, frontend parses.

## Persona batch + Meta regression fix + v2 blueprint (2026-08-10)

- **Meta connect regression FOUND + patched (repo; redeploy pending):** the IG
  inline-expansion fix requested `account_type`, a Basic-Display field that's invalid
  on the Instagram *Graph* node — Graph rejects the whole request if any field is
  invalid, which broke the connect ("meta rejected request"). Reverted both field
  strings to the bare `instagram_business_account` edge (proven-working; returns
  `{id}`, which is all pairing needs); `instagramAssetFromLinked` builds the IG from
  that id. Compiles; needs deploy (dashboard code editor was down — deploy via
  `supabase functions deploy meta-oauth --no-verify-jwt`).
- **Persona content** (persona-briefs/2026-08-10-persona-updates.md): Sherlock Chomes
  (cannabis podcast) and Song/Rhythm (combat-trained gamer siblings; Song girly /
  Rhythm tomboy) — ready-to-paste Focus/Bio/Voice/Topics + context-log seeds.
- **Context-box feature** designed: migration 030 adds `personas.context_log`
  (AI-fed roadmap journal, distinct from private notes); CONTEXT-BOX-SPEC.md covers
  UI + auto-append + bounded prompt inclusion. Apply 030 before shipping the UI.
- **V2-BLUEPRINT.md**: full from-scratch rebuild plan (SvelteKit + TS, shared `_core`
  connector library, CLI migrations + CI/CD, RLS/pgTAP, the "personas = personalized
  AI news feed" direction, projects/multi-persona, the soulular identity layer).
- **soulular** captured as a concept (concepts/soulular.md) — my interpretation
  (identity layer parallel to cellular), flagged for owner confirmation.
- **Cleanup + verify:** scanned — repo already clean of stale/unused committed files
  (junk is in _to_delete; outputs/tmp are active work). Full verify green: 17 fns +
  pure.ts compile, 18/18 tests, frontend parses. Flagged 2 ambiguous items for review
  (assets/marketing/x-integration-slide.html; root persona-prompt md files).

## Applied — retention jobs live + security review closed (2026-08-09)

- Applied migration 028: `public.run_data_retention()` created and scheduled via
  pg_cron (`data-retention-weekly`, Sundays 04:15 UTC). Verified: function exists,
  cron registered, pg_cron installed; a manual dry run returned 0 deletions in
  every category (error_logs, mailbox_findings/refs, expired transient tables) —
  the database is already clean, so the job is now maintaining that automatically.
- Security Advisor anon-EXECUTE review closed with no change (documented in
  029-anon-execute-review.DRAFT.sql): owns_persona is an RLS helper that returns
  false for anon anyway; can_request is an unreferenced core-schema helper needing
  a usage trace first; the other three power public pages.
- Meta pairing check: fix is deployed/verified; current state is 4 pages paired,
  0 with a linked IG yet, 27 IG ledgers available — a fresh connect pass (owner-
  driven) is needed to attach IGs now that discovery works.
- Enabled leaked-password protection in Auth → Attack Protection (save toggled;
  confirm on next dashboard load).

## Tooling + refactor groundwork — overnight batch (2026-08-08)

Repo-only changes (nothing deployed to prod; all reviewable before it ships):

- **CI/CD scaffolding (P0):** `.github/workflows/ci.yml` runs unit tests, `deno
  check` on every edge function, and a frontend syntax check on PRs/pushes;
  `.github/workflows/supabase-deploy.yml` deploys functions on merge to main once
  `SUPABASE_ACCESS_TOKEN` is set. Setup documented in `CI-CD-SETUP.md`.
- **Test suite (P1):** `tests/` with `npm test` — 7 passing tests covering the
  tricky pure helpers (instagramAssetFromLinked, parseBindings, safeExpiry,
  normalizeScopes, validators, email normalization). `scripts/check-frontend-syntax.mjs`
  parse-checks the single-file app. `package.json` added for tooling.
- **Email normalization (P1):** `saveLedgerDetails` and `saveLedgerBatch` now
  trim+lowercase `login_email` at write via the existing `normalizeLedgerEmail`,
  guarding the casing/whitespace class of exact-match connect failures.
- **Retention migration WRITTEN, not applied (P0):** `028-retention-jobs.sql`
  (pg_cron pruning for mailbox_findings/refs, error_logs, expired transient state;
  defensively guarded; excludes meta_oauth_candidates by design). Review before run.
- **P2 docs/drafts:** `KEY-ROTATION.md` (migrate off deprecated anon/service_role
  keys to sb_*), `CONNECTOR-CORE-DESIGN.md` (shared-core plan for the 5 connectors),
  `029-anon-execute-review.DRAFT.sql` (review-only; REVOKEs commented pending
  staging tests). Backup of index.html saved to _to_delete/backups-2026-08-08/.
- **Connector-core seed (P2):** extracted the pure helpers into
  `supabase/functions/_shared/connector/pure.ts` (validators, normalizeScopes,
  safeExpiry, instagramAssetFromLinked, parseBindings, normalizeEmail) with an
  adoption README. `tests/pure-core.test.mjs` imports the REAL module via Node
  type-stripping, so it's tested with no mirrored-copy drift. ADDITIVE — not yet
  imported by any function, so no deployed behavior changed.
- Local CI dry-run green: 17/17 functions compile, 14/14 tests pass, frontend parses.

## Docs + hygiene — architecture review and data audit (2026-08-08)

- Added ARCHITECTURE-REVIEW.md: retrospective (achievements, lessons), target
  architecture, and a prioritized P0–P3 refactor backlog (CI/CD, connector core,
  frontend modularization + tests, data lifecycle, observability, key rotation).
- Data hygiene audit: production DB is already clean of transient junk (0 rows in
  meta_oauth_transactions, leases, cleanup holds). Established an `archive` schema
  backup convention; archived error_logs to archive.error_logs_20260808 and
  removed the 1 stale (>30d) row. Left active/app data untouched; flagged the 97
  unconnected account_ledger inventory rows and unbounded mailbox_findings growth
  for owner review + a retention job (P0).

## Fixed — linked Instagram accounts not offered for pairing (2026-08-08)

- Root cause: for each discovered Page the connector made a SEPARATE
  GET /{ig-id} call (discoverInstagram) to read the linked IG's
  username/name/account_type. Meta rejected that call for granular
  business-asset grants ("instagram discovery failed … Meta rejected the
  request"), so the IG was dropped and the pairing modal showed "no linked
  Instagram." At scale it was also one extra request per page, hitting rate
  limits — which is why only tiny batches ever worked.
- Fix (deployed to prod, editor content hash-verified against repo): read the
  linked IG INLINE via field expansion
  `instagram_business_account{id,username,name,account_type}` on the page fetch
  in both discoverPages and discoverPagesByIds — no separate call. New
  instagramAssetFromLinked() keeps the IG whenever a valid id is present, so it
  is always offered for pairing even if detail fields come back empty.
  discoverInstagram() is now unused (left in place, harmless).
- Also deployed in the same push: the `dismiss` action + claim-error logging
  from the earlier cancel-lock fix (finally live now that the dashboard editor
  recovered).

## Fixed — Gmail connect failing silently (2026-08-08)

- `finishPendingGmail` set `gmailOAuthNotice` but never surfaced it: it resolves
  after the initial studio `route()` already ran, so the notice-toast in route()
  wouldn't fire until the next navigation. Gmail connect outcomes — success AND
  failures like email mismatch, scope not granted, or `google_revoke_required` —
  appeared to do nothing. Now finishPendingGmail re-renders and toasts the result
  immediately (matching disconnectGmail's pattern), respecting the uid/epoch guard.
- Diagnosed + corrected a wedged account: the ledger email was mistyped
  girl.gamers.wp@gmail.com (plural) vs the real girl.gamer.wp@gmail.com, which
  failed the connector's exact-email match every time; the gmail connection was
  stuck in connection_state=error / google_revoke_required with a retained token.
  Fix applied in one transaction (verified): deleted the retained gmail_credential
  (delete trigger cleaned the vault secret, which also lifts the login_email guard),
  corrected login_email -> girl.gamer.wp@gmail.com on all 3 of this identity's
  ledger rows (twitter/instagram/gmail; the Twitter guard only blocks
  username/provider changes so its live connection was untouched), and reset the
  gmail account_connections row to a clean disconnected state. Ready for a fresh
  Connect. Note: any stale Google grant from the failed attempts is harmless — a
  fresh connect (prompt=consent, access_type=offline) issues a new token.

## Fixed — Security Advisor warnings, safe subset (2026-08-08)

- Migration `027-advisor-warning-fixes.sql` (applied + verified in prod):
  - Dropped the broad public SELECT policies `media public read` and
    `persona media public read` that let anyone ENUMERATE every file across all
    owners ("Public Bucket Allows Listing"). Both buckets stay `public=true`, so
    getPublicUrl serving is unaffected; only anonymous listing is removed.
    (persona-media's policy was introduced by 026 earlier today — corrected.)
  - Pinned `public.concept_touch` search_path ("Function Search Path Mutable");
    it's a 157-char trigger touching no tables, so this is behavior-neutral.
  - Verified after: 0 leftover listing policies, concept_touch pinned, both
    buckets still public.
- Leaked-password protection (Auth → Attack Protection): NOT changed. Supabase's
  Management API was returning 503s all session, so the toggle's save never
  confirmed; changes were reloaded away to avoid a half-set state. One manual
  toggle + Save for the owner when the dashboard is healthy.
- Left deliberately: ~29 SECURITY DEFINER function warnings (definer-by-design
  with internal auth checks) and pg_net-in-public (moving it risks cron/webhook
  references). Both are low-value / higher-risk and need a separate careful pass.

## Added — owner-controlled persona storage foundation (2026-08-08)

- Privacy review outcome: persona working documents and persona page art move out
  of the website git repo into Supabase Storage the owner controls. Migration
  `026-persona-storage-buckets.sql` (applied in production, verified) creates:
  `persona-media` (public page art; writes RLS-scoped to the owner's own <uid>/
  prefix, public read) and `persona-docs` (fully private; owner-only read/write
  under their own <uid>/ prefix). 8 storage policies total.
- Root `.gitignore` added so /outputs/, roadmap-prompt docs, dossiers, and *.bak
  can never be committed, even by `git add -A` (push.ps1 was already scoped).
- Still to build (ordered): app upload/replace/delete UI for both buckets; persona
  art served from Storage URLs; migrate the 30 tracked avatar/banner files and the
  ~26 local persona docs; then remove assets/personas/ from the repo (history purge
  optional, owner's call).

## Fixed — "Could not lock the Meta authorization for cleanup" root cause (2026-08-08)

- Root cause found by running the claim function directly in the SQL editor:
  migration 023's `meta_claim_oauth_candidate_for_revocation` RETURNS
  TABLE(... meta_user_id ...), and PL/pgSQL treats OUT columns as in-scope
  variables, so the SELF-HEAL 2 upsert's `on conflict (meta_user_id)` raised
  42702 "column reference is ambiguous" on every cancel — surfacing as the
  dead-end "Could not lock" while the candidate stayed `pending`. Migration
  `025-meta-claim-variable-conflict.sql` re-creates the function with
  `#variable_conflict use_column` (all variables are p_*/v_*-prefixed).
  Applied in production and verified: the same direct call now claims cleanly
  (row returned, bundle decrypts, state advances).
- New safe recovery paths so abandoned pairing selections can never wedge
  connects again:
  - meta-oauth `dismiss` action: local-only discard of the owner's pending
    candidate, allowed only when a shared Meta grant already exists for the
    identity (mirrors the cross-owner cleanupSkippedToProtectSharedGrant
    precedent); refused during in-flight cleanup or recorded holds. Claim RPC
    failures in cancel now log code+message to the function console.
  - App: pairing modal gained "Close — keep everything" (plain close, nothing
    revoked); Escape now closes instead of triggering the destructive cancel;
    Connect Meta auto-dismisses a stale candidate (and retries start once)
    before telling the owner to resolve cleanup manually.
- The stuck candidate from today's pairing attempts was cleared; the existing
  Christian Cody page connection survived throughout.

## Ops — Meta connect unblocked, gemini-image deployed (2026-08-08)

- Meta assets consolidated into one Business portfolio (WAIS); `META_LOGIN_CONFIG_ID`
  now points at the system-user login configuration `28345689651788755` (verified by
  secret digest = SHA-256 of the ID).
- Verified the meta-oauth Instagram-discovery guard is live in production (deployed
  code hash-matches the repo): a page whose linked IG can't be read still pairs as a
  Facebook Page instead of failing the whole connect.
- Cleared the stale `meta_oauth_candidates` lock for the owner; verified migrations
  023 (cancel-cleanup self-heal) and 024 (ledger suspended/aliases) are applied in
  production.
- Deployed the `gemini-image` Edge Function via the dashboard editor and registered
  it in `supabase/config.toml` (`verify_jwt = true`, matching ai-proxy).
- Known issue while reconnecting: Facebook's Business Login dialog intermittently
  shows "Something went wrong" after asset selection on the fresh login config —
  retry, smaller asset batches, or incognito; grants merge across passes.

## Fixed — persona deletion blocked by audit trigger (2026-07-31)

- Deleting a persona failed with `agent_actions_binding_id_fkey` violations. The
  cascade (persona → agent binding → destinations) fired the destination audit
  trigger, which inserted an audit row referencing the binding and persona already
  deleted earlier in the same cascade. Migration `022-fix-persona-delete-audit.sql`
  makes the audit inserts reference those rows only if they still exist (NULL
  otherwise, with the persona id preserved inside the action detail). Standalone
  destination deletes keep exactly the audit context they had before.
- Run `sql-updates/022-fix-persona-delete-audit.sql` in the Supabase SQL Editor;
  no app or function deploy is required.

## Fixed — connector capability checks now retry and report unreachable honestly (2026-07-31)

- Capability checks for X, Meta, and Reddit retry transient failures with backoff
  (roughly 0.6s, 1.6s, 3.2s across four attempts). Network drops and gateway
  408/425/429/5xx are treated as transient; a definitive answer — including a clean
  "not configured" or an auth/origin rejection — is accepted on the first attempt and
  never retried.
- A capability that never answered is now tracked as `unreachable` and reported as
  "connector unreachable right now — this does not mean your credentials are missing,"
  instead of the previous claim that developer credentials were absent.

## Fixed — X connector check crashed on ledgerId:null (2026-07-31)

- True root cause of every "Failed to fetch" on the X capability check, found by
  deterministic A/B (3/3 fail with the field, 9/9 pass without): the client sent
  `{action:"capabilities", ledgerId:null}`, and in the Edge Function the handler
  signature `capabilities(req, origin, ledgerIdInput = "")` never applied its
  default — JS defaults apply to undefined, not null — so `null.trim()` threw and
  killed the worker before any response was written. Browsers surface that dropped
  connection as a bare "Failed to fetch". The check had never succeeded; earlier
  masking made it look intermittent, and prior cold-start/platform theories in this
  log were wrong.
- Client fix: twitterOAuthAction, gmailOAuthAction, and redditOAuthAction now omit
  `ledgerId` entirely when absent (the pattern metaOAuthAction already used — which
  is why Meta checks never failed).
- Server hardening (twitter-oauth): the dispatch layer rejects non-object bodies and
  coerces any non-string `ledgerId` to "" before reaching the five action handlers,
  so a raw null can never crash the worker again. Client fix alone unblocks the flow;
  the function redeploy applies the defense-in-depth.
- Verified live end-to-end with the patched call: capability returns
  `configured:true` and the account rows show **Connect X** enabled.

## Fixed — connector capability checks aborted by token refresh (2026-07-31)

- The X and Meta capability loads ran behind an auth-generation guard. When Supabase
  auto-refreshed the access token mid-load the generation bumped and the check aborted
  silently, leaving `loaded:false` — which the Accounts panel reported as "X still needs
  its developer Web App credentials," even with correct credentials installed and the
  connector answering `configured:true`. The message was wrong, not the setup.
- Owner-pressed checks ("Check X connector" / "Check Meta connector") and opening the
  Accounts tab now force a fresh capability fetch that ignores the generation guard;
  background loads keep the guard so stale state can never overwrite fresher state.
  A failed check now surfaces the real error instead of a generic credentials message.
- Note for setup: Edge Function secret names are case-sensitive. `X_Client_ID` is not
  `X_CLIENT_ID`, and a mismatch presents exactly as "credentials missing."

## Released — X API cost guard and no-backlink rule (2026-07-31)

- X moved every new developer to pay-per-use credits on 2026-02-06 (Basic/Pro are
  grandfathered-only), and a post whose text carries a URL costs about $0.20 against
  about $0.015 for a link-free post — roughly 13x. The Queue now shows a per-draft
  cost badge, warns before approving a link-carrying X draft, and the Targets tab
  shows month-to-date estimated spend plus a monthly projection from active
  schedules. All estimates are client-side against a local rate table; the X
  Developer Console remains the billing source of truth.
- Product rule: automated posts never advertise the persona's own AliaSpaces page.
  `run-tasks` now forbids any mypersonas.online/aliaspaces URL in generated drafts and
  treats links as the exception — only the owner's explicitly approved links may
  appear, and only when the task calls for one.

## Released — Reddit connector: OAuth + posting (2026-07-30)

- Built the full official Reddit connector. Migration `021-reddit-oauth.sql` adds
  single-use hashed OAuth state records and service-role-only Vault RPCs for token
  storage, read, rotation, and revocation — no token or authorization code ever
  reaches a browser (the GET callback completes the exchange server-side).
- `reddit-oauth` (deploy `--no-verify-jwt`): capabilities/start/disconnect actions,
  identity+submit+read scopes with `duration=permanent`, exact recorded-username
  binding before storage, and best-effort provider revocation on disconnect.
- `reddit-post` (default JWT): same guard order as discord-post — pause, approved
  non-terminal owned draft, share-aware persona check, connected state with submit
  scope, atomic lease — then posts via `/api/submit` with one automatic token
  refresh. Destination: `r/<name>` from the draft's tags, else the account's own
  profile (`u_<username>`). Link post when media-only, self post otherwise; Reddit
  API errors land verbatim in `publish_error`.
- Accounts → Reddit gains Connect/Disconnect with live connector-capability
  guidance; the Queue gains **Post to Reddit now** on eligible drafts.
- Owner setup: create the web app at reddit.com/prefs/apps with the exact callback,
  install `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`, run migration 021, deploy
  both functions.

## Released — Shared account managers (2026-07-30)

- Multiple personas can now manage the same account. Migration
  `020-shared-account-managers.sql` adds owner-only `account_persona_links` co-manager
  rows; `account_ledger.persona_id` stays the primary manager so every existing flow
  keeps working. The persona editor's Managed accounts checkboxes become share-aware:
  checking an account another persona holds **adds** this persona as co-manager
  (no more stealing), unchecking removes only this persona, and each row lists its
  other managers. Targets, draft destinations, Manage staging, and the discord-post
  publisher all accept co-managed accounts.
- Until migration 020 is run, the editor falls back to the previous move semantics.
  Keep a primary persona set for the provider Manage workspace, and note that
  server-side scheduled generation (`run-tasks`) still validates the primary
  assignment — schedule through the primary persona until its share-join ships.

## Released — Discord webhook posting + connector build orders (2026-07-30)

- Added the first external **posting** connector: Discord channel webhooks. Migration
  `019-discord-webhook.sql` stores an owner-pasted webhook URL only in Supabase Vault
  through owner-authenticated RPCs (never readable back), and the new `discord-post`
  Edge Function publishes exactly one approved, non-terminal draft per owner press —
  after checking the global pause, draft/account/persona ownership and assignment,
  connection state, and an atomic publishing lease. Mentions are suppressed
  (`allowed_mentions: none`), content is capped at Discord's 2,000 characters, and
  failures record a human-readable `publish_error` with no false "posted" state.
- Accounts → Discord now offers Connect/Replace/Disconnect channel webhook, and the
  Queue shows **Post to Discord now** on approved external drafts bound to a
  webhook-connected Discord account. User-account automation remains unsupported;
  scheduled/L3 Discord posting is intentionally excluded from this release.
- Added `CONNECTOR-BUILD-ORDERS.md`: the honest platform-by-platform physics table
  (what can authenticate, what can auto-post, what never will — OnlyFans, personal
  Snapchat, Twitch feed) plus implementation orders for X write, Facebook Page,
  Instagram professional, Reddit, YouTube, and Patreon identity.

## Released — Persona website field (2026-07-30)

- Added a dedicated **Website** field to the persona editor (under Tagline). It stores
  through the existing atomic links pipeline as the first `website` link — no database
  migration — auto-prefixes `https://`, and shows as a prominent 🌐 chip at the top of
  the persona's public page header. Extra Website/Store chips in the links list are
  untouched; the first one is treated as the persona's own site.

## Released — Persona Timeline tab (2026-07-30)

- Added a **Timeline** tab to the persona agent studio: an owner-private, newest-first
  merge of the persona's native AliaSpaces posts and every external draft recorded as
  posted, each entry showing destination account, format, time, native/external badge,
  tags, media handoff link, and an open-account link. External entries reflect what
  MyPersonas recorded; imports of full provider history arrive with the read connectors.
- Nothing new is shown publicly — the opt-in public page module is a separate roadmap
  item requiring a public-readable posted-history table.

## Released — Persona editor account picker (2026-07-30)

- Added a **Managed accounts** section to the persona editor: every saved Account
  Ledger record is listed by provider with its live connection-state pill; checking a
  box assigns the account to the persona being edited, unchecking releases it back to
  Unassigned, and an account currently assigned to another persona says so before a
  move. Assignments apply atomically with the Save button (including right after a
  brand-new persona is created) and remain private — nothing appears on the public page.
- No new credentials, scopes, or provider access are involved; this writes the same
  `account_ledger.persona_id` field the Accounts tab already manages.

## Released — Provider management and Meta Page pairing (2026-07-29)

- Added a provider-level **Manage** workspace to every saved account. Eligible
  non-mailbox accounts with assigned personas can stage posts, media handoffs, planned
  times, and owner-reviewed reply drafts without claiming an external post or message was
  sent; mailbox records route to the separate Inbox Concierge instead.
- Added a safe manual handoff for OnlyFans and other record-only platforms: prepare and
  review in MyPersonas, copy the package, open the official account, complete the action
  yourself, then mark the exact draft manually posted. No password, cookie, scraping, or
  reverse-engineered session path was added.
- Added public provider setup, Privacy, Terms, and Data Deletion pages and included them
  in the GitHub Pages artifact and sitemap so provider-review teams and owners can reach
  the same current capability boundaries.
- Added migration 018 and a dedicated `meta-oauth` foundation for Facebook Pages and
  Page-linked professional Instagram accounts. It discovers provider-owned asset IDs,
  binds only owner-selected ledger records, stores user/Page tokens in Supabase Vault,
  serializes token operations, and revokes the full shared grant on disconnect.
- Kept Meta publishing disabled. The first release requests Page/linked-Instagram
  discovery permissions only; write permissions, Meta review, a posting adapter, and
  live tests remain separate gates. Facebook personal profiles and consumer Instagram
  accounts are not presented as automatable destinations.
- Corrected the public canonical/social URLs to `mypersonas.online`, renamed Facebook
  inventory to **Facebook Page**, and made draft handoffs include tags and media links.

## Released — Full-history Inbox Concierge reports (2026-07-29)

- Removed the misleading same-address inventory check from unsupported mailbox panels.
  Outlook/Hotmail now says plainly that no Microsoft OAuth grant exists, Gmail explains
  Google's Testing/test-user 403 gate, and X distinguishes missing production client
  credentials from the separate API-credit check.
- Added an explicit full-history settings shortcut that selects a 100-year Gmail
  lookback and a bounded 15,000-message report ceiling. Selecting it does not save,
  queue a scan, approve cleanup, or change an email.
- Kept the one-minute worker at conservative 40-message resumable pages: a maximum
  scan needs about 6.25 hours of successful polling before retries while each function
  invocation retains the existing 80-second safety budget.
- A scan that reaches its message ceiling while Gmail has more matching mail now records
  that partial result in a persistent latest-scan banner, the Activity timeline, and the
  audit event instead of looking like a complete history scan.
- Scan cursors now have a bounded seven-day lifetime refreshed after every successful
  page. Any finding/checkpoint/progress persistence failure stops the scan incomplete
  without advancing silently; saved-versus-processed counts and the error remain visible.
- Runnable scans now rotate by the time they last received service, so one large mailbox
  cannot monopolize the worker while other connected inboxes wait for their first page.
- Every morning-report finding now displays its rules-derived suggested next step.
  Suggestions remain review material only; labeling, archive, Trash, dismissal, and
  unsubscribe handoff still require explicit owner selection or approval.
- Added migration 017 as an additive bounds change. Applied migration 016 remains
  unchanged.

## Released — Inbox Concierge (2026-07-24)

- Added a separate, owner-only mailbox control plane for Gmail reports and approved
  cleanup. Mailbox permissions do not inherit a persona's social-posting autonomy level;
  the existing global pause and a per-mailbox pause stop mailbox jobs.
- Added resumable manual and daily/weekly report-only scans across Gmail's regular mail
  and labels, with an explicit option to inventory Spam and Trash. Sent, Draft, Spam,
  Trash, unread, starred, important, attachment-bearing, security, account, receipt,
  financial/legal/medical, travel/order, personal, and unknown mail remain protected from
  bulk Trash actions.
- Added rules-first classification for subscriptions, possible account-creation evidence,
  receipts, security mail, orders/travel, financial/legal/medical mail, personal mail, and
  review items. Optional AI assistance is per-mailbox opt-in and sends only the bounded
  sender, subject, and short Gmail preview snippet to an explicitly selected hosted model;
  full bodies and attachments are not sent, messages remain untrusted data, and the model
  has no mailbox tools or credentials.
- Added exact, expiring action plans for label, label-and-archive, and recoverable Trash
  operations. The worker rechecks the owner, mailbox, Gmail permission, current message
  labels, protected-mail rules, and approval hash before changing anything. Prior labels
  are retained for a bounded Undo path; permanent deletion, sending, replies, attachment
  access, mark-read, spam/block, filters, forwarding, and account-security changes are not
  implemented.
- Added subscription-site grouping and explicit unsubscribe offers. The service never
  fetches an unsubscribe destination: a requested HTTPS page opens in the owner's browser,
  while a `mailto:` target opens the owner's mail app. Historical cleanup is always a
  separate approval.
- Upgraded new Gmail authorization and existing read-only connections through explicit
  re-consent to `gmail.modify`, the least Gmail scope that supports labels, archive, and
  Trash without immediate permanent deletion. Refresh tokens remain encrypted in Supabase
  Vault and never reach the page, classifier, or logs.
- Added truthful capability guidance for Outlook, Yahoo, iCloud, and Proton. Outlook
  requires a future Microsoft Graph app; Yahoo and iCloud require a dedicated encrypted
  IMAP/app-password worker; Proton requires a trusted local companion connected to Proton
  Mail Bridge. Unsupported providers expose no scan or mutation controls.

## Released — Grouped account connections and X OAuth foundation (2026-07-23)

- Replaced the flat saved-account stack with provider-level expandable sections. Only
  providers the owner has recorded are shown; a provider with multiple accounts gets an
  account selector while every edit, persona assignment, connection, and delete action
  remains scoped to the selected ledger record.
- Renamed the former ownership status to **Sign-in email matched · not connected**. That
  optional mailbox comparison no longer appears as provider authentication, and social
  accounts such as X do not offer it.
- Added provider-specific connection guidance so unsupported, business-only,
  professional-only, bot-based, local-bridge, and developer-review integrations are not
  presented as ordinary sign-in buttons.
- Added migration 015 and the dedicated `twitter-oauth` Edge Function for X OAuth 2.0
  Authorization Code with PKCE. The flow is bound to the owner, selected ledger record,
  initiating browser tab, exact X username, and immutable X subject; access and refresh
  tokens are stored only in Supabase Vault.
- X authorization requests only `tweet.read`, `users.read`, and `offline.access`,
  validates the complete returned scope set, supports refresh and
  revocation, and refuses account deletion until stored provider access is revoked.
- Token-exchange and refresh outcomes that may have minted or rotated an untracked grant
  now fail closed into an explicit X Connected Apps revocation/reset flow. Credential-less
  connected or post-grant error states cannot claim successful revocation, and erasure
  requires provider-specific acknowledgments so OpenRouter consent cannot satisfy X.
- Kept automated X publishing disabled and did not request `tweet.write`. Neither the
  browser nor the OAuth function contains a posting endpoint; the future external
  publisher must add claim/finalize safety, pass live provider tests, and obtain explicit
  write reauthorization.
- Added global no-referrer handling before third-party scripts so short-lived OAuth
  callback codes are not exposed through outbound request referrers.
- Made token exchange, refresh, revocation, disconnect, and erasure fail closed when X
  returns an ambiguous result or local credential state is inconsistent. Connected or
  unresolved X identities cannot be renamed or deleted until they are safely
  disconnected or explicitly revoked in X Connected Apps.
- Made provider-side erasure confirmations provider-specific, so acknowledging an
  OpenRouter key revocation can never count as acknowledging an X app revocation.

## Released — Yahoo and iCloud account records (2026-07-23)

- Added Yahoo Mail and iCloud Mail to the private account ledger and saved-account
  picker. Like Outlook and Proton Mail, they can be recorded, assigned to a persona,
  edited, and optionally sign-in-email-matched when their confirmed address matches the
  AliaSpaces sign-in, but do not yet grant mailbox API access or external publishing
  permission.

## Released — Agent control center (2026-07-20)

- Added migration 011 for Vault-backed model credentials, owner automation settings,
  persona-agent bindings, L0–L3 autonomy, content direction, native/external targets,
  exact schedules, worker leases, atomic usage quotas, approval/publish state,
  synchronized owner chat, append-only audit history, and a fan-chat inbox.
- Added the dedicated migration 012 without rewriting the already-live 011 history. It
  adds bounded transient retries, fair publish due-times, durable chat ids, owner-safe
  model readiness, consent/target approval invalidation, narrower persona/fan reads, and
  repair of approvals that no longer have valid L3 native-auto consent.
- Added migration 013 for least-recently-served owner rotation in scheduled generation,
  service-only fair claims, a grandfather-safe 100-active-schedule cap, bounded prompt
  inputs, and deterministic pausing instead of repeatedly billing oversized tasks.
- Added migration 014 and an authenticated transactional save RPC so a persona, its
  public links, and its private note either all save or all remain unchanged.
- Added a mobile-first control center with Direction, Targets, Schedule, Queue, Fan inbox,
  and Audit views. Owners can set goals, success measures, audiences, content pillars,
  campaigns, calls to action, approved offers/links, affiliate disclosures, source notes,
  platform rules, time zones, quiet hours, daily caps, and global/persona pauses.
- Reworked scheduled tasks around exact `next_run_at` and `next_publish_at` times. Each
  provider call requires a random UUID task lease plus an atomic per-owner, local-day
  model-call reservation. This prevents overlapping workers from duplicating calls or
  racing the daily cap; generated content is never self-approved.
- Kept cron credentials out of stored job commands: both cron invocations retrieve
  `mypersonas_cron_secret` from Supabase Vault at execution, and the workers compare it
  with the same value stored as their Edge Function secret.
- Added exact-content approval. Approval stores a hash of the draft, target, and publish
  time; editing any protected field clears approval and removes the draft from the queue.
- Added `post-bridge` for signed-in, owner-initiated publishing and
  `run-publish-queue` for due native publishing. L2 exact approvals wait for the owner to
  press **Publish now**; L3 can publish only exact-approved drafts on an enabled native
  `auto` target when due. Publication atomically rechecks controls, inserts the post,
  finalizes the draft, and records audit history.
- Hardened `ai-proxy`: it rebuilds persona context from the database, discards
  browser-supplied system messages, validates the owner and linked model, observes pause
  and binding controls, audits persona calls, and resolves model keys server-side from
  Supabase Vault.
- Added owner-authenticated model CRUD RPCs. Migration 011 transfers non-empty legacy keys
  into Vault and clears the old column; browsers can create, edit, or delete their model
  connections without selecting Vault mappings or reading a saved key back. Edge code
  retains a legacy-key fallback only to support deploying it before the migration.
- Added optional `fan-chat` with an immutable AI disclosure and one atomic reservation for
  session identity, hourly/daily quota, fan-message storage, audit, and a UUID response
  lease. It is SFW-only until server-verifiable age assurance exists. Escalations flag the
  owner-review inbox but promise neither an owner response nor conversation takeover.
- Added deterministic post-generation fan-reply screening before the only write/return
  path. Unsafe or persona-rule-breaking model text is discarded, replaced with a bounded
  refusal, escalated to the owner inbox, and categorized in the existing audit event.
- Added separate optional `SCHEDULE_AI_HOSTS` and `FAN_CHAT_AI_HOSTS` allowlists so a
  custom scheduled-generation endpoint is not automatically trusted by public fan chat;
  Matrix now also requires a separate explicit confirmation for each surface.
- Added privacy-safe persona RPCs and removed owner UUIDs from public/general persona
  reads. Owners retain an owner-scoped roster RPC; export covers owner-visible control and
  conversation data, while deletion also clears internal agent-usage reservations.
- Kept all external publishing hard-gated. Account-ledger records, ownership verification,
  and read-only Gmail OAuth do not provide write access; no external social posting
  connector is implemented in this release.
- Added versioned, JWT-verified content erasure that keeps the sign-in account while
  deleting owned content and private profile customization. The client requires protocol
  v2/content-only capability proof, revokes Gmail first, and requires provider-side
  revocation acknowledgment for every OpenRouter key, including legacy connections.
- Hardened Gmail OAuth failure compensation for Google's project-shared grants. Failed
  callbacks never auto-revoke a grant that may power another connected mailbox; partial
  trustworthy identities are checked first, recoverable credentials receive an explicit
  **Revoke & reset** path, and shared-grant attempts receive local-only reset.
- Changed the Pages workflow to publish an explicit runtime allowlist instead of setup
  guides, migrations, verification notes, snapshots, or other repository internals.
- Added stable persona-feed pagination and filter-aware search pagination so automated
  posting cannot make posts older than the first page unreachable.
- Added keyset Load more paths for public persona discovery, recent/tag feeds, and persona
  feeds; added lazy full audit history; and bound manual draft times to the configured
  owner time zone instead of the phone's current location.
- Added auth-generation guards around private loads, editing, chat, Gmail, OpenRouter,
  export, and content erasure so a delayed result cannot cross account boundaries.
- Live backend rollout evidence is recorded in `VERIFICATION.md` only after migrations 012–014,
  the content-erasure capability probe, worker resume/probes, Pages deployment, and live
  browser smoke checks complete. Signed-in destructive scenarios still require a
  disposable test owner.

## Unreleased — Account Ledger batch mode

- Added a private Accounts tab beside Security with multi-row account entry.
- Each account can remain unassigned, attach to an existing persona, or quick-create
  a minimal private persona during the batch save.
- Added the owner-only `account_ledger` migration and included ledger data in account
  export and deletion. The ledger stores metadata only and has no credential fields.
- Fixed saved-account persona assignment so `+ Quick create persona` is available
  after recording an account, with a private persona created and assigned in place.
- Account rows now distinguish **Recorded**, **Sign-in email matched**, and **API
  connected** instead of implying that saving metadata authenticated the account.
- Added server-attested email ownership verification in migration 009. Browsers can
  read their connection state but cannot write it or self-assert authentication;
  credentials and OAuth tokens remain outside the public schema.
- Added a dedicated Gmail authorization action after ownership verification. The
  server-side OAuth flow uses short-lived, single-use state plus PKCE, requires the
  exact recorded mailbox, and requests read-only Gmail access.
- Bound OAuth completion to the same signed-in user, site origin, and browser tab that
  started it, and isolated Gmail authorization in a separate Google Cloud project so
  project-wide revocation cannot disturb ordinary AliaSpaces Google sign-in.
- Added migration 010 and the `gmail-oauth` Edge Function. Gmail refresh tokens are
  encrypted in Supabase Vault, available only to the service role, and removed when
  the connection is disconnected or its ledger record is deleted.
- Added explicit **Authenticate Gmail** / **Disconnect Gmail** controls and callback
  status handling. **Sign-in email matched** remains an AliaSpaces-address check; only a completed
  Google consent flow produces **API connected**.
- Added **Edit details** to recorded accounts so a missing login email, username,
  profile URL, or private note can be corrected before authentication.
- Added an iPhone-friendly, provider-filtered **Saved account** picker to batch rows.
  It autofills owner-only ledger metadata, updates the selected record instead of
  duplicating it, and adds mobile autofill labels and touch-sized controls. Passwords
  remain outside AliaSpaces and authenticated login emails stay locked while connected.

## v0b — Route render race guard (2026-07-10)

- Fixed VERIFICATION.md finding #7: navigating away while a route's data was
  still loading let the stale render resolve late and overwrite the new page
  (observed live: opening the edit form got replaced by the previous persona
  page once its fetch caught up). Added a render-epoch counter bumped by
  route() and by every direct render call (post publish/delete, age-gate
  continue); renderDiscover/renderPersonaPage/renderEdit now bail before
  their final DOM write if a newer render has since started.

## v0a — Verification fixes (2026-07-10)

- Fixed persona creation failing with an RLS error (sql-updates/004). Root cause:
  the create path inserts with RETURNING, and the returned row must pass the
  personas SELECT policy; persona_visible() (security definer, STABLE) re-queries
  the table and cannot see a row inserted in the same statement, so every CREATE
  was rejected (42501) while every EDIT succeeded — which made it look
  intermittent. The SELECT policy now checks owner and public/unlisted visibility
  inline on the row and keeps persona_visible() for the private-friends case
  only. Not a session-expiry issue; the earlier re-verification workaround is
  harmless but was chasing the wrong cause.
- Fixed duplicated startup loads: getSession() and the SIGNED_IN auth event each
  ran a full loadMine()+route(), so every Supabase query (and the discover
  render) fired twice on page load. Startup now loads once via INITIAL_SESSION,
  and same-user SIGNED_IN re-fires (e.g. tab refocus) are ignored — which also
  protects in-progress forms from being wiped.
- Verification round progress in VERIFICATION.md (15/34; findings logged there,
  incl. missing assets/Extensions/Concept/releases.json fallback).

## v0a — Account, ecosystem, personality & multi-system astrology (2026-07-10)

- Full private Account area in Matrix: account details (name, DOB, location, phone, time zone),
  sign-in & security (set password, change email, TOTP two-factor, sign out everywhere, export
  my data, delete my content), and Myers-Briggs with a free-test link.
- Castleborn ecosystem card: connect to Castleborn and trAInify (handle + connected flag; product
  URLs are placeholders pending confirmation; full SSO on the roadmap).
- Multi-system astrology, configurable per account: Western tropical (whole/equal houses), Vedic
  sidereal (Lahiri/Fagan/KP ayanamsa + nakshatra), 13-sign astronomical (IAU, incl. Ophiuchus),
  Chinese zodiac (year/month/hour animals + element), Mayan Tzolk’in, and lunar/moon-phase +
  tithi. Positions from astronomy-engine, validated against reference charts.

## v0 — Foundation (2026-07-08 → 2026-07-09)

### Network
- Personas with full profiles (purpose, voice, topics, audience, hard rules),
  public/unlisted/private visibility enforced by row-level security
- Persona pages: banner, background, avatar, feed header, profile song,
  live embed (Twitch/YouTube/Kick), Top 8, platform link chips (37 platforms),
  gallery + sponsored/affiliate albums that deep-link out, blog feed + reels,
  per-page search with type filters, section show/hide, theme color, share link
- Friend requests (pending → accepted), block & mute, discover filters
  (18+ hidden by default, topic mutes), NSFW age gate
- Anonymity: profiles never shown publicly; personas unlinked from owner and
  from each other

### AI layer
- Linked AI models (any OpenAI-compatible API), assignable per persona and per task
- HQ assistant with full roster context; per-persona chatbots in-voice
- Tasks: persona + model + job type, one-click Run in a docked chat
- Content drafts pipeline: save chat/task output as drafts, idea → ready → posted,
  copy-to-clipboard for manual posting on external platforms
- Quick-setup wizard (multi-select categories, merged voice/topics/platform
  suggestions) and AI builder interview with apply-to-profile extraction
- Stable Diffusion character panel (local A1111/Forge API), per-slot sizing,
  generate → preview → apply; Concept studio integration link

### Trust, safety, reliability
- Pixel-burned watermarks (page URL) on uploaded images; media interaction guards
- In-app error reporter (rolling buffer + error_logs table + floating button)
- Session-timeout countdown popup with one-click extend; stale-page banner
- Session re-verification before persona saves; token refresh no longer
  re-renders (protects in-progress forms)

### Design & platform
- Clean light theme (white cards, blue accent), welcome/onboarding flow,
  account settings card (auto-hides after first save)
- Custom hologram-blue SVG icon bank replacing all emojis; stylized favicon
- Release-driven extensions catalog (GitHub Releases API + extension.json,
  static releases.json fallback); Apps card with Personas desktop download
- Versioned repo layout (MyPersonas.Online_v0), Pages deploy via GitHub Actions,
  VERSIONING.md, ROADMAP.md
- Supabase schema: 11 tables + drafts + error_logs, RLS throughout, media storage
  with per-user folders

### Growth
- SEO baseline: meta description, Open Graph + Twitter cards, JSON-LD,
  canonical, robots.txt, sitemap.xml; per-page titles/descriptions set on
  route change (persona pages get name/tagline)
- Promote: one-click ad posts for any of your personas (3 generated variants,
  copy buttons) plus direct pre-filled share links to X, Facebook, Reddit,
  Telegram, WhatsApp, LinkedIn and email

### Known issues
- Persona save intermittently reported an RLS error (session-expiry suspected;
  re-verification added — under verification via error_logs)
- GitHub API rate limits can briefly blank the extensions card (fallback exists)
