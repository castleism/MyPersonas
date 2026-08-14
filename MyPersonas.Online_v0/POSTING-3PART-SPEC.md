# 3-part staged posting system

_A 3-part AliaSpaces/MyPersonas post is authored once, then staged as three platform-tailored
variants and reviewed on a weekly cadence. The current exact-approved publisher is Meta-only
(Facebook Page/Instagram); X stays an editable draft until its source and write authorization are
verified. Confirmed with owner 2026-08-13._

## The three variants (thoroughness: website > Facebook > Instagram > X)

| Platform | Image | Caption | Limit |
|---|---|---|---|
| **Facebook** | **landscape 1.91:1** (e.g. 1200×628) — widest, "bigger perspective" | **Detailed** — full description of the event/product; the most thorough of the three | practically unlimited (target 300–1000+ chars) |
| **Instagram** | **square 1:1** (1080×1080) — closer | **Optimal IG length** — ~125–150 chars of hook + a few relevant hashtags | 2,200 hard cap |
| **X** | **portrait 4:5** (1080×1350) — most focused | **Very short** — one punchy line | **280 hard cap** |

Website posts (future) are the most thorough of all; the three social variants condense down
from that fuller story.

## Image pipeline (auto-crop one source)

One high-res **source image** per post (persona-generated or uploaded; should be ≥1350px on the
short side so all three crops avoid upscaling). The system produces three center-crops:

- The source is uploaded to the owner-namespaced path in the public **`persona-media`** bucket.
- Facebook 1.91:1, Instagram 1:1, and X 4:5 variants are Supabase image-transform URLs derived
  from that one object and stored on the draft; the Composer does not create three crop objects.

## Caption pipeline (persona AI writes all three)

From one **brief** (the idea/event), the persona's linked model (via `ai-proxy`) drafts all three
captions **in the persona's voice** at the right lengths — FB detailed, IG optimal, X ≤280.
They are stored as editable drafts, never posted automatically.

## Weekly staging + approval workflow

1. **Stage:** drafts are created with 3 captions + 3 image crops. Unscheduled grouping is computed
   from `created_at` in the owner's time zone; approval persists the exact local-week bucket.
2. **Approval day:** the owner reviews the week's schedule and edits captions/targets. **Approve &
   schedule** atomically records `status='scheduled'`, `scheduled_for`, owner/time-zone approval,
   actual paired Meta asset IDs, and an exact caption/target/time/destination/**image-byte** hash.
   Approval copies JPEG/PNG/WebP bytes to an owner-scoped content-addressed object and records its
   SHA-256, MIME, byte size, path, and URL; the worker re-downloads and verifies those values before
   a provider call. Image replacement remains a Composer-v2 task; a legacy Meta draft without an
   image must be re-staged.
3. **Publish:** on schedule, each approved draft posts to its `targets`:
   - Facebook + Instagram via **`meta-post`**. An older owner-triggered version was proven live;
     the hardened exact-draft implementation in this release is local/deploy-pending and scheduled
     invocation remains dormant until migration 036 is deliberately activated,
   - X via **`twitter-post`** only after its deployed-only source is pulled, audited, versioned,
     and granted write access. Until then, the approval UI rejects X as a scheduled target.
   Results are checkpointed (`fb_post_id`, `ig_media_id`, `x_tweet_id`). Confirmed safe failures
   set `status='failed'`; a timeout/5xx/accepted-without-ID outcome stays locked in `publishing`
   for provider reconciliation and must never be blindly retried.

Scheduled publishing requires the exact weekly owner approval. The separate **Publish now** action
is also explicit owner intent, but uses a draft-scoped server claim rather than the weekly approval
hash; it checkpoints each provider result before attempting the next target.

## Data model — `post_drafts` (migration 033)

`{ id, owner, persona_id, facebook_ledger_id, week_start, status(draft|approved|scheduled|publishing|posted|failed|skipped),
scheduled_for, brief, source_image_url, fb_caption/ig_caption/x_caption,
fb_image_url/ig_image_url/x_image_url, targets[], fb_post_id/ig_media_id/x_tweet_id, last_error,
approved_at, approved_by, approved_content_hash, approved_timezone, approved_facebook_page_id,
approved_instagram_business_id, publish_facebook_page_id, publish_instagram_business_id,
publish_claimed_at, posted_at, fb_published_at, ig_published_at, created_at, updated_at }` —
owner-scoped reads plus guarded mutation RPCs/server functions.

Migration 035 also adds `approved_fb_media_*` and `approved_ig_media_*` sets containing the
selected target's SHA-256, detected MIME, byte size, owner path, and canonical public URL.

## Build sequence

1. **[done]** `post_drafts` table + spec (foundation) — migration 033.
2. **[done]** Caption generation — `compose-post` edge function calls the persona model
   (via `ai-proxy`) for the 3 captions.
3. **[done]** Image crops — `compose-post` derives FB/IG/X **Supabase image-transform URLs**
   (`/storage/v1/render/image/public/...?width=&height=&resize=cover`) from one source; no
   crop code needed. Source images should live in the `persona-media` bucket.
4. **[done, adjacent]** `meta-post` **delete** action for post cleanup/management.
5. **[code complete; deploy + migration pending]** Approval-day UI: per-week review, exact
   caption/target/time approval, owner-time-zone week grouping, unschedule-to-edit, terminal-state
   locking, race-safe persistence reload, and atomic server-side immediate publishing.
   Migration 035 supplies the guarded mutation RPCs and approval hash; the authenticated
   `approve-post-draft` Edge Function alone stages immutable media and invokes scheduling.
6. **[code hardened; activation blocked]** Scheduled Meta publisher: shared FB/IG primitives,
   paused-owner-filtered current-row claim, exact approval + Meta-asset snapshot checks, owner pause,
   partial-result preservation, target truth, and an advisory local Instagram guard. Migration 036
   remains unapplied; complete
   `POST-QUEUE-ACTIVATION.md` first.
7. **[blocked]** X (`twitter-post`) wiring + verify: pull the drifted function first, remove/rotate
   inline secrets, document the request contract, add write/media scopes, and reauthorize. See
   `supabase/functions/DRIFT.md`.
