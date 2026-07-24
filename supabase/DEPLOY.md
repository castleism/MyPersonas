# AliaSpaces / MyPersonas — server deployment

The browser app is hosted by GitHub Pages. Supabase provides authentication, the
database, Vault, OAuth connectors, scheduled drafting, native publishing, and fan chat.
This is a deployment runbook for the repository state. The 2026-07-24 production rollout
applied migration 016, deployed the matching mailbox/Gmail/erasure functions, and enabled
the mailbox cron. A signed-in Gmail re-consent and real mailbox action remain explicit
owner-run smoke tests.

## 1. Link the Supabase project

```powershell
supabase login
supabase link --project-ref nwsqyuucwzihruszocge
```

Use a Supabase-supported CLI installation method. Do not install the CLI globally with
`npm install -g supabase`.

## 2. Pause workers and apply migrations 013–016 before the release

Migration 011 moves existing plaintext model keys into Supabase Vault, clears the legacy
`ai_backends.api_key` values, and revokes direct browser writes to `ai_backends`. Deploy
the new Edge code first. Its model-key resolver accepts the legacy column before the
migration and the service-only Vault RPC afterward, so the transition does not strand an
existing model connection.

Migrations 011–016 are applied on the current production project and must remain
immutable. Migration 013 added service-only least-recently-served generation, change-aware
prompt-input limits, deterministic input blocking, and a 100-active-schedule cap.
Migration 014 added the authenticated, atomic persona/profile bundle save used by the
page. Migration 015 added the independent service-only X OAuth/Vault boundary, and
migration 016 added the independent mailbox report/action boundary. Pause/unschedule all
workers before applying pending migrations or replacing their code.

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

Apply all pending migrations through 016 while the workers remain paused. Migration 015
must be live before the X function; migration 016 must be live before either mailbox
function or the Gmail permission upgrade. Then deploy the matching generator, mailbox
services, and X connector:

```powershell
supabase functions deploy run-tasks --no-verify-jwt
supabase functions deploy mailbox-manager
supabase functions deploy run-mailbox-jobs --no-verify-jwt
supabase functions deploy gmail-oauth --no-verify-jwt
supabase functions deploy twitter-oauth --no-verify-jwt
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
`gmail-oauth`, `twitter-oauth`, and `sitemap` are public at the gateway by design and
enforce their applicable checks in code.

## 3. Apply the database changes

For a new project, run `MyPersonas.Online_v0/supabase-schema.sql`. The fresh-install
snapshot contains the base schema (including the 008–010 account-ledger, connection, and
Gmail structures) plus the immutable 001–012 history and migrations 013–016. For the existing
project, run every unapplied file in `MyPersonas.Online_v0/sql-updates` in numeric order.
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

Approval hashes the exact text, media, persona, destination, platform, format, and publish
time. Editing any protected field invalidates the approval and removes the draft from the
queue. Native publication then rechecks the current pause, claim, binding, autonomy,
destination mode, content type, quiet hours, daily cap, and hash in one database
transaction that inserts the post, finalizes the draft, and writes audit history.

- **L2 / approval target:** exact approval prepares the draft, but the queue worker waits.
  The owner must press **Publish now**, which calls the authenticated `post-bridge`.
- **L3 / auto target:** an exact owner-approved native draft may publish automatically
  when its scheduled time is due. L3 still cannot approve its own draft.

`run-publish-queue` processes only due, exact-approved native drafts on enabled L3 `auto`
targets. It deliberately defers L2 `approval` targets.

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
    body := '{}'::jsonb
  );
$$);
```

Before scheduling, confirm Vault has exactly one secret named
`mypersonas_cron_secret`. Check `cron.job`, `cron.job_run_details`, and all worker logs
after scheduling. Resume only after direct authenticated worker probes return HTTP 200;
zero due work is a valid result.

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

## 8. External publishing remains locked

Direct publishing currently supports only the native AliaSpaces feed. External account
rows can be planning/manual targets, but `post-bridge` and `run-publish-queue` return
`writeAccess: false` for every external destination.

An external destination remains locked until it has an official provider-specific write
connector, verified persona/account claim, exact assignment, required write scopes and app
approval, destination limits, and an auditable reconciliation path. Gmail mailbox access
is not reusable as a social publishing connector. Do not substitute passwords, cookies,
scraping, or browser-driving automation.

## 9. Release verification

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
