# Changelog — MyPersonas.online

Versioning per VERSIONING.md: majors are milestones, `.x` are roadmap items,
trailing letters are hotfixes. Releases are git tags.

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

### Known issues
- Persona save intermittently reported an RLS error (session-expiry suspected;
  re-verification added — under verification via error_logs)
- GitHub API rate limits can briefly blank the extensions card (fallback exists)
