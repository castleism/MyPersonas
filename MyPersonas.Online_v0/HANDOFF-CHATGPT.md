# Handoff — MyPersonas / AliaSpaces (for ChatGPT)

_Written 2026-08-13. This hands the project to ChatGPT to continue. It explains how the
project works, what's already built, the exact contracts you'll need, and a prioritized
task list. **You (ChatGPT) produce code / SQL / plans; the human applies them** (see
constraints below)._

---

## 0. What you can and can't do here

- **You CAN:** write edge-function TypeScript, SQL migrations, and single-file frontend
  JS/HTML; design features; review; draft App-Review / launch materials.
- **You CAN'T (the human does these):** `git push` (deploys), apply SQL migrations, run the
  Supabase CLI (`supabase functions download`), drive the browser, or touch Supabase directly.
  So: **deliver a diff/file + the exact apply steps.** Don't assume you can run anything.

## 1. How the project ships

- **Repo layout**
  - Frontend (the whole app): `MyPersonas.Online_v0/index.html` — ONE ~4,900-line file,
    hash-routed (`#/studio`, `#/p/<handle>`, …), inline CSS + JS. No build step.
  - Edge functions: `supabase/functions/<name>/index.ts` (Deno + `@supabase/supabase-js@2`).
    Shared code in `supabase/functions/_shared/`.
  - Migrations: `MyPersonas.Online_v0/sql-updates/NNN-name.sql`, numeric order.
  - Config: `supabase/config.toml` (`[functions.<name>] verify_jwt = true|false`).
  - Docs: `MyPersonas.Online_v0/*.md` (read POSTING-3PART-SPEC, DRIFT, CONNECTORS-STATUS,
    APP-REVIEW-META, CONTEXT-BOX-SPEC, MOBILE-BLUEPRINT, V2-BLUEPRINT).
- **Deploy model**
  - Functions: **push to `main`** → GitHub Action `.github/workflows/supabase-deploy.yml`
    runs `supabase functions deploy` (ALL functions). `verify_jwt` comes from `config.toml`.
  - Frontend: pushed → GitHub Pages (`.github/workflows/pages.yml`).
  - **Migrations do NOT auto-apply.** The human runs each `sql-updates/*.sql` by hand in the
    Supabase SQL editor. Latest applied: **034**. `035` (exact approval hardening) and `036`
    (opt-in cron) are intentionally NOT applied yet.
- **Project ref:** `nwsqyuucwzihruszocge`. Site: `https://mypersonas.online`.
- **⚠ Drift:** several deployed functions are NOT in the repo (see `DRIFT.md`): `twitter-post`,
  `reddit-oauth`, `daily-discovery`, `gemini-models`, `gemini-probe`, `image-probe`,
  `meta-ig-attach`, `meta-ig-discover`. Editing them requires pulling them first
  (`supabase functions download <name>` — human, CLI). **Never overwrite a drifted function
  blind.**

## 2. Current state (what's built + PROVEN LIVE)

The **3-part posting system** is complete and verified end-to-end:
- A persona authors once; the post is staged as 3 platform-tailored variants: **Facebook**
  landscape 1.91:1 + detailed caption, **Instagram** square 1:1 + optimal caption, **X**
  portrait 4:5 + ≤280 caption. See `POSTING-3PART-SPEC.md`.
- **Deployed + working:** `ai-proxy` (persona model), `compose-post` (stages a draft),
  `meta-post` (publish + delete FB/IG), `run-post-queue` (scheduled cron, dormant),
  `_shared/meta-publish.ts` (shared publish primitives). Migration `033`+`034` applied
  (`post_drafts` table). Frontend **Composer UI** (Menu → "Compose posts (3-part)").
- Verified live: `compose-post` drafted persona-voice FB/IG/X captions + crops; `meta-post`
  published a real FB + IG pair (IG confirmed) and deleted the FB test. All own-account
  posting works in **development mode with standard access — no Meta App Review needed** for
  the owner's own pages/IG (App Review is only for posting on behalf of other people).

Other recent: `personas.pet_project` field + UI (★ chip by name/handle); `personas.context_log`
column (migration 030) — spec'd but UI not wired; responsive safe-area + tablet tier; app icon
in `brand/app-icon/`.

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
  IG 1080×1080, X 1080×1350. (Persona images live in the **`media`** bucket, public.)
- **run-post-queue** (cron, `--no-verify-jwt`, header `X-Cron-Secret: <CRON_SECRET>`): atomically
  claims due `scheduled` drafts (`scheduled`→`publishing`, preventing overlapping claims), publishes each
  platform's own `*_image_url`/`*_caption`, writes `fb_post_id`/`ig_media_id`/status. **X is a
  TODO** (deferred). Schedule via `sql-updates/036-schedule-post-queue.sql` (pg_cron+pg_net +
  Vault secret `mypersonas_cron_secret`) — apply only when ready.
