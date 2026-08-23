# Opaque public and approved media release candidate — 2026-08-23

Status: **local NO-GO checkpoint only. Nothing in this manifest proves a
database apply, Edge deployment, Storage cutover, page publication, or live
verification.**

## Included

- Forward-only canonical migrations 062/063/064 and byte-identical timestamp mirrors.
- Private opaque-handle registry with service-only issuance, rotation, bounded
  handle backfill, reference cutover, readiness, and bucket finalization.
- Exact-current publication resolver and no-redirect, no-store, bounded,
  hash-verifying `public-media` proxy.
- Coordinated media intake, Gemini handoff, signed owner preview, frontend
  opaque-URL consumption, and public raw-path fail-closed behavior.
- Canonical `https://media.mypersonas.online/persona/v1/<uuid>` contract,
  secret-gated Supabase origin, and review-only CloudFront/WAF/Wix package with
  an approval lock and unfilled cost worksheet.
- Canonical `https://media.mypersonas.online/approved/v1/<uuid>` approved-post
  contract, private handle registry, reference-gated delivery, hash verification,
  revocation, retry immutability, erasure, and a separate manual finalizer.
- Distinct registered/hash-verified Facebook, Instagram, and X renditions for
  every raster AI state; the server crops first and watermarks only AI-used media.
- External-only music/live/navigation fields, affiliate redirect suppression,
  legacy-violation readiness counters, and finalizer locks.
- Adversarial pure-runtime, source-contract, migration parity, and PostgreSQL
  role/URL tests.
- The operational and security runbook in `OPAQUE-PUBLIC-MEDIA-DELIVERY.md`.
- An AAL2, owner-scoped legacy-media inventory/list/private-preview slice with
  opaque item ids and no browser-visible Storage path, hash, URL, or owner UUID.
  Declaration, canonical import, compare-and-swap rewrite, clear, and bucket
  retirement remain a separately locked second slice.

## Not included or not complete

- Migration 061, which is a separate prerequisite release.
- Any production or staging apply/deploy of migrations 062-064 or their Functions.
- Service-role backfill or reference cutover.
- Individual owner review and republication of affected personas.
- Private-bucket finalization.
- Provisioned WAF/CloudFront, ACM, Wix DNS, provider rate limits, cost approval,
  budgets, and monitoring configuration. The IaC is review-only and unexecuted.
- Signed-in mobile and unrelated two-account privacy evidence.
- Byte-range video delivery, frame-by-frame AI marking, image/video layout
  widgets, or video backgrounds. These remain disabled.
- Confirmed inventory/migration for `research_brief_annotations.image_url`.

## Release blockers

1. Verify 061 before 062-064 in an isolated staging project, then run the exact
   062-064 release sequence there before production.
2. Run the SQL runtime against the applied schema and exercise real Storage
   bytes; local source tests cannot prove RLS, JWT role, or bucket behavior.
3. Approve costs/change set, provision ACM + CloudFront/WAF, configure the same
   secret out of band at CloudFront and Supabase, connect the Wix `media` CNAME,
   and prove direct Edge calls fail closed. There is no direct-Storage fallback.
4. Cut over a pilot, complete exact owner review, and pass archive/flag/rotation
   invalidation plus desktop/mobile rendering.
5. Verified-byte import/re-ingest or owner-replace all legacy `media` references;
   then backfill eligible assets, remove every raw owner-path reference, individually
   approve affected pages, and finish two-account privacy testing.
6. Make the bucket private only after the finalizer's prerequisites are zero.
7. Configure and observe WAF/rate controls before public traffic is expanded.
8. Deploy and live-test approved-provider delivery, real Facebook/Instagram
   fetches, account erasure, immutable retries, revocation, and finalizer evidence.
9. Exercise the 064 preview-only cleanup slice with two unrelated AAL2 accounts;
   then implement and separately approve the declaration/import/rewrite/clear
   slice before any legacy reference or Storage object is changed.

## Read-only production snapshot

Latest aggregate-only audit: 0 published personas/businesses and no release-
candidate references. Public buckets contain 408 `media` objects and 23
`persona-media` objects (all UUID-shaped), with 0 `post-approved-media` objects.
There are 120 stored first-party references: 28 avatars, 28 banners, 27
backgrounds, 27 feed headers, and 10 album thumbnails. They remain a quantified
NO-GO; no URL-only ownership/provenance inference or automatic rewrite is
authorized.

## Approval boundary

Applying migrations 062-064, deploying functions/frontend, running service-role
backfill or cutover, changing the bucket to private, and publishing persona pages
are distinct approval and evidence steps. This local candidate authorizes none
of them by itself.
