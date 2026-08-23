# MyPersonas provider setup guide

**Owner checklist for MyPersonas / AliaSpaces**
**Reviewed:** August 22, 2026

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
- **X / Twitter:** OAuth identity/read source is implemented. The production X client credentials and API credits still need owner installation. The deployed `twitter-post` source is absent from this checkout, so X publication remains fail-closed until that function is downloaded, audited, write-authorized, and reconciled with the queue.
- **Facebook Pages and linked Instagram professional accounts:** official pairing plus owner-triggered Page/IG publishing were proven earlier on an owner-controlled asset. Recurring publishing remains off, and the current hardened source/migration release is not deployed or live-verified. App Review is still required before serving accounts outside the app's permitted owner/test roles.
- **Reddit:** official OAuth and explicit owner-triggered posting source exist locally. Migration 021, credentials, deployment, commercial/API terms, revocation, erasure, and one disposable live post still require owner review and proof.
- **Discord:** a channel-webhook source exists but is deliberately dormant and has no current frontend Connect/Post controls. It must not be re-enabled without immutable channel binding, Vault erasure, retry/reconciliation, and failure/race tests.
- **Every other provider:** an inventory or planning record until its connector is built and tested. A saved username, matching email, or “ownership verified” label is not provider authorization.

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
3. **Finish X identity/read setup**, then build and separately authorize the write adapter.
4. **Finish the Meta Business app**, connect Facebook Pages, and pair each linked Instagram professional account.
5. Add **Outlook**, then the secure Yahoo/iCloud worker and local Proton Bridge companion.
6. Add lower-friction publishing routes: **Bluesky, Discord bots, Telegram bots, Threads**.
7. Submit review/audit applications for **TikTok, YouTube, LinkedIn, Reddit, and Snapchat**.
8. Keep unsupported creator and marketplace accounts in the **manual staging workflow**.

## Social publishing through official APIs

### X / Twitter — requires provider app setup

**What can ultimately be managed:** account identity, scheduled posts, media, replies, and selected engagement features within approved scopes. X API use is pay-per-use.

**Owner steps**

