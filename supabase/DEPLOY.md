# AliaSpaces / MyPersonas — server deployment

The browser app is hosted by GitHub Pages. Supabase provides authentication, the
database, Vault, OAuth connectors, scheduled drafting, native publishing, and fan chat.
> **Current release rule (verified 2026-08-23):** a push to `main` containing a new file in
> `supabase/migrations` is a production database action. The installed Supabase GitHub App
> reports a check named **Supabase Preview**, but it applied migration 061 to the linked
> production database and wrote migration history before GitHub unit tests finished.
> `.github/workflows/supabase-deploy.yml` and `.github/workflows/pages.yml` remain manual
> for Edge Functions and Pages; that does not stop database auto-apply. Freeze and test a
> migration before it reaches main, use a non-production branch/PR, or disable production
> auto-apply. Then read back database state, deploy functions, and publish Pages. See
> [`CI-CD-SETUP.md`](../CI-CD-SETUP.md).

Release-package status: **feature-specific; use the newest exact release manifest and
production readback rather than this historical default.** The exact 047–057 order,
frozen local hashes, prerequisite warning, test
evidence, and owner gates are in
[`RELEASE-MANIFEST-2026-08-22.md`](../MyPersonas.Online_v0/RELEASE-MANIFEST-2026-08-22.md).
The timestamped directory is not a complete fresh-install chain; prove all required
predecessors before any main push that can invoke the GitHub App.

Follow-on migration `20260823000000_persona_view_mode.sql` (canonical 058) is separate
from the frozen 047–057 package. It must be applied and security-tested after 057 and
before publishing `persona-view.js`, `persona-view.css`, or the matching page changes.
The client intentionally refuses to fall back to account-wide reads when 058 is missing.
See [`PERSONA-VIEW-MODE.md`](../MyPersonas.Online_v0/PERSONA-VIEW-MODE.md).

This is a deployment runbook for the repository state. The 2026-07-24 production rollout
applied migration 016, deployed the matching mailbox/Gmail/erasure functions, and enabled
the mailbox cron. The 2026-07-29 rollout applied migrations 017 and 018 and deployed
`delete-account` v17, `erase-content` v10, and the configuration-gated `meta-oauth` v1.
A signed-in Gmail re-consent, real mailbox action, and credentialed Meta owner flow remain
explicit owner-run smoke tests.

## Historical 2026-08-22 owner command center and fan inbox package

Apply the two migrations in order before their matching function and Pages changes in an
environment whose predecessor schema is already proven:

1. `20260822111946_owner_mobile_command_center.sql`
2. `20260822111947_fan_inbox_live_chat_privacy.sql`

Migration 046 deliberately fails closed unless `pg_cron` is installed, because the
five-minute abandoned-ephemeral-chat cleanup is part of the privacy promise. Validate with
`supabase db push --linked --dry-run`, apply only after owner approval, and confirm both
versions appear in `supabase migration list --linked`. A push does not deploy the current
release; manually dispatch functions and Pages in that order after database readback.

## 2026-08-22 persona full-name canon data migration

`20260822113925_persona_full_name_canon.sql` is a narrow, idempotent data migration.
It updates the `name` display field for existing Castleborn persona rows by exact handle,
leaves UUIDs, handles, visibility, ownership, biographies, and publishing state untouched,
and stops if a targeted row has an unexpected current name. It does not create Abel Atiq
or infer a surname for Enki.

Production data status (2026-08-22): the exact repository statement was applied manually
through the Supabase SQL Editor, then all 19 existing Castleborn rows in the canon set were
read back through the public REST API and matched (18 renamed rows plus Alexei Grigoriev,
which was already current). Direct SQL Editor execution does not add a
`supabase_migrations.schema_migrations` entry. The next linked `supabase db push` may
therefore execute this idempotent file once more to record version `20260822113925`; do not
insert migration-history rows by hand.

Before applying in any other environment, inspect the targeted handles and names in the
linked project. After applying, repeat the same read and compare it with
`MyPersonas.Online_v0/content/persona-full-name-canon-2026-08-22.json`. A migration-list
entry proves SQL history only; persistence verification must read the resulting persona
rows. The owner-safe preflight/postflight query is available at
`supabase/snippets/verify_persona_full_name_canon.sql`.

