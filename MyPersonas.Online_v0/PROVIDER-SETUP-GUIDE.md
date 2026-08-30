# MyPersonas provider setup guide

**Owner checklist for MyPersonas / AliaSpaces**
**Publishing readiness reviewed:** August 30, 2026

This guide covers every account type currently available in the MyPersonas Account Ledger. It distinguishes what the current site can actually connect from what a provider could support after a connector, provider review, or partner agreement is completed.

> **Do not enter a provider password, recovery code, one-time code, API secret, app password, or browser cookie into the Account Ledger, a note, or a chat.** Official OAuth should send you to the provider's own sign-in page. Server credentials belong only in the encrypted deployment secret store.

## What is true today

| State | What it means |
| --- | --- |
| **Connectable after owner setup** | MyPersonas already has the connector code. The owner must finish the provider-console step or verification before the consent button will work. |
| **Requires provider app/review** | The provider has an official route, but MyPersonas still needs provider credentials, approved permissions, a completed connector, and live testing. |
| **Limited / bot / business API** | The provider's API manages only part of the account, requires a bot/business/partner account, or does not publish ordinary feed posts. |
| **Mailbox-specific** | Safe access needs official mailbox OAuth, an encrypted IMAP worker, or a trusted local bridge. |
| **Manual staging only** | MyPersonas can prepare a package, record its intended time, support owner review, open the official site, and let the owner mark the staged item posted or sent. It must not automate the provider login or scrape the account. |

Current implementation:

- **Gmail:** real OAuth and Inbox Concierge source are implemented. Google still requires each testing mailbox to be listed as a test user, or the app must complete production verification. Reverify the deployed source before relying on it.
- **X / Twitter:** OAuth plus an owner-triggered, text-only publisher are implemented in this source release. The publisher is still inactive until this release is deployed, the production X app has credits, every intended account is reauthorized with `tweet.write`, and one exact-account proof is read back. Existing read-only grants cannot publish.
- **Facebook Pages and linked Instagram professional accounts:** official pairing plus owner-triggered Page/IG publishing were proven earlier on an owner-controlled asset. Recurring publishing remains off, and the current hardened source/migration release is not deployed or live-verified. App Review is still required before serving accounts outside the app's permitted owner/test roles.
- **Reddit:** official OAuth and explicit owner-triggered posting source exist locally. Migration 021, credentials, deployment, commercial/API terms, revocation, erasure, and one disposable live post still require owner review and proof.
- **Discord:** official `webhook.incoming` OAuth plus an exact-channel, owner-triggered publisher are implemented in this source release. It remains inactive until deployment, authorization, and a designated-channel proof; mentions are disabled by default.
- **YouTube:** narrow `youtube.upload` OAuth and a Private-first uploader are implemented in this source release, but credentials, deployment, channel authorization, and a Private readback proof are still required.
- **TikTok:** narrow `video.upload` OAuth and Upload-to-inbox are implemented in this source release. Direct Post and unattended public scheduling are deliberately disabled; the owner finishes the draft inside TikTok.
- **Twitch:** action-specific OAuth is implemented for channel information, stream schedule segments, and announcements. Twitch does not provide an ordinary social-feed or uploaded-video publisher through this route.
- **Patreon:** API v2 read/report authorization plus a native-editor handoff are implemented. Patreon ordinary post creation and scheduling remain owner actions inside Patreon.
- **Wix and WordPress:** exact-site Draft creation is implemented in this source release. Neither connector can publish or schedule; deployment, exact site/author authorization, provider-draft readback, and the provider's own theme preview are still required.
- **Every other provider:** remains an inventory or planning record until its connector is built and tested. A saved username, matching email, or “ownership verified” label is not provider authorization.

## Seven separate checks before a provider is called ready

MyPersonas must show these as separate facts. It must not collapse them into a single “connected” or “verified” label:

1. **Inventory:** the account, channel, campaign, Page, or site is saved.
2. **App credentials:** the provider recognizes the MyPersonas developer app. A client ID identifies the app; the client secret is the app's password and belongs only in encrypted server secrets.
3. **Owner sign-in:** the correct owner completed official OAuth or another supported authorization route.
4. **Write permission:** the grant includes the exact action being attempted, not only profile/read access.
5. **Exact target binding:** the provider's permanent ID for the intended Page, channel, creator, campaign, or site is saved. An author/member ID can separately select the byline. These IDs are not account or post counts.
6. **Publisher live:** reviewed MyPersonas code can submit, record the provider result ID, reconcile an uncertain outcome, revoke access, and avoid duplicates.
7. **Provider proof:** a private, draft, reversible, or designated test action was read back successfully from the exact destination.

A display such as `3 / 0` means three inventory records and zero authorized connections. It does not mean three scheduled posts.

## Non-negotiable platform preview before any approval or scheduling

**No preview, no approval, no schedule, and no immediate send.** Every action control must stay disabled until the owner sees and acknowledges a platform-specific preview of the exact proposed action. That preview must show:

- the provider and exact account, Page, channel, campaign, or site;
- the submitted media in the platform's relevant aspect frame, visible safe-area guidance, text limits, thumbnail or cover treatment, and links;
- final text, media, accessibility text, AI/affiliate disclosures, audience, privacy, and available interaction settings; and
- the date, clock time, named time zone, and exact provider action that will occur.

The server first prepares a short-lived immutable receipt, and the site renders the platform preview from that server snapshot. Your confirmation then records a separate AAL2 acknowledgement for the same owner session; only that acknowledged, unexpired, unchanged receipt can be consumed once. Any change to content, media, destination, visibility, disclosure, action, or time invalidates the receipt and requires a new preview. The preview shows the full submitted asset and safe-area guidance; final rendering can still vary by device, placement, provider UI, and active website theme. For Wix and WordPress, the owner must also open the provider's own draft/theme preview before any later public schedule because the live theme controls the final page.

