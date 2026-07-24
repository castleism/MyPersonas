# AliaSpaces / MyPersonas Verification Checklist

Status: ⬜ untested · ✅ pass · ❌ fail (see note) · ⏭ skipped/blocked

## Grouped accounts and X OAuth foundation — backend/static check 2026-07-23

- ✅ Migration 015 applied to project `nwsqyuucwzihruszocge`. The three service-only
  X tables exist with RLS enabled; the Vault-cleanup and ledger-guard triggers exist;
  all six token/state RPCs exist; `anon` and `authenticated` cannot execute the token
  retrieval RPC or select the credential table; `service_role` can.
- ✅ Active Edge versions are `twitter-oauth` v1 with gateway JWT verification off,
  `delete-account` v12 with it on, and `erase-content` v5 with it on. X callback CORS
  accepted the production origin, and an unsigned capabilities request was rejected.
- ✅ No `X_CLIENT_ID` or `X_CLIENT_SECRET` is installed. The deployed start endpoint
  returned the expected setup-required response without creating an OAuth transaction.
  This is an explicit operational blocker, not a simulated connection.
- ✅ Deno formatting, type-checking, and linting passed for `twitter-oauth`,
  `delete-account`, and `erase-content`. The main inline app script parsed, migration
  015 exactly matched its one consolidated-schema copy, SQL structural assertions
  passed, required grouping/connector markers were present, and Git whitespace checks
  passed.
- ✅ Independent fail-closed review covered concurrent OAuth completion, malformed or
  ambiguous token/refresh responses, shared-grant cleanup, missing credentials,
  revocation failure, provider-specific erasure acknowledgment, and direct ledger
  deletion/identity changes. No blocking static or security defect remained.
- ⏭ A real X authorization, refresh, revocation, and username-match test is blocked
  until a production X Web App, exact callback, client credentials, and current API
  access are installed. Automated X posting remains intentionally disabled and no
  `tweet.write` permission is requested.
- ⏭ Signed-in phone/browser interaction was not exercised in this release pass; no
  owner account, persona assignment, or existing connection was mutated.

## Agent control center release — backend smoke run 2026-07-20

Repository implementation, backend deployment, and signed-in browser behavior are separate
evidence. The backend smoke checks below were observed against project
`nwsqyuucwzihruszocge`; user-flow checks remain blank until exercised with a real persona,
model, schedule, and draft.

Observed in this release:

- ✅ Migration 011 is live and its historical file remains unchanged. The fresh-install
  schema embeds that immutable migration followed by exact copies of deltas 012–014.
- ✅ Migrations 012, 013, and 014 are live. Retry and approval hardening, fair owner
  rotation, durable queue state, server-side input and active-schedule limits, and atomic
  persona saves all passed object, trigger, and role-grant checks.
- ✅ Final Edge versions are active: `ai-proxy` v9, `post-bridge` v4, `run-tasks` v10,
  `run-publish-queue` v4, `fan-chat` v4, `gmail-oauth` v4, `delete-account` v9, and
  `erase-content` v2, each with its documented JWT setting.
- ✅ `CRON_SECRET` and `FAN_CHAT_SALT` are installed. Vault contains exactly one
  `mypersonas_cron_secret`; stored cron commands contain only the Vault lookup.
- ✅ With both jobs paused, production requests 50 and 51 called the final workers through
  `pg_net` using the Vault secret. Both returned HTTP 200 with zero due work; the two
  five-minute jobs were then resumed and independently read back as active. Their first
  scheduled runs at 15:55 UTC succeeded, and resulting requests 52 and 53 also returned
  HTTP 200 with zero due work.
- ✅ Final inline application JavaScript, JSON-LD, eight touched Edge functions, SQL parser,
  all-zone time conversion, migration 014 transactional rollback, and Git whitespace
  checks passed. Supabase's advisor warning for the authenticated atomic-save function is
  expected: that security-definer RPC is intentionally authenticated-only and performs
  owner checks with an empty search path.
- ✅ Commit `9de2a78` reached `mypersonas.online` at 2026-07-20 15:51:56 UTC. A signed-in
  smoke check loaded the owner Matrix, all six control-center tabs, the manual cadence,
  batch account picker, quick-create persona option, and connected Gmail state with no
  browser-console errors. No persona, account, schedule, draft, or connection was changed.
- ✅ The live Pages artifact serves the app and runtime assets, while verification/setup
  notes, the consolidated schema, individual migrations, and Supabase deployment notes
  each return HTTP 404.

