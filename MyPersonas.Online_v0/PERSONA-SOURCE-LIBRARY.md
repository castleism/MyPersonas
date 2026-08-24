# Persona Source Library

Status: managed-cloud MVP implemented locally on the isolated
`feature/persona-source-library` branch. Nothing in this document is evidence
that migration 070, its private bucket, its Edge function, or its frontend are
deployed.

## Product decision

MyPersonas should use a hybrid storage architecture:

1. **Managed private cloud is the default.** Postgres is the searchable,
   owner/persona-scoped control plane. A private Supabase Storage bucket holds
   the exact originals so the owner can reach them from phone and desktop and a
   consented worker can study queued sources while the original computer is
   off.
2. **A local desktop companion is the high-volume option.** It can watch folders,
   keep originals local, run a local vision model, and sync only approved
   metadata/notes. A normal browser tab cannot promise a permanent folder
   watcher.
3. **Bring-your-own S3-compatible storage is an advanced adapter.** Provider
   credentials must be encrypted server-side, bucket/prefix scoped, revocable,
   and never returned to the browser. MyPersonas must verify provider deletion
   before claiming an account erasure is complete.
4. **OPFS is only an offline upload queue/cache.** It is not a canonical archive:
   origin storage may be cleared or evicted and does not provide dependable
   cross-device/background operation.

