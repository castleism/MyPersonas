# Legacy media remediation

Status: **local, preview-only release slice; not applied, deployed, inventoried
per owner, or verified live.** The production aggregate reports 120 stored
references to the historical public `media` bucket: 28 profile images, 28
banners, 27 backgrounds, 27 feed headers, and 10 album thumbnails. That is a
reference count, not a unique-file count.

## Why this is a release blocker

Historical object paths contain a stable owner UUID. Serving or embedding those
paths can correlate assets belonging to the same owner. URL-only rewriting is
not safe because an old path does not prove:

- that the object still exists or contains supported bytes;
- that the first path segment and database owner agree;
- which persona and page slot should own the replacement asset;
- whether AI was used; or
- whether several references point to the same source.

Filenames, extensions, stored content types, and old `-sd` or `-gen` suffixes
are not AI-provenance evidence. MyPersonas must ask the owner to declare
`none`, `assisted`, `generated`, or `unknown` after previewing exact bytes.

## Data boundary

Migration 064 adds two normalized service-only tables with RLS enabled and no
`anon` or `authenticated` table grants:

- `legacy_media_sources`: one opaque record per owned source object and byte
  revision. Raw bucket/path and hashes never leave the service boundary.
- `legacy_media_references`: one opaque record per approved consumer/row/slot.
  Multiple references can share one source; cross-persona imports remain
  separately persona-bound.

The inventory uses constant SQL for an enumerated set of media slots. It never
accepts a table or column name from the browser. Navigation fields—links,
music/live destinations, layout link widgets, and affiliate destinations—are
external-only and are never treated as importable media.

## First release slice

`legacy-media-remediation` is an authenticated AAL2 Edge boundary with an exact
allowed Origin, bounded request body, per-owner rate limit, and three actions:

1. `inventory`: idempotently records strictly parsed owned references and
   returns aggregate counts only.
2. `list`: returns a bounded safe projection with opaque item ids, owned persona
   label, consumer/slot labels, state, detected byte metadata, and shared count.
3. `preview`: re-resolves the opaque item server-side, downloads the exact
   object with the service role, enforces a 15 MB limit, magic-detects the bytes,
   records their revision, and streams them with `no-store`, CSP, `nosniff`, and
   no path/hash/location headers.

The owner UI is available at **Media cleanup** in desktop and mobile navigation.
It supports scan, pagination, exact preview, and saving a verified local copy.
It never renders or requests raw paths, URLs, owner ids, or hashes.

## Second release slice — intentionally still locked

Do not expose these controls until their migration, Edge, erasure, concurrency,
and finalizer tests are green:

1. **Declare** — AAL2 owner declaration bound to the exact preview revision;
   no default answer and no declaration survives changed bytes.
2. **Import** — re-download and re-hash the source; detect real bytes; preserve
   exact bytes for no-AI originals; crop then watermark AI-used static images;
   register `origin=imported` and `declaration_source=import`.
3. **Rewrite** — one transaction with owner/persona advisory locks, row locks,
   compare-and-swap of every exact legacy value, active canonical asset/handle
   checks, and one publication-review invalidation per affected persona.
4. **Clear** — explicit owner action that removes only the selected stale or
   unsupported reference and invalidates review.
5. **Finalize** — after every readiness counter is zero, make the legacy bucket
   private, purge unreferenced objects through bounded Storage API pages, verify
   repeated empty passes, then remove the empty bucket or retain a private
   retired tombstone under a separate approval.

Database and Storage cannot be one atomic transaction. The safe order is an
immutable import first, followed by a database compare-and-swap. A failed rewrite
may leave an unreferenced canonical asset, but it must never partially rewrite a
reference group.

## Byte and path rules

Automatic inventory accepts only the exact project-host public-object route for
`media/<lowercase owner UUID>/<historically sanitized path>` with no userinfo,
custom port, query, fragment, backslash, dot segment, or percent ambiguity.
The exact first slice inventories canonical routes only. Signed/authenticated/
render routes, transformed URLs, query-bearing or noncanonical encodings, and
other malformed references remain global fail-closed readiness blockers and do
not yet appear as owner queue items. The second slice must enumerate them safely
before an owner can explicitly replace or clear them. Cross-owner paths and
missing objects are recorded as blocked states without exposing the other owner
or the raw location; SVG/unknown bytes are rejected at private preview.

AI-used or unknown animated GIF/WebP and video remain unsupported until there is
a verified frame-by-frame watermark/transcode path. No-AI supported animation or
video may later import exact bytes. A no-AI crop must never be registered by
weakening the source-hash invariant globally; keep the original bytes and use
CSS presentation, or add a narrowly attested derivative contract.

## Finalizer readiness

The legacy bucket cannot be retired until aggregate service evidence reports:

- zero live legacy references across every enumerated slot;
- zero pending, stale, missing, cross-owner, malformed, unsupported, or
  import-not-rewritten items;
- zero erasures in flight;
- no remaining browser/object writers;
- the bucket is private with no `anon`/`authenticated` Storage policy; and
- repeated bounded Storage listings are empty before removal.

Never delete rows directly from `storage.objects`.

## Required verification

- First slice: two-owner SQL tests with no cross-owner list/preview/existence
  leak; exact parser coverage; stale, missing, shared-source, null-persona, and
  account/content-erasure cases; AAL2/rate/request/byte/header bounds; account
  race handling; and signed-in mobile/two-account privacy evidence.
- Second slice, before it is exposed: no default AI declaration, revision-bound
  declaration, import/rewrite/clear concurrency and rollback, publication-review
  invalidation, unsupported media, finalizer blockers, and repeated empty-bucket
  evidence.
- Edge tests for AAL2, exact Origin, request/rate bounds, magic detection, size
  limit, safe headers/errors/logging, and idempotent retries.
- UI tests for account/session races, exact preview, publication warning, mobile
  layout, and signed-in two-account privacy.

Applying migration 064, deploying the Edge function, running an owner inventory,
declaring/importing assets, privatizing/purging Storage, and republishing pages
are separate evidence and approval steps.