## Who does what

### You, the owner

1. Create or upgrade the eligible provider account.
2. Create the provider developer/business app where required.
3. Add the exact callback URL shown in this guide.
4. Add test users, business assets, Pages, channels, or bots.
5. Complete identity, business, app, or security review.
6. Accept provider pricing or partner terms.
7. Sign in on the provider's consent screen and select the exact account.
8. Approve the first real publish, mailbox change, reply, or financial action.

### Codex / MyPersonas

1. Build the provider-specific OAuth and API adapter.
2. Store credentials and tokens server-side in the encrypted secret store.
3. Verify that the provider identity matches the ledger record.
4. Request only the minimum permissions needed for the feature you enable.
5. Stage drafts, media, accessibility text, disclosures, affiliate links, and replies.
6. Keep approval, publishing, failure, retry, and revocation records.
7. Enforce caps, quiet hours, approval rules, and a global pause.
8. Never bypass provider controls with passwords, cookies, scraping, or unofficial login automation.

## Recommended rollout order

1. **Keep the public review pages live:** [Privacy](https://mypersonas.online/privacy.html), [Terms](https://mypersonas.online/terms.html), and [Data deletion](https://mypersonas.online/data-deletion.html).
2. **Finish one Gmail connection and one real report** before connecting the rest of the mailboxes.
3. **Deploy the reviewed provider release**, add X API credits, then reauthorize each intended X account with `tweet.write` for the text-only first release.
4. **Finish the Meta Business app**, connect Facebook Pages, and pair each linked Instagram professional account.
5. Add **Outlook**, then the secure Yahoo/iCloud worker and local Proton Bridge companion.
6. Configure and privately prove the implemented **Discord, YouTube, TikTok Upload-to-inbox, Twitch, Patreon handoff, Wix Draft, and WordPress Draft** routes one exact destination at a time.
7. Submit any required review/audit applications for **Meta, TikTok, YouTube, LinkedIn, Reddit, and Snapchat**.
8. Keep unsupported creator and marketplace accounts in the **manual staging workflow**.

## Social publishing through official APIs

### X / Twitter — requires provider app setup

**What can ultimately be managed:** account identity, scheduled posts, media, replies, and selected engagement features within approved scopes. X API use is pay-per-use.

**Owner steps**

1. Open the [X Developer Console](https://console.x.com), accept the developer terms, and create a confidential Web App.
2. Set the callback exactly to:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitter-oauth`
3. Add `https://mypersonas.online` as the website URL.
4. For the text-only publisher, allow `tweet.read`, `tweet.write`, `users.read`, and `offline.access`.
5. Install the client ID and client secret directly as deployment secrets named `X_CLIENT_ID` and `X_CLIENT_SECRET`. Do not paste them into the website or chat.
6. Activate X API billing/credits and set a conservative spending limit. See [current X API pricing](https://docs.x.com/x-api/getting-started/pricing).
7. Connect the exact X account from MyPersonas.

**Before posting can be enabled**

- Deploy the reviewed `twitter-post` function and migrations, then complete an exact-account text-post proof with provider readback. Media upload remains disabled in this first release.
- The app must request `tweet.write`.
- You must explicitly reauthorize after the write feature exists. The existing read grant cannot publish.

Official reference: [OAuth 2.0 Authorization Code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).

### Facebook Pages + Instagram — paired Meta route, requires review

**What can ultimately be managed:** Facebook **Pages** and eligible Instagram **Business or Creator** accounts. Personal Facebook profiles and Instagram consumer accounts are not eligible for this automation route.

**Best setup for synchronized posting**

1. In Facebook, create or confirm each Facebook Page.
2. Convert the Instagram account to **Business or Creator**.
3. Link that Instagram professional account to the correct Facebook Page.
4. Put both assets in the same Meta Business Portfolio.
5. The MyPersonas pairing flow lets you choose a Page and discover its linked Instagram account. An owner-triggered Page/IG pair was proven earlier, but the recurring queue remains off and the current hardened source has not been deployed or reverified. Every retry keeps separate provider result identifiers to avoid claiming or blindly repeating a partially successful pair.

**Owner steps**

1. Open [Meta for Developers — My Apps](https://developers.facebook.com/apps/) and create a **Business** app.
2. Open [Meta Business settings](https://business.facebook.com/settings/), select the correct business portfolio, and confirm that you administer the Pages and linked Instagram accounts.
3. Add Facebook Login for Business and this exact callback:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/meta-oauth`
4. Add `mypersonas.online` to the allowed app domains and use the live policy URLs above.
5. Install the app ID and app secret directly as deployment secrets named `META_APP_ID` and `META_APP_SECRET`. If Facebook Login for Business gives this app a login configuration ID, also install it as optional `META_LOGIN_CONFIG_ID`; the connector sends it as `config_id`.
6. While the app is in development, add the intended Facebook member as an app role/tester and ensure that member has Page access.
7. First authorize discovery scopes: `pages_show_list`, `pages_read_engagement`, and `instagram_basic`.
8. After the pairing flow passes, request Advanced Access/app review for the exact production features.

**Before Facebook Page posting can be re-enabled from this source release**

- Add `pages_manage_posts`; add `pages_manage_engagement` only if Page comment/reply management is enabled.
- Deploy and verify the reviewed Page publish primitives, duplicate protection, partial-success reconciliation, revocation, and one disposable real Page test. Do not infer current deployment parity from the earlier proof.

**Before linked Instagram posting can be re-enabled from this source release**

- Add `instagram_content_publish`; add `instagram_manage_comments` only for owner-approved comment management; add insights only if reports need them.
- Deploy and verify the reviewed media-container status checks, publish primitive, media validation, partial-success reconciliation, and one disposable professional-account test. Instagram deletion remains a manual in-app action.
- Stories through the Facebook Login route are limited to eligible business accounts; do not assume every professional account can use every format.

Meta's official setup and reference links: [Meta App Dashboard](https://developers.facebook.com/apps/) to configure the app, [Facebook Pages API getting started](https://developers.facebook.com/docs/pages-api/getting-started/) and [Page posts documentation](https://developers.facebook.com/docs/pages-api/posts/) for the Page-publishing API, [Instagram API with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/), [App Review](https://developers.facebook.com/docs/app-review/), and [Business verification](https://developers.facebook.com/docs/development/release/business-verification).

**Standalone Instagram alternative:** Meta also offers Instagram Login for professional accounts without a linked Page. It uses `instagram_business_basic` and `instagram_business_content_publish`. MyPersonas should add this only as a separate connector after the paired Page route is stable; see the [official Instagram API documentation](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

### Threads — requires Meta app/review

**Owner steps**

1. Use the Meta developer app and live policy/data-deletion URLs.
2. Add the Threads API product and configure its OAuth redirect when the MyPersonas Threads callback is implemented.
3. Request `threads_basic` and `threads_content_publish`.
4. Add `threads_read_replies`, `threads_manage_replies`, or `threads_manage_insights` only for features you actually enable.
5. Add the owner as a tester during development; complete Meta review before serving non-role accounts.

**Codex work still required:** OAuth callback, token lifecycle, publishing, replies, analytics, reconciliation, and live-account tests.

Official reference: [Threads official API workspace](https://www.postman.com/meta/threads/overview).

### TikTok — requires app review and Content Posting audit

**Implemented action:** Upload a video to the authorized creator's TikTok inbox so the owner can finish the caption, privacy, disclosure, and interaction choices in TikTok. Direct Post is deliberately disabled in this release.

**Current MyPersonas state:** the `video.upload` OAuth and Upload-to-inbox source are implemented but not deployed or live-verified. Production app credentials, an exact creator authorization, a verified media source, and one inbox readback proof are still required.

**Owner steps**

1. Register or sign in by following TikTok's current [app registration guide](https://developers.tiktok.com/doc/getting-started-create-an-app).
2. Create an app, provide the live website, Privacy, Terms, and Data Deletion URLs, and configure this callback: `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/tiktok-oauth`.
3. Add the **Content Posting API** product.
4. Request the minimum `video.upload` scope for the implemented Upload-to-inbox flow. Do not request `video.publish` for this release.
5. Verify the media domain or URL prefix if TikTok will pull hosted media.
6. Submit the app and Upload API use case for any review or audit TikTok requires.

Before every upload, MyPersonas shows the exact creator, media, caption handoff, and action, then consumes a short-lived owner preview receipt. The safe first proof is an Upload-to-inbox followed by provider-status polling; the owner completes or discards it in TikTok. It does not authorize Direct Post or unattended public scheduling.

Official references: [Content Posting API setup](https://developers.tiktok.com/docs/en/content-posting-api-get-started) and [Upload-to-inbox reference](https://developers.tiktok.com/docs/en/content-posting-api-reference-upload-video).

### YouTube — requires Google OAuth and API compliance audit

**Supported action:** upload a video with the narrow `youtube.upload` scope. A private upload is the safe first connector proof.

**Current MyPersonas state:** the narrow OAuth and Private-first uploader are implemented in source but not deployed or live-verified. Production client credentials, owner authorization, exact channel binding, and one Private readback proof are still required.

**Owner steps**

1. Create a dedicated project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the YouTube Data API v3.
3. Configure the OAuth consent screen with the live policy URLs and add this callback: `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/youtube-oauth`.
4. Create a Web OAuth client and add the owner as a test user during development.
5. Request `https://www.googleapis.com/auth/youtube.upload`; add broader YouTube scopes only if a separately approved feature needs them.
6. Complete Google OAuth verification as required.
7. Submit the YouTube API compliance audit before relying on public uploads.

Uploads from unverified API projects created after July 28, 2020 are restricted to private visibility. The first proof must upload a clearly labeled test video as Private, read back its returned video ID and status from the exact channel, and leave it private or delete it only after approval. YouTube can also schedule an unpublished private video using `status.publishAt`, but MyPersonas must first show the exact channel, title, description opening, thumbnail/crop, audience, synthetic-media disclosure, privacy, date, and named time zone.

Official reference: [YouTube `videos.insert`](https://developers.google.com/youtube/v3/docs/videos/insert).

### LinkedIn — member posting is self-service; organization access is reviewed

**Owner steps**

1. Create an app in [LinkedIn Developer Apps](https://www.linkedin.com/developers/apps).
2. Associate it with the correct LinkedIn Page and verify the Page relationship.
3. Add **Sign In with LinkedIn using OpenID Connect** for identity and **Share on LinkedIn** for member posting.
4. Configure the callback Codex supplies when the connector is built.
5. Request `w_member_social` for the owner's member posts.
6. For organization/Page posting, apply for the current Community Management access and request the write permission shown in the approved product. The owner must have a qualifying Page role such as Administrator or Content Admin.

LinkedIn is migrating community-management permission names and versions. Use the scopes actually granted in the developer portal rather than copying an old scope list.

Official references: [Getting API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access), [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api), and [Community Management migration guide](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-api-migration-guide).

### Bluesky — official OAuth, no conventional developer review

**Owner steps**

1. No developer-console application is normally required.
2. Codex must first publish a MyPersonas OAuth client-metadata JSON document over HTTPS and add the secure callback.
3. Select **Connect Bluesky** and authorize the correct account at its provider.

**Codex work still required:** OAuth client metadata, PKCE, pushed authorization requests, DPoP, refresh-token rotation, secure key storage, account verification, repository-record publishing, and revocation. A hosted connector should not collect Bluesky app passwords.

Official references: [Bluesky OAuth client guide](https://docs.bsky.app/docs/advanced-guides/oauth-client) and [AT Protocol repository records](https://docs.bsky.app/docs/api/com-atproto-repo-put-record).

### Snapchat — Public Profile API is allowlist-only

**Owner steps**

1. Create or confirm a Snapchat **Public Profile**.
2. Create a Snap Business Account/Organization in [Snap Business Manager](https://business.snapchat.com/).
3. Create the OAuth app in Business Manager, not the general developer portal.
4. Give Snap the client ID and the exact MyPersonas use case through the allowlist/application process. Never send the client secret to a representative.
5. Request the `snapchat-profile-api` scope and authorize the Public Profile after approval.

Personal Snapchat account automation is not supported. Access and pricing/partner terms depend on Snap's allowlist decision.

Official references: [Public Profile API introduction](https://developers.snap.com/marketing-api/Public-Profile-API/Introduction) and [get started](https://developers.snap.com/marketing-api/Public-Profile-API/GetStarted).

### Reddit — explicit user action and approval, not unattended autopost

Reddit's current Devvit user-action route requires a clear, separate owner click for each post or comment. It explicitly prohibits automated user actions.

**Owner steps**

1. Create a project at [Reddit for Developers](https://developers.reddit.com/new).
2. Use Devvit permissions `SUBMIT_POST` and/or `SUBMIT_COMMENT` only for the actions needed.
3. Keep publishing and commenting as separate, explicit buttons.
4. Publish the Devvit app and complete approval before expecting actions to run as ordinary users.
5. If MyPersonas is commercial or monetized, obtain any separate agreement Reddit requires before using its Data APIs commercially.

**Safe MyPersonas mode:** prepare the title/body/media, show the exact target subreddit, require an owner click, submit once, and mark the staged item posted. Do not automate voting, following, bulk comments, or unattended submissions.

Official references: [Devvit user actions](https://developers.reddit.com/docs/capabilities/server/userActions), [launch a Devvit app](https://developers.reddit.com/docs/guides/launch/launch-guide), and [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms).

## Bot, live-stream, membership, and business-messaging APIs

### Discord — bot only

**Owner steps**

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add a bot and install it into each server through OAuth with `bot` and `applications.commands`.
3. Grant only the channels and permissions needed: typically View Channel, Send Messages, Embed Links, Attach Files, and Read Message History only when required.
4. Store the bot token only in the deployment secret store.

Never automate a normal Discord user account or use a “self-bot.” Codex must build channel selection, slash-command/interaction verification, rate-limit handling, moderation boundaries, and audit logs.

Official reference: [Discord OAuth and permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions).

### Telegram — bot/channel route

**Owner steps**

1. Open the official [BotFather](https://t.me/BotFather), create a bot, and copy the token directly into the deployment secret store.
2. Add the bot as an administrator to the intended channel or group.
3. Grant only the ability to post/manage messages that the workflow needs.
4. Record the exact channel or group identifier in MyPersonas.

Codex can build `sendMessage`, `sendPhoto`, `sendVideo`, webhook verification, and error reconciliation. A personal Telegram login is not an ordinary hosted OAuth connector.

Official reference: [Telegram Bot API](https://core.telegram.org/bots/api).

### WhatsApp — Business Platform messaging, not social-feed posting

**Owner steps**

1. Create or use a Meta Business Portfolio.
2. Create a WhatsApp Business Account and add a business phone number.
3. Add the WhatsApp product to the Meta app and follow [WhatsApp Cloud API setup](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api).
4. Request `whatsapp_business_management` and `whatsapp_business_messaging`; use `business_management` only when the selected setup requires it.
5. Configure webhooks and complete Meta review/Advanced Access before production use.
6. Create and obtain approval for business-initiated message templates and review [current WhatsApp pricing](https://developers.facebook.com/docs/whatsapp/pricing/).

This connector may manage customer conversations for the business number. It must not be presented as social posting or as access to a personal WhatsApp account. Automated replies need opt-in, template/window compliance, escalation rules, and owner approval for sensitive messages.

### Patreon — reporting/webhooks plus native scheduled posts

**Supported API actions:** identity, campaigns, memberships, post reads, webhooks, and Patreon Live capabilities that Patreon makes available to an eligible early-access integration.

**Unsupported action:** Patreon's public API does not offer a general create-post permission. MyPersonas cannot honestly provide API-based ordinary Patreon post publishing or scheduling.

**Owner steps**

1. Register a client in the [Patreon developer portal](https://www.patreon.com/portal/registration/register-clients).
2. Configure the callback Codex supplies when the connector is built.
3. Grant only identity/campaign/member/post-read/webhook scopes needed for reporting.
4. Use Patreon's own [scheduled posts](https://support.patreon.com/hc/en-us/articles/360031956632-Scheduled-posts) for publishing.

MyPersonas should stage the title, body, media, attachment, access tier/audience, charge setting when applicable, disclosure, and intended time. The owner then opens Patreon's native draft, checks Patreon's own preview, schedules it there, and returns the native draft/post URL to MyPersonas. A safe API proof is read-only reporting access to the exact campaign; a safe content proof is a native Patreon draft, not a public test post.

Official reference: [Patreon API documentation](https://docs.patreon.com/).

### Twitch — channel, schedule, chat, and moderation tools

**Supported actions:** read/update selected channel information, manage eligible stream schedule segments, and perform separately authorized chat/announcement or moderation actions.

**Unsupported action:** Twitch does not expose a general social-feed or uploaded-video publisher. A Twitch connection must not be labeled as ordinary scheduled-post capability.

**Owner steps**

1. Register an app in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Add the callback Codex supplies when the connector is built.
3. Request only the scopes required for selected features, such as `channel:manage:schedule` or the current chat/moderation scopes.
4. Confirm Affiliate/Partner eligibility before relying on nonrecurring schedule operations.

First verify the exact broadcaster/channel with a read. Any write test can be visible, so it requires a separate platform-shaped preview and explicit owner approval; use a reversible schedule item or a designated test channel where available. A Twitch preview must show the actual action type—schedule segment, channel change, or chat announcement—rather than a fake feed card.

Official references: [Twitch API](https://dev.twitch.tv/docs/api/), [scopes](https://dev.twitch.tv/docs/authentication/scopes/), and [schedule API](https://dev.twitch.tv/docs/api/schedule).

### Kick — channel/chat API, not ordinary feed publishing

**Owner steps**

1. Open [Kick Dev](https://dev.kick.com/) and create the developer app.
2. Configure the callback Codex supplies when the connector is built.
3. Approve only channel/chat/moderation features you want managed.

Kick's official public API currently exposes channel updates, chat messages, event subscriptions, rewards, moderation, and live-stream information. No general uploaded-post/feed publisher is documented. MyPersonas should not promise scheduled feed publishing.

Official references: [Kick developer help](https://help.kick.com/en/articles/8159966-kick-dev), [Kick documentation](https://docs.kick.com/), and [public API reference](https://api.kick.com/swagger/index.html).

### Rumble — use the native uploader/scheduler

No official public video-upload API was located as of July 28, 2026. Rumble's Live Stream API is a read/overlay data feed, not an upload or publishing API.

Use MyPersonas to prepare the file, title, description, thumbnail, affiliate disclosure, and schedule; then open Rumble's native uploader, finish the upload/schedule, and mark the task posted with its URL.

Official references: [upload a video](https://rumble.support/help/how-to-upload-a-video), [upload Shorts](https://rumble.support/help/upload-shorts), [set up a livestream](https://rumble.support/en/help/how-to-setup-a-livestream), and [Live Stream API](https://rumble.support/help/how-to-use-rumble-s-live-stream-api).

## Mailbox management

All mailbox automation starts report-only. Labels, archive, Trash, unsubscribe, or other changes must appear as exact approval items. MyPersonas does not send mail or permanently delete Gmail messages.

### Gmail — connector implemented; Google testing/verification remains

**Owner steps now**

1. Open the existing project's [Google Auth Platform Audience](https://console.cloud.google.com/auth/audience?project=genial-union-503010-q5).
2. While the app is in Testing, add every exact Gmail address that will connect under **Test users**.
3. Confirm the Gmail API is enabled and the OAuth client includes:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth`
4. Use `openid`, `email`, and `https://www.googleapis.com/auth/gmail.modify`. Do not request full-mailbox scope.
5. In MyPersonas, record the exact Gmail address and press **Connect Gmail**. Choose that same Google account on the Google screen.
6. Run one report first. Review the proposed account-discovery, subscription, receipt, registration, and cleanup actions before approving any change.

Testing refresh tokens normally expire after seven days. A durable public release needs Google OAuth verification; storing/transmitting restricted Gmail data can also require a restricted-scope security assessment.

Official references: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and [Google OAuth verification](https://support.google.com/cloud/answer/13461325?hl=en).

### Outlook / Hotmail / Microsoft 365 — Microsoft Graph connector required

**Owner steps**

1. Open [Microsoft Entra App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and create an app.
2. Choose **Accounts in any organizational directory and personal Microsoft accounts** so Hotmail/Outlook.com and work accounts can authorize.
3. Add the exact MyPersonas callback after Codex builds the Outlook connector.
4. Start with delegated `openid`, `profile`, `email`, `offline_access`, `User.Read`, and `Mail.Read`.
5. Add `Mail.ReadWrite` only when exact cleanup actions are implemented and owner-approved. Do not add `Mail.Send`.
6. Add test users/tenant consent as required, then connect the exact recorded address.

Official references: [register an app](https://learn.microsoft.com/en-us/graph/auth-register-app-v2) and [Microsoft identity OAuth flow](https://learn.microsoft.com/en-us/graph/auth-v2-user).

### Yahoo Mail — encrypted IMAP worker required

Yahoo documents IMAP access rather than a general mailbox-management API for this use.

**Owner steps after the secure worker exists**

1. Turn on account security/2-step verification as Yahoo requires.
2. Create an [app password](https://help.yahoo.com/kb/account/password-sln15241.html) for the dedicated worker.
3. Enter it only through the future encrypted secret-entry flow—not the ledger, notes, or chat.
4. The worker will use `imap.mail.yahoo.com`, port `993`, SSL, and the full Yahoo email address.

Some Yahoo accounts cannot create app passwords. If Yahoo does not offer one, use Yahoo's official web/mobile app and keep MyPersonas in manual/report staging.

Official reference: [Yahoo IMAP settings](https://help.yahoo.com/kb/imap-internet-message-access-protocol-sln4075.html).

### iCloud Mail — third-party authorization or app-specific password

**Owner steps after the secure worker exists**

1. Enable two-factor authentication for the Apple Account.
2. Prefer Apple's supported [third-party authorization](https://support.apple.com/en-us/121539) when available for the app.
3. Otherwise create an [app-specific password](https://support.apple.com/en-us/102654).
4. Enter it only through the future encrypted secret-entry flow.
5. The worker will use `imap.mail.me.com`, port `993`, SSL, and the full iCloud email address.

Official reference: [iCloud Mail server settings](https://support.apple.com/en-gb/102525).

### Proton Mail — trusted local Proton Bridge companion

**Owner steps**

1. Confirm the mailbox has a paid Proton plan that supports Bridge.
2. Install [Proton Mail Bridge](https://proton.me/support/protonmail-bridge-install) on a trusted always-on computer.
3. Sign in to Bridge locally.
4. After Codex builds the local companion, authorize it to connect only to Bridge's localhost IMAP endpoint.

A hosted website cannot directly reach the local Bridge. Do not expose Bridge ports to the internet. Protect the local disk because connected mail software may store decrypted copies.

Official reference: [Proton IMAP/SMTP and Bridge](https://proton.me/support/imap-smtp-and-pop3-setup).

### Email / Newsletter — choose the real service first

“Email / Newsletter” is a category, not a provider. Record whether it is Mailchimp, Kit, beehiiv, Substack, Buttondown, another sender, or a mailbox. Codex can then evaluate that provider's official OAuth/API and sending rules. A mailbox password must never be reused as a newsletter connector.

## Website, commerce, reviews, and affiliate management

### Wix — official site/store APIs

Use the native MyPersonas external app-install flow. Create the app in [Wix Custom Apps](https://manage.wix.com/account/custom-apps), request only **Manage Blog** and **Read Members**, release the permission version, and create a Share Install Link if the app is unlisted. MyPersonas does not ask the owner for a Wix password or account API key.

Set the external post-install URL to `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wix-oauth`. Store the app secret only in Supabase Vault as `wix_app_secret`. MyPersonas verifies the signed instance and exact site ID, then separately binds the intended author/member ID and proves the installed permissions with provider reads.

The connector source is staged but not deployed or live-verified. Its first proof creates one uniquely titled Blog draft with publishing explicitly off and reads it back from the exact site. Wix does not document an active-theme preview deep link for this API draft, so MyPersonas returns the exact site dashboard and provider ID; the owner opens Blog → Posts → Drafts and uses Wix's own preview. No CMS public schedule exists in this release.

Official references: [create Wix Blog posts](https://dev.wix.com/docs/api-reference/business-solutions/blog/skills/how-to-create-blog-posts), [Wix Draft Posts API](https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/introduction), and [external install flow](https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/set-up-the-external-install-flow).

### WordPress — choose WordPress.com or self-hosted first

“WordPress” is not one shared authorization route.

- **WordPress.com:** use official OAuth for a deployed MyPersonas connector. The currently signed-in Codex WordPress.com connection is a separate tool grant; enabling Content Authoring at [WordPress.com MCP settings](https://wordpress.com/me/mcp) can prove Codex access to selected sites, but it does not authorize the deployed MyPersonas app.
- **Self-hosted WordPress:** use the site's REST API and a separate, revocable Application Password for the exact author. Enter it only in the transient connection dialog; MyPersonas stores it only in Supabase Vault.

**Owner steps**

1. Identify every site as WordPress.com or self-hosted and save its exact site address/ID.
2. Select the intended author/byline and grant only content-writing access.
3. Do not treat a generic Website record or saved URL as authorization.
4. After deployment and exact connection, approve the platform preview and create one uniquely titled **Draft**; read it back from the exact site and author. Private, Publish, and Schedule are outside this proof.
5. Open WordPress Preview in the site's active theme on desktop and mobile before approving a public schedule.

Official references: [WordPress.com OAuth](https://developer.wordpress.com/docs/api/oauth2/), [WordPress.com REST API](https://developer.wordpress.com/docs/api/getting-started/), [REST Posts](https://developer.wordpress.org/rest-api/reference/posts/), and [Application Passwords](https://developer.wordpress.org/advanced-administration/security/application-passwords/).

### Website / Store — identify the host or CMS

Record the exact host: WordPress, Shopify, Squarespace, Webflow, WooCommerce, a custom site, or another service. Codex will then use the official OAuth/API, a narrowly scoped service account, or a normal Git deployment. A saved website URL is not authentication.

Owner approval remains required for domain/DNS changes, billing, checkout/payment changes, legal text, destructive content removal, and a production publish that materially changes the business.

### Etsy — seller/shop API

**Owner steps**

1. Confirm the Etsy shop is active and in good standing.
2. Register at [Etsy Developers](https://developers.etsy.com/documentation/).
3. For your own shop, create a Seller App. Use Personal/Commercial access only if the app will serve other sellers.
4. Configure the callback Codex supplies when the connector is built.
5. Request `listings_r` and `listings_w`; request delete or transaction scopes only for an explicitly approved feature.

The connector can manage shop/listing/order data within Etsy's approved access. It is not social-feed posting.

Official reference: [Etsy listing tutorial and scopes](https://developers.etsy.com/documentation/tutorials/listings/).

### Amazon / Affiliate — product/link data, not account posting

**Owner steps**

1. Join [Amazon Associates](https://affiliate-program.amazon.com/) for each intended marketplace.
2. Keep the correct Partner Tag/tracking ID for each persona and region.
3. Meet Amazon's current qualifying-sales requirement for API eligibility.
4. Register for the [Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/onboarding/register-for-creators-api) and store its credentials only in the deployment secret store.
5. Put a clear affiliate disclosure next to every qualifying link.

Amazon retired Product Advertising API on May 15, 2026; new work should use the Creators API. This can support product discovery and approved affiliate-link data. It does not authorize MyPersonas to operate the retail account or publish social posts.

Official reference: [Creators API introduction](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction).

### Yelp — claimed business plus partner review-reply access

**Owner steps**

1. Claim and verify the business listing in [Yelp for Business](https://biz.yelp.com/).
2. Create/manage the developer app at [Yelp Manage App](https://www.yelp.com/developers/v3/manage_app).
3. Apply as a Yelp Partner for Respond to Reviews access; it is disabled by default.
4. Ensure the replying owner profile meets Yelp's name/photo requirements.
5. Request `r2r` and `r2r_business_owner` only after approval.

Do not automate consumer reviews, review solicitation that violates policy, or fabricated replies. Stage replies for owner approval until partner access and live tests pass.

Official reference: [Yelp Respond to Reviews API v2](https://docs.developer.yelp.com/docs/respond-to-reviews-api-v2).

### Trustpilot — paid API module / partner route

**Owner steps**

1. Use a Trustpilot for Business account.
2. Confirm the plan includes the API module or obtain it through Trustpilot.
3. Start with [Trustpilot developer documentation](https://developers.trustpilot.com/introduction/) and identify the Business Unit ID.
4. For a product serving multiple businesses, apply to [become an integration partner](https://developers.trustpilot.com/become-an-integration-partner/).

Invitations, business data, and replies depend on plan, module, approval, and the exact API. Pricing is contract/add-on dependent. Stage replies for owner approval until the production entitlement is confirmed.

Official reference: [API module best practices](https://developers.trustpilot.com/api-module-best-practices/).

### LegalZoom — official MCP is narrow; legal actions remain owner-controlled

LegalZoom offers an [official MCP access path](https://www.legalzoom.com/tools/mcp-docs), but its available capabilities depend on the authorized service and documents. MyPersonas has no LegalZoom connector.

Keep LegalZoom as a manual inventory record unless you deliberately authorize a narrow document workflow. Contract formation, filings, signatures, legal advice, purchases, and account changes always require owner review and confirmation.

### Fiverr — manual staging only

No official public Fiverr seller gig/order/message-management API or developer portal was located.

Use MyPersonas to prepare gig copy, images, FAQs, offers, and reply drafts from text you paste or otherwise supply. Open Fiverr, review, send/publish manually, and mark the task complete. Do not automate seller login, scrape buyer messages, or mass-message.

Official reference: [Fiverr prohibited-services guidance](https://help.fiverr.com/hc/en-us/articles/49174165608593-Prohibited-services-on-Fiverr).

## Manual-only and consumer gaming accounts

### OnlyFans — manual staging only

As of July 28, 2026, no public official OnlyFans developer portal or account-management API was located. MyPersonas must not collect an OnlyFans password, 2FA code, recovery code, browser cookie, or session token; must not scrape fans/messages; and must not use unofficial automation to log in, mass-message, or publish.

**Safe MyPersonas workflow**

1. Build a complete content package: media, caption, accessibility text, content warning, price/promotion notes, affiliate link/disclosure, and intended time.
2. Review and approve the package in MyPersonas.
3. In the review Queue, use **Open asset** for the media handoff, **Copy package** for the approved text and links, and **Open account** to continue on OnlyFans.
4. Publish or schedule using OnlyFans' own signed-in interface **only if that interface currently offers the feature**.
5. Return to MyPersonas and mark the staged item posted.
6. For replies, paste or otherwise supply the message text to MyPersonas, approve the reply draft, and send it yourself.
7. Connected email may identify OnlyFans notifications or receipts, but it must not be used to reconstruct private fan conversations.

Use the provider's [official site](https://onlyfans.com/) and [Terms](https://onlyfans.com/terms). Availability of native scheduling must be confirmed in the signed-in account; this guide does not claim it exists for every account or content type.

### Signal — manual only

Signal does not provide a supported hosted account-management API for this use. Its terms prohibit bulk/automated messaging and unauthorized data collection.

Paste or supply message text for a reply draft, review it, and send it in Signal yourself. Do not automate registration, copy session material, scrape conversations, or run bulk messaging.

Official references: [Signal legal terms](https://signal.org/legal/) and [developer documentation](https://signal.org/docs/).

### Steam, PlayStation, Xbox, Nintendo, and Epic Games — inventory only

These providers offer game-developer, title-service, public-statistics, or publisher APIs—not a general consumer-account/social-posting management API.

- **Steam:** [Steam Web API overview](https://partner.steamgames.com/doc/webapi_overview). Consumer/social management remains manual; publisher keys are only for approved Steamworks operations.
- **PlayStation / PSN:** [PlayStation Partners](https://partners.playstation.net/sign-in) is for game development/publishing. Personal PSN management remains manual.
- **Xbox:** [Xbox services APIs](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/xbox-services-api/live-introduction-to-xbox-live-apis) are title/game services, not a social-media manager for a consumer Xbox account.
- **Nintendo:** [Nintendo Developer Portal registration](https://developer.nintendo.com/register) is for game development/publishing. Consumer account management remains manual.
- **Epic Games:** [Epic Online Services Accounts & Social](https://onlineservices.epicgames.com/en-US/accounts-social) supports a developer's game integration, not a general Epic account manager.

MyPersonas can inventory usernames, map personas, store public profile URLs and private planning notes, record intended times, and draft public descriptions. Never store gaming passwords, recovery codes, cookies, or publisher keys in the ledger.

### Other — assess before connecting

Record the provider name and public account URL. Codex will check for an official developer program, account eligibility, OAuth/API scopes, pricing, review, and terms. Until that review is complete, use manual staging only.

## Standard manual staging handoff

Use this for OnlyFans, Fiverr, Rumble, Signal, consumer gaming accounts, and any provider without a live-tested connector:

1. **Stage:** caption/body, media, thumbnail, accessibility text, disclosures, affiliate links, target account, and intended time.
2. **Preview and approve:** show the exact platform-shaped preview, destination, visibility, and time zone; require the owner to approve or deny that exact revision. Any edit invalidates the approval.
3. **Handoff:** provide Copy package, Open asset, and Open account controls.
4. **Publish manually:** owner signs in and finishes the external action.
5. **Record:** owner returns to MyPersonas and marks the staged item posted or sent.
6. **Follow up:** the item remains visible in the review Queue until the owner marks it complete or skips it.

Safe options for unsupported platforms:

- Native provider scheduler, when the signed-in provider interface currently offers it.
- Email discovery for registration, billing, security, and notification messages through a separately authorized mailbox.
- Affiliate-link inventory, disclosure checks, and click/report imports where the affiliate program officially supports them.
- Reply drafts from text the owner pastes or explicitly supplies.
- Manual open-asset/copy-package/open-account/mark-posted workflow.

Never use:

- Saved external passwords or app passwords in the ledger.
- Browser cookies, session tokens, or copied local storage.
- Scraping private inboxes, fan lists, followers, or messages.
- CAPTCHA bypasses, stealth browsers, or reverse-engineered private APIs.
- Auto-DMs, unsolicited bulk replies, fake engagement, or unattended actions that a provider requires a human to confirm.

## Full account-type coverage

| Ledger key | Account type | Current safe classification |
| --- | --- | --- |
| `twitter` | X / Twitter | Text-only publisher implemented; deploy, credits, `tweet.write` reauthorization, and provider proof required |
| `instagram` | Instagram | Meta professional-account publisher implemented; deployment, app review where applicable, exact target, and provider proof required |
| `facebook` | Facebook Page | Meta Page publisher implemented; deployment, app review where applicable, exact target, and provider proof required |
| `tiktok` | TikTok | Upload-to-inbox implemented with `video.upload`; Direct Post disabled; deployment/review/proof required |
| `onlyfans` | OnlyFans | Manual staging only |
| `patreon` | Patreon | API v2 read/report connector and native-editor handoff implemented; ordinary post scheduling stays in Patreon |
| `snapchat` | Snapchat | Public Profile API allowlist/partner gate |
| `discord` | Discord | Exact-channel incoming-webhook OAuth and owner-triggered send implemented; deployment and proof required |
| `reddit` | Reddit | Official OAuth owner-triggered post route; deployment, terms review, and disposable proof required |
| `youtube` | YouTube | Private-first uploader implemented; credentials, deployment, channel authorization, audit, and proof required |
| `twitch` | Twitch | Action-specific channel/schedule/announcement connector implemented; no ordinary feed/video publisher |
| `kick` | Kick | Limited channel/chat/rewards/moderation API |
| `rumble` | Rumble | Native/manual uploader and scheduler |
| `steam` | Steam | Consumer account inventory only |
| `psn` | PlayStation | Consumer account inventory only |
| `xbox` | Xbox | Consumer account inventory only |
| `nintendo` | Nintendo | Consumer account inventory only |
| `epic` | Epic Games | Consumer account inventory only |
| `linkedin` | LinkedIn | Member posting product; organization access/review required |
| `signal` | Signal | Manual only |
| `whatsapp` | WhatsApp | WhatsApp Business messaging only |
| `telegram` | Telegram | Bot/channel route |
| `bluesky` | Bluesky | Official OAuth connector can be built |
| `threads` | Threads | Meta app/review and connector required |
| `legalzoom` | LegalZoom | Narrow official MCP may be evaluated; legal actions manual/approval-gated |
| `wix` | Wix | Exact-site/author Draft connector implemented; deployment, authorization, and provider preview proof required |
| _(not first-class yet)_ | WordPress | Identify WordPress.com vs self-hosted; exact site connector and draft/private test required |
| `fiverr` | Fiverr | Manual staging only |
| `amazon` | Amazon / Affiliate | Associates + Creators API for approved link/product data |
| `etsy` | Etsy | Seller/shop API connector required |
| `yelp` | Yelp | Claimed business + partner reply API |
| `trustpilot` | Trustpilot | Paid API module/partner route |
| `gmail` | Gmail | Connector implemented; test-user or production verification required |
| `outlook` | Outlook | Microsoft Graph/Entra connector required |
| `yahoo` | Yahoo Mail | Encrypted IMAP worker + app password required |
| `icloud` | iCloud Mail | Third-party authorization or encrypted IMAP worker required |
| `proton` | Proton Mail | Paid Proton Bridge + trusted local companion required |
| `website` | Website / Store | Host/CMS-specific; WordPress.com and self-hosted WordPress Draft routes are implemented but require exact-site authorization |
| `email` | Email / Newsletter | Actual provider must be identified |
| `other` | Other | Manual until official route is assessed |

## Uncertainties that must remain visible

- Provider permissions, reviews, pricing, rate limits, and product names change. Recheck the linked official documentation immediately before submission.
- A provider offering an API does not mean MyPersonas has implemented it.
- OnlyFans: no public official developer/account-management API was located in the research completed July 28, 2026. Native scheduling availability was not independently verified for this account.
- Rumble: no public upload API was located; its documented Live Stream API is not a publisher.
- Patreon: no general create-post scope was found in the public API documentation; use Patreon's native scheduler.
- Reddit: Devvit user actions require an explicit manual action; they are not a route to unattended autoposting as the user.
- LinkedIn: permission names and Community Management versions are changing; the developer portal's approved product/scopes are authoritative.
- Yahoo/iCloud app passwords and Proton Bridge are credentials for dedicated secure workers or a trusted local companion, never fields in a public static website.
- Yelp, Trustpilot, Snapchat, Reddit commercial access, and some Meta/LinkedIn features can require discretionary partner/review approval or contract pricing.
