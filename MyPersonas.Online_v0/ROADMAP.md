# AliaSpaces.online — Roadmap

**Vision:** the home for every persona a person carries. A MySpace-style network where
each persona gets its own page (looks, music, Top 8, albums, feed, links), fully
anonymous by design — never linked to the owner or to each other — with an AI layer
(models per persona and per task, an HQ assistant, character tooling) and an
extension ecosystem (Concept character studio, Personas desktop companion) that
carries personas beyond the site onto every platform they live on.

---

## v0 — Foundation (current)

Shipped:

- Auth: Google OAuth + email magic link for AliaSpaces sign-in; profiles private, no
  public linkage to personas (mailbox authorization is a separate connector)
- Personas: create/edit, quick-setup wizard (multi-category, merged suggestions),
  AI builder interview, purpose/voice/topics/audience/rules, per-persona AI model
- Pages: banner/background/avatar/feed images (file picker + preview + SD generate),
  profile song, live embed (Twitch/YouTube/Kick), Top 8, 37-platform link chips,
  gallery & sponsored/affiliate albums (deep-link out), blog feed + reels,
  per-page search, section show/hide modules, theme color, share link
- Social: friend requests (pending/accepted), block/mute, private/unlisted/public
  visibility enforced by row-level security, discover filters (18+ default-hidden,
  topic mutes), age gate on NSFW pages
- AI: linked models (any OpenAI-compatible API), HQ assistant with roster context,
  per-persona chatbots, tasks with model-per-task and one-click Run,
  SD character panel (local A1111/Forge), content drafts pipeline
  (chat/task output → draft → copy → post on platform; idea → ready → posted)
- Trust & safety: pixel-burned watermarks with page URL on uploads, right-click/drag
  guards, in-app error reporting to error_logs, session-timeout countdown popup,
  stale-page banner
- Platform: brand icon bank (SVG, hologram-blue), favicon, release-driven extensions
  catalog (GitHub Releases + extension.json), versioned repo layout + Pages workflow

## v0.5 — Live network (roadmap items)

- [x] Private Account Ledger batch mode: add many external accounts, keep them
      unassigned or bind each to an existing/quick-created private persona. Deployed
      with owner-only storage, saved-row Quick Create, and explicit connection states.
- [x] Provider OAuth connections: separate, read-only Gmail authorization with
      single-use state + PKCE, exact-mailbox validation, refresh credentials encrypted
      in Supabase Vault, and only server-attested connection state exposed to the
      browser. Ownership verification remains distinct from API connection.
- [ ] Auto-running scheduled tasks: Supabase Edge Function + pg_cron; results land
      in drafts automatically each morning
- [ ] Server-side AI proxy (Edge Function) so model API keys never touch the browser
- [ ] Notifications: Supabase Realtime for friend requests/accepts (replace
      load-time polling badge)
- [ ] Comments and reactions on feed posts
- [ ] Feed pagination + hashtag browse pages
- [ ] Per-platform branded icons (extend the hologram icon bank beyond the orbit node)
- [ ] Proper "act as persona" picker modal (replace prompt() dialogs)
- [ ] Extensions page: full catalog view with release notes + version history;
      Personas app switched to the same releases-driven model as Concept
- [ ] Resolve persona-save session bug from verification round (error_logs driven)
- [ ] SEO: path-based routing + prerendered persona pages so Google indexes each
      persona individually, and per-persona OG images for rich link previews
      (today: hash routes = one indexable URL; JS-set titles/descriptions only)
- [ ] Auto-generated per-persona sitemap (Edge Function serving sitemap.xml
      from the personas table)

## v1 — The platform (major milestone)

- [ ] Persona-to-persona direct messages (privacy-preserving)
- [ ] Native live streaming (Cloudflare Stream/Mux) replacing embed-only
- [ ] Post-bridge: publish drafts directly to platforms with official APIs
      (Facebook/Instagram Graph, TikTok Content Posting) where ToS allows
- [ ] Discovery: trending personas/tags, better ranking than recency
- [ ] Moderation pipeline: user reports on content/personas, review queue
- [ ] PWA: installable mobile experience, push notifications
- [ ] Custom auth domain (auth.aliaspaces.com) for branded OAuth consent
- [ ] Profile analytics for owners (views, clicks on links/albums)

## v1.5+ — The ecosystem

- [ ] Concept cloud sync: LoRA-consistent persona imagery generated from the site
- [ ] Personas desktop ↔ site sync (personas, goals, chat history)
- [ ] Extension marketplace: third-party extensions, in-site install flows
- [ ] Groups/communities around topics
- [ ] Creator monetization: tips, gated albums

---

## Detours & PoC shortcuts (deliberate, to revisit)

1. **Single-file app** — one index.html, no framework/bundler. Fastest iteration;
   revisit when the file's size hurts (split modules + build step).
2. **Limited server layer** — most ordinary app data still flows browser ↔ Supabase
   under RLS; sensitive integrations use Edge Functions. Gmail OAuth now keeps its
   client secret, state exchange, and refresh credentials server-side.
3. **AI keys stored in DB and used from the browser** — protected by owner-only RLS
   but visible to the owner's browser. v0.5 proxy removes browser exposure.
4. **Scheduled tasks are manual** — ▶ Run opens a chat; no background execution yet.
5. **"Live" is an embed** of the persona's Twitch/YouTube/Kick, not native streaming.
6. **Watermarking is client-side** canvas burn (images only; videos get an overlay);
   screenshots are unpreventable — treated as attribution/deterrence.
7. **Blocks/mutes/topic filters are partly client-side** — a blocked user can't
   friend you (RLS-enforced) but public content hiding is UX-level, not server-level.
8. **Notifications poll at page load** only (no realtime).
9. **prompt()/confirm() dialogs** for persona picking and destructive confirms.
10. **Drafts post manually** (copy → paste on platform) — deliberate: avoids paid/
    restricted APIs (X ~$200/mo) and ToS-risky automation (OnlyFans has no API).
11. **GitHub Pages hosting** — free static host, ~10-minute cache, no server control.
12. **error_logs is insert-open** (anyone can file) — spam-able; fine pre-launch.
13. **Top 8 is a jsonb array** on the persona row (no referential integrity).
14. **Extensions "Open" buttons target localhost ports** — tools must be installed
    and running locally; catalog reads GitHub API client-side (rate-limited) with a
    static releases.json fallback.
15. **Personas app zip lives in the site repo** — small today; moves to GitHub
    Releases like Concept in v0.5.
16. **Age gate is honor-system** (button + session flag); NSFW hiding is default-on
    but client-side.
17. **Google consent screen shows the Supabase domain** — cosmetic; fixed by the
    paid Supabase custom domain when it matters.
