# Handoff — MyPersonas / AliaSpaces (for ChatGPT)

_Written 2026-08-13; release truth refreshed 2026-08-24. This hands the project to ChatGPT to continue. It explains how the
project works, what's already built, the exact contracts you'll need, and a prioritized
task list. Agents may prepare code, SQL, tests, plans, and dashboard steps. The owner must confirm
production migrations/deployments, provider permissions, keys, MFA, publishing, and money actions
at the exact action boundary._

Current release truth: **the last signed-in production verification covered frontend-only hotfix `c46b1b6` with the
migration ledger read back through 061. The current owner completed TOTP and reached
the signed-in owner Studio. Pages run `32647147304` deployed only `index.html` plus
its source test; signed-in 390px QA verified a 375px document/body/main with one 351px
persona column and no horizontal overflow. No migration, Function, provider, payment,
publication, or gateway change accompanied that hotfix.** The 062-064 opaque-media and
cleanup-preview foundation is a committed local release candidate (`ad68319`), not
live. Migration 065's declaration/import/rewrite second slice remains local and is
explicitly rejected for deployment despite green local tests: ordinary persona deletion,
durable destination identity, affiliate review invalidation, same-product concurrency,
audit authority, declaration correction, producer cutover, and hosted Storage compatibility
remain unsafe or unproven. Migrations 066 custom
persona fields and 067 project-resource editing are locally green but cannot bypass
the earlier timestamped migration sequence. Nothing in 062-067 has been applied,
deployed, configured, activated, or verified live. Preservation branches have been
pushed to GitHub, but no migration-bearing branch has been merged to `main`.
Repository topology after the pre-split rescue: `origin/main` is `569f002`; unique
opaque-media, monetization/security, source-library, and rescue work is preserved on
named remote branches. Migration 065 is explicitly quarantined. Migrations 066-067 are
designated for AliaSpaces. Read the root `REPOSITORY-BOUNDARIES.md` and
`REPOSITORY-SPLIT-MANIFEST.md` before reconciling or deploying anything.
Start with `RELEASE-MANIFEST-2026-08-22.md`, then this handoff. Historical live claims
below are useful evidence snapshots but may have drifted and do not prove the current source.

---

## 0. Collaboration and authority

- Agents can inspect, implement, test, prepare release artifacts, and navigate approved dashboards.
- The owner handles passwords, OTP/TOTP/recovery material, cookies, master/service credentials,
  payment authentication, and any action-time confirmation the interface requires.
- Do not push, deploy, apply production SQL, issue/revoke keys, grant OAuth/cloud permissions,
  publish, send external messages, or change money/billing merely because a roadmap asks for it.
  State the exact destination, scope, spend, and rollback, then obtain owner confirmation.
- Keep one writer per file/branch/worktree. Separate `local`, `pushed`, `deployed`, and `verified
  live` evidence in every handoff.

## 1. How the project ships

- **Repo layout**
  - Frontend (the whole app): `MyPersonas.Online_v0/index.html` — ONE ~5,100-line file,
    hash-routed (`#/studio`, `#/p/<handle>`, …), inline CSS + JS. No build step.
  - Edge functions: `supabase/functions/<name>/index.ts` (Deno + `@supabase/supabase-js@2`).
    Shared code in `supabase/functions/_shared/`.
  - Migrations: `MyPersonas.Online_v0/sql-updates/NNN-name.sql`, numeric order.
  - Config: `supabase/config.toml` (`[functions.<name>] verify_jwt = true|false`).
  - Docs: `MyPersonas.Online_v0/*.md` (start with ROADMAP-EXECUTION-2026-08-13,
    POST-QUEUE-ACTIVATION, POSTING-3PART-SPEC, DRIFT, CONNECTORS-STATUS,
    CONTEXT-BOX-SPEC, MOBILE-BLUEPRINT, then V2-BLUEPRINT/APP-REVIEW-META).
