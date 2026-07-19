# v0 Verification Checklist

Status: ⬜ untested · ✅ pass · ❌ fail (see note) · ⏭ skipped/blocked

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