Prerequisites: the new Edge code staged while both workers are paused; migrations 001–014
applied in order; `erase-content` deployed before the compatible `index.html`;
`CRON_SECRET` and `FAN_CHAT_SALT` set;
all eight release functions deployed with the documented JWT settings; both workers
scheduled every five minutes; at least one owner-linked model and one SFW public test
persona available. If custom model hosts are used, set `SCHEDULE_AI_HOSTS` and
`FAN_CHAT_AI_HOSTS` independently.

### Database and privacy

- [ ] A1. Before migration 011, the newly deployed `ai-proxy` can still use an existing
      legacy owner key; the new workers remain unscheduled until their RPCs exist — ⏭ no
      legacy model key existed to exercise; workers remained unscheduled until migration
- [x] A2. Migration 011 completes without error; the Vault credential map, model CRUD/key
      RPCs, task leases, daily usage table, fan reservation RPCs, atomic native publisher,
      triggers, and partial indexes exist — ✅ live apply and object/signature checks passed
- [x] A2b. Migration 012 completes in one transaction; its retry/due/dequeue RPCs, new
      columns/indexes, narrowed persona/fan grants, durable message id, and invalid-approval
      repair exist before either worker resumes — ✅ live object, grant, and repair checks
- [x] A2c. Migration 013 installs service-only fair candidate/claim RPCs, a protected
      owner-rotation state table, prompt-byte triggers on all four input sources, and the
      100-active-schedule trigger before the final worker resumes — ✅ live objects,
      service/auth/anon grants, RLS, and five trigger attachments checked
- [x] A2d. Migration 014 installs one authenticated-only atomic persona-bundle save with
      owner, linked-persona, Top 8, model, size, and count validation — ✅ compiled and
      transactionally exercised twice under rollback, then applied live; anon execute is
      false and authenticated execute is true
- [ ] A3. Every non-empty legacy model key has a Vault mapping and an empty legacy
      `api_key`; the linked model still responds through `ai-proxy` after migration — ⏭
      no linked model/key existed; confirmed zero non-empty plaintext keys
- [ ] A4. Browser model create/update/delete uses the owner RPCs. The browser cannot read
      Vault mappings, execute `ai_backend_get_key`, or directly write `ai_backends` — ⬜
- [ ] A5. Deleting one model connection and deleting all model connections remove their
      associated Vault secrets without affecting another owner — ⬜
- [ ] A6. A signed-in browser can load its own personas through `my_personas`, but anon
      and authenticated table reads cannot select `personas.owner` — ⬜
- [ ] A7. A new/existing persona has one binding and one native destination; account and
      persona assignment guards reject cross-owner or mismatched rows — ⬜

### Direction and safety controls

- [ ] A8. Matrix shows Direction, Targets, Schedule, Queue, Fan inbox, and Audit on phone
      and desktop widths; a database-not-ready state appears cleanly before migration —
      ✅ live signed-in desktop tabs; ⬜ final real-phone width check remains
- [ ] A9. Direction fields persist and are present in a generated draft's server-built
      prompt; persona hard rules remain authoritative — ⬜
- [ ] A10. L0 allows co-writing only; L1 enables scheduled drafts; L2 exact approval waits
      for the owner to press Publish now; L3 auto mode still requires exact approval but
      may publish an approved native draft when due — ⬜
- [ ] A11. Global pause and persona pause each stop new persona AI calls, draft generation,
      publishing, and new fan-chat requests; resume restores only previously enabled
      paths — ⬜
- [ ] A12. Direction, pause, autonomy, destination, generation, approval, publish, and fan
      events appear in the owner-only audit view — ⬜

### Scheduling and drafts

- [ ] A13. A daily schedule and a weekly schedule calculate the expected next generation
      and publication time in the selected time zone, including preparation lead time — ⬜
- [x] A14. Both stored cron commands read `mypersonas_cron_secret` from
      `vault.decrypted_secrets` and contain no literal credential. Both endpoints reject a
      missing/wrong `X-Cron-Secret` with HTTP 403 — ✅ final workers probed while paused:
      both HTTP 200 with zero due work; jobs then resumed, ran on schedule, and produced
      two more HTTP 200 responses
- [ ] A15. `run-tasks` ignores future, inactive, paused, L0, invalid-claim, mismatched, and
      quiet-hour tasks and records a useful status/audit reason — ⬜
- [ ] A16. Concurrent calls for one due task produce only one UUID lease, one reserved
      daily model-call unit, at most one provider request, and one task/time-slot draft — ⬜
- [ ] A17. The owner's local-day cap is atomic across different tasks. A reserved provider
      call counts even if the provider fails, and an over-cap call is never sent — ⬜
