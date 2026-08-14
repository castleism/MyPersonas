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

1. **Stage:** drafts are created for the week (`post_drafts`, grouped by `week_start`), each with
   its 3 captions + 3 image crops + `scheduled_for`.
2. **Approval day:** the owner reviews the week's schedule, **edits any caption or swaps an image**,
   and approves. Approval sets `status='approved'` (+ `approved_at`/`approved_by`); scheduling sets
   `status='scheduled'` with `scheduled_for`.
3. **Publish:** on schedule, each approved draft posts to its `targets`:
   - Facebook + Instagram via **`meta-post`** (already live),
   - X via **`twitter-post`**.
   Results are written back (`fb_post_id`, `ig_media_id`, `x_tweet_id`); failures set
   `status='failed'` + `last_error`.

Nothing publishes without an explicit weekly approval — the same owner-approval gate `meta-post`
already enforces per call.

## Data model — `post_drafts` (migration 033)

`{ id, owner, persona_id, week_start, status(draft|approved|scheduled|posted|failed|skipped),
scheduled_for, brief, source_image_url, fb_caption/ig_caption/x_caption,
fb_image_url/ig_image_url/x_image_url, targets[], fb_post_id/ig_media_id/x_tweet_id, last_error,
approved_at, approved_by, created_at, updated_at }` — owner-scoped RLS.

## Build sequence

1. **[done]** `post_drafts` table + spec (foundation) — migration 033.
2. **[done]** Caption generation — `compose-post` edge function calls the persona model
   (via `ai-proxy`) for the 3 captions.
3. **[done]** Image crops — `compose-post` derives FB/IG/X **Supabase image-transform URLs**
   (`/storage/v1/render/image/public/...?width=&height=&resize=cover`) from one source; no
   crop code needed. Source images should live in the `persona-media` bucket.
4. **[done, adjacent]** `meta-post` **delete** action for post cleanup/management.
5. **[next]** Approval-day UI: the week's schedule with inline caption edit + image swap + Approve
   (calls `compose-post` to stage, then sets `status`/`scheduled_for`).
6. **[next]** Scheduled publisher: a cron that posts `scheduled` drafts due now. FB/IG reuse the
   `meta-post` publish path (refactor into `_shared/meta-publish.ts` so the cron can call it with
   the draft's owner via service role); respect IG's ~25 posts/24h/account cap.
7. **[next]** X (`twitter-post`) wiring + verify (drifted function — pull first, see DRIFT.md).
