# Connector status

_Account counts and provider authorization were checked live 2026-08-30 against the
app's own data. The live site, provider migrations 065–076, and matching Edge functions
are deployed. Deployment does not mean credentialed, connected, write-authorized,
target-bound, preview-approved, or provider-verified._

## Current provider authorization

| Provider | Current state | Remaining | Blocker on the remaining |
|---|---|---|---|
| Gmail | 28 / 28 | 0 | — done (inbox cleanup just needs each inbox un-paused) |
| X (Twitter) | 0 usable write grants / 28 saved | 28 | all 27 connection records are expired, none has `tweet.write`, and one saved account has no connection record |
| Facebook Pages | 25 fresh, write-scoped / 28 saved | 3 | not connected; no provider-post proof has run for this release |
| Instagram | 25 fresh, write-scoped / 28 saved | 3 | not connected; no provider-post proof has run for this release |

The Meta counts prove fresh recorded authorization, write scopes, and targets. They do not prove a post. The X records are unusable until freshly authorized with `tweet.write`. No current-release provider proof has run.

## Not connected in the deployed UI snapshot

- **Reddit** — `reddit-oauth` and `reddit-post` are version-controlled in this checkout,
  and the local frontend now uses the actual capability/start/disconnect/callback
  contract with exact ledger username binding. This is **local implementation only**:
  the owner still needs to review/apply migration 021 if necessary, configure Reddit
  client credentials and callback, deploy both functions, push the Pages frontend, and
  verify one real OAuth round trip plus an owner-approved low-stakes post. The existing
  Reddit account is not claimed connected by this file.
- **Discord** — official `webhook.incoming` OAuth, immutable exact-channel binding, Vault
  erasure, owner-triggered sending, action-time preview receipts, reconciliation, and UI controls
  are deployed. Production has zero Discord credential and connection rows, so authorization and
  one designated-channel proof are still required; mentions remain disabled by default. This route
  does not use a bot token, `bot`, or `applications.commands`.
- **OnlyFans** — no public official account-management API was located; keep manual staging only.
- **YouTube, TikTok, Twitch, Patreon, Wix, WordPress** — their gated connector functions are deployed, but each has zero credential and connection rows. None is target-bound or provider-verified.

## Focused publishing readiness snapshot

Each column is a separate fact. A record marked **saved** is not a provider-authorized connection.

| Provider | Inventory | App credentials | Owner authorization | Exact write ability | Exact target | Publisher | Safe proof |
|---|---|---|---|---|---|---|---|
| YouTube | 3 saved records | 0 credential rows | 0 connected | `youtube.upload` not granted | channel not bound | Private-first uploader deployed, gated | private upload/readback not run |
| TikTok | 1 saved record | 0 credential rows | 0 connected | `video.upload` not granted | creator not bound | Upload-to-inbox deployed, gated; Direct Post disabled | inbox upload/status proof not run |
| Discord | saved inventory | 0 credential rows | 0 connected | `webhook.incoming` not granted | channel not bound | exact-channel sender deployed, gated | designated-channel proof not run |
| Twitch | 1 saved record | 0 credential rows | 0 connected | no action-specific grant | channel not bound | limited action connector deployed, gated | read identity first; any visible write needs exact preview/approval |
| Patreon | 2 saved records | 0 credential rows | 0 connected | no general create-post permission exists | campaign not bound | read/report plus native editor handoff deployed | read-only report or native draft proof needed |
| Wix | 2 saved records | 0 credential rows | 0 connected | Manage Blog + Read Members not granted | site/author not bound | Draft-only connector deployed, gated | publish-off Blog draft not run |
| WordPress | identify exact sites | 0 credential rows | 0 connected | posts / edit_posts not granted | site/author not bound | Draft-only connector deployed, gated | Draft-only post not run |

The Wix and WordPress connector functions, migrations, owner UI, and setup guidance are
deployed, but neither provider is credentialed, connected, target-bound, or provider-verified.
A sign-in or tool grant elsewhere does not authorize the MyPersonas application.

## Platform preview release gate

**No preview, no approval, no schedule, and no immediate send.**

No provider row may be approved, scheduled, or sent until the owner has seen the exact platform-specific
preview, exact destination, privacy/audience, disclosure, and date/time with a named time zone or explicit immediate
action. The server prepares a short-lived immutable receipt before the preview; the owner's separate AAL2 acknowledgement binds that exact revision and target, and the unchanged receipt can be consumed only once. Any change invalidates the receipt.
The preview shows the full submitted media in a relevant platform frame with safe-area
guidance, while final rendering can still vary by device and placement. Wix and WordPress also require
the provider's own active-theme draft preview before any later public schedule.

