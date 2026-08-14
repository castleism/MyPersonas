# nooyouniverse.com — Site Roadmap

Updated: 2026-08-13 (Package A drafting session; live and deploy state unchanged) · Owner: Christian · Persona: Cillian O'Sullivan / Noo YouNiverse

Stack: static site → **Cloudflare Worker with static assets** + Supabase free-tier email waitlist. This is not Cloudflare Pages. GitHub Pages remains a fallback (CNAME file included). Recorded infrastructure cost: $0/month; billing was not re-audited in this session.

## Status — 🟢 LIVE at https://nooyouniverse.com (2026-08-09)

| Item | State |
|---|---|
| Landing page | ✅ Live |
| Mission Log — 10 concepts (`/log`) | ✅ Live |
| 404 page, robots, sitemap | ✅ Live |
| Waitlist table + RLS (migration 027) | ✅ Run in Supabase |
| Waitlist end-to-end | ✅ Verified: insert 201 · duplicate 409 · bad email 400 · anon read 401 (denied) |
| Deploy repo `castleism/nooyouniverse` | ✅ Pushed; Cloudflare auto-builds on push |
| Cloudflare Worker + apex domain | ✅ HTTPS live, 18 assets served |
| `www.nooyouniverse.com` | ✅ Added; resolves, canonical points to apex (no duplicate content) |
| **Phase 3** — source badges, `/sources`, `/corrections` | ✅ Built — **awaiting deploy** |
| **Package A** — Missions 11–14 | 📝 Four internal drafts — **zero approved; not in site source; not deployed** |

### Outstanding — one command plus one cleanup

1. **Deploy everything pending:**
   ```powershell
   & "$HOME\Documents\GitHub\MyPersonas\_ops\deploy-nooyouniverse.ps1" -Message "Phase 3: source badges, sources page, corrections log"
   ```
   The script now syncs source → deploy repo → pushes both → Cloudflare rebuilds. Use it for every future content update.
2. **Delete 2 test rows** in Supabase → Table Editor → `noo_waitlist`: `deploy-test-2026-08-09@nooyouniverse.com` and one `verify-…@example.com`.

## Phase 3 (built 2026-08-09)

- **Source-basis badges** on all ten Mission Log entries. They label *what kind of support an entry rests on* — Health-agency source / Methodology reference / Regulatory guidance / Editorial promise · no efficacy claim / Introduction · no factual claim. Classifications taken verbatim from `SOURCE-AND-POLICY-LEDGER.md`; deliberately **not** framed as evidence tiers, because most entries teach method rather than assert empirical claims. Inventing a tier for a non-claim would be exactly the certainty theater the charter forbids.
- **`/sources`** — badge legend, per-mission source table with live links to NCCIH/AHRQ/NHLBI/FDA/FTC, the publication standard, and the hard-limits list ("what this project will never do").
- **`/corrections`** — the charter promises corrections at equal visibility; this makes that operational before it is needed. Four change grades (Note / Clarification / Correction / Retraction), the five-step process, an append-only commitment, and how to report an error. Ships with an honest empty state.

Both pages are linked from the nav, the homepage evidence + charter sections, and every footer.

## Package A continuation (drafted 2026-08-13)

Four approval-only Mission Log drafts now live at `outputs/cillian-noo-youniverse/mission-log/NOO-MISSION-LOG-PACKAGE-A-DRAFTS-2026-08-13.md`:

- Mission 11 — The P-Value Is Not the Payload (`Methodology reference`)
- Mission 12 — The Claim Is the Whole Constellation (`Regulatory guidance`)
- Mission 13 — Read the Flight Plan Before the Landing (`Methodology reference`)
- Mission 14 — Tracker Build Diary: A Field Is Not Yet a Measurement (`Methodology reference`)

State: **four drafts prepared; zero owner approvals; zero human-review approvals; zero assets created; zero entries added to `log.html` or `sources.html`; zero deploys.** The first ten CIL-LW01 missions remain a closed launch sequence. The package proposes `CIL-ML02` as the new draft sequence key, but Christian must confirm it before use. If approved later, the new work should append as Missions 11–14.