## 2026-08-22 private persona backup relationships (pending)

`20260822130000_persona_backup_relationships.sql` creates only the private owner-roster
relationship table, its validation trigger, and the authenticated setter RPC. It does not
backfill or infer relationships, alter public persona pages, or enable any provider action.
Apply it before publishing the matching `index.html` and `owner-app.js`; an older database
makes the new client fail flat and disables assignment, but release order still requires
the database first.

Current status: repository source and static tests only. It has not been applied to the
linked production project. Run `supabase db push --linked --dry-run`, confirm the plan may
first record/rerun the idempotent `20260822113925` full-name migration as documented above,
then apply through the normal linked migration path. Verify table/RLS/grants, owner-only
read, attach/detach, role-conflict rejection, and endpoint-deletion behavior before the
page release. Do not insert migration-history rows by hand.

## 2026-08-22 persona page layout builder (pending)

`20260822150000_persona_page_layout_builder.sql` adds bounded declarative page layouts
and owner-private HTML/CSS/JSON learning snippets. It does not execute owner-supplied
code, enable arbitrary widgets, publish a page, or migrate existing public asset URLs.
Apply migration 050 before the matching page release; without it the client deliberately
keeps the legacy safe layout and disables the designer.

Current status: repository source and focused tests only. It has not been applied to the
linked project. Before any release, follow `MyPersonas.Online_v0/PERSONA-PAGE-LAYOUT-BUILDER.md`,
including cross-owner/anonymous RPC tests and the documented opaque-public-asset privacy
blocker. Do not enable image/video widgets or video backgrounds until viewer-facing asset
URLs no longer expose a stable owner UUID path.

## 2026-08-22 Castleborn relationships, project, and business (pending)

`20260822140000_persona_relationships_projects_businesses.sql` records only the current
confirmed family edges, derives inverse/sibling labels, creates an owner-private Castleborn
project with WAIS as manager metadata, and creates a blank owner-private business draft.
It neither invents unresolved canon nor attaches a database/provider resource. Apply it
after 048 and before 050. A disposable PostgreSQL 16 apply/RLS/security run passed; the
linked production project remains unchanged.

## 2026-08-22 publication, social, and security governance (pending)

`20260822170000_publication_social_security_governance.sql` depends on 049 and 050. It
adds review-first persona publication, transparent AI disclosure, separate follow/friend
flows, confirmed feature requests, service-assigned roles, account-sync preferences,
inert extension review, and security/retention primitives. Apply it before the matching
`platform-governance.js`/CSS/index release.

The canonical 051 source and its timestamped mirror are synchronized locally. Record their
final frozen pair hash and replay evidence before any linked apply; do not substitute an
earlier working-tree hash for the release record.

Migration 051 also has earlier schema prerequisites. Migration 041 supplies the revenue
tables, and hardened `MyPersonas.Online_v0/sql-updates/043-request-review-phase1.sql`
supplies the `product_review_*` tables and service RPC that 051 wraps. Hardened 043 now
has the ordered local mirror `20260822160000_request_review_phase1.sql`. Apply/read it
before 051 and verify its objects. This repair does not make the wider timestamped
directory a complete fresh-install chain. Never insert a migration-history row by hand or
assume the older 041 `persona_review_requests` table is the hardened phase-1 contract.

Applying 051 intentionally sets every legacy persona whose lifecycle is uninitialized to
`unpublished` and clears its published revision/timestamp. It also resets every legacy
business to `draft` + `owner_only`. Inventory and export those records before the window;
afterward publish only individual exact revisions through owner review. Material profile,
post/link/album, family, layout, revenue/product/review-setting, AI-backend credential,
and fan-binding changes invalidate the reviewed page revision. The old native auto
publisher is disabled: approved native drafts stage into page review and become public
only through `publish_persona_page` plus post-commit reconciliation.

