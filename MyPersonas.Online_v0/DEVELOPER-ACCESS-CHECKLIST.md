# Developer access checklist — finish authenticating your connected accounts

**Owner:** Christian · **Updated:** 2026-07-30
Secrets always go here, never into the site or a chat:
**[Supabase → Project Settings → Edge Functions secrets](https://supabase.com/dashboard/project/nwsqyuucwzihruszocge/settings/functions)**

Full detail lives in `PROVIDER-SETUP-GUIDE.md`; this is the short do-it list.

---

## 1. X / Twitter — unlocks the already-deployed connector

1. Open the [X Developer Console](https://console.x.com) → accept developer terms.
2. Create a Project → App → **confidential Web App** (OAuth 2.0).
3. Callback URL (paste exactly):
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitter-oauth`
4. Website URL: `https://mypersonas.online`
5. Scopes for the current read/identity connector: `tweet.read`, `users.read`, `offline.access`.
6. Copy the client ID + secret → install as secrets **`X_CLIENT_ID`** and **`X_CLIENT_SECRET`** (link above).
   **Names are case-sensitive.** `X_Client_ID` will not be found and shows up in the app
   as "X still needs its developer Web App credentials." No redeploy is needed after
   setting secrets — they take effect immediately.
7. Activate [X API billing/credits](https://docs.x.com/x-api/getting-started/pricing) with a low spending cap.
8. In MyPersonas → Matrix → Accounts → your X account → **Connect X**.

**X policy compliance (binding — read before registering):**

- Use-case description is binding; declare the full direction up front: owner-verified
  accounts; reading the account's own profile/posts/metrics for a unified history and
  performance view; publishing owner-created or owner-approved content immediately or
  on schedule (caps + quiet hours); owner-reviewed reply drafting. Scheduled posting of
  approved content is allowed — per-post manual pressing is NOT required by X.
- Register ONE app for MyPersonas (up to 3 only as dev/staging/prod of the same service).
- Never post identical or substantially similar content across multiple accounts —
  each persona's drafts must be distinct. This is the top suspension risk.
- Never use X API content for AI/model training (explicitly prohibited) — training
  sets must come from your own local originals, not API-pulled X data.

## 2. Gmail — if a mailbox still gets a 403

The connector is live; Google gates it while the OAuth app is in Testing.

1. Open [Google Cloud Console → your project → OAuth consent screen / Audience](https://console.cloud.google.com/auth/audience).
2. Either add each mailbox you own as a **test user** (fast), or submit the app for
   production verification (slow, needed eventually).
3. No new secrets required. Reconnect the mailbox from Matrix → Accounts afterward.

## 3. Meta — Facebook Page + linked Instagram pairing

1. [Meta for Developers → My Apps](https://developers.facebook.com/apps/) → Create App → type **Business**.
2. In [Meta Business settings](https://business.facebook.com/settings/), select the correct business portfolio and confirm you admin the Page(s); Instagram must be **Business/Creator** and linked to the Page in that same portfolio.
3. Add **Facebook Login for Business** to the app; callback (paste exactly):
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/meta-oauth`
4. App domains: `mypersonas.online`; policy URLs: [privacy](https://mypersonas.online/privacy.html), [terms](https://mypersonas.online/terms.html), [data deletion](https://mypersonas.online/data-deletion.html).
5. Install secrets **`META_APP_ID`**, **`META_APP_SECRET`** (+ **`META_LOGIN_CONFIG_ID`** if Login for Business shows a configuration ID).
6. While in development mode: add yourself as app tester with Page access.
7. Discovery scopes first: `pages_show_list`, `pages_read_engagement`, `instagram_basic`.
8. Start [business verification](https://developers.facebook.com/docs/development/release/business-verification) early — it's the slow gate; [app review](https://developers.facebook.com/docs/app-review/) comes later for advanced access.
9. Then Matrix → Accounts → Facebook Page → pair.

## 4. Adobe Lightroom — file the request now, build later

1. [Adobe Developer Console](https://developer.adobe.com/console) → Create project.
2. Try to add the **Lightroom API**; if it isn't self-serve, request partner access per the
   [getting-started docs](https://developer.adobe.com/lightroom/lightroom-api-docs/getting-started).
3. No site secrets yet — the connector gets built after Adobe grants a production key.

## 5. Discord — works as soon as you deploy it (no external approval needed)

1. Run `sql-updates/019-discord-webhook.sql` in the [Supabase SQL Editor](https://supabase.com/dashboard/project/nwsqyuucwzihruszocge/sql/new) — and `sql-updates/020-shared-account-managers.sql` while you're there (enables multi-persona account sharing).
2. Deploy the function: `supabase functions deploy discord-post` (from the repo's `supabase` folder).
3. In Discord: Server Settings → Integrations → Webhooks → New Webhook → pick the channel → Copy URL.
4. MyPersonas → Matrix → Accounts → Discord → **Connect channel webhook** → paste it once.
5. Approve a draft for that account in the Queue → **Post to Discord now**.

## 6. Reddit — create the app, then it's fully automatic

1. Open [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) signed in as the Reddit account → **create another app** → type **web app**.
2. Redirect URI (paste exactly):
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/reddit-oauth`
3. Install the app's client id (under the app name) and secret as secrets **`REDDIT_CLIENT_ID`** and **`REDDIT_CLIENT_SECRET`** ([secrets page](https://supabase.com/dashboard/project/nwsqyuucwzihruszocge/settings/functions)).
4. Run `sql-updates/021-reddit-oauth.sql` in the SQL editor.
5. Deploy: `supabase functions deploy reddit-oauth --no-verify-jwt` and `supabase functions deploy reddit-post`.
6. Matrix → Accounts → Reddit → **Connect Reddit** (username must match), then approved drafts get **Post to Reddit now**. Put `r/subredditname` in a draft's tags to target a subreddit; otherwise it posts to the account's profile.

## 7. Not needed yet

- **Outlook/Yahoo/iCloud/Proton** mailboxes: connectors not built (roadmap).
- **OnlyFans and other record-only providers**: manual staging only, by design — nothing to authenticate.
- **Bluesky/Discord/Telegram/TikTok/YouTube/LinkedIn/Reddit/Snapchat**: wait until their write connectors are on deck (see PROVIDER-SETUP-GUIDE.md rollout order).

---

**Never enter a provider password, app password, cookie, or API secret anywhere in MyPersonas or in chat. Consent screens belong to the provider; secrets belong in the Supabase secret store.**