This follows the access model documented for
[Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[Storage RLS](https://supabase.com/docs/guides/storage/security/access-control),
and [private downloads](https://supabase.com/docs/guides/storage/serving/downloads).
Uploads larger than the first-release 10 MiB image ceiling should move to the
[resumable upload protocol](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
instead of raising the Edge request limit. Browser folder access remains a
feature-detected enhancement because
[`showDirectoryPicker`](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
is not Baseline. User-provided cloud storage should use narrow, expiring
operations such as
[S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html),
not permanent keys in JavaScript.

## What a source is

A source is private owner material attached to one persona. Its lane is one of:

- `research`: ask the persona to study it after explicit analysis consent;
- `content_later`: retain it for owner-reviewed editing or drafting;
- `unsorted`: ingest now and classify later;
- `archive`: retained but excluded from active work.

Lane and study status are different. Storing a file never means it has been
studied. Queuing a study never means the result was accepted. A machine note is
always a suggestion until the owner accepts it.

Each source also records:

- AI-use declaration (`none`, `assisted`, `generated`, `unknown`);
- rights basis;
- reuse permission (`reference_only`, `derivative_allowed`, `publish_allowed`);
- sensitivity;
- explicit permission to send a sanitized derivative to an approved hosted
  model;
- owner notes/tags separately from AI suggestions.

## Byte and publication boundaries

- The private bucket is `persona-source-library` and is never public.
- The browser cannot write to Storage directly and cannot read a raw object
  path. The authenticated Edge function validates signatures, MIME, dimensions,
  size, quota reservation, owner/persona binding and SHA-256 before registering
  metadata.
- Originals are immutable and are not watermarked merely because they are
  evidence in the private library.
- Preview and download re-read and hash-verify the exact private bytes, return
  them with `Cache-Control: no-store`, and disclose neither path nor hash.
- A source is not a post. To publish it, the owner must explicitly promote a
  derivative through the existing `media-ingest` provenance/watermark and
  publication-review gates. The source never receives a public handle.
- Images, screenshots, filenames, OCR, and embedded instructions are untrusted
  data. A future vision worker must never interpret visible text as a system or
  tool instruction.

## First-release behavior

The managed-cloud web MVP accepts independent PNG, JPEG, and WebP uploads
up to 10 MiB and 40 million pixels. A batch is a browser convenience: every file
has its own idempotency key, progress, retry and failure state, so one bad image
does not roll back successful files.

The owner can:

- filter sources by persona, lane, analysis state, and a bounded text search
  across titles, owner notes, filenames, and tags;
- open a full uncropped authenticated preview;
- save an original copy;
- edit lane, title, owner notes, tags and consent controls;
- add owner notes and accept/reject future AI note suggestions;
- queue or cancel a study request;
- archive or storage-first delete an item.

The first release intentionally does **not** claim that queued images have been
analyzed. Actual hosted analysis requires a separately reviewed multimodal
worker, an `image_analysis` model route, the existing default-deny automation
budget, a live membership recheck immediately before provider access, sanitized
working derivatives, and provider/model/version audit evidence. Local-only
study requires the future desktop companion.

HEIC/HEIF, video, folder watching, background upload, Web Share Target, local
vision, BYO S3, source-to-brief joins, and promotion into a content draft remain
later phases. Mobile owners can use the ordinary camera/photo picker in the
first release.

## Quotas and deletion

Migration 070 serializes upload reservations and enforces both item and byte
ceilings. A reservation does not authorize a Storage write: immediately before
the write, the Edge service must move that exact idempotency receipt into the
`writing` state. Persona/account deletion guards block that transition, cancel
queued studies, request cancellation of claimed studies, and report remaining
active writes and studies. Exact retries are idempotent. Duplicate detection is
scoped to one owner and must never reveal that another account uploaded matching
bytes.

Single-item deletion first enters a service-only asset deletion guard. That
guard cancels a queued study, requests cancellation of a claimed study, and
reports claimed studies still active. A nonzero count or a conflicting
persona/account deletion guard returns a retryable conflict before the service
resolves a private locator or touches Storage. Once the count is zero, deletion
removes Storage bytes before metadata. Account/content erasure adds the owner
prefix in `persona-source-library` to the verified storage pass, then removes
Source Library metadata through a service-only RPC. If byte deletion cannot be
verified, erasure fails closed instead of claiming success.

Deleting one persona also fails closed. A service-only deletion guard first
blocks new reservations and `reserved` → `writing` transitions, cancels queued
studies, requests cancellation of claimed studies, reports both remaining
active counts, and identifies the opaque private prefix. If either count is
nonzero, the Edge service returns a retryable conflict without erasing bytes or
finalizing metadata. After writes register or release and claimed studies record
a terminal state, a retry can observe both counts at zero. Only then does the
service remove and re-list the prefix, delete Source Library metadata, and let
the existing persona deletion RPC run.

Account/content erasure uses the same owner-wide interlock before any owned
Storage pass. Once acquired, a failed or interrupted erasure retains the guard
so no new source write or study can race a partial delete. A successful
content-only erasure releases the exact guard token only after byte verification,
Source Library metadata removal, all other owned-row erasure, and preference
reset succeed. Full account deletion retains a tombstone instead of reopening
uploads or studies for a deleted account.

The ordinary JSON account export contains private source metadata, declarations,
notes, and job state but not raw object paths, hashes, credentials, or binary
bytes. A complete binary export must be a later asynchronous manifest plus
verified originals; binary images must not be embedded into the existing JSON
backup.

## Release order

1. Apply and read back migration 070 in the isolated staging project.
2. Confirm `persona-source-library` exists and is private; confirm authenticated
   and anonymous browser roles cannot insert/update/delete Storage objects.
3. Deploy `persona-source-library`, `delete-account`, and `erase-content` through
   the protected `persona-source-library` deployment scope.
4. Run two signed-in accounts on desktop and mobile: owner A must never list,
   preview, update, queue, download, or delete owner B's source ID, including a
   copied UUID.
5. Test logout/account switching during upload/preview, stale route/persona
   responses, duplicate upload races, quota failures, corrupted bytes, deletion
   while a receipt is `writing`, and deletion during a queued study. Prove that
   nonzero `active_writes` or `active_studies` performs no prefix erase or
   metadata finalize.
6. Verify account/content erasure removes the private prefix before metadata.
7. Only then use the Pages release confirmation containing
   `SOURCE-LIBRARY-070-VERIFIED`.

No migration, bucket, function, provider credential, scheduled worker, or public
frontend should be changed by merely building or testing this branch.