The migration does not seed a role or activate Auth hooks, CAPTCHA, SMTP, WAF, log drains,
SSO, provider workers, or page publication. Rehearse it with two unrelated Auth users and follow
`MyPersonas.Online_v0/OWNER-APPROVAL-QUEUE-2026-08-22.md`. Never infer the owner Auth UUID,
put raw IP/contact proof into the app log, or deploy the frontend before the database.

### Request-review and affiliate public functions (pending)

Both public endpoints intentionally set `verify_jwt=false` in `supabase/config.toml`; this
is not an authorization shortcut. Deploy them only after their exact database contracts
are applied and verified.

Set the request-review configuration directly in the Edge environment:

```powershell
supabase secrets set REQUEST_REVIEW_ALLOWED_ORIGIN="https://mypersonas.online"
supabase secrets set TURNSTILE_SECRET_KEY="<provider secret>"
supabase secrets set REQUEST_REVIEW_TURNSTILE_ACTION="request_review"
supabase secrets set REQUEST_REVIEW_TURNSTILE_HOSTNAME="mypersonas.online"
supabase secrets set REQUEST_REVIEW_HMAC_SECRET="<at least 32 random bytes>"
supabase secrets set AFFILIATE_CLICK_HMAC_SECRET="<separate secret, at least 32 random bytes>"
```

Set the matching public Turnstile site key in `CONFIG.TURNSTILE_SITE_KEY`. Supabase
provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; do not expose or duplicate the
service-role secret. With any required server value missing or malformed, the function
returns 503. With the wrong/missing Origin it returns 403 without granting CORS. It
streams/caps JSON before parsing, verifies Turnstile with timeout/action/hostname,
validates but never fetches requester URLs, HMACs abuse identifiers, resolves only a
currently published persona, calls `accept_product_review_request_service`, and returns
one neutral 202 receipt for accepted/duplicate/suppressed valid requests.

Leave `product_review_global_controls` at its fail-closed defaults
(`accepting_requests=false`, `abuse_paused=true`) and every persona disabled until a
disposable staging flow passes. Migration 043 queues notification rows only; no
notification worker or email sender exists. A database row is not a delivered email.

Before deploying `affiliate-redirect`, set a separate 32-byte-or-longer
`AFFILIATE_CLICK_HMAC_SECRET`, audit every active legacy destination, and verify the final
frozen canonical/mirror 051 hash. The local Edge source
bounds the offer URL and attribution fields, generates rotating domain-separated HMAC
identifiers, and permits only credential-free HTTPS destinations. Its service RPC atomically
rechecks the current reviewed page, applies global/offer/fingerprint caps and deduplication,
and conditionally records click analytics. Verify those paths plus the service-only cleanup
RPC for expired limiter rows and click events older than 400 days; give retention an approved
scheduler/runbook. These changes are local source, not proof of deployed configuration or
traffic. A successful redirect proves neither a sale nor revenue.

### Public asset release boundary

Migration 051 makes authenticated first-party `persona-media` writes content-addressed
and append-only. The matching page hashes final bytes after watermarking and uploads only
PNG/JPEG/WebP/GIF or MP4/WebM with `upsert:false`. This does not make legacy or external
HTTPS URL fields byte-integrity-bound; the review manifest commits URL text and never
fetches remote bytes. Release-critical external media must be ingested/hash-verified or
treated as mutable. Viewer-facing first-party URLs also retain an owner UUID prefix, so
the opaque-asset correlation remediation remains required before new media widgets.

## 2026-08-22 follow-on hardening 052–057 (pending)

After 051, apply and read back the remaining manifest entries in order:

- 052: exact-revision AAL2 business review/publish/unpublish;
- 053: bounded, human-approved Agent Board proposal and execution authority;
- 054: narrow quota-bound owner research/content writes and service provenance;
- 055: reserved terminal capacity and service-only agent audit mutation/erasure ordering;
- 056: Auth-email-triggered invalidation of stale AliaSpaces email attestations; and
- 057: durable per-owner/backend/mode request-token budgets and expiring leases.