- **Deploy model**
  - The installed Supabase GitHub App auto-applies new timestamped migrations after a push to
    `main`, and it may do so before CI finishes. A migration-bearing commit must therefore be
    completely release-ready before push. Supabase Functions and Pages remain separate manual
    `workflow_dispatch` workflows with release-specific typed confirmations.
  - For opaque-media/remediation migrations 062-064, the required order is fully validated main push → production
    migration-ledger readback plus cleanup-preview and protected-gateway verification → foundation Functions (`MIGRATIONS-062-064-GATEWAY-VERIFIED`) → Pages
    (`OPAQUE-FOUNDATION-VERIFIED`) → signed-in live verification → producer Functions
    (`OPAQUE-FRONTEND-VERIFIED`). The manual workflows do not themselves apply migrations.
  - A missing `SUPABASE_ACCESS_TOKEN` makes the function workflow fail closed. Historical manual
    deployments may exist, but exact current source parity is not proven.
  - Production migration history was read back through **061** on 2026-08-23. Migrations **062-064**
    remain local-only until their complete release gate passes. Re-audit older dormant migrations
    and deployed-function drift against the current runbooks before activation.
  - Migration 065 has canonical and timestamped mirrors plus green local Node, Deno, and
    repeat-apply/runtime harnesses, but the independent review verdict is **REJECT for
    deployment**. Keep its readiness flags false. Required corrections/evidence include:
    ordinary persona deletion with imported media and sibling isolation; retained destination
    object identity plus missing/replaced-object detection; exactly-once affiliate review
    invalidation with accurate audit cardinality; a shared product lock and two-session race
    test; RPC-only append/audit authority; safe pre-import AI-use correction; a tested
    expand/contract sequence or explicit media-write maintenance window; full two-owner,
    CAS-zero-side-effect, tamper, lease/erasure/orphan, and Facebook/Instagram cleanup matrices;
    and hosted Supabase success/reject/cleanup proof plus explicit owner acceptance before any
    `storage.objects` trigger risk. The current producer and migration signatures are not
    zero-downtime compatible.
  - Migrations 066 and 067 have focused repeated-apply/runtime evidence locally. See
    `CUSTOM-PERSONA-FIELD-BOXES.md` and `PROJECT-RESOURCE-EDITOR.md`; their UI is absent
    from production build `c46b1b6`.
- **Project ref:** `nwsqyuucwzihruszocge`. Site: `https://mypersonas.online`.
- **⚠ Drift:** several deployed functions are NOT in the repo (see `DRIFT.md`): `twitter-post`,
  `daily-discovery`, `gemini-models`, `gemini-probe`, `image-probe`,
  `meta-ig-attach`, `meta-ig-discover`, `split-post`. Editing them requires pulling them first
  (`supabase functions download <name>` — human, CLI). **Never overwrite a drifted function
  blind.**

## 2. Current state (separate proven-live behavior from local replacements)

The **owner-triggered Meta slice** of the 3-part system was previously verified end-to-end:
- A persona authors once; the post is staged as 3 platform-tailored variants: **Facebook**
  landscape 1.91:1 + detailed caption, **Instagram** square 1:1 + optimal caption, **X**
  portrait 4:5 + ≤280 caption. See `POSTING-3PART-SPEC.md`.
- **Previously deployed/live-tested:** `ai-proxy` + `compose-post` staged a draft and `meta-post`
  published/deleted the Meta test. Migration `033`+`034` created the `post_drafts` foundation.
- **Current hardened replacements are local release-candidate source:** `meta-post`,
  `run-post-queue`, shared publishing, immutable approval, and the revised Composer. Some function
  names have historical live evidence, but exact deployed-source parity and the full signed-in
  contract are unverified. The scheduled cron remains dormant and X remains draft-only.
- Verified live: `compose-post` drafted persona-voice FB/IG/X captions + crops; `meta-post`
  published a real FB + IG pair (IG confirmed) and deleted the FB test. That demonstrates the
  tested owner-asset path; it is not evidence for every account, schedule, retry, or policy case.
  Meta App Review is not needed for the owner's own development-mode assets, but is required before
  posting for other users.

Other recent source work: `personas.pet_project` field + UI (★ chip by name/handle); conflict-safe
persona context + bounded AI prompt; resumable chat workspaces; Reddit OAuth/publishing UI and
server hardening; friend-request Realtime; release-history extension catalog; an installable PWA
shell; and fail-closed owner-media/Reddit erasure. Their individual live state differs; require the
release order and evidence checks in `ROADMAP-EXECUTION-2026-08-13.md` and
`SETUP-CONDUCTOR-HANDOFF.md` before claiming them live.

