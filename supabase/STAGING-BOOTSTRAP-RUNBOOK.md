# Isolated Supabase staging bootstrap and opaque-media release

Status: **local readiness package only.** Nothing in this document proves that a
Supabase project, Cloudflare Pages project, protected GitHub environment, Edge
Function, secret, DNS record, migration, or frontend is live.

This package builds a fresh, empty staging schema from a reviewed **schema-only**
production snapshot through migration 061, then gates 062 configuration/lock
before 063 and 064. It never copies Auth users, application rows, Storage
objects, Vault secrets, provider credentials, custom roles, cron rows, or the
production migration ledger. It never edits migration history by hand.

Supabase documents that `db dump` is schema-only by default and excludes managed
schemas/data/roles, and that target default privileges should be revoked before
a schema restore. This package uses the equivalent narrower `pg_dump
--schema-only --schema=public` contract so the database password can stay in
`PGPASSWORD` instead of a process argument. See the official
[CLI reference](https://supabase.com/docs/reference/cli/supabase-init) and
[backup/restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

## Why a reviewed predecessor is required

`supabase/migrations` is not a complete historical fresh-install chain. Replaying
that directory into a blank project would invent a state the repository cannot
prove. The older `MyPersonas.Online_v0/supabase-schema.sql` is also not current.
The safe staging predecessor is therefore the actual public schema at the
through-061 checkpoint, normalized into one **staging-only** baseline migration.

The validator rejects a source containing any 062–064 sentinel. If production
has already advanced past 061, stop. Restore an authorized production backup at
the through-061 point into an isolated Supabase project, pass that project ref
and endpoint to the exporter, and use
`-IConfirmIsolatedThrough061ProductionSnapshot`. Do not strip later objects from
a current dump and call it a predecessor.

The public-only dump omits app-owned objects attached to managed schemas. The
baseline therefore adds a small, reviewed empty-environment supplement:

- the two application triggers on `auth.users`;
- four empty Storage bucket configuration rows;
- the exact final through-061 policies for those empty buckets (including the
  two legacy public-read policies and excluding superseded browser-write
  policies); and
- `pgcrypto`, `citext`, and Supabase Vault prerequisites.

These rows are deterministic staging configuration, not copied production data.
Schedules, publications, singleton business controls, credentials, and content
remain absent/fail-closed. The baseline preflight refuses a target that already
has a user, Storage object, Vault secret, app relation/routine, bucket, or
MyPersonas cron job. The generated predecessor wraps preflight, prerequisites,
the normalized snapshot, empty configuration, and readback in one transaction.

## Required local/protected values

The protected runner needs Git, Node.js, a PostgreSQL client containing
`pg_dump` and `psql` compatible with the target Postgres major version, and a
reviewed pinned Supabase CLI. Record all four tool versions in release evidence;
do not download an unpinned executable inside the approval job.

Never put these values in the repository, command arguments, issue text, or
evidence JSON:

- `MP_PRODUCTION_DB_PASSWORD` — only for the read-only schema capture;
- `SUPABASE_ACCESS_TOKEN` — staging CLI link/push in the protected runner;
- `SUPABASE_DB_PASSWORD` — staging database password;
- `MP_STAGING_SUPABASE_ANON_KEY` — public in the eventual browser artifact, but
  kept environment-specific and out of source; and
- `MP_STAGING_TURNSTILE_SITE_KEY` — public provider site key for the staging
  hostname, also kept environment-specific.

The protected environment supplies non-secret variables for the exact staging
project ref, session-pooler/direct host, database user, and reviewed evidence
references. Use a session-pooler hostname with `postgres.<ref>` when direct IPv6
is unavailable. The scripts accept no connection URL and bind the host/user to
the exact 20-character project ref.

## Gate 0 — create the external staging boundaries

Owner/provider actions, not performed by these scripts:

1. Create a new Supabase project with a unique database password. Record its
   exact 20-character ref. It must not be `nwsqyuucwzihruszocge`.
2. Keep Auth users, Storage, Vault, cron, functions, and test data empty.
3. Prepare the exact frontend origin
   `https://mypersonas-staging.pages.dev`. The optional later custom origin is
   exactly `https://staging.mypersonas.online`. No wildcard `*.pages.dev` origin
   is accepted.
   Before deploying any browser-facing Edge Function, set
   `MYPERSONAS_DEPLOYMENT_ENVIRONMENT=staging` and set
   `MYPERSONAS_STAGING_PROJECT_REF` to this separate project's exact
   20-character ref. Supabase injects `SUPABASE_URL`; the function boundary
   requires that URL to equal `https://<that-ref>.supabase.co` and then trusts
   only the two exact reviewed staging origins above. It never trusts a wildcard,
   an operator-supplied free-form origin, or a production origin. Missing,
   malformed, or crossover configuration fails closed during function startup.
4. Put the Pages staging host behind Cloudflare Access. Authorize only named
   testers. Confirm the Access callback itself does not leak a Supabase session.
5. Reserve `https://media-staging.mypersonas.online` for the staging media
   gateway. It must route only to the staging project.
6. Create GitHub environment `supabase-staging` with required reviewers,
   environment-scoped secrets, deployment-branch restrictions, and no production
   credential. Do not let the staging environment self-approve or access the
   production database secret.

The repository now includes a protected, manually dispatched function-deployment
workflow whose staging job declares `environment: supabase-staging` and whose
production job declares `environment: production`. It never applies migrations.
The database bootstrap remains an operator-run, evidence-producing procedure so
a generic `db push` cannot replay the repository's incomplete historical chain.

## GitHub protection contract

Before any migration-bearing branch reaches `main`, disable the Supabase GitHub
App's automatic migration integration. It has previously applied main-branch
migrations before CI completed. Do not push the release branch until that
provider-side switch is read back as disabled.

Create `supabase-staging`, `production`, and `github-pages` environments. For
each environment:

- require a named reviewer other than the person dispatching the job and enable
  prevention of self-review;
- disallow administrator bypass for ordinary releases;
- allow only `release/*` for `supabase-staging`, and only the protected `main`
  branch for `production` and `github-pages`;
- keep every token/ref secret environment-scoped, never repository- or
  organization-scoped; and
- record the reviewer, dispatch actor, commit, environment, and readback without
  recording any credential value.

GitHub requires the reviewer to have repository read access. A single GitHub
account cannot satisfy the no-self-review requirement: add a second trusted
account/team before activation. Also verify repository visibility and plan
eligibility; GitHub documents that required reviewers on Free, Pro, and Team are
limited to public repositories.

The `supabase-staging` environment contains only
`STAGING_SUPABASE_ACCESS_TOKEN` and `STAGING_SUPABASE_PROJECT_REF` for the
function workflow. The `production` environment contains only the corresponding
`PRODUCTION_...` pair. The `github-pages` environment contains the public
variable `PRODUCTION_TURNSTILE_SITE_KEY`; the Turnstile secret never enters
GitHub Pages. Database passwords used by this runbook remain in the approved
secret-bearing runner and are never available to a frontend deployment job.

Protect `main` with a pull-request ruleset that blocks force-pushes and deletion,
dismisses stale approvals, and requires these exact CI check names:

1. `Unit tests (pure helpers)`
2. `Deno type-check edge functions`
3. `Billing migration runtime contract`
4. `Opaque media and operations migration runtime contracts`
5. `Repository credential scan`
6. `Frontend script syntax`

GitHub may not offer a check for selection until it has run once. Run the pinned
CI workflow on the release branch first, then bind these exact names; do not
substitute a similarly named or skipped job.

## Gate 1 — capture and review the through-061 predecessor

Run only while the source is independently verified as through 061:

```powershell
$env:MP_PRODUCTION_DB_PASSWORD = '<protected prompt or environment secret>'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging-bootstrap/Export-Through061Schema.ps1 `
  -OutputDirectory staging-bootstrap-evidence/capture-061 `
  -IConfirmReadOnlyProductionSchemaExport
```

For a confirmed point-in-time snapshot, also pass its `-SourceProjectRef`,
`-ProductionDatabaseHost`, `-ProductionDatabaseUser`, and
`-IConfirmIsolatedThrough061ProductionSnapshot`.

Review all of the following before approval:

- `source-public-schema.validation.json` is `ok:true`;
- the baseline contains no table-data section, `COPY`, top-level DML, role DDL,
  credential-bearing URL, key/token signature, psql include, or 062–064 object;
- `capture-manifest.json` records the expected Git commit, production/snapshot
  ref, raw/normalized/baseline hashes, and matching 062–064 pair hashes;
- the baseline begins with the fresh-target abort guard;
- the only top-level `INSERT` statements are the four named empty staging bucket
  configuration rows; and
- the reviewer records the full baseline SHA-256 outside the artifact directory.

If validation fails, the exporter deletes the SQL artifacts and retains only a
rule-level report/log. Do not bypass the rule.

## Gate 2 — read-only target preflight and apply through 061

Run the preflight first; it has no Supabase CLI write:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging-bootstrap/Invoke-StagingBootstrap.ps1 `
  -Phase Preflight `
  -StagingProjectRef '<20-char-staging-ref>' `
  -ConfirmedStagingProjectRef '<same-ref>' `
  -DatabaseHost '<exact-direct-or-session-pooler-host>' `
  -DatabaseUser 'postgres.<same-ref>' `
  -EvidenceDirectory staging-bootstrap-evidence/staging-run
```

After a protected reviewer approves the baseline hash, use the exact token shown
by the script contract:

```text
APPLY-THROUGH-061:<staging-ref>:<first-12-lowercase-baseline-hash>
```

Then run `-Phase ApplyThrough061` with `-BaselinePath`,
`-ExpectedBaselineSha256`, and `-ApprovalToken`. The script:

1. captures a schema-only before image;
2. creates a new temporary Supabase workdir containing only the reviewed staging
   baseline;
3. links only to the confirmed non-production ref using protected environment
   values;
4. saves a `db push --dry-run` transcript;
5. applies through the normal Supabase migration path so the staging ledger
   records the baseline (no `migration repair` or manual ledger write);
6. reads back the 061 sentinels, ACLs, triggers, empty buckets, and zero
   user/object/secret counts; and
7. captures a schema-only after image and hashes both.

The custom baseline version `20260823035000` exists only in this isolated
staging ledger. Never copy it into production or the repository's production
migration directory.

## Gate 3 — apply 062, then configure and lock

Approve exact token `APPLY-062-AND-LOCK:<staging-ref>`, and supply two distinct,
bounded change/ticket references. Run `-Phase Apply062AndLock` with the baseline
path/hash plus `-ConfigurationEvidence` and `-LockEvidence`.

The phase refuses to proceed unless through-061 readback is still exact. It
checks canonical/timestamp byte equality, makes only 062 pending, records the
dry run, applies 062, then calls the service-only configure and lock RPCs with:

- environment: `staging`;
- Supabase origin: `https://<staging-ref>.supabase.co`; and
- media origin: `https://media-staging.mypersonas.online`.

The SQL readback requires a locked row, exact origins, and no browser-role table
or RPC access. A locked row is intentionally immutable. Never unlock/rewrite it
with ad hoc SQL.

## Gate 4 — apply and verify 063–064

Approve exact token `APPLY-063-064:<staging-ref>`, then run
`-Phase Apply063And064` with the same baseline path/hash. The temporary workdir
contains exactly the staging baseline plus 062, 063, and 064—never 065–067. The
remote ledger makes only 063 and 064 pending. Readback verifies:

- the locked staging environment did not change;
- opaque approved-media and legacy-remediation functions/tables exist;
- Auth users, Storage objects, Vault secrets, and legacy-reference rows remain
  zero; and
- before/after public-schema hashes are recorded.

This is schema readiness, not a passed runtime/privacy release.

## Gate 5 — reviewed billing and operations schema release (068 and 069 only)

Do not enter this gate until Gate 4 evidence is green and the protected runner
can read back the exact isolated staging ledger. The release intentionally skips
deferred local work 065–067. Those versions are neither prerequisites nor
approved migrations, and the generated workdir rejects them by filename and by
remote-ledger state.

The apply must run inside GitHub environment `supabase-staging`, with required
reviewers and a protected `release/*` ref. Configure these protected values:

- `MP_STAGING_PROTECTED_ENVIRONMENT=supabase-staging`;
- `MP_STAGING_APPROVED_PROJECT_REF=<exact 20-character staging ref>`;
- `SUPABASE_ACCESS_TOKEN` scoped to the staging project; and
- `SUPABASE_DB_PASSWORD` for that same project.

The environment name is a fail-closed script assertion, not proof that GitHub
review protection exists. Retain the GitHub deployment approval, protected-ref
evidence, environment configuration, and distinct change/reviewer references
outside the generated database evidence. Use a reviewer other than the runner
where staffing permits; a single-owner exception must be documented and must
not be described as separation of duties. Production credentials must not be
available to this environment.

First calculate and independently review the canonical/timestamp-mirror hashes
for migrations 068 and 069. The exact approval token is:

```text
APPLY-068-069:<staging-ref>:<first-12-lowercase-068-hash>:<first-12-lowercase-069-hash>
```

Then run the reviewed phase with distinct bounded evidence references:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging-bootstrap/Invoke-StagingBootstrap.ps1 `
  -Phase Apply068And069 `
  -StagingProjectRef '<20-char-staging-ref>' `
  -ConfirmedStagingProjectRef '<same-ref>' `
  -DatabaseHost '<exact-direct-or-session-pooler-host>' `
  -DatabaseUser 'postgres.<same-ref>' `
  -BaselinePath '<reviewed-staging-predecessor.sql>' `
  -ExpectedBaselineSha256 '<64-lowercase-hex-baseline-hash>' `
  -ReleaseChangeEvidence 'change:MP-STAGING-068-069' `
  -ReleaseReviewEvidence 'review:independent-review-record' `
  -ApprovalToken '<exact-token-above>' `
  -EvidenceDirectory staging-bootstrap-evidence/staging-run
```

Before any write, the phase requires all of the following:

- three-way exact project-ref agreement between the request, typed
  confirmation, and protected environment value;
- the production ref rejected by the shared staging guard;
- exact remote ledger `20260823035000`, 062, 063, and 064—nothing else;
- locked 062 origins and complete 063/064 objects;
- no Auth users, Storage objects, Vault secrets, billing objects, or operations
  inbox object;
- byte-identical canonical/timestamp mirrors for 062–064 and 068–069; and
- an exact workdir containing only the staging baseline, 062–064, 068, and 069.

The recorded pre-push migration list and dry run must show only 068 and 069 as
pending. The phase then applies through the normal migration path, never
`migration repair`, reads the ledger and schema back, and captures before/after
normalized schema hashes. The post-readback requires:

- exact ledger baseline + 062–064 + 068 + 069, with 065–067 absent;
- billing enforcement, checkout, and live mode all false;
- exactly the reviewed $20/week, $50/month, and $333/year unbound test catalog;
- zero customers, trial claims, Checkout reservations, subscriptions, webhook
  events, financial holds, duplicate remediations, or reconciliation alerts;
- private billing tables inaccessible to browser roles and reviewed RPC grants;
- the 069 AAL2 staff inbox and bounded service maintenance functions installed;
- no operations-maintenance provider schedule; and
- the locked staging media environment unchanged.

This gate installs schema only. It does not bind Stripe Price IDs, set secrets,
deploy Edge Functions, enable Checkout/enforcement, create test users, schedule
maintenance, send alerts, or affect production. Run `-Phase Verify068And069`
for another read-only pre-data schema check; it keeps the same exact
non-production ref confirmation and readbacks. After test users or media exist,
use the runtime/privacy evidence harnesses instead of this zero-data verifier.

## Matching staging frontend artifact

Repository `index.html` deliberately remains the production source and currently
contains production runtime values. Do not serve that file from staging. Generate
an ignored artifact after setting the staging public keys:

```powershell
$env:MP_STAGING_SUPABASE_ANON_KEY = '<staging publishable/anon key>'
$env:MP_STAGING_TURNSTILE_SITE_KEY = '<site key bound to exact staging host>'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1 `
  -StagingProjectRef '<20-char-staging-ref>' `
  -StagingSiteOrigin 'https://mypersonas-staging.pages.dev' `
  -OutputDirectory staging-bootstrap-evidence/pages-artifact
```

The generator copies only an exact reviewed top-level/runtime asset allowlist;
it does not recurse over the repository or copy by extension. Persona fixtures,
design previews, marketing drafts, Markdown, SQL, tests, workflows, `.git`, and
archives are absent. The production-configured Personas desktop ZIP/current
catalog entry is excluded, and its staging navigation target is a no-download
explanation. A newly added source asset cannot enter staging until this
allowlist and its integration test are deliberately reviewed.

It replaces four runtime configuration fields (Supabase URL, publishable key,
media origin, and Turnstile site key), five canonical/social metadata origins,
and every copied textual production project/media/site marker; this includes
provider callback examples and the provenance module's canonical Storage host.
It injects a runtime guard and freezes `CONFIG`. The
artifact renders only when `window.location.origin` is the one exact selected
host and the Supabase/media origins are the exact staging values. It rejects the
production project, production key, production media origin, unknown
`pages.dev` host, wildcard, dirty output directory, existing evidence sibling,
or source overwrite.

The exact `-OutputDirectory` is the only directory eligible for Pages upload.
It contains no `CNAME`, sitemap, or evidence file. Every HTML page receives
`noindex,nofollow,noarchive,nosnippet`; `robots.txt` disallows all and `_headers`
adds the matching `X-Robots-Tag`, no-referrer, and no-store controls. The web
manifest uses the exact staging `id`, `start_url`, `scope`, and shortcut URLs.
The staging service worker only clears same-origin AliaSpaces shell caches,
claims clients, and unregisters itself; it has no fetch handler.

Two evidence siblings are generated beside, never inside, the upload directory:

- `<OutputDirectory>.staging-artifact-files.json` lists every upload-relative
  path, byte length, and SHA-256; and
- `<OutputDirectory>.staging-artifact-manifest.json` binds that manifest hash,
  source commit, exact origins, index hash, public-key hash, and the noindex/PWA/
  CNAME/desktop-download policy. It stores no public-key value or service secret.

Reviewers must compare the listed path set and hashes to the directory
immediately before upload and upload only that directory, not its parent. The
generator does not create or deploy a Pages project.

Before upload, independently scan the artifact for all production project,
site, media, CONFIG, desktop-download, and service-secret markers and verify the
evidence manifest hash. Configure every staging Edge Function's exact CORS/OAuth
origin and callback to the selected host. Provider consoles must list the exact
callback; do not add `*.pages.dev`. Keep media producers disabled until the
protected gateway and 062–064 consumer readback pass.

## Function and provider gates after schema readiness

In a separately reviewed release, configure staging-only values for
`MYPERSONAS_DEPLOYMENT_ENVIRONMENT=staging`,
`MYPERSONAS_STAGING_PROJECT_REF=<the exact protected staging ref>`, CAPTCHA,
SMTP, OAuth state/callbacks, request-review allowed origin, gateway HMAC secret,
cron secrets, and any provider test credentials. Never reuse production secrets.
Confirm injected `SUPABASE_URL` is exactly
`https://<MYPERSONAS_STAGING_PROJECT_REF>.supabase.co`, then prove preflights and
requests from both reviewed staging origins succeed while production, wildcard,
`null`, missing, and other origins fail for every browser-facing function in the
selected deploy scope. A project-ref or environment crossover must fail closed.
Deploy opaque consumers/foundation before producers in the order documented in
`MyPersonas.Online_v0/OPAQUE-PUBLIC-MEDIA-DELIVERY.md`.
For a fresh project, verify the foundation, gateway, and exact noindex frontend
shell, then use the staging-only `opaque-media-intake-pilot` workflow scope to
deploy only authenticated `media-ingest`. That narrow pilot supplies disposable
upload/crop fixtures for the signed-in matrix below. Keep `gemini-image` disabled
until the complete matrix is green; production has no intake-pilot scope.

Required negative evidence:

- direct `public-media`/`approved-media` Edge calls fail closed;
- the staging gateway never routes to the production project;
- the Pages artifact never calls the production Supabase/media origins;
- missing/wrong origin, Turnstile, gateway secret, or project lock fails closed;
- no scheduler, publication, automation, or provider mutation is active; and
- no production credential is visible to the staging protected environment.

## Signed-in mobile and two-account privacy matrix

Only after schema, functions, gateway, Access, and exact frontend artifact are
green:

1. Create two new staging-only email users A and B. Do not clone production
   accounts. Enroll required MFA/recovery separately.
2. Use a real mobile browser for A and a separate device/private profile for B.
   Cloudflare Access and Supabase sessions must be distinct.
3. Give each one persona and media. Exercise upload/crop, owner preview, publish,
   opaque public fetch, reload, back/forward, sign-out/sign-in, and account swap.
4. Prove A cannot list, preview, resolve, infer, cache, or fetch B's registry row,
   raw Storage path, draft/stale/archived asset, owner UUID correlation, signed
   blob, or rotated opaque id. Repeat B-to-A.
5. Inspect DOM, copied links, network URLs, console, local/session storage,
   service-worker/cache storage, and browser history for raw paths or the other
   account's identifiers.
6. Run the cache-race test: start A preview/fetch, sign out before completion,
   sign in as B, and prove the delayed A result is aborted, revoked, and never
   hydrated into B's view.
7. Test narrow mobile widths, orientation change, background/resume, offline/
   reconnect, and expired access/refresh tokens.
8. Delete both staging test users/content under the approved retention flow and
   record erasure readback. Do not run the pre-data bootstrap verifier after test
   users exist; use the runtime/privacy harnesses instead.

## Rollback and evidence boundary

Every baseline and canonical migration is transaction-bounded. A failed baseline
leaves the fresh target unchanged. Later successful phases are forward-only and
their schema before/after images, hashes, CLI dry run/apply transcript, SQL
readback, target ref, and Git commit remain in the ignored evidence directory.

There is no automated destructive rollback. Before handle issuance/finalization,
pause the release and roll back only functions/frontend through their reviewed
deployment mechanism. If the isolated database is unusable after 062 lock,
obtain owner approval to delete/recreate the **exact staging project** and repeat
from the reviewed baseline. Never run `supabase db reset --linked`, never repair
the ledger by hand, never point staging at production, and never make a private
bucket public as a recovery shortcut.

## Final protected-environment checklist

- [ ] Source independently verified at through 061; capture validator green.
- [ ] Full baseline hash recorded and approved by a reviewer other than runner.
- [ ] Fresh non-production ref typed twice; database host/user bound to it.
- [ ] Production ref/secret absent from the staging environment.
- [ ] Baseline dry run names exactly one staging-only migration.
- [ ] Through-061 readback and zero data/secret counts green.
- [ ] 062 pair hash green; exact staging origins configured and locked.
- [ ] 063/064 pair hashes green; 065–067 absent; final schema readback green.
- [ ] Protected `supabase-staging` approval and protected `release/*` ref
      evidence retained; typed and environment-pinned refs match exactly.
- [ ] 068/069 mirror hashes and approval token independently reviewed; dry run
      lists only 068 and 069 pending.
- [ ] 068/069 readback green in shadow/test-safe state; 065–067 absent, no
      provider bindings, Edge Function deployment, schedules, customers, or
      billing events.
- [ ] Exact Pages artifact generated for one allowed host; Access enabled.
- [ ] Public file-manifest paths/hashes match exactly; no CNAME/sitemap/archive,
      production marker, evidence file, or production desktop download is in
      the upload directory.
- [ ] Noindex/robots/headers, staging web-manifest URLs, and PWA teardown verified.
- [ ] `MYPERSONAS_DEPLOYMENT_ENVIRONMENT=staging`, the exact
      `MYPERSONAS_STAGING_PROJECT_REF`, and injected `SUPABASE_URL` agree;
      both reviewed staging-origin preflights pass and production/wildcard/null/
      missing/other-origin probes fail for every browser-facing deployed function.
- [ ] Exact CORS/OAuth/Turnstile/gateway provider configuration approved.
- [ ] Consumer functions/gateway green before any producer.
- [ ] Signed-in mobile and unrelated two-account privacy matrix green.
- [ ] Evidence retained under policy; no SQL dump or log contains a credential.
- [ ] Separate owner approval obtained before any production action.
