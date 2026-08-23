# Persona page layout builder and owner asset preview

Status: **Implemented and tested locally; not pushed, applied to the linked database,
deployed, configured, activated, or verified live unless separately evidenced.** Migration
050 and the matching page are part of the ordered package in
`RELEASE-MANIFEST-2026-08-22.md`. Nothing in this package publishes a page, executes
arbitrary owner code, or changes production data.

## Implemented slice

- Owners can open full previews from their persona page for the profile image,
  banner, page background, feed header, album thumbnails, and native post
  image/video/audio assets.
- **Save a copy** fetches without cookies, authorization, or referrer data,
  accepts only an explicit raster-image/audio/video MIME allowlist, verifies the
  matching file/container signature, enforces a 50 MB streamed limit, derives
  the local extension only from the verified MIME, sanitizes the filename, and
  revokes its temporary object URL. SVG/XML, text, HTML, JSON, JavaScript,
  octet-stream, unknown, and MIME/signature-mismatched payloads are rejected;
  the URL suffix is never trusted for the saved type. When a remote host
  blocks browser CORS, the UI reports that direct saving was blocked and offers
  **Open original**; it never claims the copy succeeded.
- Migration 050 stores a versioned declarative profile layout, not executable
  code. Owners can reorder eleven built-in sections (including Family and
  Offers & review requests), choose half/full width,
  square/soft/round corners, and default/theme/muted/glass tones.
- Owners can add at most 12 escaped text boxes or HTTPS link boxes. Unknown
  fields, duplicate ids/modules, unsupported kinds, unsafe link protocols, and
  oversized recipes are rejected in both the client normalizer and database
  trigger.
- The learning console shows generated HTML, CSS, or the validated layout JSON.
  Highlighting common elements/properties gives a local explanation without an
  AI call. The console is read-only in this release.
- HTML/CSS/JSON snippets can be saved as owner-private reusable references.
  They are never returned by the public layout RPC and never injected into or
  executed by the public page.
- If migration 050 is unavailable, public pages fall back to the legacy safe
  order and the editor clearly disables layout saving rather than overwriting
  anything.
- With migration 051, a layout save advances the persona publication revision
  exactly once and returns a published page to draft. Family and revenue module
  data has its own revision invalidation; moving a family edge invalidates both
  endpoint personas.

## Language and runtime decision

HTML describes page structure; CSS controls layout and appearance; TypeScript
is the right modern language for interactive widget behavior. The long-term v2
implementation should use the repository's planned SvelteKit + TypeScript
frontend while continuing to teach portable HTML and CSS in the learning view.

Public customization must remain declarative on the MyPersonas origin. Do not
run raw JavaScript, `eval`, `new Function`, event-handler attributes supplied by
users, arbitrary SVG, or arbitrary CSS in the authenticated/public application.
If a later code lab supports editable HTML/CSS, render it only on a separate
origin or in a sandboxed iframe without `allow-scripts` or `allow-same-origin`,
with a self-contained CSP that blocks network, forms, navigation, and base URLs.
Executable third-party widgets require immutable package hashes, signed
manifests, permission review, administrator approval, revocation, and a typed
`postMessage` capability boundary. The current extension catalog is a download
catalog, not a safe widget runtime.

## Blocking privacy remediation: opaque public assets

Existing page-art uploads use a Storage object name beginning with the
authenticated owner's UUID (`<owner uid>/...`). The full public URL is stored on
the persona and rendered to viewers. That stable path segment can correlate two
personas owned by the same account, conflicting with the product's default
unlinked-persona promise.

Do not add image/video widgets, video backgrounds, or a public asset picker on
top of that URL model. The safe follow-up is:

1. Put original public-page assets in a private bucket under owner-scoped paths.
2. Store the private bucket/path in an owner-only asset row with an independent,
   opaque public asset id.
3. Serve visible assets through a bounded Edge endpoint keyed by that opaque id,
   or mint short-lived viewer URLs after checking persona visibility. Never put
   the owner UUID in the viewer-facing URL.
4. Validate magic bytes and MIME, set `nosniff`, constrain image/video size and
   duration, and serve downloads with a sanitized `Content-Disposition`.
5. Copy existing public page assets to opaque ids, update persona/post/album
   references transactionally, verify rendering, then retire the correlatable
   URLs. Keep a rollback map until verification is complete.

Background GIFs continue to work through the existing image background field,
but they inherit this blocker. Video backgrounds remain intentionally disabled.
They also need muted/looping/playsinline playback, a visible pause control,
`prefers-reduced-motion` and data-saver behavior, a poster image, and route
teardown before release.

## First-party immutability versus external URLs

The current browser upload paths now watermark first when applicable, hash the final
bytes with SHA-256, and write with `upsert:false` to
`<owner>/published/<scope>/<sha256>.<safe-extension>` in `persona-media`. Composer media
uses the persona-specific `published/composer/<persona id>/...` scope. The UI accepts
only PNG, JPEG, WebP, GIF, MP4, or WebM; SVG is not an upload type. Migration 051 removes
authenticated update/delete policy for these reviewed public objects, so changing a
first-party asset means writing a new content address and reviewing the new page revision.

This is a narrow first-party guarantee. Existing legacy object paths and external HTTPS
URLs remain supported by several profile, post, album, product-image, audio, and embed
fields. The review manifest hashes the URL-bearing manifest, not bytes fetched from those
hosts, and the public path never performs an integrity fetch. External content can change
at the same URL after review. Owner preview/download likewise copies the bytes currently
served; it does not prove that they match the bytes originally reviewed. Do not describe
an external or legacy asset as immutable or byte-integrity-bound without a separate
server-side ingest, hash, and provenance record.

## Migration and release order

1. Review migrations 050 and 051 together for the layout/revision and immutable-upload
   boundary, including each canonical SQL file and its byte-identical timestamped
   Supabase mirror. Reconfirm parity after the coordinated source freeze; local parity is
   packaging evidence, not linked-database evidence.
2. Run the full test suite and frontend syntax check. Confirm the migration 050 and 051
   canonical/timestamped pairs remain byte-identical.
3. Apply migration 050 in a non-production project first. Verify anon can read
   only a visible persona's layout recipe; owner ids and snippets must remain
   unavailable. Verify owners cannot save layouts or snippets for another
   owner's persona.
4. Test migration-absent fallback, keyboard reorder controls, mobile one-column
   layout, modal focus/Escape behavior, reduced-motion behavior for existing
   GIFs, media CORS failure, and the 50 MB download limit.
5. Apply production SQL only with an explicit owner approval naming migrations
   050 and 051 and the rollback window. Deploy the matching page afterward; a new page
   against an old database intentionally stays in fallback mode.
6. Live-test a public, unlisted, private/friend-visible, NSFW, and owner page.
   Test with a separate viewer session before marking the feature live.

Rollback is application-first: restore the previous page so it ignores layout
rows. Preserve the tables during the rollback window because they are inert
without the renderer. After export and owner approval, the layout/snippet tables
and RPCs can be dropped in a separate forward migration.

## Focused verification

`tests/persona-page-layout-builder.test.mjs` checks migration equality, grants
and privacy separation, strict recipe validation, client normalization, the
read-only/no-eval learning console, owner-only asset entry points, accessible
preview markup, credential-free bounded downloads, strict MIME/signature
validation, MIME-derived filename extensions, filename sanitization, and
the opaque-asset release blocker. `tests/approved-media.test.mjs` separately checks
final-byte hashing, allowlisted MIME, `persona-media` content addresses, duplicate reuse,
and the composer path. Neither suite proves deployment, remote-host byte stability, or a
live signed-in browser flow.