- **Key tables**
  - `post_drafts`: `id, owner, persona_id, facebook_ledger_id, week_start, status
    (draft|approved|scheduled|publishing|posted|failed|skipped), scheduled_for, brief,
    source_image_url, fb/ig/x_caption, fb/ig/x_image_url, targets[], fb_post_id, ig_media_id,
    x_tweet_id, last_error, approved_at, approved_by, approved_content_hash, approved_timezone,
    approved_facebook_page_id, approved_instagram_business_id, publish_claimed_at, posted_at`.
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
- Cannabis personas (CannaCandidz, Sherlock Chomes, Trad Family Values) can't post/monetize via
  Meta — content policy. Don't wire them to Meta publishing.

## 5. Tasks you can pick up (prioritized)

Each item says: **goal · files · approach · blocker (if any) · deliverable.**

1. **Wire X into the 3-part publisher.**
   Goal: post `x_image_url` + `x_caption` to X. Files: `supabase/functions/run-post-queue/
   index.ts` (add an X branch), `MyPersonas.Online_v0/index.html` (`composerPublish` X call),
   plus `twitter-post`. **Blocker:** `twitter-post` is drifted — the human must
   `supabase functions download twitter-post` first so you can see its request contract.
   Deliverable: the X branch + the pulled/normalized `twitter-post`, given its contract.

2. **Weekly approval-day scheduling** — **code complete locally; deploy/migrations pending; cron
   activation blocked.** The Composer groups by week and calls guarded save/schedule/unschedule/
   delete RPCs instead of raw status writes; immediate Meta publishing is now a server-side atomic
   draft claim. Deploy the matching source and apply migration `035` as one maintenance step. Keep
   migration `036` unapplied until every blocker and pilot step in `POST-QUEUE-ACTIVATION.md` is
   complete. X remains draft-only; Meta scheduling requires an owned paired destination and image.

3. **Composer v2 polish.** Files: `index.html` composer functions (added after
   `closeSiteMenu`). Add: image **upload** to the `media`/`persona-media` bucket (so any image
   can be a source, not just the persona's), per-target checkboxes, live X char counter,
   auto-select the FB page that matches the chosen persona. Keep it isolated.

4. **Context-box feature** (`context_log`, migration 030 already applied). Files: `index.html`
   (add an `eContext` textarea to the persona edit form near `eNotes`, save via owner-scoped
   `personas.update({context_log})` on the resolved id — mirror the `pet_project` pattern at
   `savePersona`), and `ai-proxy` (fold a bounded recent slice of `context_log` into the persona
   system prompt). See `CONTEXT-BOX-SPEC.md`. Deliverable: the two diffs.

5. **Reddit connect** (`#35`). Frontend has no `connectReddit`. **Blocker:** `reddit-oauth`
   is drifted — pull it for the start/callback contract, then add `connectReddit(id)` + a
   Connect button in `index.html` mirroring `connectGmail`/`connectTwitter`.

6. **PWA** (fast app win, see `MOBILE-BLUEPRINT.md`): add `manifest.webmanifest` (icons from
   `brand/app-icon/`), a service worker, install prompt, and push for post-approval. No backend
   change. Deliverable: the manifest + SW + `<head>` wiring.

7. **Meta App Review** (only needed to post for OTHER users / go public): draft materials from
   `APP-REVIEW-META.md`; the human submits (business verification + screencasts).

8. **Drift cleanup** (`DRIFT.md`): guide the human through `supabase functions download` for the
   8 drifted functions, scrub any inline secrets into env, commit. Unblocks #1 and #5.

## 6. How to test what you build (the human runs it)

- Deploy: the human pushes; functions deploy via the Action; migrations they run in the SQL
  editor. Frontend is live on Pages after push.
- Function smoke test from the browser console on `mypersonas.online` (already signed in):
  `fetch(CONFIG.SUPABASE_URL+'/functions/v1/<fn>', {method:'POST', headers:{'Content-Type':
  'application/json','Authorization':'Bearer '+(await sb.auth.getSession()).data.session.
  access_token}, body: JSON.stringify({...})}).then(r=>r.json())`.
- Posting tests: use a low-stakes page (e.g., "Jokes from Dads") and delete after
  (`meta-post` `{action:"delete"}` for FB; Instagram deletes are manual in-app).

_When in doubt, read `POSTING-3PART-SPEC.md` and `CHANGELOG.md` (top entries) — they mirror this._
