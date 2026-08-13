# Mobile Blueprint — responsive web, tablet, native apps, chat workspaces

_2026-08-10. Covers three things: (1) optimizing the responsive **web** for phones and
adding a proper **tablet** tier, (2) the **native iOS/Android apps** focused on talking
to your personas and approving posts, and (3) **chat workspaces** — saved conversations
that build a persona's context over time. Sequenced so each step ships on its own and
reuses the same Supabase backend (no rewrite)._

---

## 1. Responsive web (optimize phone + add tablet)

**Current state is already decent** — `index.html` has 10 media queries at 900/820/
760/560/440 px, 44 px touch targets, 16 px inputs (stops iOS zoom), correct viewport.
So this is **tuning + one missing tier**, not a rebuild.

Gaps and fixes:
- **No dedicated tablet tier (768–1024 px).** On iPads the phone layout stretches or
  the desktop layout cramps. Add a tablet band: 2-column where phone is 1-column,
  content capped at a comfortable reading width, the persona rail as a slim sidebar
  rather than a wrapped row.
  ```css
  @media (min-width: 768px) and (max-width: 1024px) {
    .appbody { /* keep rail as a narrow left column, not full-width wrap */ }
    .cols { grid-template-columns: 1fr 1fr; }
    .studio, .card { max-width: 900px; margin-inline: auto; }
  }
  ```
- **Safe-area insets** (notch/home-bar): add `env(safe-area-inset-*)` padding to fixed
  bars and modals so nothing hides under the notch or gesture bar.
- **Sticky bottom action bar on phones** for the primary action (Save / Approve /
  Send) so the main CTA is always thumb-reachable.
- **Audit long forms** (persona edit, ledger, mailbox) for horizontal overflow at 320 px;
  a couple of grids still assume width.
- **Images**: serve responsive sizes from Storage (`srcset`) once media moves to buckets.

_How to ship safely:_ these are additive CSS. Do them behind the existing media-query
block, screenshot on real phone + tablet widths (or the browser device toolbar) before
push — CSS can't be unit-tested, so visual verification is the gate. I can implement the
tablet tier + safe-area + sticky CTA as a reviewable diff whenever you want.

---

## 2. Native apps (iOS + Android) — a focused companion, not the whole site

The studio (connectors, ledger, albums, App-Review-gated publishing) stays on the web.
The **app is a companion** for the two things you do daily: **talk to your personas** and
**approve what they post**. Plus your "personalized AI news feed" vision.

### Recommended path (cheapest → most native)

1. **PWA first (days, not weeks).** The responsive site is already close. Add a web
   manifest + service worker + install prompt and you have an installable home-screen
   app with offline shell and **push notifications** (for "a post needs your approval").
   Reuses 100% of the backend and most of the UI. Best effort-to-value ratio; ship this
   before building anything native.
2. **Native shell with Expo / React Native (weeks).** One TypeScript codebase → real
   iOS + Android apps in the App Store / Play Store. Use it for the **focused** surfaces
   (chat, approvals, feed), calling the same Supabase Auth + edge functions. Native push
   (APNs/FCM), biometric unlock, share-sheet ("send this to a persona").
3. **Deepen** only where native pays off (camera/share for content, background sync).

### App surfaces (v1 of the app)

- **Persona chat** — owner↔persona conversations (the existing `agent_messages` model),
  now organized into **workspaces** (§3).
- **Approvals** — the L2 approval queue: pending drafts with Approve / Edit / Reject,
  push-notified. Calls the existing publish/approval RPCs.
- **Feed** — the personalized AI news feed (V2-BLUEPRINT §6): each persona researches
  its interests, fact-checks, cites sources, serves short blurbs. Read-first, tappable
  to expand + sources.
- **Not in the app (stays web):** connectors/OAuth, ledger, album management, App-Review
  publishing setup.

### Reuse (nothing new server-side to start)

Supabase Auth (same accounts), Postgres + RLS (same data), edge functions
(`ai-proxy` for chat, `run-publish-queue`/approval RPCs, `ai/research` for the feed).
The app is a new client, not a new backend.

---

## 3. Chat workspaces (save chats → build persona context)

Your idea: _"workspaces for the chats with your personas, where you can save chats to add
to future ones later as you continue to build the context for the persona."_ This is the
**memory spine** — and it plugs straight into the context-box (`context_log`, migration 030).

### Model

- `chat_workspaces` — `{ id, owner, persona_id, title, pinned, created_at, updated_at }`.
  A workspace is a named, saved conversation (or a themed collection of them) with a
  persona: e.g. "Sherlock — cannabis podcast season 1", "Song vs Rhythm bits".
- Messages hang off a workspace (extend the existing owner-chat messages with a
  `workspace_id`), so a thread is resumable and nothing is lost between sessions.
- **Save-to-context:** a "📌 Save to persona context" action on a message or a whole
  thread distills it into a dated `context_log` entry (via `appendContextLog`). That's
  how a chat "adds to future ones" — the persona carries the takeaway into every later
  generation and feed item, without replaying the whole transcript (bounded prompt).
- **Attach-as-context:** starting a new chat, pick prior saved workspaces to seed context
  from — the app loads their distilled summaries (not the raw history) so the persona
  continues the arc within the token budget.

### Why this shape

- Keeps the **prompt bounded** (owner chat replays newest 36 msgs / 48k chars; the
  context box adds a bounded ~1.5k-char continuity slice) while letting the *durable*
  knowledge accumulate in `context_log` — the exact "keep building the persona" goal.
- Same mechanism feeds the news feed and (later) multi-persona **projects**: a project
  references its member personas' context logs so they collaborate with shared memory.

### Build order

1. Migration: `chat_workspaces` + `workspace_id` on owner messages (additive).
2. Web + app UI: workspace list per persona, rename/pin, resume; "Save to context" +
   "Attach context" actions calling `appendContextLog`.
3. ai-proxy: fold the bounded `context_log` slice + any attached-workspace summaries into
   the system prompt (one Edge Function deploy).

---

## Sequenced plan (what unblocks what)

1. **PWA** (installable + push) — fastest app win, pure web.
2. **Tablet tier + safe-area + sticky CTA** — responsive polish (reviewable CSS diff).
3. **Context box** (migration 030 + UI) — the memory foundation.
4. **Chat workspaces** (migration + UI) on top of the context box.
5. **Expo native shell** — chat + approvals + feed, reusing the backend.
6. **News-feed research pipeline** (`feed_items` + `ai/research`).
7. **Meta publishing** — gated on App Review (APP-REVIEW-META.md), independent of the above.

Each step is shippable and verifiable on its own; none requires a big-bang rewrite.
