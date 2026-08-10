# Akiko / Being Tea Co. — Canonical Action Register

Prepared: 2026-08-09  
Status vocabulary: `COMPLETE_LOCAL`, `READY_FOR_OWNER_REVIEW`, `AWAITING_OWNER`, `BLOCKED_ACCESS`, `PROPOSED`, `NOT_STARTED`, `VERIFIED_EXTERNAL`  
Timing rule: `T` is the first owner-approved publication time; proposed calendar dates shift together if approval or access is delayed.

This register is the owner/operations source of truth. Narrative recommendations in the roadmap should be mapped to a row here before execution.

| ID | Action | Owner | Due | Effort | Cost | Dependency | Approval gate | Truthful status | Success metric |
|---|---|---|---|---:|---:|---|---|---|---|
| A01 | Confirm pronunciation and she/her pronouns | Account owner | Before profile approval | 5 min | $0 | Working brief | Owner decision | `AWAITING_OWNER` | One explicit approved spelling/pronunciation/pronoun record |
| A02 | Approve / deny / revise fictional AI-host model and disclosure | Account owner | Before any post approval | 10 min | $0 | Persona and disclosure review | Owner decision | `AWAITING_OWNER` | Public identity model and exact disclosure approved |
| A03 | Approve / deny / revise v2 master likeness | Account owner | Before derivative approval | 10–20 min | $0 | Review master and private provenance boundary | Owner decision | `READY_FOR_OWNER_REVIEW` | Master receives a written Approve / Deny / Revise result |
| A04 | Review 30 v2 derivatives on contact sheet and exceptions | Account owner | Before content approval | 30–60 min | $0 | A03 | Owner decision per concept or batch | `READY_FOR_OWNER_REVIEW` | All 30 derivatives have explicit decisions; revisions identified precisely |
| A05 | Review 30 captions, alt text, sources, and disclosures | Account owner | Before app-side import | 60–90 min | $0 | A02 and A04 | Owner decision per row | `READY_FOR_OWNER_REVIEW` | `QUEUE.csv` decisions complete with no unresolved claim/rights issue |
| A06 | Decide public Castleborn connection and Brother Kāruṇya separation | Account owner | Before profile/canon change | 10 min | $0 | Canon review | Owner decision | `AWAITING_OWNER` | Public/private boundary recorded; launch default is keep private/separate |
| A07 | Approve profile names, bios, links, pinned order, and banner directions | Account owner | Before account-side edits | 20–30 min | $0 | A01, A02, A03, final URL | Owner decision | `READY_FOR_OWNER_REVIEW` | One approved profile specification per platform |
| A08 | Name crisis/global-pause owner and approve comment/DM capacity | Account owner | Before first publication | 10 min | $0 | Community playbook | Owner decision | `AWAITING_OWNER` | Named person, contact route, two daily review windows, and pause rule documented |
| A09 | Supply current follower totals, 28-day exports, and Account Status screenshots | Account owner | Immediately before T | 20–40 min | $0 | Platform access | Owner-controlled export | `AWAITING_OWNER` | Complete baseline by platform with timestamp and native metric labels |
| A10 | Repair Meta authorization through the official owner-controlled flow | Account owner | Before any Meta staging | 15–60 min | $0 expected | Correct Page, professional Instagram, owner access | Explicit external action | `BLOCKED_ACCESS` | Correct Page/IG mapping and required scope verified without password sharing |
| A11 | Restore/approve official X write access if scheduling is desired | Account owner | Before X staging | 15–45 min | $0 expected | X owner access and connector | Explicit external action | `BLOCKED_ACCESS` | Official write scope passes a non-publishing verification; no post sent |
| A12 | Reverify live account health and official platform rules | Human operator + AI research | Immediately before T | 20–30 min | $0 | A09–A11 | Human review of warnings | `NOT_STARTED` | No unresolved recommendation, copyright, monetization, or identity restriction |
| A13 | Preview every approved v2 crop and alt text in native composers | Human operator | Before staging | 30–45 min | $0 | A04, A10/A11 | Owner visual approval | `NOT_STARTED` | 30/30 previews pass without UI crop, disclosure, or accessibility defect |
| A14 | Import approved rows into MyPersonas with idempotency/provider fields | Authorized operator | After A05 and access repair | 30–60 min | $0 | Explicit import authorization, correct account map | Separate owner instruction | `NOT_STARTED` | Imported count matches approved count; zero duplicates; no external publish |
| A15 | Issue a separate scheduling/publishing instruction | Account owner | After A10–A14 | 2 min | $0 | Every launch gate passed | Explicit external instruction | `AWAITING_OWNER` | Instruction names accounts, rows, times, and allowed action; provider receipts preserved |
| A16 | Approve and publish the Start Here page, privacy/consent flow, and one-line log | Account owner + site operator | Before link CTA goes live | 2–5 hr | Hosting/service dependent | Local log PDF is ready for review; final URL, email provider, privacy notice, sender identity, and analytics remain unresolved | Owner/site approval | `PROPOSED` | Approved accessible download on a live HTTPS page with tested opt-in/unsubscribe and analytics |
| A17 | Record one truthful human-run controlled tea experiment | Account owner or named tester | During first 14 days | 1–2 hr | Product, water, equipment, filming access | Human consent and claim review | `PROPOSED` | Source footage/log identifies tester, variables, tea/product, result, and rights |
| A18 | Review and approve the produced Facebook covers, X header, and profile crops | Account owner | Before any profile change | 20–30 min plus native previews | $0 | A03/A07; choose ornament direction and one Facebook cover option | Owner visual approval | `READY_FOR_OWNER_REVIEW` | Selected assets pass Facebook desktop/mobile and X native previews with no unsafe crop |