The sources were checked on their current primary or official pages on August 13, 2026 and recorded in `SOURCE-AND-POLICY-LEDGER.md`. Mission 14 uses FDA measurement guidance only as a bounded design influence; it does not imply that the unbuilt consumer tracker is FDA governed, validated, compliant, cleared, or approved. Track A remains a recommendation awaiting an owner decision.

Publication gates remain unchanged: Christian must decide per entry; proposed public Transparency lines cannot be treated as human-reviewed until a human actually reviews them; Mission 14 additionally needs product, privacy, legal, health-safety, and technical review. Any later site integration must update the hard-coded ten-entry copy, table of contents, source table, and sitemap dates. Do not deploy Package A merely because Phase 3 is already awaiting deployment.

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

- ~~**Phase 3:** per-post source-ledger pages, badges on each log entry.~~ ✅ Done 2026-08-09.
- **Phase 4 (newsletter):** double opt-in ESP integration. The waitlist currently stores emails only; nothing is sent. Before the first send: confirmation flow, unsubscribe link, sender identity, and restating Cillian's fictional identity in every email.
- **Phase 5 (product):** Observation Log build-diary series → waitlist segmentation. Requires product, privacy, security, legal and health review before *any* capability claim. Mission 09 describes it as unbuilt — that must stay accurate.
- **Press/collab kit:** blocked until a qualified reviewer is named (see below).
- **Content cadence:** publish future approved concepts as new `/log` entries as they clear the social approval queue (source of truth: `outputs/cillian-noo-youniverse/`). Give each a source-basis badge and add its source to `/sources`.

## Adjacent workstreams (specced 2026-08-13, unapproved)

The website is now the smallest piece of the plan. Three new drafts live in `outputs/cillian-noo-youniverse/`:

- `app/NOO-APP-PRODUCT-SPEC.md` — mobile + web app: questionnaire, substance model, MyChart/FHIR, overclocking section, **risk-tier gating**
- `app/NOO-APP-SECURITY-COMPLIANCE.md` — auth, encryption, RLS, audit, HIPAA/FTC/state-law posture, FDA device line
- `supply-chain/NOOTROPIC-SUPPLY-CHAIN-ROADMAP.md` — sourcing, testing, cGMP, ethical audits, stability, personalisation-at-scale
- `HANDOFF-TO-CHATGPT-2026-08-13.md` — delegation brief for the other model

**The central decision** those docs raise: an app that suggests supplements or medicines *for a reported diagnosis* is a regulated medical device and contradicts this site's published promise ("we never tell you what to take"). The specs recommend **Track A** — same rich data collection, but output is information, interaction flags and clinician handoff, with hard suppression tiers for serious conditions. Owner decision required before any build.

## Open items the site cannot solve

From the master roadmap, still genuinely unresolved — the site is built to be honest about these rather than paper over them:

- **No named human health-claim approver.** Until one exists, content stays on methodology, regulatory explanation and agency summaries. Ingredient-, dose-, interaction- or condition-specific content is gated on this.
- **Social accounts unverified.** Instagram/Facebook/X appear as unlinked text ("coming online"). Link them only once ownership and write access are confirmed — a dead link on a trust-focused site is a self-inflicted wound.
- **MyPersonas profile conflicts** remain open: the public bio lacks a fictional/AI disclosure and can imply lived self-experimentation, and the profile theme is hot pink against this site's indigo/amber. The website now sets the correct precedent for both.

## Guardrails baked into the site

- Fictional/AI disclosure: hero chip, per-entry Transparency lines (×10), footer block, meta descriptions.
- No dosing, stacks, product claims, or first-person supplement stories anywhere; Mission 03/09 boundary language preserved verbatim.
- Evidence-tier legend matches the master roadmap taxonomy exactly.
- Social handles unlinked text until verified; only verified property linked is the AliaSpaces profile.
- Waitlist collects email only (insert-only RLS; anon cannot read); deletion path linked; 21+ statement included.
