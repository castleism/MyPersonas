# MyPersonas.online — Setup Guide

Files in this repo:
- **index.html** — the entire app (hosted as a static site)
- **supabase-schema.sql** — the database (run once in Supabase)
- **sql-updates/** — ordered migrations for an existing database
- **../supabase/functions/** — server-side connectors and automation

## Step 1 — Database
Supabase Dashboard → **SQL Editor** → New query → paste the entire contents of `supabase-schema.sql` → **Run**. You should see "Success".

## Step 2 — Wire the app to your project
Dashboard → **Settings → API**:
- **Project URL** (looks like `https://abcdxyz.supabase.co`)
- **anon / public key** (long string starting `eyJ…`)

Paste both into the `CONFIG` block at the top of the `<script>` in `index.html` (or send them to Claude to wire in). These are safe to be public — all security lives in the database row-level policies.

## Step 3 — Host it
The current site deploys from this repository through GitHub Pages. A push to the
configured branch starts the Pages workflow; allow for CDN/cache delay before testing
the live copy at `https://mypersonas.online`.

## Step 4 — Tell Supabase your site URL
Supabase → **Authentication → URL Configuration**:
- **Site URL**: `https://mypersonas.online`
- **Redirect URLs**: add `https://mypersonas.online/**`

Magic-link email sign-in works immediately after this. ✅

## Step 5 (optional) — Google sign-in to AliaSpaces
1. https://console.cloud.google.com → new project → **APIs & Services → OAuth consent screen** → External.
2. **Credentials → Create OAuth Client ID** → Web application → Authorized redirect URI: `https://YOURPROJECT.supabase.co/auth/v1/callback`.
3. Paste Client ID + Secret into Supabase → Authentication → **Providers → Google** → enable.

This signs a person into AliaSpaces. It does **not** authorize MyPersonas to read a
Gmail inbox.

## Step 6 — Gmail account authorization

For the current deployment, run `sql-updates/009-external-account-connections.sql`
and `sql-updates/010-gmail-oauth.sql`, then configure the isolated Google Cloud
project **MyPersonas Gmail Connector** (`genial-union-503010-q5`):

1. Enable the **Gmail API**.
2. In **Google Auth Platform → Audience**, use External/Testing during development
   and add the mailbox owner (currently `christiancodyak@gmail.com`) as a test user.
3. In **Data Access**, add `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.readonly`.
4. Use its Web OAuth client
   `373519662305-05bnlabe18i89efnhec9inpt36al7lc6.apps.googleusercontent.com` and add
   this authorized redirect URI:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth`.
   Keep this client in the isolated Gmail project. Google token revocation can affect
   grants project-wide, so creating another client in the normal site-sign-in project
   is not sufficient; Gmail disconnect/revocation must not disturb AliaSpaces login.
5. Save the OAuth client ID and client secret as Supabase Edge Function secrets named
   `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`. Never place the secret
   in `index.html` or Git.
6. Deploy the connector:

   ```
   supabase functions deploy gmail-oauth --no-verify-jwt
   ```

After an account is recorded, **Ownership verified** only means its login email matches
the confirmed AliaSpaces sign-in email. Select **Authenticate Gmail** to run Google's
consent flow. The user must choose the exact recorded mailbox and approve read-only
access before the status becomes **API connected**. Passwords are never collected;
the refresh token is encrypted in Supabase Vault and is unavailable to browser code.
Completion is also bound to the same signed-in user and browser tab that started it,
so forwarding a consent link cannot attach someone else's mailbox.

The `gmail.readonly` permission is a restricted Google scope. A Testing app works only
for configured test users. A public production launch requires Google's OAuth app
verification and may require a restricted-scope security assessment.

## What works now vs. phase 2
**Now:** sign-in (magic link + Google), anonymous multi-persona accounts, private
external-account ledger with separate ownership/API connection states, read-only Gmail
OAuth connector, persona pages (banner/background/avatar/feed images, profile song,
Top 8, 37-platform links incl. gaming), quick-setup wizard with platform suggestions,
page section toggles, gallery & sponsored/affiliate albums that deep-link out, blog
feed + reels, watermarked uploads, per-page search, friend requests, block/mute,
private/unlisted pages, discover filters, 18+ gates, linked AI models, HQ assistant,
per-persona chatbots, runnable tasks with model-per-task.

**Phase 2:** auto-running scheduled tasks (Supabase Edge Functions + pg_cron), native live streaming (Cloudflare Stream/Mux — today personas embed their Twitch/YouTube/Kick player), custom domain.

## Honest notes
- **Watermarks**: uploaded images get the page URL burned into pixels (tiled + corner tag); right-click/drag is blocked. Screenshots can't be prevented — treat watermarks as attribution + deterrence.
- **Adult content**: you're the site operator — keep the 18+ gate on NSFW personas and check your host's acceptable-use terms as the site grows.
- **AI keys** are stored per-account behind owner-only row rules. Never store passwords in private notes.
- **Gmail credentials** are not stored in the account ledger. OAuth refresh tokens are
  encrypted in Supabase Vault and only the server-side connector can retrieve them.