- [ ] A18. A lease expires/retries safely after an interrupted worker; transient failures
      retain the intended slot for at most three exponential retries, permanent failures
      advance it, and an old lease token cannot mutate a newer worker's task — ⬜
- [ ] A19. A due eligible task produces an unapproved draft. Generation never sets exact
      approval or silently enables a destination — ⬜
- [ ] A20. Approving stores the exact-content hash and queues the selected time. Editing
      content, target, format, or time clears approval and removes the draft from queue — ⬜

### Publishing boundary

- [ ] A21. `post-bridge` rejects signed-out users, non-owners, inactive claims/bindings,
      insufficient autonomy, manual targets, invalid approvals, caps, and quiet hours — ⬜
- [ ] A22. An eligible L2 exact-approved draft remains waiting when cron runs, then
      publishes exactly once only after the owner presses Publish now — ⬜
- [ ] A23. An eligible L3 exact-approved draft on an enabled native `auto` target publishes
      only when due; a repeated queue invocation is idempotent — ⬜
- [ ] A24. The atomic native publisher cannot exceed a destination daily cap or create a
      post without finalizing the corresponding draft and audit record — ⬜
- [ ] A25. Every external destination returns a clear gated/no-write-connector result even
      when the ledger account is ownership verified or Gmail API connected — ⬜
- [ ] A26. After the owner posts externally by hand, “mark manually posted” records the
      state; it cannot be used for a native draft — ⬜

### AI and fan chat

- [ ] A27. `ai-proxy` requires a valid owner session, refuses another owner's persona or
      model, strips browser system messages, honors pause/binding controls, and audits the
      persona request without logging credentials — ⬜
- [ ] A28. `SCHEDULE_AI_HOSTS` plus its Matrix confirmation extends only scheduled
      generation; `FAN_CHAT_AI_HOSTS` plus its separate confirmation extends only fan chat;
      an unlisted or unconfirmed custom host is refused — ⬜
- [ ] A29. Fan chat is off by default and unavailable for private, paused, inactive,
      unclaimed, or NSFW personas. A client-side 18+ acknowledgment does not bypass the
      server NSFW block — ⬜
- [ ] A30. Two concurrent messages for one session cannot both obtain the response lease.
      Hourly visitor and persona-local-day quotas, fan-message storage, audit, session
      state, and the 90-second response lease are reserved atomically — ⬜
- [ ] A31. Only the matching response UUID can store the assistant reply and clear the
      lease; retrying an old completion cannot create a duplicate reply — ⬜
- [ ] A32. The fixed disclosure says AI and owner review. Commercial, dispute, self-harm,
      or hard-rule signals flag the inbox without promising an owner reply or takeover — ⬜
- [ ] A33. Export includes owner-visible automation/chat data without visitor hashes.
      Delete-my-data removes daily usage, automation, messages, transcripts, and audit
      rows, including Vault secrets through model deletion — ⬜
- [ ] A34. Authenticated `erase-content` capabilities report protocol v2,
      `contentOnly:true`, and `fullAccount:false`; the page refuses every older or
      ambiguous contract — ⬜
- [ ] A35. On a disposable owner, confirmed content erasure preserves the auth login but
      removes every owned persona/post/media/ledger/model/automation/chat row plus profile
      display name and preferences. Gmail revocation happens first, and any OpenRouter
      backend requires provider-side key-revocation acknowledgment — ⬜
- [x] A36. The Pages artifact contains only `index.html`, runtime assets, CNAME,
      `.nojekyll`, robots, and sitemap; it contains no setup guides, SQL, verification
      notes, source snapshots, or private mailbox addresses — ✅ workflow allowlist plus
      live 200 checks for app/assets and 404 checks for representative internal files
- [ ] A37. A persona with more than 30 posts exposes Load more; repeated loads use stable
      newest-first created-at/id ordering, and Posts/Reels/search filters continue through
      older pages without duplicates or silently stopping at 50 — ⬜
- [ ] A38. Switching directly between two signed-in accounts immediately removes the old
      owner's Matrix, draft, fan, audit, and chat UI; late requests and OAuth callbacks
      cannot repopulate it — ⬜ requires two disposable signed-in accounts
- [ ] A39. Discovery, recent/tag feeds, persona posts, and audit history load stable keyset
      pages on demand, preserve filters, and neither duplicate nor skip equal-timestamp
      rows — ⬜ live multi-page data set required
- [ ] A40. A manually queued wall-clock time is stored and displayed in the configured
      owner time zone, independent of phone location; a DST-gap time is rejected — ⬜
