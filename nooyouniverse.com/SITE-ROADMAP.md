# nooyouniverse.com — Site Roadmap

Updated: 2026-08-13 (full roadmap execution reconciliation; live site state unchanged) · Owner: Christian · Persona: Cillian O'Sullivan / Noo YouNiverse

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
| **Package A** — Missions 11–14 | 📝 Four internal copy drafts + four visual candidates — **zero approved; not in site source; not deployed** |

### Outstanding — one release decision plus one cleanup

1. **Review the Phase 3-only release candidate:**
   ```powershell
   & .\_ops\deploy-nooyouniverse.ps1
   ```
   The default is now a read-only preview. After Christian confirms the exact Phase 3-only scope, publish with `-Publish -Message "Phase 3: source badges, sources page, corrections log"`. The helper stages only the scoped site paths; it no longer stages the whole dirty repository. Full validation and rollback expectations are in `outputs/cillian-noo-youniverse/site/NOO-PHASE-3-RELEASE-READINESS-2026-08-13.md`.
2. **Verify, then delete, 2 recorded test rows** in Supabase → Table Editor → `noo_waitlist`: `deploy-test-2026-08-09@nooyouniverse.com` and one `verify-…@example.com`. Their current presence was not rechecked in this session; confirm exact rows before deletion.

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

State: **four copy drafts and four visual candidates prepared; zero owner approvals; zero human-review approvals; zero approved public assets; zero entries added to `log.html` or `sources.html`; zero deploys.** The visual-candidate folder includes provenance, literal alt text, QA notes, and checksums; candidates are not approvals. The first ten CIL-LW01 missions remain a closed launch sequence. The package proposes `CIL-ML02` as the new draft sequence key, but Christian must confirm it before use. If approved later, the new work should append as Missions 11–14.

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

These content approvals do not mark the still-unpublished Phase 3 build as verified live. Because the deployment now has an explicit release manifest and Package A exists as a separate unapproved draft, confirm the exact Phase 3-only release scope before using `-Publish`.

## Later phases (aligned to master roadmap)

- **Phase 3:** per-post source-basis badges, Sources, and Corrections are **built locally; release still pending**.
- **Phase 4 (newsletter):** the double-opt-in contract, lifecycle copy, ESP/compliance audit, QA, and owner-decision package are drafted under `outputs/cillian-noo-youniverse/newsletter/`. The waitlist currently stores emails only; nothing is sent. Before the first send: owner/operator decisions, lawful consent treatment, unsubscribe, sender identity and postal address, mailbox/domain authentication, current DNS verification, and restating Cillian's fictional identity in every email.
- **Phase 5 (product):** Observation Log build-diary series → waitlist segmentation. Requires product, privacy, security, legal and health review before *any* capability claim. Mission 09 describes it as unbuilt — that must stay accurate.
- **Press/collab kit:** blocked until a qualified reviewer is named (see below).
- **Content cadence:** publish future approved concepts as new `/log` entries as they clear the social approval queue (source of truth: `outputs/cillian-noo-youniverse/`). Give each a source-basis badge and add its source to `/sources`.

## Adjacent workstreams (specced 2026-08-13, unapproved)

The website is now the smallest piece of the plan. Current drafts and operating packages live in `outputs/cillian-noo-youniverse/`. Start with `strategy/NOO-EXECUTION-CONTROL-CENTER-2026-08-13.md`; it distinguishes finished local work from owner, specialist, and external gates.