## Phase gates

| ID | Phase action | Owner | Due | Effort | Cost | Dependency | Approval gate | Status | Success metric |
|---|---|---|---|---:|---:|---|---|---|---|
| P01 | Run 14-day validation sprint | Human operator + AI analysis | T through T+14d | Capacity-dependent | $0 plus production | A01–A15 | All publish gates | `PROPOSED` | Complete source-labeled data, no safety/account incident, provisional seven-day medians |
| P02 | Select two repeatable franchises and complete day-30 launch cycle | Human operator + AI analysis | T+15d through T+30d | Capacity-dependent | Owner-set | P01 | Weekly owner review | `PROPOSED` | At least two formats show repeatable qualified conversion or are explicitly stopped |
| P03 | Scale qualified winners and launch owned-audience test | Human operator + AI analysis | Days 31–60 | Capacity-dependent | Owner-set | P02 and A16 | Owner approves scale and CTA | `PROPOSED` | 28-day medians, documented series continuation, attributable email conversion |
| P04 | Expand collaborations and platform-native formats | Account owner + contributors | Days 61–90 | Capacity-dependent | Case-by-case | P03, releases, access | Owner approves each collaboration | `PROPOSED` | Qualified reach expands without identity, rights, or workload degradation |
| P05 | Reforecast and execute final stretch | Account owner + AI analysis | Day 91–2026-12-31 | Capacity-dependent | Owner-set | P04 and current evidence | Weekly owner reforecast | `PROPOSED` | Honest conservative/strong/breakout forecast, sustainable output, owned-audience growth |

## Completed local work

| ID | Deliverable | Owner | Completed | Cost authorized | Dependency | Gate | Status | Success metric |
|---|---|---|---|---:|---|---|---|---|
| C01 | Persona, voice, roadmap, policy, category, franchise, community, monetization, and risk documents | AI drafting/research | 2026-08-09 | $0 | Workspace sources and current official research | Owner review | `COMPLETE_LOCAL` | Required sections exist; unknowns and proposals remain labeled |
| C02 | 30 platform-native v2 images and provenance | AI image generation | 2026-08-09 | $0 | V2 master anchor | Owner review | `COMPLETE_LOCAL` | 30/30 exact sizes, sRGB, no EXIF, <5 MB, unique hashes |
| C03 | 30-post local queue, approval pack, manifest, contact sheets, and tracker workbook | AI operations | 2026-08-09 | $0 | C01–C02 | Owner review | `COMPLETE_LOCAL` | 30 rows ready for review; external scheduled=false; no account mutation |
| C04 | Owner review index and consolidated decision path | AI operations | 2026-08-09 | $0 | C01–C03 | Owner review | `COMPLETE_LOCAL` | Creative, canon, profile, access, and publishing gates are separated in one review sequence |
| C05 | Build and validate inert MyPersonas local draft pack | AI operations | 2026-08-09 | $0 | C01–C03 | Separate future import authorization | `COMPLETE_LOCAL` | 30 unapproved local drafts validate; IDs/media unresolved; import, scheduling, and publishing disabled |
| C06 | Add and pass repeatable package-level launch validation | AI operations | 2026-08-09 | $0 | C01–C05 | Owner review | `COMPLETE_LOCAL` | Queue, captions, disclosures, hashes, dimensions, asset uniqueness, draft safety, and required deliverables pass together |
| C07 | Reconcile every requested roadmap section to a deliverable and external gate | AI operations | 2026-08-09 | $0 | C01–C06 | Owner review | `COMPLETE_LOCAL` | Coverage matrix distinguishes completed local work from owner/provider-controlled work |
| C08 | Produce and validate the printable/fillable one-line brewing log | AI document production | 2026-08-09 | $0 | Owned-audience copy and v2 visual system | Owner/site review | `COMPLETE_LOCAL` | One-page PDF has ten canonical fields/widgets, valid appearances, blank and filled render QA, and no external publication |
| C09 | Produce and validate profile and header asset proposals | AI creative | 2026-08-09 | $0 | V2 master likeness and current official platform guidance | Owner/native preview | `COMPLETE_LOCAL` | Profile exports, two Facebook covers, and X header pass dimensions, sRGB, metadata, size, unique-hash, and provenance checks |
| C10 | Complete consolidated independent and automated final QA | AI QA | 2026-08-09 | $0 | C01–C09 | Owner review | `COMPLETE_LOCAL` | Creative, operational, workbook, profile, PDF, privacy, and truthful-state checks pass with no blocking local defect |
