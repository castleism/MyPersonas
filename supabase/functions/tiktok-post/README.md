# TikTok preview and publishing foundation

`tiktok-post` is intentionally owner-triggered and fail-closed. The safest
first release uses TikTok's Upload API to hand one approved video to the exact
creator's TikTok inbox. The creator must open TikTok and finish the post; the
caption is not transferred by this mode. Text-only drafts are rejected.

## Required configuration

- `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`
- `TIKTOK_OAUTH_APP_ORIGIN`
- `TIKTOK_VERIFIED_MEDIA_PREFIXES`: comma/newline-separated HTTPS URL prefixes
  verified in the TikTok developer portal. Approved media URLs must be under
  one exact prefix and contain the approved SHA-256 checksum.
- `TIKTOK_DIRECT_POST_ENABLED=false` for the initial Upload-only release.
- Leave `TIKTOK_CLIENT_AUDIT_STATE` unset for the initial release. Direct Post
  remains disabled unless it is exactly `audited` or `unaudited` and the
  release flag is also true. `unaudited` mode is forced to `SELF_ONLY`.

Apply migrations 068 and 069 first. Deploy `tiktok-post` with gateway JWT
verification enabled.

## Approval and send contract

Every write requires all of the following to still match immediately before
the TikTok request:

- signed-in owner at AAL2;
- global automation pause off;
- current persona/account/agent-destination assignment;
- exact connected `open_id`, current username, and required scope;
- generic draft content approval plus a durable `platform-preview-v1` receipt
  bound to `account_connections.provider_subject`;
- a second TikTok-specific preview receipt binding the video checksum, MIME,
  byte size, URL, mode, account, privacy, interaction controls, commercial
  disclosures, music confirmation, AIGC disclosure, duration, cover time, and
  explicit consent;
- for Direct Post only, freshly queried creator options that still allow every
  approved setting.

The browser first calls `prepare-preview`, renders the returned TikTok-style
preview, and then calls `approve-preview` with that exact version/hash and an
explicit confirmation. `send-approved` rejects changed content or settings.
There is no text-only fallback and no unattended TikTok scheduler in this
foundation.

The provider `publish_id` is checkpointed before any success response. Timeout,
5xx, unreadable, or otherwise ambiguous initialize results leave the draft
locked for reconciliation; they are never blindly retried. `reconcile-status`
polls TikTok and marks a draft published only after `PUBLISH_COMPLETE`.

## Remaining release gates

1. TikTok approves Login Kit and Content Posting API scopes for the app.
2. The media host domain/URL prefix is verified in TikTok and serves stable
   HTTPS content without redirects for at least the required fetch window.
3. Migration 068 and the cross-provider preview migration 069 are applied and
   database policies/RPC grants are reviewed in the target project.
4. A private owner-account test proves connect, refresh, Upload inbox handoff,
   creator completion, status reconciliation, disconnect, and provider-side
   revocation. No public post is part of that test unless separately approved.
5. Direct Post stays off until TikTok audit/review state, consent UX,
   commercial-content policy, music policy, and AIGC labeling are separately
   verified. A deletion/account-erasure path must also revoke TikTok access.

Official references:

- <https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content>
- <https://developers.tiktok.com/docs/en/content-posting-api-media-transfer-guide>
- <https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video>
- <https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post>
- <https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status>
- <https://developers.tiktok.com/docs/en/content-sharing-guidelines>
