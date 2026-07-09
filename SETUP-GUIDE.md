# MyPersonas.online — Setup Guide

Files in this repo:
- **index.html** — the entire app (hosted as a static site)
- **supabase-schema.sql** — the database (run once in Supabase)

## Step 1 — Database
Supabase Dashboard → **SQL Editor** → New query → paste the entire contents of `supabase-schema.sql` → **Run**. You should see "Success".

## Step 2 — Wire the app to your project
Dashboard → **Settings → API**:
- **Project URL** (looks like `https://abcdxyz.supabase.co`)
- **anon / public key** (long string starting `eyJ…`)

Paste both into the `CONFIG` block at the top of the `<script>` in `index.html` (or send them to Claude to wire in). These are safe to be public — all security lives in the database row-level policies.

## Step 3 — Host it
Since this repo is on GitHub, easiest: **Netlify → Add new site → Import from Git** → pick this repo (no build command; publish directory = repo root). Every push auto-deploys. Alternative: drag the folder onto https://app.netlify.com/drop.

## Step 4 — Tell Supabase your site URL
Supabase → **Authentication → URL Configuration**:
- **Site URL**: your Netlify URL
- **Redirect URLs**: add the same URL

Magic-link email sign-in works immediately after this. ✅

## Step 5 (optional) — Google sign-in
1. https://console.cloud.google.com → new project → **APIs & Services → OAuth consent screen** → External.
2. **Credentials → Create OAuth Client ID** → Web application → Authorized redirect URI: `https://YOURPROJECT.supabase.co/auth/v1/callback`.
3. Paste Client ID + Secret into Supabase → Authentication → **Providers → Google** → enable.

## What works now vs. phase 2
**Now:** sign-in (magic link + Google), anonymous multi-persona accounts, persona pages (banner/background/avatar/feed images, profile song, Top 8, 37-platform links incl. gaming), quick-setup wizard with platform suggestions, page section toggles, gallery & sponsored/affiliate albums that deep-link out, blog feed + reels, watermarked uploads, per-page search, friend requests, block/mute, private/unlisted pages, discover filters, 18+ gates, linked AI models, HQ assistant, per-persona chatbots, runnable tasks with model-per-task.

**Phase 2:** auto-running scheduled tasks (Supabase Edge Functions + pg_cron), native live streaming (Cloudflare Stream/Mux — today personas embed their Twitch/YouTube/Kick player), custom domain.

## Honest notes
- **Watermarks**: uploaded images get the page URL burned into pixels (tiled + corner tag); right-click/drag is blocked. Screenshots can't be prevented — treat watermarks as attribution + deterrence.
- **Adult content**: you're the site operator — keep the 18+ gate on NSFW personas and check your host's acceptable-use terms as the site grows.
- **AI keys** are stored per-account behind owner-only row rules. Never store passwords in private notes.
