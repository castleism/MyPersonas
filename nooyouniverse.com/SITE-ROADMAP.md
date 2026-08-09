# nooyouniverse.com — Site Roadmap

Updated: 2026-08-09 (overnight session) · Owner: Christian · Persona: Cillian O'Sullivan / Noo YouNiverse

Stack (best practice = free here): static site → **Cloudflare Pages** (zone already on Cloudflare, matches awareofmyfood.com pattern) + Supabase free tier waitlist. GitHub Pages remains a fallback (CNAME file included). $0/month.

## Status — 🟢 LIVE at https://nooyouniverse.com (2026-08-09)

| Item | State |
|---|---|
| Landing page | ✅ Live |
| Mission Log — 10 concepts (`/log`) | ✅ Live |
| 404 page, robots, sitemap | ✅ Live |
| Waitlist table + RLS (migration 027) | ✅ Run in Supabase |
| Waitlist end-to-end | ✅ Verified: insert 201 · duplicate 409 · bad email 400 · anon read 401 (denied) |
| Deploy repo `castleism/nooyouniverse` | ✅ Pushed; Cloudflare auto-builds on push |
| Cloudflare Worker + custom domain | ✅ `nooyouniverse.com` attached, HTTPS live, 18 assets served |
| Clean-URL canonicals | ✅ Committed (`6872279` deploy repo / `a5afcf9` source) — **awaiting next push** |

### Only outstanding items

1. **Push the clean-URL commit** — `cd "$HOME\Documents\GitHub\nooyouniverse"; git push` (Cloudflare rebuilds automatically). Same for the MyPersonas source copy: `git push origin main`.
2. **Delete 2 test rows** in Supabase → Table Editor → `noo_waitlist`: `deploy-test-2026-08-09@nooyouniverse.com` and one `verify-…@example.com`.
3. Optional: add `www.nooyouniverse.com` as a second custom domain.

## Deploy architecture (as built)

Cloudflare **Worker with static assets** (not Pages — Cloudflare's Git-connect flow now defaults to Workers).

- `wrangler.jsonc` at deploy-repo root declares `./public` as the asset dir, `not_found_handling: "404-page"`.
- Build settings: build command *none*, deploy command `npx wrangler deploy`, root `/`.
- Everything served lives in `public/`; nothing above it is public.

### Gotchas learned during this deploy

- **Empty-repo build failure:** connecting Cloudflare to a repo *before* pushing code fails with "error occurred while fetching repository". Fix is Retry build after the first push, not reconfiguration.
- **Worker ≠ Pages:** a dashboard-created Worker ships a "Hello world" script that serves the domain until a successful asset build replaces it. Seeing "Hello world" means the build never succeeded.
- **Clean URLs:** Workers assets 301s `/log.html` → `/log`. Internal links, canonicals, og:url and sitemap all use the extensionless form.
- **Sandbox git:** locks can't be unlinked on this mount — rename them aside and commit via `GIT_INDEX_FILE` + `write-tree`/`commit-tree`/`update-ref`. `_ops/deploy-nooyouniverse.ps1` sweeps the debris.

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
