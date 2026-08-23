# AliaSpaces / MyPersonas — Setup Guide

Release-package status: **migration 060 is applied/read back in the linked database; the
requested owner staff-role rows are active; the four reviewed functions and matching Pages
source are deployed from commit `968e1ea`; and the current owner cleared TOTP and completed
live owner-route QA with zero console errors.** Use `RELEASE-MANIFEST-2026-08-22.md` for the
historical ordered chain and `RELEASE-MANIFEST-2026-08-23-AI-PROVENANCE.md` for the forward
060 release record. This guide documents procedure; it is not proof of unrelated-account,
real-phone, provider, load, email, payment, or opaque-delivery behavior.

## Current production verification checkpoint — 2026-08-23

After the current owner completed the enrolled TOTP challenge, production rendered
Overview and exact Persona mode, authenticated account handles, the family editor and
connected tree, page designer and learning console, business draft workspace, staff queue,
full asset preview and **Save a copy**, friend policy, and the deterministic intention plan.
Desktop and responsive browser emulation completed with zero console errors. A real phone,
an unrelated account, external-provider transactions, hosted load, email delivery,
payments, and opaque public asset delivery remain unverified.

Files in this repo:
- **index.html** — the entire app (hosted as a static site)
- **supabase-schema.sql** — the database (run once in Supabase)
- **sql-updates/** — ordered migrations for an existing database
- **../supabase/functions/** — server-side connectors and automation

## Step 1 — Stage the Vault-compatible release

For an existing project, pause the scheduled workers and deploy the new Edge Functions
before migration 011. Their model-key resolver can use the legacy owner-only key column
before migration and the service-only Vault accessor afterward. Deploy the matching
`index.html` before or with the migration; after migration 011, the owner roster and model
operations intentionally require their owner-scoped RPCs instead of broad table reads.

Then run each unapplied file in `sql-updates/` in numeric order. Migration
`011-agent-automation.sql` enables Supabase Vault, moves existing model keys into Vault,
clears the legacy key column, revokes direct browser model writes, and creates the new
agent-control, lease, quota, approval, publishing, and fan-chat data plane. Do not apply it
while an older Edge/client release is the only code available.

An earlier production checkpoint confirmed migrations 011–018; do not treat that as the
current complete migration inventory. Later evidence separately found 035 and 038 visible,
and the 047 display-name statement was run/read back through SQL Editor without proving a
CLI migration-history row. Inventory the linked project's actual migration table and schema
before planning another apply. Keep historical files unchanged. Migration
`016-mailbox-manager.sql` added the owner-readable sanitized mailbox
reports plus service-only provider references, cursors, exact action items, and operation
leases used by Inbox Concierge. In another environment, apply it before deploying
`mailbox-manager`, `run-mailbox-jobs`, the Gmail permission upgrade, or the matching page.
Migration `017-mailbox-full-history.sql` is the applied additive bounds change. In another
environment, apply it after 016 with the matching mailbox manager, worker, and page. It
raises only the report lookback and per-scan ceiling; it grants no new scope or automatic
action authority. Migration `018-meta-oauth.sql` is the applied additive connector
boundary. In another environment, apply it after 017 before deploying `meta-oauth`. It
adds service-only Meta OAuth transactions, candidate assets, grants, Page connections,
token-operation and owner-erasure leases, Vault mappings, and ledger mutation guards. It
grants no direct Facebook or Instagram publishing authority.
Deploy the updated `delete-account` and `erase-content` functions before the new page so
provider grants are revoked and mailbox jobs cannot race erasure. The page checks the
versioned content-only capability before enabling erasure.

For a new Supabase project, `supabase-schema.sql` supplies only an earlier baseline; it is
not a current full-schema installer. The timestamped `supabase/migrations/` directory also
omits part of the later canonical 019–046 history. Do not combine those artifacts and
assume a safe fresh install. First build and verify a complete predecessor inventory from
the canonical `sql-updates/` history, then rehearse it in an isolated database.

For an existing eligible baseline, apply the exact timestamped order in
`RELEASE-MANIFEST-2026-08-22.md`: 047, 048, 049, 050, hardened prerequisite 043, then
051, 052, 053, 054, 055, 056, and 057. The nonnumeric placement of 043 is intentional:
051 requires its phase-1 request-review objects. Every canonical/timestamped pair must be
byte-identical at the final freeze. Never hand-edit migration history to conceal a
dependency or parity failure. Rehearse the sequence in staging and use
`OWNER-APPROVAL-QUEUE-2026-08-22.md`; none of these files configures a live provider,
staff role, Auth hook, CAPTCHA, email sender, WAF, log drain, payment processor, or DNS.

Migration 058 is a separate follow-on after that frozen chain. Apply and verify
`20260823000000_persona_view_mode.sql` before publishing the Persona-view page assets.
Do not let the browser fall back to owner-wide RLS for a persona perspective; follow the
exact-actor checks in `PERSONA-VIEW-MODE.md`.

Migration 059 is immutable historical source. If the linked migration ledger already
records 059, do not edit, replace, or re-run it even when schema readback shows that some
hardening is absent. The missing complete media-provenance contract is the new,
forward-only migration 060. The linked production project applied and read back **060
only** on 2026-08-23. Other environments must use a maintenance window with matching
`media-ingest`, `gemini-image`, `compose-post`, `ai-proxy`, publisher, frontend, and cache versions
ready. First run `scripts/test-ai-content-provenance-sql.ps1` against Docker PostgreSQL 16;
the required sequence is prerequisite seed → frozen 059 → 060 → 060 reapply → runtime.
Then follow the backup, readback, function, page, signed-in, and resume order in
`AI-CONTENT-PROVENANCE.md`. Deploy `media-ingest` with local Supabase CLI bundling and its
configured watermark `static_files`; the pinned ImageMagick WASM is too large for the
server-side dashboard bundle path. Do not re-enable the old browser Storage policy as rollback.

Migration 051 intentionally backfills every legacy persona without lifecycle state to
`unpublished`, clears its published revision/timestamp, and returns every legacy business
to an owner-only draft. Inventory the current pages and plan individual exact-revision
reviews before applying it; do not rewrite the migration to preserve implicit public state.

## Step 2 — Wire the app to your project
Dashboard → **Settings → API**:
- **Project URL** (looks like `https://abcdxyz.supabase.co`)
- **anon / public key** (long string starting `eyJ…`)

Paste both into the `CONFIG` block near the top of the `<script>` in `index.html`. These
two values identify the public Supabase client; authorization still comes from row-level
policies and the authenticated Edge Functions. Never put the service-role key there.

## Step 3 — Host it
The current site deploys through GitHub Pages, but a push does not publish it. After the
database is applied/read back and matching functions are manually deployed/verified,
dispatch `.github/workflows/pages.yml` with `MIGRATIONS-VERIFIED`. Record the workflow
run, artifact, commit, public hash, and signed-in smoke result; allow for CDN/cache delay.

## Step 4 — Tell Supabase your site URL
Supabase → **Authentication → URL Configuration**:
- **Site URL**: `https://mypersonas.online`
- **Redirect URLs**: add `https://mypersonas.online/**`

This configures the allowed return path for magic-link and provider sign-in.

## Step 5 (optional) — Google sign-in to AliaSpaces
1. https://console.cloud.google.com → new project → **APIs & Services → OAuth consent screen** → External.
2. **Credentials → Create OAuth Client ID** → Web application → Authorized redirect URI: `https://YOURPROJECT.supabase.co/auth/v1/callback`.
3. Paste Client ID + Secret into Supabase → Authentication → **Providers → Google** → enable.

This signs a person into AliaSpaces. It does **not** authorize MyPersonas to read a
Gmail inbox.

## Request-review phase-1 deployment gate (default off)

Do not deploy the public CTA ahead of its database and function contracts. The current
repository source is local only and requires this order:

1. Apply and verify the complete ordered release manifest in staging. Request-review
   specifically depends on hardened 043 followed by 051; include anonymous/other-owner
   denial and the existing-persona unpublication backfill.
2. Create a production Turnstile widget restricted to the final hostname. Set the public
   site key in `CONFIG.TURNSTILE_SITE_KEY`; this is an identifier, not the secret.
3. Set these Edge Function secrets/config values directly in Supabase:
   - `REQUEST_REVIEW_ALLOWED_ORIGIN=https://mypersonas.online` (one exact HTTPS origin);
   - `TURNSTILE_SECRET_KEY=<provider secret>`;
   - `REQUEST_REVIEW_TURNSTILE_ACTION=request_review`;
   - `REQUEST_REVIEW_TURNSTILE_HOSTNAME=mypersonas.online`;
   - `REQUEST_REVIEW_HMAC_SECRET=<at least 32 random bytes>`.
   Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never copy the
   service-role value into the page, documentation, logs, or chat.
4. Deploy `request-review` with the repository's intentional `verify_jwt=false` setting.
   It is public CAPTCHA ingress and therefore enforces exact Origin, a streamed 16 KiB
   body limit, a five-second Turnstile verification timeout with exact action/hostname,
   HTTPS public-domain product URLs without fetching them, rotating HMAC abuse keys, and
   the service-only acceptance RPC. Missing configuration returns 503.
5. Deploy `affiliate-redirect` only after the hardened migration-051 pair is proven
   byte-identical in the frozen release. Set a distinct
   `AFFILIATE_CLICK_HMAC_SECRET` of at least 32 bytes. Verify bounded offer/attribution
   input, rotating HMAC identifiers, the atomic current-page/cap/deduplication RPC,
   credential-free HTTPS destinations, and the service-only 400-day retention RPC. Audit
   every legacy active destination before enabling buttons and schedule retention only
   through an approved service-role job/runbook.
6. Keep `product_review_global_controls.accepting_requests=false`,
   `abuse_paused=true`, and every persona request setting disabled. Enable one disposable
   staging persona only after its current page revision, active binding, connected
   nonsuspended Gmail ledger, and destination are verified.
7. Prove invalid CAPTCHA/config/origin fail closed, accepted/duplicate/suppressed requests
   receive the same neutral receipt, private personas cannot be enumerated, and no raw IP,
   secret, mailbox address, or database error appears in logs or responses.

Phase 1 writes a private request, audit event, and notification-queue row. It does not
send email and has no notification claim/sender worker, owner evidence/review queue,
published-review state machine, payment path, or promise of a response. Keep the global
gate closed until those later phases and SMTP reconciliation are implemented and tested.

## Agent Board and AI budget activation gate (default off)

The local Agent Board is not recursive autopilot. Migration 053 requires one bounded
proposal, one exact owner-reviewed payload/hash, an AAL2 run action, an exact request and
idempotency key, and a short-lived one-use service capability. Migration 057 independently
requires an enabled nonzero budget for the exact owner/backend/mode. A normal browser JWT
cannot invoke `agent_board` or `automation` mode directly through `ai-proxy`.

Use this staging-only ceremony after the full manifest database package is read back:

1. Deploy the matching `agent-board-propose`, `agent-board-run`, and `ai-proxy` source
   together. Keep every persona's proposal/execution switches off.
2. Verify the selected backend uses a least-privilege server-side Vault credential, an
   official allowlisted host/path, a pinned model, no auto-recharge, and the smallest
   provider-side trial/hard cap. The application budget stores tokens/requests, not price.
3. With AAL2, save a disabled minimal `agent_board` budget first. Review the values, then
   explicitly enable only that backend/mode. Leave `automation` disabled.
4. Configure one disposable persona with a nonempty task-type allowlist and a small daily
   proposal limit. An empty allowlist denies both proposals and execution.
5. Add one synthetic/public-data proposal. Inspect and copy the complete authoritative
   review packet, including target persona/backend, subject, instructions, context, and
   resolved content inputs. Approve only the displayed SHA-256-bound packet.
6. Run that exact request once. Verify repeat clicks/tabs with the same idempotency key
   return the existing run rather than call the provider twice; verify a different key
   cannot run the already-running/completed request.
7. Verify pre-provider policy/budget failure returns the request to approved without
   consuming its review. Reconcile an expired pre-provider claim back to approved. An
   expired claim whose provider call may have started must be quarantined for manual
   review and never automatically retried.
8. Read back the budget lease/finalization, board run/result, and terminal `agent_actions`
   audit. Revoke the disposable provider key and disable proposal, execution, and budget
   switches after the test.

No Agent Board result is published. It returns owner-private result/draft material for a
separate content/page review. Provider dashboard setup, key creation, nonzero spend, and
the staging/live ceremony are owner-controlled actions.

## Step 6 — Gmail account authorization

For the current deployment, run `sql-updates/009-external-account-connections.sql`
and `sql-updates/010-gmail-oauth.sql`, then configure the isolated Google Cloud
project **MyPersonas Gmail Connector** (`genial-union-503010-q5`):

1. Enable the **Gmail API**.
2. In **Google Auth Platform → Audience**, use External/Testing during development
   and add each mailbox owner you will use during testing as a test user.
3. In **Data Access**, add `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.modify`. Do not request the broader
   `https://mail.google.com/` scope: Inbox Concierge never immediately or permanently
   deletes mail.
4. Use its Web OAuth client
   `373519662305-05bnlabe18i89efnhec9inpt36al7lc6.apps.googleusercontent.com` and add
   this authorized redirect URI:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth`.
   Keep this client in the isolated Gmail project. Google token revocation can affect
   grants project-wide, so creating another client in the normal site-sign-in project
   is not sufficient; Gmail disconnect/revocation must not disturb AliaSpaces login.
5. Save the OAuth client ID and client secret as Supabase Edge Function secrets named
   `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`. Never place the secret
   in `index.html` or Git.
6. Deploy the connector:

   ```
   supabase functions deploy gmail-oauth --no-verify-jwt
   ```

The old same-address inventory check is no longer shown as a connection step. It never
authenticated Google, Microsoft, Yahoo, or Apple and was especially misleading when one
AliaSpaces owner managed several mailbox addresses. Select **Connect Gmail** to run
Google's real consent flow. The user must choose the exact recorded mailbox and approve
cleanup access before the status becomes **Cleanup enabled**. An existing read-only grant
can be upgraded in place through the same button; denial leaves the earlier report-only
connection unchanged. Passwords are never collected; the refresh token is encrypted in
Supabase Vault and is unavailable to browser code. Completion is also bound to the same
signed-in user and browser tab that started it, so forwarding a consent link cannot attach
someone else's mailbox.

Both `gmail.readonly` and `gmail.modify` are restricted Google scopes. A Testing app works
only for configured test users, and its refresh tokens normally expire after seven days.
A public production launch requires Google's OAuth app verification and, when restricted
Gmail data is stored or transmitted by the service, may require a restricted-scope
security assessment.

### Inbox Concierge worker

Run `sql-updates/016-mailbox-manager.sql` followed by
`sql-updates/017-mailbox-full-history.sql`, then deploy the signed-in control endpoint
and the cron-secret worker:

```
supabase functions deploy mailbox-manager
supabase functions deploy run-mailbox-jobs --no-verify-jwt
```

`mailbox-manager` creates report jobs and exact action plans for the signed-in owner.
`run-mailbox-jobs` performs bounded Gmail pages, approved actions, and approved Undo
requests. Store the same `CRON_SECRET` value in the Edge Function environment and in
Supabase Vault as `mypersonas_cron_secret`, then schedule the worker every minute using
the Vault lookup shown in `../supabase/DEPLOY.md`.

The **Use full-history limits** control fills in a 100-year lookback and a
15,000-message ceiling, but the owner must still save those settings and explicitly start
the report. The worker retains 40-message resumable pages, which is about 6.25 hours of
successful one-minute polling at the ceiling before retries. Scan cursors have a bounded
seven-day expiry that refreshes after every successful page. If Gmail still has matching
mail at the ceiling, the persistent latest-scan banner and Activity timeline say that
older mail remains; the app never represents the bounded result as a complete history
scan. A metadata/finding/checkpoint persistence failure ends the scan as incomplete and
reports processed-versus-saved counts instead of advancing silently. When several
mailboxes are active, the worker rotates by least-recently-served scan rather than letting
one full-history report monopolize every minute.

Inbox Concierge is rules-first. To enable optional AI classification, the owner must
link a hosted text model in Matrix, select it for that mailbox, and accept the
per-mailbox disclosure. Only the bounded sender, subject, and short Gmail preview snippet
is sent to the selected provider; full bodies and attachments are not sent. Custom model
hosts need both `MAILBOX_AI_HOSTS` in the deployed function environment and the separate
**Confirm inbox host** control; schedule or fan-chat confirmation does not authorize
mailbox data.

Scheduled jobs are report-only. Labels, label-and-archive, Trash, and Undo use separate
exact plans and fresh owner approval. The code contains no Gmail send, permanent-delete,
attachment-download, spam/block, forwarding, filter, or account-security endpoint.
Unsubscribe destinations are never fetched by the server.

## Step 7 — X / Twitter account authorization

Run `sql-updates/015-twitter-oauth.sql`, then create an X Developer **Web App** and
register this exact callback URL in the
[X Developer Console](https://console.x.com):

`https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitter-oauth`

Save the Web App credentials as Supabase Edge Function secrets. Never put them in
`index.html`, a ledger note, or Git:

```
supabase secrets set X_CLIENT_ID="<X Web App client ID>"
supabase secrets set X_CLIENT_SECRET="<X Web App client secret>"
supabase functions deploy twitter-oauth --no-verify-jwt
```

The X developer project must have current API access/credits. MyPersonas requests only
`tweet.read`, `users.read`, and `offline.access`; the callback must match
exactly. Record the exact X username first, then select **Connect X**. Completion is
single-use and bound to the same owner and browser tab, and `/2/users/me` must return that
username before the connection becomes active.

The X grant does not request posting permission, and automated X publishing is not enabled
in this release. The OAuth function supports identity validation, read access, refresh,
revocation, and secure Vault storage only. The future write connector must request
`tweet.write` through a separate explicit reauthorization after it is implemented and
live-tested.

Current connection coverage is intentionally explicit:

- **Gmail** — real Google consent, private report scans, explicitly approved
  label/archive/recoverable-Trash actions, refresh, revocation, and bounded Undo.
- **X / Twitter** — real X consent, identity/read access, refresh, and revocation once
  the production Web App credentials and API access are installed.
- **Facebook Pages and Page-linked professional Instagram** — the official Meta pairing
  foundation can discover and securely bind eligible assets once the Business app is
  configured. The current grant is identity/read-only; direct publishing remains off.
- **Outlook / Hotmail / Microsoft 365** — private planning records until the delegated
  Microsoft Graph adapter and its Entra app are installed.
- **Yahoo and iCloud Mail** — private planning records until a dedicated encrypted IMAP
  worker exists. Never paste a normal or app-specific password into the website.
- **Proton Mail** — private planning records until a trusted local companion can connect
  to Proton Mail Bridge on the same computer.
- **Other saved providers** — private planning records until their provider-specific
  connector, eligibility rules, app review, and permissions are implemented.
  MyPersonas never treats a saved password, cookie, or matching email as provider
  authentication.

## Step 8 — Facebook Page and linked Instagram pairing

The first Meta connector uses one Meta Business app with
[Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
to discover [Facebook Pages](https://developers.facebook.com/documentation/pages-api/overview)
and an eligible professional Instagram account linked to each Page. It does not automate a
Facebook personal profile or a consumer Instagram account. Standalone professional
Instagram Login is a separate connector and is not installed in this release.

1. Open [Meta for Developers → My Apps](https://developers.facebook.com/apps/), create a
   **Business** app, and add Facebook Login for Business.
2. Add `mypersonas.online` as the app domain and use the public URLs:
   `https://mypersonas.online/privacy.html`,
   `https://mypersonas.online/terms.html`, and
   `https://mypersonas.online/data-deletion.html`.
3. Register this exact OAuth redirect URI:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/meta-oauth`.
4. During development, add the Facebook member as an app administrator/developer/tester
   and keep only the Pages that member is authorized to manage in scope. For broader use,
   complete the applicable [business verification](https://developers.facebook.com/documentation/development/release/business-verification)
   and [app review](https://developers.facebook.com/documentation/instagram-platform/app-review)
   steps.
5. Configure discovery permissions `pages_show_list`, `pages_read_engagement`, and
   `instagram_basic`. Do not add publishing permissions to make the first connection pass.
6. Install the credentials directly as Edge Function secrets, apply migration 018, and
   deploy the callback:

   ```
   supabase secrets set META_APP_ID="<Meta app ID>"
   supabase secrets set META_APP_SECRET="<Meta app secret>"
   supabase secrets set META_LOGIN_CONFIG_ID="<Meta login configuration ID>"
   supabase functions deploy meta-oauth --no-verify-jwt
   ```

   Set `META_LOGIN_CONFIG_ID` when Facebook Login for Business creates a login
   configuration. Its configured permissions must match the same three discovery scopes.

7. In Matrix → Account & settings → Accounts, record each destination as
   **Facebook Page** and optionally **Instagram**, assign its persona, open
   **Connection**, choose **Connect Meta & choose Pages**, and bind only the Page records
   Meta returns. A linked Instagram ID is accepted only when Meta discovers it on that
   Page.

The callback exchanges and stores Meta user/Page tokens in Supabase Vault. Disconnecting
one paired asset revokes the complete shared Meta-user grant and disconnects every Page
and linked Instagram asset created from it. The UI continues to label external publishing
as unavailable. A later write release must separately request `pages_manage_posts` and/or
the current Instagram content-publishing permission, complete review, add reconciliation
and rate-limit handling, and pass live owner-account tests.

## Step 9 — Agent control center and schedules

Follow the staged order in `../supabase/DEPLOY.md`: pause both workers; deploy `ai-proxy`,
`post-bridge`, `run-publish-queue`, `fan-chat`, `gmail-oauth`, and `twitter-oauth`; apply
every pending migration through 018; deploy `meta-oauth`,
`run-tasks`, `mailbox-manager`,
`run-mailbox-jobs`, `delete-account`, and the JWT-verified `erase-content`; publish the
page; probe all three workers; then schedule content workers every five minutes and the
bounded mailbox worker every minute. Set `CRON_SECRET` and `FAN_CHAT_SALT` before probing.
`SCHEDULE_AI_HOSTS`, `FAN_CHAT_AI_HOSTS`, and `MAILBOX_AI_HOSTS` are separate optional
hostname allowlists for custom scheduled-generation, public fan-chat, and private mailbox
classification endpoints. A custom hostname also needs the separate matching confirmation
in Matrix; one surface's confirmation never authorizes another.

Store the same `CRON_SECRET` value twice: once as the Edge Function secret and once in
Supabase Vault named `mypersonas_cron_secret`. The cron jobs read the Vault copy at runtime,
so the stored job definition contains no credential.

After deployment, the owner configures each persona in Matrix:

1. **Direction** — goal, success measure, audience, content pillars, campaign, calls to
   action, offers/approved links, affiliate disclosure, source notes, and platform rules.
2. **Safety** — global pause, persona status, autonomy level L0–L3, daily model-call and
   publishing limits, quiet hours, and optional disclosed fan chat.
3. **Targets** — native AliaSpaces plus persona-assigned account-ledger rows. A recorded,
   sign-in-email-matched, or read-only-connected external account is still not write-enabled.
4. **Schedule** — daily/weekly day, local time, time zone, preparation lead time, content
   type, model, instructions, and approval requirement.
5. **Queue** — edit, approve the exact draft, reject, publish native content now, or record
   an externally posted draft as manual.

Scheduled generation claims each task with a UUID lease and atomically reserves one daily
model-call unit before contacting the provider. This prevents overlapping cron runs from
duplicating paid calls or exceeding the configured cap. It creates drafts only and never
approves its own output.

Editing an approved draft clears its exact approval and removes it from the publish queue.
For native AliaSpaces feed content after migration 051, neither L2 nor L3 bypasses page
review. The owner stages an exact-approved native draft into the persona page; that content
edit advances the page revision and keeps it nonpublic. Only the owner can review and
publish that exact current page revision. Publication then finalizes the unchanged staged
draft, and a second reconciliation RPC activates any now-current cyclic dependencies.
External-provider queues retain their own separate approval and provider gates.

Fan chat atomically reserves the visitor/persona quota, session, saved message, audit row,
and response lease before a model call. It is unavailable for NSFW personas until
AliaSpaces has server-verifiable age assurance; the current client-side 18+ prompt is not
enough for a public AI endpoint. Escalated transcripts are flagged for owner review only—
they do not promise an owner reply or live takeover.

## Implemented in this repository vs. still gated

**Implemented in the repository:** sign-in, anonymous multi-persona pages, private
provider-grouped account ledger, distinct recorded/email-match/API states, Gmail Inbox
Concierge with exact cleanup approval and Undo, X OAuth identity/read authorization with
refresh and revocation, Meta Page/linked-Instagram identity pairing with publishing
disabled, manual provider handoffs, persona direction, server-side AI proxy, Vault-backed model keys,
precise scheduled draft generation with atomic call reservations, approval queue, native
AliaSpaces page-review staging/publishing in the coordinated 051 source, global/persona
pauses, caps and quiet hours, audit history,
synchronized owner chat, and optional disclosed SFW fan chat with an owner-review inbox.
The 2026-07-24 production rollout applied migration 016, deployed the mailbox, Gmail, and
erasure functions, and enabled the one-minute mailbox worker. The 2026-07-29 rollout
applied migrations 017 and 018 and deployed the hardened erasure pair plus the
configuration-gated Meta connector. Static-client, server-boundary, schema, rollback-only
race, and empty-Meta-state checks passed. A signed-in Google re-consent, real
owner-approved Gmail scan/action, and credentialed Meta owner flow remain owner-run smoke
tests; this guide does not claim those mailbox contents or provider assets were accessed.

**Content erasure:** the Matrix security area uses the versioned `erase-content` endpoint,
which can retain the Supabase sign-in while removing owned personas, pages, posts, media,
account records, drafts/tasks, model connections, automation/chat history, display name,
and preferences. It refuses to run unless the server reports the immutable content-only
contract. Gmail, identifiable X grants, and safely attributable Meta grants or unfinished
Meta candidates are revoked first. If X cannot prove the final grant state, the owner must
revoke MyPersonas in X Connected Apps before acknowledging X separately. When the server
can safely reserve an unfinished Meta identity to that owner, it may require the owner to
remove MyPersonas in Meta Business Integrations before acknowledging Meta separately;
that one Meta authorization can cover every paired Page and linked professional Instagram
account. An exchange with no trustworthy identity is retained as an ownership
investigation instead: the page must not advise provider revocation or accept an ordinary
manual acknowledgement, because doing so could disrupt another owner's existing shared
grant. Any OpenRouter
connection—legacy, pasted, or OAuth—also requires the owner to revoke its provider-side
key before acknowledging OpenRouter separately. The server recomputes the required
provider list at deletion time; one provider's acknowledgment never satisfies another
provider's revocation requirement.

**Still gated:** Outlook mailbox management, Yahoo/iCloud IMAP workers, a local Proton
Bridge companion, standalone Instagram Login, and direct posting to Instagram, Facebook,
TikTok, X, YouTube, LinkedIn,
or any other external service. Each provider needs its own official integration,
permissions, review where required, credential lifecycle, reconciliation, and
provider-specific testing. Gmail mailbox access does not authorize social posting. Native
live streaming is also still an embed; a future release can add Cloudflare Stream or Mux.

## Honest notes
- **Historical watermark note:** older source burned a page URL into uploads. The
  immutable 059 baseline plus forward-only migration 060 replaces that design with a required AI-use declaration, trusted
  server-created MyPersonas AI derivatives, immutable provenance, and accessible labels.
- **Asset integrity**: new first-party PNG/JPEG/WebP/GIF and MP4/WebM uploads hash the
  final bytes and use append-only content-addressed `persona-media` paths after the
  coordinated 060 release. External HTTPS media present at the first successful 060 apply is snapshotted once as visibly
  unverified URL text, not fetched or byte-hashed; changing it makes page review fail.
  Newly supplied external media is blocked until a secure declared-import workflow exists.
- **Opaque delivery remains blocked:** 060 does not replace stable owner UUIDs in current
  public Storage paths. Keep rich public image/video widgets and video backgrounds
  disabled until an opaque-id migration, backfill, and signed-in two-account privacy test
  pass.
- **Adult content**: keep the 18+ page gate on NSFW personas and check the host's
  acceptable-use terms. Fan chat remains server-disabled for NSFW personas until a
  server-verifiable age-assurance system exists.
- **AI keys** are accepted through `create_ai_backend`, encrypted in Supabase Vault, and
  retrievable only through a service-role RPC. Browser create/update/delete operations use
  owner-authenticated RPCs and cannot read a saved key back. Never store passwords in
  private notes.
- **Gmail credentials** are not stored in the account ledger. OAuth refresh tokens are
  encrypted in Supabase Vault and only the server-side connector can retrieve them.
- **X credentials** are not stored in the account ledger. OAuth access/refresh tokens are
  encrypted together in Supabase Vault and are available only to service-role connector
  code. A saved username or matched AliaSpaces email is never treated as X authentication.