1. Open the [X Developer Console](https://console.x.com), accept the developer terms, and create a confidential Web App.
2. Set the callback exactly to:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitter-oauth`
3. Add `https://mypersonas.online` as the website URL.
4. For the current identity/read connector, allow `tweet.read`, `users.read`, and `offline.access`.
5. Install the client ID and client secret directly as deployment secrets named `X_CLIENT_ID` and `X_CLIENT_SECRET`. Do not paste them into the website or chat.
6. Activate X API billing/credits and set a conservative spending limit. See [current X API pricing](https://docs.x.com/x-api/getting-started/pricing).
7. Connect the exact X account from MyPersonas.

**Before posting can be enabled**

- Codex must add the publish/media adapter and live-test failure reconciliation.
- The app must request `tweet.write` and, for uploads, the current media permission shown by X.
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
2. Open [Meta Business](https://business.facebook.com/) and confirm that you administer the Pages and linked Instagram accounts.
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

Meta's official references: [Facebook API workspace](https://www.postman.com/meta/facebook/overview), [Instagram API with Facebook Login](https://www.postman.com/meta/instagram/folder/23987686-3a75357f-e106-47ef-a8d9-af1aadf85365), [App Review](https://developers.facebook.com/docs/app-review/), and [Business verification](https://developers.facebook.com/docs/development/release/business-verification).

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

**Owner steps**

1. Register or sign in by following TikTok's current [app registration guide](https://developers.tiktok.com/doc/getting-started-create-an-app).
2. Create an app, provide the live website, Privacy, Terms, and Data Deletion URLs, and configure the callback Codex supplies when the connector is built.
3. Add the **Content Posting API** product.
4. Request Login Kit scopes needed for identity plus `video.publish` for Direct Post.
5. Verify the media domain or URL prefix if TikTok will pull hosted media.
6. Submit the app and Direct Post use case for review/audit.

Unaudited Direct Post clients are restricted to private visibility. MyPersonas must keep TikTok in manual/approval staging until the app passes review and a public post is live-tested.

Official reference: [Content Posting API](https://developers.tiktok.com/products/content-posting-api).

### YouTube — requires Google OAuth and API compliance audit

**Owner steps**

1. Create a dedicated project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the YouTube Data API v3.
3. Configure the OAuth consent screen with the live policy URLs and add the callback Codex supplies when the connector is built.
4. Create a Web OAuth client and add the owner as a test user during development.
5. Request `https://www.googleapis.com/auth/youtube.upload`; add broader YouTube scopes only if a separately approved feature needs them.
6. Complete Google OAuth verification as required.
7. Submit the YouTube API compliance audit before relying on public uploads.

Uploads from unverified API projects created after July 28, 2020 are restricted to private visibility. YouTube can also schedule an unpublished private video using `status.publishAt`, but MyPersonas must verify the exact channel, audience, synthetic-media disclosure, and privacy state before submission.

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

**Owner steps**

1. Register a client in the [Patreon developer portal](https://www.patreon.com/portal/registration/register-clients).
2. Configure the callback Codex supplies when the connector is built.
3. Grant only identity/campaign/member/post-read/webhook scopes needed for reporting.
4. Use Patreon's own [scheduled posts](https://support.patreon.com/hc/en-us/articles/360031956632-Scheduled-posts) for publishing.

The public Patreon API scopes documented as of July 28, 2026 do not provide a general create-post permission. MyPersonas should stage the content, open Patreon, support copy/download, and let the owner mark the staged item posted; the API can later support membership/reporting and webhooks.

Official reference: [Patreon API documentation](https://docs.patreon.com/).

### Twitch — channel, schedule, chat, and moderation tools

**Owner steps**

1. Register an app in the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
2. Add the callback Codex supplies when the connector is built.
3. Request only the scopes required for selected features, such as `channel:manage:schedule` or the current chat/moderation scopes.
4. Confirm Affiliate/Partner eligibility before relying on nonrecurring schedule operations.

Twitch's API can manage channel information, schedules, chat, clips, and moderation. It is not a general social-feed/video-upload API. Native video and live workflow remain in Twitch unless a specific official endpoint supports the action.

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

**For only your own Wix account:** create a minimal-permission API key through Wix account settings. Only an owner/co-owner should do this.

**For an installable MyPersonas app:** create an app in the [Wix Developer Center](https://dev.wix.com/), use Wix OAuth, choose only required site/blog/store permissions, and have the site owner install it.

Codex must build the connector before MyPersonas can edit or publish anything. Use the site-specific API rather than browser automation.

Official references: [Wix REST app integration](https://dev.wix.com/docs/build-apps/develop-your-app/api-integrations/rest) and [Wix API keys](https://dev.wix.com/docs/rest/articles/get-started/api-keys).

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
2. **Approve:** show an exact preview and require the owner to approve or deny.
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
| `twitter` | X / Twitter | Existing identity/read connector; provider credentials/credits required; write adapter and reauthorization still required |
| `instagram` | Instagram | Meta professional-account route; app review and publish adapter required |
| `facebook` | Facebook Page | Meta Page route; app review and publish adapter required |
| `tiktok` | TikTok | Content Posting app review/audit required |
| `onlyfans` | OnlyFans | Manual staging only |
| `patreon` | Patreon | API reporting/webhooks; native/manual post scheduling |
| `snapchat` | Snapchat | Public Profile API allowlist/partner gate |
| `discord` | Discord | Authorized bot only |
| `reddit` | Reddit | Approved Devvit route with explicit user action; no unattended user autopost |
| `youtube` | YouTube | OAuth connector and YouTube API audit required |
| `twitch` | Twitch | Limited channel/schedule/chat/moderation API |
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
| `wix` | Wix | Site-specific OAuth/API connector required |
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
| `website` | Website / Store | Host/CMS-specific connector |
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
