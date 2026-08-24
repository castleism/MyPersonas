# Opaque public media delivery

Status: **local NO-GO security checkpoint; not applied, deployed, backfilled,
or verified live.** Migrations 062/063 and the companion preview-only remediation
migration 064 are forward-only and must follow migration 061. The protected
first-party origins, Edge secret boundary, and AWS/Wix package
are implemented only as reviewable local source; no certificate, stack, secret,
DNS record, or live endpoint exists yet. The approved-provider delivery redesign
is complete and tested locally but is not applied or live. Rich image/video
widgets and video backgrounds remain disabled.

## Security contract

Public profile, post, and album media use this shape:

`https://media.mypersonas.online/persona/v1/<random-v4-uuid>`

Approved provider renditions use a separate namespace:

`https://media.mypersonas.online/approved/v1/<random-v4-uuid>`

The UUID is generated independently for each immutable asset. It contains no
owner id, persona id, content hash, filename, or storage prefix. The private
`persona_public_media_handles` correlation table is unavailable to `anon` and
`authenticated` roles.

Migration 062 also creates one private `media_environment_config_062` row. SQL
URL helpers and every media-producing/consuming Edge Function require the row
to be reviewed and locked. The migration ships the production values
`https://nwsqyuucwzihruszocge.supabase.co` and
`https://media.mypersonas.online` as **unlocked defaults**, not as permission to
use them. Staging must replace both values with its own exact Supabase project
origin and its own `*.mypersonas.online` media origin. A staging record is
rejected if either value overlaps production. Once locked, it cannot be edited
through the service API; a mismatch between the record and the function's exact
`SUPABASE_URL` disables media operations.

CloudFront/WAF accepts only the exact branded host and path, rejects viewer query
strings and alternate hostnames, strips any viewer-supplied gateway header, and
rewrites the path to the Supabase Edge origin. CloudFront adds a configured
  `X-MyPersonas-Media-Gateway` origin header. The `public-media` and
  `approved-media` functions disable
itself when `PUBLIC_MEDIA_GATEWAY_SECRET` is missing or malformed and returns a
generic 404 to direct calls without a current/previous secret match.

The public-media function does not redirect. For every gateway-authenticated GET
request it:

1. accepts one exact UUIDv4 path with no query, fragment, encoded segment, Range,
   credentials, or extra path component;
2. asks the service-only resolver for the current asset;
3. requires an active handle and active canonical provenance;
4. requires the persona page to be current and published;
5. matches the current consumer, slot, asset id, public id, and provenance hash
   to the exact stored publication-review manifest;
6. downloads through the service role, enforces the 15 MiB maximum and registered
   length, then recomputes SHA-256 before returning bytes; and
7. emits controlled `no-store`, `nosniff`, CSP, referrer, MIME, and length headers.

It returns generic, bounded errors. It never sends a Storage redirect, filename,
owner id, persona id, Storage path, registry metadata, or stable content-hash
ETag. Archive or flag makes the reviewed revision stale and revokes the active
handle in the same transaction. Reactivation requires a new service handle and
new owner review. Rotation revokes the prior opaque id, rewrites references,
and also requires review.

## Existing and new media

New `media-ingest` calls keep the immutable Storage URL only in the private
registry. They issue an opaque handle service-side and return:

- `publicUrl`: the value saved to persona/public-content fields;
- `assetId`: the authenticated owner-preview selector; and
- the existing safe hash, MIME, byte count, and provenance fields.

The browser renews preview bytes through authenticated `owner-media-preview`
using `assetId`. It never receives a raw or signed Storage URL or treats a
server-authored preview URL as persistent state.
The UID-scoped cache aborts in-flight requests, revokes blob URLs, blanks hydrated
DOM media, and generation-checks delayed completions on every account transition.
The stable Storage path is no longer returned as `path`. Gemini forwards the same
opaque URL and asset id. Public rendering accepts exact opaque URLs and
grandfathered non-Storage HTTPS assets, but fails closed rather than placing an
owner-correlating project Storage path in the public DOM. Music/live embeds,
persona links, album destinations, link widgets, and active affiliate/product
destinations are external-HTTPS-only; public rendering and affiliate redirects
fail closed on project Storage and both media gateway namespaces.

Old canonical assets need two distinct service-only operations:

- `backfill_persona_public_media_handles_service(limit)` issues missing opaque
  ids without changing pages.
