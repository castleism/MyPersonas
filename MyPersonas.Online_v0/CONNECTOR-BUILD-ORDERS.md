# Connector build orders — automated posting, platform by platform

**Updated:** 2026-07-30 · Work orders for Codex/Claude sessions. Follow the house
rules: OAuth/state hardening like `twitter-oauth`, all tokens in Supabase Vault via
service-only RPCs, browser never sees a credential, L2 owner-press before any
publish, L3 only behind destination-mode review, no passwords/cookies/scraping ever.

## Physics summary (what can and cannot exist)

| Platform | Auth possible | Automated posting possible | Route |
| --- | --- | --- | --- |
| X / Twitter | ✅ built | ✅ buildable | API v2 `tweet.write` + media (paid API) |
| Facebook Page | ✅ built (pairing) | ✅ after Meta app review | Graph `pages_manage_posts` |
| Instagram (professional) | ✅ built (pairing) | ✅ after Meta app review | Graph container publish |
| Discord (own channel) | ✅ **shipped 019** | ✅ **shipped** (owner-press) | Official channel webhook |
| Reddit | ✅ buildable | ✅ buildable | OAuth app + `/api/submit` |
| YouTube | ✅ buildable | ✅ buildable (video upload) | Data API v3 `videos.insert` |
| Patreon | ✅ buildable (identity/campaign read) | ❌ API cannot create posts | Manual staging stays |
| OnlyFans | ❌ no official API | ❌ never (ToS + house rules) | Manual staging stays |
| Snapchat (personal) | ❌ no consumer API | ❌ (Marketing/Public-Profile API is ads/partner-gated) | Manual staging stays |
| Twitch | ✅ buildable | ❌ no feed-post API (schedule/clips only) | Record + embed |
| Gmail | ✅ built | n/a (mailbox; sending deliberately excluded) | Inbox Concierge |
| Outlook | ✅ buildable | n/a | Graph `Mail.ReadWrite` worker (roadmap) |
| Yahoo / iCloud | app-password IMAP worker | n/a | Roadmap |

## Order 1 — X write adapter (`twitter-post`)

Prereqs: owner installs `X_CLIENT_ID`/`X_CLIENT_SECRET`, billing active, ledger
account connected. Then:

1. Extend `twitter-oauth` scopes with `tweet.write` (+ `media.write` if uploads) behind
   an explicit **reauthorize for posting** owner action; keep read-only grants working.
2. New `twitter-post` Edge Function mirroring `discord-post`'s guard order: paused →
   owned approved non-terminal draft → ledger/persona match → connection connected with
   write scope → atomic `publishing` lease → provider call → `published`/`failed` + reason.
3. POST `https://api.x.com/2/tweets` `{text}` (280-char budget; media via chunked
   upload first when `media_url` present). Store returned tweet id in `publish_error`-adjacent
   audit (add `agent_actions` row: kind `external_publish`, provider `twitter`).
4. Reconciliation: on 403/429 map to human-readable errors; on timeout, verify via
   GET tweet lookup before marking failed (prevent double-post on retry).
5. UI: reuse the Queue "Post to … now" pattern gated on write-scope connection.

## Order 2 — Facebook Page publish (`meta-post`, hard-gated)

Prereqs: Meta app credentials installed, Pages paired (018), app review passed for
`pages_manage_posts`. Publish via `POST /{page_id}/feed` with Vault Page token;
same guard order as Order 1; store returned post id; per-Page daily cap from
destination row; keep the config flag default-off until live Page test passes.

## Order 3 — Instagram professional publish (`meta-post` extension)

Prereqs: review-passed `instagram_content_publish`. Two-step container flow:
`POST /{ig_user_id}/media` (image/video by https URL + caption) → poll status →
`POST /{ig_user_id}/media_publish`. Validate media type/aspect before creating the
container; surface Meta's per-24h publish quota; same lease/audit pattern.

## Order 4 — Reddit (`reddit-oauth` + `reddit-post`)

1. Owner creates a Reddit app (web type) at https://www.reddit.com/prefs/apps with
   callback `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/reddit-oauth`;
   secrets `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`.
2. OAuth code flow with `duration=permanent`, scopes `identity submit flair read`;
   tokens to Vault; identity check binds the exact recorded username.
3. `reddit-post`: `POST /api/submit` (self/link) with subreddit + flair from the draft's
   target metadata; map Reddit's ratelimit errors verbatim into `publish_error`.
4. Respect Reddit Data API terms (free tier, non-commercial rate limits).

## Order 5 — YouTube upload (`youtube-oauth` + `youtube-post`)

1. Google Cloud OAuth client (same project as Gmail is fine), scope
   `https://www.googleapis.com/auth/youtube.upload`; add channels' Google accounts
   as test users until verification.
2. Resumable upload session server-side from `media_url` (https only, size-capped);
   set title/description/tags/privacy from the draft; store returned video id.
3. Note: unverified-app uploads may be locked private by YouTube until the app
   passes its audit — surface that state honestly, never claim public when private.

## Order 6 — Patreon identity (auth-only)

OAuth v2 (`identity`, `campaigns` read) to verify the creator account and show
campaign/member counts in Manage. **Do not** promise post creation — the public API
does not create posts; drafts stay manual-staging with copy/open handoff.

## Explicitly impossible — do not attempt, ever

- **OnlyFans**: no official API; automation would require credentials/scraping —
  permanently manual staging (existing Manage workspace).
- **Snapchat personal snaps/stories**: no consumer posting API.
- **Twitch feed posts**: no API surface; embeds + schedule API only.
- **Personal Facebook profiles / consumer Instagram**: excluded by Meta.

Each shipped order updates: `PROVIDER-SETUP-GUIDE.md`, `DEVELOPER-ACCESS-CHECKLIST.md`,
`ROADMAP.md`, `CHANGELOG.md`, `VERIFICATION.md` (live-test evidence), and the
in-app `CONNECTOR_GUIDANCE` copy for that provider.