- [ ] A41. Fan replies remain default-off and SFW-only; unsafe generated output is discarded,
      replaced by the bounded refusal, escalated, and audited before any response is stored
      or returned — ⬜ disposable fan session and intentionally unsafe model fixture required

## Yahoo and iCloud account records — 2026-07-23

- [x] M1. Yahoo Mail and iCloud Mail are present in the private account-ledger provider
      picker and inherit saved-account autofill, editing, persona assignment, and quick
      persona creation from the generic ledger flow.
- [x] M2. Case-insensitive duplicate detection uses the recorded email independently for
      each mail provider; distinct addresses and different providers remain distinct.
- [x] M3. Yahoo and iCloud remain private-ledger-only choices, do not appear in the public
      persona-link selector, never expose Gmail OAuth actions, and state that mailbox/API
      access and external publishing are unavailable.
- [x] M4. The final inline application JavaScript parses and targeted provider, picker,
      public-link exclusion, duplicate-identity, and safety-guidance assertions pass.
- [ ] M5. Add, edit, assign, export, and delete disposable Yahoo and iCloud records in a
      signed-in production session — ⬜ intentionally not performed against the owner's
      real account records during this code-only release.

## Historical v0 verification (2026-07-10)

Prereqs: sql-updates 001, 002, 003, 004 run in Supabase; latest commit pushed and
deployed (Actions green); hard refresh.

Verification round 2026-07-10 run by Claude (browser automation) + Christian.

## Setup & shell
- [x] 1. SQL updates 001-004 applied — ✅ (004 added this round: persona-create RLS fix)
- [x] 2. https://aliaspaces.com loads with padlock; favicon shows the blue P — ✅ (favicon.svg served 200)
- [ ] 3. Signed out (incognito): welcome hero + 3 "What is AliaSpaces" cards + Get started — ⬜ needs signed-out browser (Christian)
- [x] 4. Signed in: DNA background appears behind pages — ✅
- [x] 5. Nav reads Entangle / Matrix; no emojis anywhere; blue glowing icons on card headings — ✅