- `cutover_persona_public_media_batch_service(limit)` replaces bound profile,
  post, and album references. This intentionally makes affected persona pages
  draft/stale. Each page must be reviewed and published again by the owner.

After every reference is cut over, every current page is reviewed, and the
readiness report is clean, `finalize_opaque_public_media_bucket_service()` makes
`persona-media` private. That disables historical direct owner-path URLs even if
one survives in an old log or cache. There is deliberately no browser callable
operation that can make the bucket public again.

## Release sequence

Do not split this sequence across an unattended production window.

For a new isolated Supabase project, use the guarded schema-only predecessor,
protected apply phases, exact staging frontend artifact, and rollback-evidence
procedure in `../supabase/STAGING-BOOTSTRAP-RUNBOOK.md`. That runbook deliberately
excludes production data/secrets and migrations 065–067; it does not itself
create or deploy any external resource.

1. Back up the database and Storage metadata. Record current published persona
   counts, raw owner-path reference counts, bucket visibility, and migration
   ledger hashes.
2. Verify reviewed migration 061, then apply canonical migration 062 (or its
   byte-identical timestamp mirror) in isolated staging. Before any handle is
   issued, call `configure_media_environment_service` with:
   `staging`, the exact staging `https://<20-char-ref>.supabase.co` origin, the
   separately routed staging media origin (for example
   `https://media-staging.mypersonas.online`), and a bounded ticket/change-set
   evidence reference. Call `lock_media_environment_service` with those exact
   three expected values plus independent lock evidence. Read back
   `media_environment_config_service`; an anonymous or authenticated call must
   be denied. Then apply 063 and 064 in order. Production uses the same two-step
   configure-and-lock call with the fixed production defaults. Do not copy a
   production database after this lock and use it as staging.
3. Obtain separate owner approval for the filled AWS cost worksheet, `us-east-1`
   ACM certificate, CloudFormation change set, secret configuration, and Wix DNS
   records described in `../infrastructure/aws/media-gateway/README.md`. Do not
   create or connect them from this source-review step.