All are default-safe local schema contracts. They do not enable an Agent Board, create a
model/provider project, configure a secret, spend trial credit, grant a staff role, publish
content, send email, or schedule a worker. Apply/reapply, AAL1/AAL2, cross-owner, direct-DML,
budget concurrency, exact-review/idempotency, terminal-audit, and writer/erasure tests must
pass against the frozen files before the Functions workflow is dispatched. They passed in
the disposable local release run and must be reproduced in staging against the inventoried
linked predecessor. Automated modes must remain disabled until a separately approved
staging owner saves explicit nonzero limits.

## 1. Link the Supabase project

```powershell
supabase login
supabase link --project-ref nwsqyuucwzihruszocge
```

Use a Supabase-supported CLI installation method. Do not install the CLI globally with
`npm install -g supabase`.

## 2. Pause workers and apply migrations 013–018 before the release

Migration 011 moves existing plaintext model keys into Supabase Vault, clears the legacy
`ai_backends.api_key` values, and revokes direct browser writes to `ai_backends`. Deploy
the new Edge code first. Its model-key resolver accepts the legacy column before the
migration and the service-only Vault RPC afterward, so the transition does not strand an
existing model connection.

Migrations 011–018 are applied on the current production project and must remain
immutable. Migration 013 added service-only least-recently-served generation, change-aware
prompt-input limits, deterministic input blocking, and a 100-active-schedule cap.
Migration 014 added the authenticated, atomic persona/profile bundle save used by the
page. Migration 015 added the independent service-only X OAuth/Vault boundary, and
migration 016 added the independent mailbox report/action boundary. Pause/unschedule all
workers before applying pending migrations or replacing their code. Migration 017 added
the full-history report bounds without changing permissions or creating a scan. Migration
018 added the Meta OAuth/Page-discovery and Vault boundary; it requests no publishing
scope and enables no external posting.

```sql
select cron.unschedule(jobid)
from cron.job
where jobname in (
  'mypersonas-run-tasks',
  'mypersonas-run-publish-queue',
  'mypersonas-run-mailbox-jobs'
);
```

If `pg_cron` or the named jobs do not exist yet, skip that statement. Existing projects
must apply `013-fair-generation-queue.sql` before deploying the matching `run-tasks`,
because that worker consumes the new service-only candidate RPC. Other functions may be
deployed while the workers remain paused:

```powershell
supabase functions deploy ai-proxy
supabase functions deploy post-bridge
supabase functions deploy run-publish-queue --no-verify-jwt
supabase functions deploy fan-chat --no-verify-jwt
```

Apply all pending migrations through 018 while the workers remain paused. Migration 015
must be live before the X function; migrations 016 and 017 must be live before deploying
the full-history mailbox manager/worker/page combination; migration 018 must be live
before the Meta connector. Then deploy the matching generator, mailbox services, and
OAuth connectors:

```powershell
supabase functions deploy run-tasks --no-verify-jwt
supabase functions deploy mailbox-manager
supabase functions deploy run-mailbox-jobs --no-verify-jwt
supabase functions deploy gmail-oauth --no-verify-jwt
supabase functions deploy twitter-oauth --no-verify-jwt
supabase functions deploy meta-oauth --no-verify-jwt
```

Deploy the content-erasure pair before publishing the matching GitHub Pages client. The
client refuses to erase content unless `erase-content` reports protocol v2 with immutable
content-only semantics, so reversing this order leaves the control unavailable rather than
risking the older full-account path.

```powershell
supabase functions deploy delete-account
supabase functions deploy erase-content
```

For a fresh project, also deploy the unchanged sitemap function:

```powershell
supabase functions deploy sitemap --no-verify-jwt
```

`ai-proxy`, `post-bridge`, `mailbox-manager`, `delete-account`, and `erase-content`
receive signed-in browser JWTs. The three cron workers use `X-Cron-Secret`. `fan-chat`,
`gmail-oauth`, `twitter-oauth`, `meta-oauth`, and `sitemap` are public at the gateway by
design and enforce their applicable checks in code.

## 3. Apply the database changes

`MyPersonas.Online_v0/supabase-schema.sql` is an earlier baseline, not a current complete
fresh-install artifact. The timestamped folder also omits part of canonical 019–046. For a
new project, first construct and verify the complete canonical predecessor chain in an
isolated environment. For an existing project, inventory the linked ledger/schema and run
only proven unapplied files. The current package follows the manifest's explicit order,
not simple numeric order, because hardened 043 is intentionally placed between 050 and 051.
The automation release requires:

