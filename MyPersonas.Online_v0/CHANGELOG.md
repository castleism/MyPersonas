# Changelog — MyPersonas.online

Versioning per VERSIONING.md: majors are milestones, `.x` are roadmap items,
trailing letters are hotfixes. Releases are git tags.

## v0a — Verification fixes (2026-07-10)

- Fixed persona creation failing with an RLS error (sql-updates/004). Root cause:
  the create path inserts with RETURNING, and the returned row must pass the
  personas SELECT policy; persona_visible() (security definer, STABLE) re-queries
  the table and cannot see a row inserted in the same statement, so every CREATE
  was rejected (42501) while every EDIT succeeded — which made it look
  intermittent. The SELECT policy now checks owner and public/unlisted visibility
  inline on the row and keeps persona_visible() for the private-friends case
  only. Not a session-expiry issue; the earlier re-verification workaround is
  harmless but was chasing the wrong cause.
- Fixed duplicated startup loads: getSession() and the SIGNED_IN auth event each
  ran a full loadMine()+route(), so every Supabase query (and the discover
  render) fired twice on page load. Startup now loads once via INITIAL_SESSION,
  and same-user SIGNED_IN re-fires (e.g. tab refocus) are ignored — which also
  protects in-progress forms from being wiped.
- Verification round progress in VERIFICATION.md (15/34; findings logged there,
  incl. missing assets/Extensions/Concept/releases.json fallback).

## v0 — Foundation (2026-07-08 → 2026-07-09)

### Network
- Personas with full profiles (purpose, voice, topics, audience, hard rules),
  public/unlisted/private visibility enforced by row-level security
- Persona pages: banner, background, avatar, feed header, profile song,
  live embed (Twitch/YouTube/Kick), Top 8, platform link chips (37 platforms),
  gallery + sponsored/affiliate albums that deep-link out, blog feed + reels,
  per-page search with type filters, section show/hide, theme color, share link
- Friend requests (pending → accepted), block & mute, discover filters
  (18+ hidden by default, topic mutes), NSFW age gate
- Anonymity: profiles never shown publicly; personas unlinked from owner and
  from each other

### AI layer
- Linked AI models (any OpenAI-compatible API), assignable per persona and per task
- HQ assistant with full roster context; per-persona chatbots in-voice
- Tasks: persona + model + job type, one-click Run in a docked chat
- Content drafts pipeline: save chat/task output as drafts, idea → ready → posted,
  copy-to-clipboard for manual posting on external platforms
- Quick-setup wizard (multi-select categories, merged voice/topics/platform
  suggestions) and AI builder interview with apply-to-profile extraction
- Stable Diffusion character panel (local A1111/Forge API), per-slot sizing,
  generate → preview → apply; Concept studio integration link

### Trust, safety, reliability
- Pixel-burned watermarks (page URL) on uploaded images; media interaction guards
- In-app error reporter (rolling buffer + error_logs table + floating button)
- Session-timeout countdown popup with one-click extend; stale-page banner
- Session re-verification before persona saves; token refresh no longer
  re-renders (protects in-progress forms)

### Design & platform
- Clean light theme (white cards, blue accent), welcome/onboarding flow,
  account settings card (auto-hides after first save)
- Custom hologram-blue SVG icon bank replacing all emojis; stylized favicon
- Release-driven extensions catalog (GitHub Releases API + extension.json,
  static releases.json fallback); Apps card with Personas desktop download
- Versioned repo layout (MyPersonas.Online_v0), Pages deploy via GitHub Actions,
  VERSIONING.md, ROADMAP.md
- Supabase schema: 11 tables + drafts + error_logs, RLS throughout, media storage
  with per-user folders

### Growth
- SEO baseline: meta description, Open Graph + Twitter cards, JSON-LD,
  canonical, robots.txt, sitemap.xml; per-page titles/descriptions set on
  route change (persona pages get name/tagline)
- Promote: one-click ad posts for any of your personas (3 generated variants,
  copy buttons) plus direct pre-filled share links to X, Facebook, Reddit,
  Telegram, WhatsApp, LinkedIn and email

### Known issues
- Persona save intermittently reported an RLS error (session-expiry suspected;
  re-verification added — under verification via error_logs)
- GitHub API rate limits can briefly blank the extensions card (fallback exists)