The number beside **Save target** is the provider's stable Page/channel/creator/campaign/site ID.
It is not an account count. A client ID identifies the developer app; a client secret is the app's
password and must never be entered in the target field.

At this snapshot, zero content rows are scheduled, queued, or publishing, and no recurring
publisher cron job is enabled. Deploying the release did not activate unattended posting.

## Production credential handoff

Open the official [MyPersonas Supabase Edge Function secrets page](https://supabase.com/dashboard/project/nwsqyuucwzihruszocge/functions/secrets) in the owner's signed-in browser. The exact deployed names and callbacks are:

| Provider | Production settings | Exact callback |
|---|---|---|
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`; optional `YOUTUBE_OAUTH_REDIRECT_URI`, `YOUTUBE_OAUTH_APP_ORIGIN` | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/youtube-oauth` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_OAUTH_REDIRECT_URI`, `TIKTOK_OAUTH_APP_ORIGIN`; keep Direct Post settings disabled | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/tiktok-oauth` |
| Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`; optional `DISCORD_OAUTH_REDIRECT_URI`, `DISCORD_OAUTH_APP_ORIGIN` | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/discord-oauth` |
| Twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_OAUTH_REDIRECT_URI`, `TWITCH_OAUTH_APP_ORIGIN` | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitch-oauth` |
| Patreon | `PATREON_CLIENT_ID`, `PATREON_CLIENT_SECRET`, `PATREON_OAUTH_REDIRECT_URI`, `PATREON_OAUTH_APP_ORIGIN` | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/patreon-oauth` |
| Wix | `WIX_APP_ID`, `WIX_SHARE_URL_ID`, `WIX_POST_INSTALL_URI`, `WIX_OAUTH_APP_ORIGIN`; Vault-only `wix_app_secret` | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wix-oauth` |
| WordPress.com | `WORDPRESS_COM_CLIENT_ID`, `WORDPRESS_COM_REDIRECT_URI`, `WORDPRESS_OAUTH_APP_ORIGIN`; Vault-only `wordpress_com_client_secret` | `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wordpress-oauth` |

Use `https://mypersonas.online` for each app-origin value. Save Edge Function settings only on the linked Supabase page; never paste their values into this file, the site, the ledger, or chat. Wix and WordPress.com's two named app secrets are deliberate [Supabase Vault](https://supabase.com/docs/guides/database/vault) exceptions and must not be duplicated as Edge Function settings.

## Next actions

1. **X:** verify the production Web App and API credits, then freshly authorize each intended account
   with `tweet.write`. All 27 existing connection records are expired and unusable.
2. **Reddit:** owner reviews migration 021 and the versioned functions → sets
   `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and the exact callback → deploys
   `reddit-oauth` + `reddit-post` and pushes the frontend → verifies Connect,
   Disconnect, account erasure, and one explicitly approved low-stakes post. Keep
   scheduled Reddit publishing off; the current Queue action is owner-triggered.
3. **Meta:** keep the 25 fresh Facebook and 25 fresh Instagram grants, then run one separately previewed and approved low-stakes proof on an exact pair before relying on posting. The other three accounts remain unconnected.
4. **YouTube:** install the provider credentials, bind one exact channel, then run one explicitly approved Private upload/readback proof.
5. **TikTok:** install the provider credentials, bind one exact creator, then run one explicitly approved Upload-to-inbox/status proof. Finish or discard it in TikTok; Direct Post remains off.
6. **Wix / WordPress:** bind one exact site and author, create a draft with publishing off, read it back, and open the provider's own preview.
7. **Twitch:** choose the exact deployed feature (channel information, schedule segment, or announcement); do not present it as general feed/video publishing.
8. **Patreon:** use the deployed OAuth only for the read-only identity/campaign/existing-post report; ordinary posts stay in Patreon's native editor and scheduler.

## Owner handoff boundary

The reviewed release is live. MyPersonas can open an implemented provider authorization route only
after that provider's production credentials and callback configuration are present.
The owner must take over only for provider login, MFA, CAPTCHA, developer terms, billing, app review,
business verification, and the final consent screen. Secrets never belong in this file, the ledger,
or chat.