## 3. Reference contracts (use these exactly)

- **ai-proxy** (persona model, OpenAI-agnostic; returns normalized `{content}`):
  `POST /functions/v1/ai-proxy` with owner Bearer JWT, body
  `{ backendId, personaId, mode:"owner_chat", max_tokens, messages:[{role,content}] }`.
  `backendId` = `personas.ai_backend`. It rebuilds the persona system prompt server-side and
  ignores client system messages. No server-side history replay — you control `messages`.
- **compose-post** (`{action:"compose", personaId, brief, sourceImageUrl?, facebookLedgerId?,
  scheduledFor?, targets?, captions?}` → `{draft}`): generates the 3 captions via ai-proxy,
  builds 3 image-transform URLs, inserts a `post_drafts` row (`status:'draft'`). 422 if the
  persona has no `ai_backend` and no `captions` supplied.
- **meta-post**: `{action:"publish-draft", draftId}` atomically claims one owner-scoped editable
  draft, publishes its selected Meta targets, checkpoints each provider ID, and returns
  `{status, facebook?:{postId}, instagram?:{mediaId}, errors?}`. Direct client-supplied image/
  caption publishing is retired. `{action:"delete", facebookLedgerId, postId}` →
  `{deleted:true}` (FB only — the IG API can't delete media). Owner Bearer JWT.
- **Image crops = Supabase image transforms** (Pro plan, no crop code): take a public Storage
  object URL `…/storage/v1/object/public/<bucket>/<path>`, replace `/object/public/` with
  `/render/image/public/`, append `?width=W&height=H&resize=cover&quality=82`. FB 1200×628,
  IG 1080×1080, X 1080×1350. New persona images live in the public, owner-namespaced
  **`persona-media`** bucket; videos retain the legacy `media` path.
- **approve-post-draft** (owner JWT): accepts `{draftId,scheduledFor,timezone,fbCaption,
  igCaption,xCaption,targets}`, stages exact image bytes into `post-approved-media`, verifies
  SHA-256/MIME/size/path/URL, then invokes the internal service-role scheduling RPC. The browser
  must never call `approve_and_schedule_post_draft` directly.
- **run-post-queue** (cron, `--no-verify-jwt`, header `X-Cron-Secret: <CRON_SECRET>`): atomically
  claims one due `scheduled` draft, re-verifies approval, immutable media, pause/policy, and exact
  attempt destinations, checkpoints provider IDs, and transactionally finalizes state + audit.
  **X is deferred.** Schedule via `sql-updates/036-schedule-post-queue.sql`; keep it dormant until
  every blocker and pilot in `POST-QUEUE-ACTIVATION.md` is closed.
- **Key tables**
  - `post_drafts`: `id, owner, persona_id, facebook_ledger_id, week_start, status
    (draft|approved|scheduled|publishing|posted|failed|skipped), scheduled_for, brief,
    source_image_url, fb/ig/x_caption, fb/ig/x_image_url, targets[], fb_post_id, ig_media_id,
    x_tweet_id, last_error, approved_at, approved_by, approved_content_hash, approved_timezone,
    approved_facebook_page_id, approved_instagram_business_id, publish_claimed_at, posted_at`.
    Immutable-media fields are `approved_fb_media_*` / `approved_ig_media_*` for SHA-256, MIME,
    byte size, owner path, and canonical URL; every selected target must have a complete set.
    Attempt/reconciliation fields also include `publish_facebook_page_id,
    publish_instagram_business_id, fb_published_at, ig_published_at`.
    Owners retain RLS reads; mutations use guarded RPCs or owner-scoped server functions.
  - `personas`: `id, owner, ai_backend, pet_project, context_log, handle, name, feed_img_url,
    banner_url, …`. Owner-writable RLS. Bundle save via RPC `save_persona_bundle`; fields not
    in the bundle (title/focus/pet_project) are written by a follow-up owner-scoped update on
    the resolved persona id.
  - `meta_page_connections`: `owner, grant_id, facebook_ledger_id, facebook_page_id,
    facebook_page_name, instagram_ledger_id, instagram_business_id, …`.
  - `meta_grants`: `id, owner, meta_user_id, granted_scopes[]`. Durable token via RPC
    `meta_get_grant_token_bundle({p_grant_id,p_owner})` → `[{token_bundle:{access_token}}]`.
  - `account_ledger` (owner, provider, login_email, username), `account_connections`
    (ledger_id, provider, connection_state, granted_scopes, error_code).
- **Meta app:** App ID `2042281049742621`; Login-for-Business config
  `28345689651788755` (already carries all publish scopes). Redirect URI:
  `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/meta-oauth`.

## 4. Security patterns to KEEP (every new function/UI must follow)

- Owner-scope everything: service-role client + explicit `.eq("owner", user.id)`, or the
  frontend authed client relying on RLS. Never trust a client-supplied owner.
- Verify the caller JWT (`admin.auth.getUser(bearer)`); functions read from the browser use
  `verify_jwt = true`, cron/OAuth-callback functions use `false` + their own check.
- No secrets in source. Read via `Deno.env.get`. Never return tokens to the browser.
- Validate ids against `^[A-Za-z0-9_-]{1,64}$` before using them in a PostgREST `.or()` filter.
- Meta's restricted-goods block is keyed to the durable production UUIDs for the three cannabis
  personas: Chomes, Sherlock (the CannaCandidz brand), and Sherlock Chomes. Do not infer policy
  from mutable names. Traditional Family Values / Kunuk is not cannabis and must not be blocked
  merely because an older handoff grouped that destination with the two blocked Meta pairings.

## 5. Tasks you can pick up (prioritized)

Each item says: **goal · files · approach · blocker (if any) · deliverable.**

1. **Release the coordinated safe slice.** Review the diff, deploy functions first where noted,
   apply migration 035 in its maintenance window, deploy Pages, and live-verify context/workspaces,
   PWA install/offline, Composer approval, Reddit OAuth/disconnect, erasure, extension fallbacks,
   and friend Realtime. Follow `ROADMAP-EXECUTION-2026-08-13.md`; never treat a local test as live.
2. **Keep scheduled external publishing dormant.** Do not apply 036. Close reconciliation,
   atomic per-IG quota, production UUID mapping, legacy destination attribution, queue integration
   tests, and the L2-vs-L3 contract; then run the manual dormant-worker pilot before cron.
3. **Pull and normalize the eight drifted functions.** Start with `twitter-post`, scrub and rotate
   inline secrets, then explicitly reauthorize X with write/media scopes. This is the prerequisite
   for adding X to the exact-approved publisher; never infer write authority from read OAuth.
4. **Finish the owner-storage migration.** Inventory legacy repo/persona URLs, copy to owned
   Storage, reload every page, and remove repo art only after exact verification. The new paths and
   fail-closed erasure are already local.
5. **Choose the sourced-feed MVP contract.** Owner selects allowed sources/topics and citation/
   freshness rules before implementation. Build read-first research cards with evidence and
   feedback, not an unsourced infinite-scroll generator.
6. **Meta App Review** is only needed to post for other users/go public. Use
   `APP-REVIEW-META.md` when that becomes a launch goal.

## 6. How to test and release what you build

- Local validation and disposable database testing may proceed without production authority.
  Production requires the manifest's owner-approved database apply/readback, then a manual
  Functions dispatch, then a manual Pages dispatch. A push alone deploys nothing.
- Function smoke test from the browser console on `mypersonas.online` (already signed in):
  `fetch(CONFIG.SUPABASE_URL+'/functions/v1/<fn>', {method:'POST', headers:{'Content-Type':
  'application/json','Authorization':'Bearer '+(await sb.auth.getSession()).data.session.
  access_token}, body: JSON.stringify({...})}).then(r=>r.json())`.
- Posting tests: use a low-stakes page (e.g., "Jokes from Dads") and delete after
  (`meta-post` `{action:"delete"}` for FB; Instagram deletes are manual in-app).

_When in doubt, read `POSTING-3PART-SPEC.md` and `CHANGELOG.md` (top entries) — they mirror this._
