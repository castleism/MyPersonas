# Mobile Blueprint — responsive web, tablet, native apps, chat workspaces

_Updated 2026-08-13. Covers three things: (1) optimizing the responsive **web** for phones and
adding a proper **tablet** tier, (2) the **native iOS/Android apps** focused on talking
to your personas and approving posts, and (3) **chat workspaces** — saved conversations
that build a persona's context over time. Sequenced so each step ships on its own and
reuses the same Supabase backend (no rewrite)._

---

## 1. Responsive web (optimize phone + add tablet)

**Current state is already decent** — `index.html` has 10 media queries at 900/820/
760/560/440 px, 44 px touch targets, 16 px inputs (stops iOS zoom), correct viewport.
So this is **tuning + one missing tier**, not a rebuild.

Current implementation and remaining gaps:
- **Tablet tier (768–1024 px) is implemented.** The studio uses the dedicated intermediate
  layout instead of stretching the phone or desktop arrangement. Keep this band in logged-in
  phone/tablet visual regression checks.
  ```css
  @media (min-width: 768px) and (max-width: 1024px) {
    .appbody { /* keep rail as a narrow left column, not full-width wrap */ }
    .cols { grid-template-columns: 1fr 1fr; }
    .studio, .card { max-width: 900px; margin-inline: auto; }
  }
  ```
- **Safe-area insets are implemented** for the header, stale bar, main content, overlays,
  fan chat, and image panel; verify them on real notched devices before release.
- **Sticky bottom action bar on phones** for the primary action (Save / Approve /
  Send) so the main CTA is always thumb-reachable.
- **Audit long forms** (persona edit, ledger, mailbox) for horizontal overflow at 320 px;
  a couple of grids still assume width.
- **Images**: serve responsive sizes from Storage (`srcset`) once media moves to buckets.

_How to ship safely:_ tablet/safe-area code already exists; screenshot signed-in phone +
tablet widths and exercise long forms before push. The remaining code task is a context-aware
sticky phone CTA that never obscures fields, validation, or destructive actions. CSS cannot
prove those interactions, so real-device visual verification remains the gate.

---

## 2. Native apps (iOS + Android) — a focused companion, not the whole site

The studio (connectors, ledger, albums, App-Review-gated publishing) stays on the web.
The **app is a companion** for the two things you do daily: **talk to your personas** and
**approve what they post**. Plus your "personalized AI news feed" vision.

### Recommended path (cheapest → most native)

1. **PWA first (install shell complete locally).** The manifest, public-only offline
   shell, service worker, install prompt, icons, Pages artifact, and package tests are
   wired in this checkout. They still need an owner push and real-device install/offline
   verification. **Push notifications are not part of that package**: permission UX,
   subscriptions, delivery, and an approval-event backend remain a separate phase.
2. **Native shell with Expo / React Native (weeks).** One TypeScript codebase → real
   iOS + Android apps in the App Store / Play Store. Use it for the **focused** surfaces
   (chat, approvals, feed), calling the same Supabase Auth + edge functions. Native push
   (APNs/FCM), biometric unlock, share-sheet ("send this to a persona").
3. **Deepen** only where native pays off (camera/share for content, background sync).

### App surfaces (v1 of the app)

- **Persona chat** — owner↔persona conversations (the existing `agent_messages` model),
  now organized into **workspaces** (§3).
- **Approvals** — the L2 approval queue: pending drafts with Approve / Edit / Reject.
  The client calls owner-authenticated approval/publisher Edge Functions (including
  `approve-post-draft` for immutable-media scheduling), never service-role-only internal RPCs.
  Notification delivery is a later phase, not part of the initial screen.
- **Feed** — the personalized AI news feed (V2-BLUEPRINT §6): each persona researches
  its interests, fact-checks, cites sources, serves short blurbs. Read-first, tappable
  to expand + sources.
- **Not in the app (stays web):** connectors/OAuth, ledger, album management, App-Review
  publishing setup.

### Reuse and new backend boundaries

Chat and review can reuse Supabase Auth, Postgres/RLS, `ai-proxy`, and the guarded owner
approval/publisher functions. The sourced feed still needs its approved schema/research
function/evidence model, and push needs subscription storage, revocation, delivery, and
quiet-hours handling. The app is a new client over shared foundations, not a promise that
every proposed surface already has a backend.

---

## 3. Chat workspaces (save chats → build persona context)

Your idea: _"workspaces for the chats with your personas, where you can save chats to add
to future ones later as you continue to build the context for the persona."_ This is the
**memory spine** — and it plugs straight into the context-box (`context_log`, migration 030).

### Model

- `chat_workspaces` — `{ id, owner, persona_id, title, pinned, created_at, updated_at }`.
  A workspace is a named, saved conversation (or a themed collection of them) with a
  persona: e.g. "Sherlock — cannabis podcast season 1", "Song — charity-literacy pilot".
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

1. [x] Migration: `chat_workspaces` + `workspace_id` on owner messages (additive; migration
   031 recorded as applied and verified in the project handoff).
2. [x] Web code ready locally: workspace list per persona, create/rename/pin/resume;
   "Save context" + "Attach" actions. Both use model-distilled bounded excerpts rather than
   storing or attaching raw conversation history; durable Save context takeaways are
   owner-reviewed before they enter the persona memory.
3. [x] ai-proxy code ready locally: fold the bounded `context_log` slice + bounded attached
   workspace summaries into the system prompt as non-authoritative continuity reference.
4. [ ] Deploy and live-verify in sequence: `ai-proxy` first, then the matching Pages build;
   test concurrent context edits, workspace RLS, resume, distillation, and full-account export inclusion with
   an owner test account. No deployment is implied by the completed code boxes above.

---

## Sequenced plan (what unblocks what)

1. **PWA install/offline shell** — code complete locally; owner release + device verify.
   Treat push as its own permission/backend project after the install shell is proven.
2. **Responsive release verify** — tablet tier + safe-area are local; sticky phone CTA and
   logged-in real-device checks remain.
3. **Context + chat workspaces** — schema is recorded live and code is complete locally;
   deploy `ai-proxy` before Pages, then verify conflict/RLS/distillation/export behavior.
4. **Sourced news-feed research pipeline** (`feed_items` + `ai/research`) after the owner
   approves source, citation, freshness, and feedback rules.
5. **Push-notification pilot** — separate permission/subscription/delivery design after the
   installed PWA is stable.
6. **Expo native shell** — chat + approvals + feed, reusing the backend, only when native
   camera/share/biometric/notification value justifies another client.
7. **Meta hardening release** — owner-asset publishing is proven; ship migration 035 and the
   guarded code first. App Review is needed only when posting for other users becomes a goal.

Each step is shippable and verifiable on its own; none requires a big-bang rewrite.
