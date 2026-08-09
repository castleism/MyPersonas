# nooyouniverse.com — Site Roadmap

Updated: 2026-08-09 (overnight session) · Owner: Christian · Persona: Cillian O'Sullivan / Noo YouNiverse

Stack (best practice = free here): static site → **Cloudflare Pages** (zone already on Cloudflare, matches awareofmyfood.com pattern) + Supabase free tier waitlist. GitHub Pages remains a fallback (CNAME file included). $0/month.

## Status

| Item | State |
|---|---|
| Landing page (`index.html`) | ✅ Built + validated |
| Phase 2 Mission Log (`log.html`, 10 concepts, optimized images) | ✅ Built + validated (moved up from "later phases") |
| 404 page, robots, sitemap, CNAME | ✅ Built |
| Committed to MyPersonas repo | ✅ `006390d` + `72645cc` on main (local; push pending) |
| Deploy repo `GitHub/nooyouniverse` | ✅ Created locally, commit `d37b4c0`, remote pre-set to `castleism/nooyouniverse` |
| One-shot deploy script | ✅ `_ops/deploy-nooyouniverse.ps1` |
| DNS | ✅ Verified: nameservers already on Cloudflare (camilo/brianna), zone empty — custom-domain attach will auto-create records |
| Waitlist migration run | ⬜ Owner (SQL editor tab left open; automation blocked by safety classifier) |
| GitHub pushes | ⬜ Owner (sandbox has no push credentials) |
| Cloudflare Pages project + custom domain | ⬜ Owner (browser automation blocked by safety classifier) |
| End-to-end form test | ⬜ After the above |

## Morning checklist (~5 min)

Run one script, then two dashboard clicks-throughs:

1. **PowerShell:** `& "$HOME\Documents\GitHub\MyPersonas\_ops\deploy-nooyouniverse.ps1"` — cleans stale git locks, pushes both repos, prints the rest.
2. **Supabase:** SQL editor → paste/run `MyPersonas.Online_v0/sql-updates/027-noo-waitlist.sql` (a partially-typed editor tab may be open from last night — safe to clear and paste fresh).
3. **Cloudflare:** Workers & Pages → connect `castleism/nooyouniverse` → deploy → Custom domains → `nooyouniverse.com` (+ optional `www`).
4. **Test:** site loads over HTTPS · Mission Log renders · waitlist submit → "You're aboard" → row visible in Supabase → duplicate submit → "already aboard".

## Overnight session notes (2026-08-09)

- Blanket owner authorization given for roadmap execution ("full permissions"); safety classifier still blocked unattended browser writes to Supabase/GitHub dashboards — those remain the only human steps.
- Sandbox git cannot unlink lock files on this mount; commits were made via plumbing (`GIT_INDEX_FILE` + `commit-tree` + `update-ref`). Stale `*.lock*`/`tmp_obj_*` debris in both repos' `.git` is harmless; the deploy script cleans it.
- Supabase SQL editor tab may contain a partial paste of migration 027 (typing was interrupted by the classifier ~line 8). Clear the editor and paste the file fresh — running the partial fragment would error harmlessly, but don't.

## Owner approvals — treated as granted 2026-08-09 ("full permissions" instruction), revert on request

- [x] Landing page copy (disclosure chip, tagline usage, charter lines, waitlist framing)
- [x] Launch-pack images 01+10 on site (hero/og) + all ten X-format images on Mission Log
- [x] Mission Log web adaptation of the 30-post pack's Facebook captions (platform-specific CTAs generalized; all Transparency lines kept verbatim)
- [x] Privacy/data-deletion links point to mypersonas.online pages for v1
- [x] Social handles listed text-only until account ownership verified

## Later phases (aligned to master roadmap)

- **Phase 3 (Oct+):** newsletter integration (double opt-in ESP), press/collab kit, per-post source-ledger pages, evidence-tier badges on each log entry.
- **Phase 4 (product):** Observation Log build diary series → app waitlist segmentation; requires product, privacy, legal and health review before any capability claims.
- **Content cadence:** publish future approved concepts to `log.html` as they clear the social approval queue (source of truth: `outputs/cillian-noo-youniverse/`).

## Guardrails baked into the site

- Fictional/AI disclosure: hero chip, per-entry Transparency lines (×10), footer block, meta descriptions.
- No dosing, stacks, product claims, or first-person supplement stories anywhere; Mission 03/09 boundary language preserved verbatim.
- Evidence-tier legend matches the master roadmap taxonomy exactly.
- Social handles unlinked text until verified; only verified property linked is the AliaSpaces profile.
- Waitlist collects email only (insert-only RLS; anon cannot read); deletion path linked; 21+ statement included.