- `008-account-ledger.sql` — private external-account inventory; no passwords or tokens.
- `009-external-account-connections.sql` — server-attested ownership/connection state.
- `010-gmail-oauth.sql` — one-time OAuth state and Vault-backed Gmail refresh tokens.
- `011-agent-automation.sql` — agent controls, Vault-backed model credentials, direction,
  destinations, schedules, leases, atomic quotas, approval/publish state, synchronized
  owner chat, audit records, fan-chat inbox, and privacy-safe persona reads.
- `012-agent-automation-hardening.sql` — bounded schedule retries, fair native publish
  due-times, exact approval invalidation after consent/target changes, durable chat ids,
  owner-safe backend readiness, narrower persona/session reads, and content-erasure
  support RPCs.
- `013-fair-generation-queue.sql` — service-only least-recently-served generation
  candidates, durable claim state, per-field provider-input bounds, deterministic task
  pausing for oversized input, and a grandfather-safe 100-active-schedule cap.
- `014-atomic-persona-save.sql` — owner-authenticated, transactional persona/profile,
  public-link, and private-note saving so a partial request cannot erase child data.
- `015-twitter-oauth.sql` — one-time owner/browser-bound X OAuth state, Vault-backed
  token bundles, provider-subject identity binding, serialized token operations, and
  fail-closed ledger-change/deletion guards.
- `016-mailbox-manager.sql` — owner-readable sanitized mailbox settings, scan summaries,
  findings, exact action plans, and audit events plus service-only cursors, provider
  message references, prior-label Undo snapshots, and serialized mailbox operations.
- `017-mailbox-full-history.sql` — additive 100-year lookback and bounded
  15,000-message report limits; no permission, schedule, or mutation grant.
- `018-meta-oauth.sql` — owner/browser-bound Meta OAuth state, short-lived
  Vault-backed Page selection, immutable Facebook Page and linked Instagram
  professional-account bindings, shared-grant revocation, and service-only user/Page
  token storage. It adds no publishing permission or posting path.

Migration 011 enables `supabase_vault`, creates an owner-authenticated model-management
surface, migrates every non-empty legacy model key into Vault, and then clears the legacy
column. Browser model operations use these RPCs:

- `create_ai_backend` accepts a key once and writes it into Vault.
- `update_ai_backend` edits non-secret connection metadata.
- `delete_ai_backend` and `delete_my_ai_backends` remove records and their Vault secrets.
- `ai_backend_get_key` is service-role only; browser sessions cannot call it.

The browser cannot select Vault mappings or read a saved key back. Model keys are held in
Edge Function request memory only while calling the configured provider. Migration 011
also removes owner UUIDs from public/general persona reads; owners load their own roster
through the owner-scoped `my_personas` RPC. Migration 012 explicitly removes legacy
column grants for private persona direction/model fields and repairs queued approvals
that no longer have valid L3 native-auto consent.

## 4. Set secrets and optional host allowlists

```powershell
supabase secrets set CRON_SECRET="<long random value>"
supabase secrets set FAN_CHAT_SALT="<at least 32 random characters>"
supabase secrets set GOOGLE_GMAIL_CLIENT_ID="<Google Gmail OAuth client ID>"
supabase secrets set GOOGLE_GMAIL_CLIENT_SECRET="<Google Gmail OAuth client secret>"
supabase secrets set X_CLIENT_ID="<X Web App client ID>"
supabase secrets set X_CLIENT_SECRET="<X Web App client secret>"
supabase secrets set META_APP_ID="<Meta app ID>"
supabase secrets set META_APP_SECRET="<Meta app secret>"
# Set this too when Facebook Login for Business created a login configuration.
supabase secrets set META_LOGIN_CONFIG_ID="<Meta login configuration ID>"
```

Store the exact same `CRON_SECRET` value in Supabase Vault under the name
`mypersonas_cron_secret` (Dashboard → Vault). The Edge workers compare their function
secret, while pg_cron retrieves the Vault copy at execution time. Rotate both copies
together. Do not paste the secret into the stored cron SQL.

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Never put a secret,
refresh token, password, or provider key in `index.html`, a migration, or documentation.