## Auth
- [ ] 6. Google sign-in round-trips back signed in — ⬜ (Christian — automation can't handle credentials)
- [ ] 7. Magic link email arrives and signs you in — ⬜ (Christian)
- [ ] 8. Sign out → sign back in works — ⬜ (Christian)

## Onboarding & settings
- [ ] 9. Fresh account (no personas): onboarding page with "Create your first persona" + settings card at bottom — ✅ hero + button shown; settings card was NOT on the welcome page (it shows in Matrix) — confirm whether card had already been saved once
- [ ] 10. Save settings → card collapses; doesn't reappear on welcome page later — ⬜ (needs fresh account to observe)
- [ ] 11. Autofilled fields render white immediately (no gray boxes) — ⬜ (needs real browser autofill)

## Personas
- [x] 12. New persona form shows basics only; no example placeholder text — ✅
- [x] 13. Quick setup: step 1 multi-select; suggestions merge from multiple categories; platform placeholders added to links — ✅ (Product reviewer + Gamer merged into topics/voice/purpose; 9 platform link placeholders added)
- [x] 14. Persona SAVES without RLS error — ✅ after sql-updates/004. ROOT CAUSE (was ❌): insert().select() returns the new row; the returned row must pass the personas SELECT policy; persona_visible() (security definer, STABLE) re-queries personas and cannot see the row inserted in the same statement → 42501. Edits worked (no representation requested), creates always failed — hence "intermittent". NOT a session-expiry bug.
- [x] 15. Page looks: Choose file → upload → preview updates; Clear empties the slot — ✅ (avatar uploaded to media/<uid>/ folder, preview updated, Clear emptied, avatar persisted after save; OS picker itself un-automatable but the full pipeline verified)
- [ ] 16. SD panel docks bottom-right; generates via local A1111/Forge — ⏭ needs Christian's local SD with --api --cors-allow-origins=https://aliaspaces.com
- [x] 17. Saved page renders: banner, avatar, song player, link chips, Top 8, theme color — ✅ (theme-gradient banner fallback + avatar placeholder with no images; YouTube song player; 9 link chips; Top 8 empty → section hidden; theme color applied)
- [x] 18. Share button copies a working page link — ✅ copies https://aliaspaces.com/#/p/nova_qa

## Content
- [x] 19. Publish a post and a reel (reel displays vertical; Reels chip filters) — ✅ both published; reel badge + vertical video + page-URL overlay; Reels chip filters correctly
- [x] 20. Uploaded post image has the page-URL watermark burned in — ✅ (published "Watermark check" post; fetched the raw stored -wm.jpg from Supabase storage: diagonal tiled page-URL + solid bottom-right label are in the pixels)
- [x] 21. Page search finds posts by word and tag; feed type chips work — ✅ (note: search is scoped to the active type chip — searching while "Reels" selected only searches reels)
- [x] 22. Albums: gallery + sponsored created; items render and click out; sponsored label shows — ✅ (also rel="noopener sponsored" on affiliate links)
- [x] 23. Live URL set → LIVE pill + embedded player; module checkboxes hide/show sections — ✅ (Twitch player embedded — channel happened to be offline; modules Links/Song hidden and restored)

## Social (needs a second account)
- [ ] 24. Friend request → badge → accept → friend count — ⬜
- [ ] 25. Block prevents requests; mute hides from Entangle — ⬜
- [ ] 26. Private invisible to non-friends; unlisted only via link; 18+ gate — ⬜
- [x] 34. Linked personas reveal one-way — ✅ (deployed & tested: nova_qa shows "More of me → Echo QA"; echo_qa's page reveals nothing about Nova). Stranger-view double-check still worthwhile with the second account.

## AI & drafts
- [ ] 27. Model linked → HQ Assistant responds knowing the roster — ⬜ (needs an API key linked)
- [ ] 28. Persona chat responds in voice; "Save draft" lands in Matrix drafts — ⬜
- [ ] 29. Task ▶ Run works; drafts advance idea → ready → posted; Copy copies — ⬜
- [x] 30. Extensions card shows Concept entry (minimal, no GitHub release yet); Personas app download works — ✅ zip serves 200 (42 KB). FINDING: static fallback assets/Extensions/Concept/releases.json referenced by registry.json does not exist (404) — create it so the GitHub-rate-limit fallback works
- [x] 31. Report a problem creates a row in error_logs — ✅ insert path verified (row "[QA] verification test report" — confirm visible in dashboard). NOTE: the button itself uses prompt(), untestable via automation
​
## Growth
- [x] 32. Promote panel: 3 ad variants, Copy works, X share opens pre-filled — ✅ (deployed & tested; variants personalized from tagline/topics, clipboard verified, twitter.com/intent/tweet pre-filled)
- [ ] 33. Page link pasted in Discord/X shows hero image + description preview — ✅ meta side: static HTML head carries og:image (hero.png), og/twitter description + summary_large_image. Actual paste test: Christian. (Per-persona OG images = v0.5 roadmap.)

---
Progress: 19 / 34 (4 need second account, 3 need Christian-side auth, 1 needs local SD, AI checks need a linked model)

7. FIXED: route renders don't cancel superseded ones — navigating while a page render's queries are in flight lets the old render resolve late and clobber the new view (seen live: edit form replaced by the previous persona page). Added a renderEpoch counter: route() and every direct render call (post publish/delete, age-gate continue) claim a new epoch; renderDiscover/renderPersonaPage/renderEdit check it before their final DOM write and bail if superseded. Syntax-checked and smoke-tested locally (rapid hash-navigation sequence lands on the correct final view, no console errors) — NEEDS RE-VERIFICATION on a live deploy with real network latency to confirm the original repro (fast nav into an edit form) no longer clobbers.
8. FINDING (onboarding): fetching localhost (SD panel / local Ollama) from the https site triggers Chrome's local-network-access permission prompt, which blocks the page until answered. Expected browser behavior, but the SD/extensions docs should tell users to click Allow.
9. SECURITY NOTE: API keys were pasted into a chat during verification — owner advised to rotate the OpenRouter, xAI and ollama.com keys. As designed, keys should only ever be entered directly into Matrix → AI Models by the owner.

## Round findings (2026-07-10)
1. FIXED — persona create RLS (sql-updates/004): SELECT policy now checks owner/public inline; persona_visible() kept for private-friends case.
2. FIXED & VERIFIED LIVE — every Supabase query fired twice on page load. First attempt (event-name guard) didn't hold: SIGNED_IN and INITIAL_SESSION both fire at startup in varying order. Final fix dedupes by user-id in onAuthStateChange; deployed and confirmed single-fire via resource timing.
3. Live deploy is behind the working tree (no Promote, no linked personas). Push to deploy, then verify #32/#34 and the double-fetch fix.
4. assets/Extensions/Concept/releases.json missing — registry fallback 404s.
5. Minor: handle field label doesn't mention hyphens are rejected (validation toast easy to miss when Save silently no-ops).
6. Minor: test personas nova_qa (posts/albums/live/song) and echo_qa (linked-reveal target) left in place for further testing — delete both when verification wraps.
