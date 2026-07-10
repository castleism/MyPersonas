# v0 Verification Checklist

Status: ⬜ untested · ✅ pass · ❌ fail (see note) · ⏭ skipped/blocked

Prereqs: sql-updates 001, 002, 003, 004 run in Supabase; latest commit pushed and
deployed (Actions green); hard refresh.

Verification round 2026-07-10 run by Claude (browser automation) + Christian.

## Setup & shell
- [x] 1. SQL updates 001-004 applied — ✅ (004 added this round: persona-create RLS fix)
- [x] 2. https://mypersonas.online loads with padlock; favicon shows the blue P — ✅ (favicon.svg served 200)
- [ ] 3. Signed out (incognito): welcome hero + 3 "What is MyPersonas" cards + Get started — ⬜ needs signed-out browser (Christian)
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
- [ ] 15. Page looks: Choose file → upload → preview updates; Clear empties the slot — ⬜ (needs native file dialog — Christian)
- [ ] 16. SD panel docks bottom-right; generates via local A1111/Forge — ⏭ needs Christian's local SD with --api --cors-allow-origins=https://mypersonas.online
- [x] 17. Saved page renders: banner, avatar, song player, link chips, Top 8, theme color — ✅ (theme-gradient banner fallback + avatar placeholder with no images; YouTube song player; 9 link chips; Top 8 empty → section hidden; theme color applied)
- [x] 18. Share button copies a working page link — ✅ copies https://mypersonas.online/#/p/nova_qa

## Content
- [x] 19. Publish a post and a reel (reel displays vertical; Reels chip filters) — ✅ both published; reel badge + vertical video + page-URL overlay; Reels chip filters correctly
- [ ] 20. Uploaded post image has the page-URL watermark burned in — ⬜ (needs file upload — Christian)
- [x] 21. Page search finds posts by word and tag; feed type chips work — ✅ (note: search is scoped to the active type chip — searching while "Reels" selected only searches reels)
- [x] 22. Albums: gallery + sponsored created; items render and click out; sponsored label shows — ✅ (also rel="noopener sponsored" on affiliate links)
- [x] 23. Live URL set → LIVE pill + embedded player; module checkboxes hide/show sections — ✅ (Twitch player embedded — channel happened to be offline; modules Links/Song hidden and restored)

## Social (needs a second account)
- [ ] 24. Friend request → badge → accept → friend count — ⬜
- [ ] 25. Block prevents requests; mute hides from Entangle — ⬜
- [ ] 26. Private invisible to non-friends; unlisted only via link; 18+ gate — ⬜
- [ ] 34. Linked personas reveal one-way — ⏭ BLOCKED: feature not in the live deploy yet (working tree is ahead — push to deploy)

## AI & drafts
- [ ] 27. Model linked → HQ Assistant responds knowing the roster — ⬜ (needs an API key linked)
- [ ] 28. Persona chat responds in voice; "Save draft" lands in Matrix drafts — ⬜
- [ ] 29. Task ▶ Run works; drafts advance idea → ready → posted; Copy copies — ⬜
- [x] 30. Extensions card shows Concept entry (minimal, no GitHub release yet); Personas app download works — ✅ zip serves 200 (42 KB). FINDING: static fallback assets/Extensions/Concept/releases.json referenced by registry.json does not exist (404) — create it so the GitHub-rate-limit fallback works
- [x] 31. Report a problem creates a row in error_logs — ✅ insert path verified (row "[QA] verification test report" — confirm visible in dashboard). NOTE: the button itself uses prompt(), untestable via automation
​
## Growth
- [ ] 32. Promote panel: 3 ad variants, Copy works, X share opens pre-filled — ⏭ BLOCKED: openPromo not in the live deploy (working tree is ahead — push to deploy)
- [ ] 33. Page link pasted in Discord/X shows hero image + description preview — ⬜ (Christian — paste link after next deploy)

---
Progress: 15 / 34 (+2 blocked on deploy, 4 need second account, 3 need Christian-side auth/files)

## Round findings (2026-07-10)
1. FIXED — persona create RLS (sql-updates/004): SELECT policy now checks owner/public inline; persona_visible() kept for private-friends case.
2. FIXED — every Supabase query fired twice on page load (getSession + SIGNED_IN both ran loadMine/route). index.html now loads once via INITIAL_SESSION and ignores same-user SIGNED_IN re-fires (tab refocus) — also protects in-progress forms.
3. Live deploy is behind the working tree (no Promote, no linked personas). Push to deploy, then verify #32/#34 and the double-fetch fix.
4. assets/Extensions/Concept/releases.json missing — registry fallback 404s.
5. Minor: handle field label doesn't mention hyphens are rejected (validation toast easy to miss when Save silently no-ops).
6. Minor: test persona nova_qa (with posts/albums) left in place for further testing — delete when verification wraps.