Scheduled generation, fan chat, and mailbox classification have separate outbound
model-host allowlists. Their built-in lists cover the supported hosted providers and
Azure OpenAI subdomains. Add only hostnames you operate or explicitly trust:

```powershell
supabase secrets set SCHEDULE_AI_HOSTS="models.example.com,another.example.com"
supabase secrets set FAN_CHAT_AI_HOSTS="models.example.com,another.example.com"
supabase secrets set MAILBOX_AI_HOSTS="models.example.com,another.example.com"
```

- `SCHEDULE_AI_HOSTS` extends only `run-tasks` scheduled generation.
- `FAN_CHAT_AI_HOSTS` extends only public fan-chat generation.
- `MAILBOX_AI_HOSTS` extends only optional, owner-consented mailbox classification.
- `FAN_CHAT_ALLOWED_ORIGINS` optionally adds comma-separated browser origins.
- `FAN_CHAT_HOURLY_LIMIT` optionally changes the per-visitor hourly cap; default 12.

Do not add a broad domain merely to make a request pass. The three model-host settings are
separate because private mail, public fan chat, and owner schedules have different risk
boundaries. A custom hostname must be both allowlisted here and explicitly confirmed for
the matching surface in Matrix; one surface never authorizes another.

## 5. Runtime safety model

### Scheduled generation

`run-tasks` asks the service-only `due_ai_generation_tasks` RPC for due work. It returns
one due task per owner before any owner's second task and prioritizes owners least recently
served. A successful `claim_ai_task_generation` call records that owner's turn and creates
a five-minute lease, stopping overlapping cron invocations from sending duplicate model
requests. Owners cannot read or reset the fairness state.

New or re-enabled schedules are limited to 100 active rows per owner; already-active rows
are grandfathered and remain editable. Provider-input fields have UTF-8 byte limits at the
database boundary, and the worker enforces a 32 KiB aggregate system-plus-prompt limit
before loading a credential or reserving quota. A deterministic size violation is audited,
the task is paused, and its lease is released; content is never silently truncated.

Immediately before a provider call, `reserve_agent_generation` locks the owner's local
calendar-day usage row, rechecks the owner pause and persona binding, and atomically
reserves one daily model-call unit. The cap counts reserved calls, including a provider
failure, because the request may already incur cost. A unique task/time-slot index
separately prevents duplicate drafts.

Scheduled generation creates a draft only. It never approves content.

### Approval and native publishing

Before migration 051, approval hashes the exact text, media, persona, destination,
platform, format, and publish time, and the legacy native bridge could finalize a post.
Do not use that behavior as the current release contract.

After migration 051, `publish_native_agent_draft` fails closed for background callers.
An authenticated owner may call `stage_native_agent_draft_for_review` for an exact-approved
native-feed draft. Staging inserts or verifies the corresponding page post, advances the
persona revision, and marks the automation draft blocked/staged—not published. The owner
must complete the exact page review and call `publish_persona_page`. That transaction
publishes the page and finalizes only unchanged staged drafts. The frontend then calls
`reconcile_staged_native_page_publications({p_persona_id:null})`; reconciliation failure is
surfaced as a warning and never changes the original publish response into a false claim.

`run-publish-queue` is not a native-page auto-publication path after 051. External Meta or
other provider queues are separate systems with their own dormant/approval/provider gates.

### Fan chat

Fan chat is off by default. `reserve_fan_chat_message` atomically validates the public or
unlisted persona, active binding, owner pause, session identity, per-visitor hourly quota,
persona daily quota, fan-message insert, audit insert, and a 90-second response UUID lease.
Only the holder of that lease can save the corresponding assistant response, preventing
concurrent replies and quota races.

NSFW personas are unavailable to fan chat until AliaSpaces has server-verifiable age
assurance. The existing client-side 18+ acknowledgment is not sufficient for this public
AI endpoint.

Commercial requests, disputes, self-harm signals, and persona hard-rule topics are flagged
for owner review. Escalation means the transcript appears in the owner's review inbox; it
does not promise that the owner will reply, take over the conversation, or perform an
action. The fixed AI/owner-review disclosure cannot be removed.

