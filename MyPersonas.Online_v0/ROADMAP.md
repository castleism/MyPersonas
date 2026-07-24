# AliaSpaces / MyPersonas — Roadmap

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
- AI: linked hosted text models on approved HTTPS provider hosts, HQ assistant with roster
  context, per-persona chatbots, tasks with model-per-task and one-click Run,
  SD character panel (local A1111/Forge), content drafts pipeline
  (chat/task output → draft → copy → post on platform; idea → ready → posted)
- Trust & safety: pixel-burned watermarks with page URL on uploads, right-click/drag
  guards, in-app error reporting to error_logs, session-timeout countdown popup,
  stale-page banner
- Platform: brand icon bank (SVG, hologram-blue), favicon, release-driven extensions
  catalog (GitHub Releases + extension.json), versioned repo layout + Pages workflow

## v0.5 — Agent control center and live network

An `[x]` here means the implementation exists in this repository. Migration 011, the five
release Edge Functions, production secrets, and both five-minute cron jobs were deployed
and smoke-tested on 2026-07-20. The Pages artifact is included in this release; signed-in
browser scenarios retain their own verification evidence.

- [x] Private Account Ledger batch mode: add many external accounts, keep them
      unassigned or bind each to an existing/quick-created private persona. Deployed
      with owner-only storage, saved-row Quick Create, and explicit connection states.
- [x] Provider OAuth connections: separate Gmail authorization with single-use state +
      PKCE, exact-mailbox validation, explicit cleanup re-consent, refresh credentials
      encrypted in Supabase Vault, and only server-attested connection state exposed to
      the browser. Ownership verification remains distinct from API connection.
- [x] Gmail Inbox Concierge: resumable manual and report-only scheduled scans,
      subscriptions/account-evidence/receipt/protected-mail reports, optional owner-chosen
      AI classification using bounded sender, subject, and short Gmail preview snippets,
      exact approval plans for labels/archive/recoverable Trash, bounded Undo, a separate
      audit trail, and manual unsubscribe offers that never fetch arbitrary links in the
      background.
- [ ] Outlook Inbox Concierge adapter through delegated Microsoft Graph `Mail.ReadWrite`
      after an Entra app, callback, credentials, consent, and live personal/tenant tests
      are installed.
- [ ] Yahoo and iCloud Inbox Concierge adapters through a dedicated encrypted IMAP
      worker using user-created app-specific passwords; never collect either account's
      normal password in the website.
- [ ] Proton Inbox Concierge companion that runs locally beside Proton Mail Bridge;
      hosted Supabase functions cannot directly reach Bridge's loopback-only IMAP service.
- [x] Persona agent control center: strategic direction, L0–L3 autonomy, global and
      per-persona pauses, destination modes, exact daily/weekly schedules, time zones,
      lead times, caps, quiet hours, approval queue, synchronized owner chat, and audit log
- [x] Auto-running scheduled tasks: five-minute pg_cron polling, UUID task leases, and
      atomic per-owner daily model-call reservations generate only due drafts without
      duplicate provider calls or self-approval
- [x] Server-side AI proxy: browser system prompts are discarded, persona context and
      controls are loaded server-side, model keys migrate into Supabase Vault, and browser
      model CRUD is limited to owner-authenticated RPCs that never read a key back
- [x] Native AliaSpaces post bridge: L2 exact approvals wait for the owner to press
      Publish now; L3 may publish only exact-approved native drafts on an enabled auto
      target when due
- [x] Optional SFW fan chat: fixed AI disclosure, atomic session/quota/response leasing,
      bounded session memory, owner transcript review, and escalation flags that promise
      neither an owner reply nor takeover. NSFW stays unavailable pending server-verifiable
      age assurance
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
- [ ] External provider write connectors: publish through official APIs only
      (for example Facebook/Instagram Graph or TikTok Content Posting), after required
      write scopes, app review, verified account assignment, and reconciliation are in place
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
2. **Limited server layer** — ordinary owner data still flows browser ↔ Supabase under
   RLS; credentials, persona-controlled AI, scheduled work, publishing, and public fan
   chat use Edge Functions.
3. **Legacy `ai_backends.api_key` remains as an empty compatibility column** — migration
   011 moves non-empty values to Vault and browser CRUD uses RPCs. Remove the old column
   after the staged transition no longer needs schema compatibility.
4. **Schedules use five-minute polling** — exact local times are stored and UUID leases
   plus atomic daily call reservations prevent overlapping workers, but normal dispatch may
   occur up to about five minutes after a due time.
5. **"Live" is an embed** of the persona's Twitch/YouTube/Kick, not native streaming.
6. **Watermarking is client-side** canvas burn (images only; videos get an overlay);
   screenshots are unpreventable — treated as attribution/deterrence.
7. **Blocks/mutes/topic filters are partly client-side** — a blocked user can't
   friend you (RLS-enforced) but public content hiding is UX-level, not server-level.
8. **Notifications poll at page load** only (no realtime).
9. **prompt()/confirm() dialogs** for persona picking and destructive confirms.
10. **External drafts still post manually** — native AliaSpaces publishing is implemented,
    but every external destination remains hard-gated until its official write connector,
    scopes, provider approval, assignment, caps, and reconciliation are implemented.
11. **GitHub Pages hosting** — free static host, ~10-minute cache, no server control.
12. **error_logs is insert-open** (anyone can file) — spam-able; fine pre-launch.
13. **Top 8 is a jsonb array** on the persona row (no referential integrity).
14. **Extensions "Open" buttons target localhost ports** — tools must be installed
    and running locally; catalog reads GitHub API client-side (rate-limited) with a
    static releases.json fallback.
15. **Personas app zip lives in the site repo** — small today; moves to GitHub
    Releases like Concept in v0.5.
16. **Page age gate is honor-system** (button + session flag); NSFW hiding is default-on
    but client-side. Public fan chat therefore stays server-disabled for NSFW personas
    until server-verifiable age assurance exists.
17. **Google consent screen shows the Supabase domain** — cosmetic; fixed by the
    paid Supabase custom domain when it matters.