- `app/NOO-APP-COMMUNITY-MODEL.md` v0.2 — reconciled detached-report proposal, Green-only/app-only launch recommendation, privacy/moderation gates
- `app/NOO-APP-COMMUNITY-OWNER-DECISIONS-2026-08-13.md` — 14 explicit owner choices; none inferred approved
- `app/NOO-APP-COMMUNITY-SOURCE-AUDIT-2026-08-13.md` — primary-source record for the corrected legal/privacy claims
- `app/NOO-APP-PRODUCT-SPEC.md` v0.2 — questionnaire, private current-use log, MyChart/FHIR, narrower **risk-tier gating**; suggestions/Overclocking retired from current scope
- `app/NOO-APP-SECURITY-COMPLIANCE.md` v0.2 — auth, encryption, RLS, audit, health-privacy posture, FDA function review, detached-publication addendum
- `app/implementation/` — boundary ADR, gated backlog, private-log contracts, 40 tier cases, 54 acceptance criteria, detached-publication blockers, and a synthetic local prototype plan; documentation only
- `mission-log/` — four Package A copy drafts and four unapproved visual candidates with provenance, alt text, QA, and checksums
- `evidence-library/` — nine provisional claim cards plus schema/JSON and approval record; qualified review still required
- `questionnaire/` — complete copy/field contract, tier and crisis messaging, 48-case QA, and owner choices; no intake system built
- `newsletter/` — double-opt-in integration contract, ESP/compliance audit, lifecycle copy, 53 QA checks, and owner decisions; no account or send
- `community-ops/` — voice, corrections, UGC, daily runbook, moderation, evidence preservation, and source/decision guide; no live operation
- `platform-strategy/` — official-source audit, readiness/funnel strategy, and proposed 30-day experiment plan; live account state remains unverified
- `category-intelligence/` — 12 positive project profiles, eight documented failure-side cases, and a combined original-format/guardrail synthesis; research only, with no outreach or copying authority
- `analytics/` — blank-safe weekly operating workbook; no real social metrics imported and all experiments remain Proposed
- `strategy/` — operating package plus the execution control center and ordered owner decision queue
- `supply-chain/` — v0.2 deferred business-case roadmap and unqualified candidate research; commerce is on Hold, with zero outreach or spend
- `HANDOFF-TO-CHATGPT-2026-08-13.md` — delegation brief for the other model

**The central product boundary:** the current proposal makes no app-generated treatment, medicine, supplement, amount, stack, combination, schedule, cycle, washout, or Overclocking plan. The specs recommend a private neutral log plus curated research, with a possible detached community library only after separate owner, legal, clinical, privacy, security, moderation, and adversarial linkability-review gates. FDA status remains function-specific; user-generated content creates no automatic legal safe harbor. Owner decisions are required before any build.

### Community model reconciliation — exact state

The supplied v0.1 community model was already present locally but conflicted with the binding risk tiers and overstated several legal/privacy conclusions. The v0.2 reconciliation now makes the following explicit:

- Amber and Red cannot browse or submit community reports; Red receives current-use/context logging, export/handoff, and immediate safety routing only.
- Mission 09 supports a neutral observation log, not prospective stack building, cycles, washouts, or one-tap publication.
- Individual reports are recommended app-only, authenticated, 21+, and Green-only at launch; public web receives no raw reports.
- Detached publication is a recorded owner direction but remains an unverified design objective, not an anonymity claim.
- Anonymous eligibility credentials, capability-based correction/deletion, separate security domains, human moderation, crisis interception before detachment, edge/log audit, and re-identification review are pre-launch gates.
- `k ≥ 20` is a provisional privacy floor, not a guarantee or legal safe harbor.
- Generic-compound-only/no-brand reporting is the recommended commerce boundary; it does not itself guarantee FTC compliance.

State: **documentation reconciled; zero new owner decisions; zero app code; zero community infrastructure; zero reviews/sign-offs; zero public-site page/code changes; roadmap documentation only; zero deploys.** The live site and pending Phase 3 deploy scope are unchanged.

## Open items the site cannot solve

From the master roadmap, still genuinely unresolved — the site is built to be honest about these rather than paper over them:

- **No named human health-claim approver.** Until one exists, content stays on methodology, regulatory explanation and agency summaries. Ingredient-, dose-, interaction- or condition-specific content is gated on this.
- **Social accounts unverified.** Instagram/Facebook/X appear as unlinked text ("coming online"). Link them only once ownership and write access are confirmed — a dead link on a trust-focused site is a self-inflicted wound.

### MyPersonas profile — live verification closed 2026-08-13

The signed-in profile was reopened in read-only mode and independently checked. The public About text now explicitly identifies Cillian as fictional, AI-assisted, human-reviewed, educational-only, and without personal product experience; the title is `Noo YouNiverse · Evidence Scout`; and the saved theme is deep auburn `#8f3f28`. The evidence-literacy focus and topic tags are aligned. No field was changed or saved in this verification session. The profile still has no posts and no public social links, which is the correct state while the launch packages and account ownership remain unapproved/unverified.

## Guardrails baked into the site

- Fictional/AI disclosure: hero chip, per-entry Transparency lines (×10), footer block, meta descriptions.
- No dosing, stacks, product claims, or first-person supplement stories anywhere; Mission 03/09 boundary language preserved verbatim.
- Evidence-tier legend matches the master roadmap taxonomy exactly.
- Social handles unlinked text until verified; only verified property linked is the AliaSpaces profile.
- Waitlist collects email only (insert-only RLS; anon cannot read); deletion path linked; 21+ statement included.