### Inbox Concierge

Mailbox jobs use a separate per-ledger lease and never inherit a persona's L0–L3 setting.
The existing global automation pause and the mailbox's own pause stop new work. A
scheduled job may scan and report only; no saved schedule can label, archive, Trash, or
unsubscribe.

The Gmail adapter retrieves bounded headers, subject, and Gmail preview snippets in
bounded pages. It never downloads attachments or stores raw bodies. Provider message IDs,
label snapshots, page cursors, and unsubscribe destinations stay in service-only tables;
owner-readable tables contain only sanitized findings and aggregate job/action status.
The optional full-history settings use a 100-year lookback and a 15,000-message ceiling.
The worker advances at 40 messages per one-minute invocation (about 6.25 hours at the
ceiling before retries), with a bounded seven-day cursor expiry refreshed after every
successful page. A remaining Gmail page token is recorded as a cap-limited partial result
in the persistent latest-scan banner, Activity, and audit history. A persistence failure
stops the scan incomplete before a page can advance silently and records processed and
saved-finding counts with the error. Runnable scans rotate by the time they last received
service so active mailboxes advance fairly and refresh their bounded checkpoints.
After per-mailbox consent, optional AI classification receives only the bounded sender,
subject, and short Gmail preview snippet; full bodies and attachments are not sent. The
model has no provider token, mailbox tool, unsubscribe URL, or mutation authority.

Every label, label-and-archive, or Trash request first creates an exact 24-hour plan bound
to the owner, ledger, selected findings, current labels, target label, and plan hash. The
worker re-fetches current state and skips changed or protected messages. Trash uses
Gmail's recoverable Trash endpoint only, stores prior labels, and exposes a bounded Undo;
the code has no permanent-delete path. Unsubscribe is a separate owner request and the
server never fetches the untrusted destination.

## 6. Schedule content workers every five minutes and mailbox jobs every minute

Five-minute polling gives due work a maximum normal dispatch delay of about five minutes.
The content functions select only rows whose `next_run_at` or `publish_at` is due.
One-minute mailbox polling advances bounded pages and approved plans without turning the
schedule into permission to mutate mail.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'mypersonas-run-tasks',
  'mypersonas-run-publish-queue',
  'mypersonas-run-mailbox-jobs'
);

select cron.schedule('mypersonas-run-tasks', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/run-tasks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'mypersonas_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('mypersonas-run-publish-queue', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/run-publish-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'mypersonas_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
$$);

