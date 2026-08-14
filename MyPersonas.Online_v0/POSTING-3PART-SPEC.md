# 3-part staged posting system

_Every AliaSpaces/MyPersonas post is authored once, then staged as three platform-tailored
variants, reviewed and approved on a weekly cadence, and published to the persona's own
Facebook Page, Instagram, and X. Confirmed with owner 2026-08-13._

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

- Facebook → 1.91:1, Instagram → 1:1, X → 4:5.
- Crops are uploaded to the **`persona-media` public bucket** (posting APIs need a public https
  URL that Meta/X fetch server-side) and their URLs stored on the draft.

## Caption pipeline (persona AI writes all three)

From one **brief** (the idea/event), the persona's linked model (via `ai-proxy`) drafts all three
captions **in the persona's voice** at the right lengths — FB detailed, IG optimal, X ≤280.
They are stored as editable drafts, never posted automatically.

## Weekly staging + approval workflow

1. **Stage:** drafts are created with 3 captions + 3 image crops. Unscheduled grouping is computed
   from `created_at` in the owner's time zone; approval persists the exact local-week bucket.
2. **Approval day:** the owner reviews the week's schedule and edits captions/targets. **Approve &
   schedule** atomically records `status='scheduled'`, `scheduled_for`, owner/time-zone approval,
   actual paired Meta asset IDs, and an exact content/destination hash. Image replacement remains a
   Composer-v2 task; a legacy Meta draft without an image must be re-staged.
3. **Publish:** on schedule, each approved draft posts to its `targets`:
   - Facebook + Instagram via **`meta-post`** (already live),
   - X via **`twitter-post`** only after its deployed-only source is pulled, audited, versioned,
     and granted write access. Until then, the approval UI rejects X as a scheduled target.
   Results are written back (`fb_post_id`, `ig_media_id`, `x_tweet_id`); failures set
   `status='failed'` + `last_error`.

Scheduled publishing requires the exact weekly owner approval. The separate **Publish now** action
is also explicit owner intent, but uses a draft-scoped server claim rather than the weekly approval
hash; it checkpoints each provider result before attempting the next target.

## Data model — `post_drafts` (migration 033)

`{ id, owner, persona_id, week_start, status(draft|approved|scheduled|publishing|posted|failed|skipped),
scheduled_for, brief, source_image_url, fb_caption/ig_caption/x_caption,
fb_image_url/ig_image_url/x_image_url, targets[], fb_post_id/ig_media_id/x_tweet_id, last_error,
approved_at, approved_by, approved_content_hash, approved_timezone, approved_facebook_page_id,
approved_instagram_business_id, publish_claimed_at, posted_at, fb_published_at, ig_published_at,
created_at, updated_at }` — owner-scoped reads plus guarded mutation RPCs/server functions.

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
   Migration 035 supplies the guarded approval RPCs and approval hash.
6. **[code hardened; activation blocked]** Scheduled Meta publisher: shared FB/IG primitives,
   paused-owner-filtered current-row claim, exact approval + Meta-asset snapshot checks, owner pause,
   partial-result preservation, target truth, and an advisory local Instagram guard. Migration 036
   remains unapplied; complete
   `POST-QUEUE-ACTIVATION.md` first.
7. **[blocked]** X (`twitter-post`) wiring + verify: pull the drifted function first, remove/rotate
   inline secrets, document the request contract, add write/media scopes, and reauthorize. See
   `supabase/functions/DRIFT.md`.