4. Configure the same secret out of band in Supabase and the reviewed CloudFront
   origin, then deploy foundation/consumers:
   `public-media`, `approved-media`, `owner-media-preview`,
   `legacy-media-remediation`, `compose-post`, `approve-post-draft`, `meta-post`,
   `run-post-queue`, `delete-account`, and `erase-content`. Do not deploy a
   producer yet.
   The staging gateway origin must be that staging project's exact Supabase
   hostname, never the production hostname. The staging frontend must set all
   three matching public values in `CONFIG`: `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, and `PUBLIC_MEDIA_ORIGIN`. The anon key is public; the
   service key and configuration evidence remain server-side.
   A fresh empty staging project needs authenticated intake before upload/crop
   QA can exist. After this foundation and the exact noindex frontend shell are
   verified, the staging-only `opaque-media-intake-pilot` workflow scope may
   deploy **only** `media-ingest`. Use it to create bounded disposable AAL2 test
   assets and complete the owner/viewer/mobile/two-account matrix. The later
   staging producer scope deploys `gemini-image` only after that evidence.
   Production has no intake-pilot scope and retains the reviewed
   `gemini-image`, then `media-ingest` order after full staging approval.
5. Verify direct Edge calls fail closed and the branded endpoint passes exact
   host/path/query/TLS/WAF checks. Only after explicit DNS-cutover approval,
   deploy the matching Pages frontend and complete live signed-in owner/viewer,
   reload, mobile, and two-account A-to-B cache-race verification.
6. Only after that evidence, deploy producers in order: backward-compatible
   `gemini-image`, then `media-ingest` last.
7. Run the full Node suite and all 062-064 disposable PostgreSQL harnesses. Exercise
   malformed ids, query/fragment/encoded paths, byte mismatch, oversize response,
   wrong asset/persona, draft/stale review, archive, flag, and rotation.
8. Run the AAL2 owner cleanup inventory/list/private-preview pilot. This release
   has no declare/import/rewrite/clear action: do not imitate one with SQL or raw
   Storage operations. Build, test, and separately approve that second slice.
9. Call the service-only handle backfill in bounded batches. Inspect readiness.
   Legacy `media` bucket values are not eligible for URL-only backfill: import
   only after bytes, hash, owner, persona, slot, AI declaration, and provenance
   are verified, or have the owner explicitly clear/replace them.
10. Cut over a non-public pilot persona, review it, publish it, and verify opaque
   delivery on desktop/mobile while its raw Storage URL is absent from the page,
   DOM, request URLs, copied links, and public API projections used by the app.
11. Cut over remaining assets in bounded batches. This unpublishes affected pages;
   obtain individual owner approval and republish each exact revision.
12. Complete signed-in mobile and unrelated two-account privacy testing. Confirm
   one account cannot discover another owner's registry, Storage path, persona
   correlation, draft asset, archived asset, or rotated id.
13. When every public/private/draft/scheduled/affiliate raw-reference count is
   zero, `missing_active_handles=0`, `legacy_media_bucket_references=0`,
   `blocked_external_reference_violations=0`, and
   `stale_published_pages=0`, call the finalizer and confirm the bucket is private.
14. Re-run the full readback, archive/rotation tests, public cache tests, and WAF
    observation before considering rich media widgets for a separate release.

## Operations and rollback boundary

The resolver and proxy fail closed. A function outage produces missing media,
not a direct Storage fallback. Do not add such a fallback.

An unlocked, malformed, or cross-project environment record is also a deliberate
fail-closed outage. Roll back functions/frontend if needed, but do not unlock or
rewrite the row in place. Correcting a locked environment requires a separately
reviewed forward migration so the original evidence remains auditable.

Before bucket finalization, code rollback can restore the previous frontend while
the service cutover is paused. After finalization, raw public URLs intentionally
stop working; recovery is to restore the reviewed opaque proxy or perform a DBA
incident decision, not to expose the bucket from browser code.

The database emergency limiter admits at most 6,000 verified requests/minute
site-wide and 600/minute for one active handle, removes stale handle counters,
and lets random UUID floods touch only one global row. These defaults are not a
substitute for upstream abuse controls and require realistic burst/load testing.
The function rejects HEAD and Range requests, so video delivery is not
production-ready.

## Remaining release blockers (2026-08-23)

- The first-party CloudFront/WAF gateway, secret-gated Edge origin, and Wix DNS
  runbook exist only in local source. Publication and producers stay fail-closed
  until owner cost/change-set approval, ACM, out-of-band secrets, deployment,
  DNS, exact endpoint verification, rate/load testing, and WAF attestation.
- Approved-provider migration 063, Edge proxy, exact Facebook/Instagram/X crops,
  retry/revocation checks, and erasure are green locally. They still require
  staging apply, gateway routing, real provider fetch tests, release evidence,
  and a separate manual `post-approved-media` bucket finalizer.
- Confirm or migrate first-party values in owner-only research annotations,
  repost/provider URLs, and content-variant `media_plan` JSON. These are an
  explicit follow-up; native research media needs asset ids, not raw URLs.
- The raw-URL runtime boundary can receive an already-normalized `Request.url`.
  Exact raw-string checks prevent application-level aliases but cannot prove what
  an upstream router normalized before the function was invoked.
- Upstream WAF evidence must cover the actual media endpoint, not merely
  `mypersonas.online`. No automatic inbound DDoS protection is claimed.

## Read-only production inventory (2026-08-23)

Latest aggregate-only audit: 0 published personas/businesses and no release-
candidate references. The public `media` bucket has 408 objects, all UUID-shaped;
`persona-media` has 23, all UUID-shaped; `post-approved-media` has 0. Stored
first-party references total 120: 28 avatars, 28 banners, 27 backgrounds, 27
feed headers, and 10 album thumbnails. These legacy `media` values are a
quantified NO-GO. Migration 062 counts them but deliberately does not infer
ownership/provenance or auto-rewrite them. Verified-byte import/re-ingest or
explicit owner replacement is required. Frame-by-frame AI marking, safe byte-
range service, backfill evidence, and mobile privacy evidence remain prerequisites
for rich video/image widgets.

## Verification artifacts

- `tests/opaque-public-media.test.mjs`
- `tests/media-gateway-infrastructure.test.mjs`
- `tests/sql/062-opaque-public-media-runtime.sql`
- `tests/migration-release-parity.test.mjs`
- `supabase/functions/_shared/public-media.ts`
- `supabase/functions/public-media/index.ts`
- `MyPersonas.Online_v0/sql-updates/062-opaque-public-media-delivery.sql`
- `supabase/migrations/20260823040000_opaque_public_media_delivery.sql`
- `infrastructure/aws/media-gateway/template.yaml`
- `infrastructure/aws/media-gateway/README.md`