select cron.schedule('mypersonas-run-mailbox-jobs', '* * * * *', $$
  select net.http_post(
    url := 'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/run-mailbox-jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'mypersonas_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
$$);
```

Before scheduling, confirm Vault has exactly one secret named
`mypersonas_cron_secret`. Check `cron.job`, `cron.job_run_details`, and all worker logs
after scheduling. Resume only after direct authenticated worker probes return HTTP 200;
zero due work is a valid result. The mailbox request timeout is deliberately longer than
the worker's 80-second execution budget; pg_net's five-second default can otherwise record
a false timeout while a bounded Gmail page is still completing successfully.

## 7. Gmail supports reports and explicitly approved cleanup

Gmail authorization is separate from AliaSpaces sign-in and from social posting
permission. Keep it in the isolated Google Cloud project **MyPersonas Gmail Connector**
(`genial-union-503010-q5`) and request only `openid`, `email`, and
`https://www.googleapis.com/auth/gmail.modify`. Do not request
`https://mail.google.com/`; Inbox Concierge has no immediate permanent-delete endpoint.

Authorized callback:

```text
https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth
```

The Testing app must list each mailbox owner as a Google test user. Testing refresh tokens
normally expire after seven days. Production use of `gmail.modify` requires Google's
applicable verification and restricted-scope review; server storage or transmission of
restricted Gmail data may require a security assessment. Sign-in email matched means the
ledger address matches the signed-in AliaSpaces email. Reports connected means an earlier
read-only grant remains usable for scans; Cleanup enabled means explicit `gmail.modify`
re-consent completed. Neither grants social posting or mail sending in MyPersonas.

## 8. Meta connects Facebook Pages and linked Instagram professional accounts

Migration 018 and `meta-oauth` provide the server-side authorization, Page discovery,
selection, immutable identity binding, Vault token storage, and shared-grant disconnect
foundation. They do **not** enable posting. Create a Meta Business app with Facebook
Login for Business, register this exact valid OAuth redirect URI, and keep the app secret
only in Supabase Edge Function secrets:

```text
https://nwsqyuucwzihruszocge.supabase.co/functions/v1/meta-oauth
```

The connector requests only `pages_show_list`, `pages_read_engagement`, and
`instagram_basic`. It supports Facebook Pages returned by `/me/accounts`; it never binds
or automates a personal Facebook profile. A linked Instagram target is offered only when
the Page reports an exact `instagram_business_account` professional-account id. Personal
Instagram consumer accounts are not eligible.

If Facebook Login for Business creates a login configuration, copy its Configuration ID
into `META_LOGIN_CONFIG_ID`. The connector then sends `config_id` and
`override_default_response_type=true` in the authorization request. Keep the permissions
inside that Meta configuration aligned with the same three read/discovery scopes.

The pinned default is Graph API `v25.0`. Set `META_GRAPH_API_VERSION` only when performing
a reviewed version upgrade:

```powershell
supabase secrets set META_GRAPH_API_VERSION="v25.0"
```

During development, app administrators, developers, and configured testers can exercise
the flow against assets they are permitted to manage. Broader production access still
requires the applicable Meta business verification, Privacy Policy, Terms, Data Deletion
instructions/callback, Live mode, and App Review/Advanced Access. Completing the local
OAuth flow is not proof that those production gates are approved.

Facebook Login authorization is shared by all Pages selected under one immutable Meta
user id. **Disconnect Meta** revokes and disconnects that complete grant, including every
Facebook Page and linked Instagram ledger bound to it. If Meta does not confirm
revocation, the service retains the encrypted credential and requires the owner to remove
MyPersonas in Facebook Business Integrations before explicitly acknowledging manual
revocation. Never describe removal of one local Page row as provider revocation.

Future publishing must be a separate reviewed release. It will need explicit
reauthorization for `pages_manage_posts` and/or `instagram_content_publish`, exact draft
approval and destination reconciliation, Meta review, and live Page/Instagram tests.
Neither migration 018 nor `meta-oauth` requests those permissions or exposes a publish
endpoint.

## 9. External publishing remains locked

Direct publishing currently supports only the native AliaSpaces feed. External account
rows can be planning/manual targets, but `post-bridge` and `run-publish-queue` return
`writeAccess: false` for every external destination.

An external destination remains locked until it has an official provider-specific write
connector, verified persona/account claim, exact assignment, required write scopes and app
approval, destination limits, and an auditable reconciliation path. Gmail mailbox access
is not reusable as a social publishing connector. Do not substitute passwords, cookies,
scraping, or browser-driving automation.

## 10. Release verification

After the staged code rollout, migration, secrets, cron jobs, and Pages release complete,
perform the unchecked automation section in
`MyPersonas.Online_v0/VERIFICATION.md`. A type check or deploy does not prove signed-in,
real-database, real-cron, quota-race, or live-browser behavior.

Before Pages goes live, call `erase-content` with `{"action":"capabilities"}` and a valid
JWT. It must report `protocolVersion: 2`, `contentOnly: true`, and `fullAccount: false`.
Exercise `keepAccount: true` only with a disposable test owner: its auth login must remain,
while its personas, posts, media, ledger, model keys, automation/chat data, profile display
name, and preferences are removed. If any OpenRouter backend exists, erasure must require
an `openrouter` acknowledgment that every corresponding provider-side key was revoked
first. Seed a credential-less X `connected` or post-grant `error` state and verify that
erasure independently requires a `twitter` acknowledgment after MyPersonas is revoked in
X Connected Apps. A legacy boolean acknowledgment may satisfy only OpenRouter; it must
never satisfy X. If the required providers change between the warning and deletion, the
409 response must return the current provider list and the page must display it again.
