# Mobile portfolio: remaining work and ready-to-copy handoffs

23 September 2026. These are Android testing builds, not finished store products. The current local polish adds distinct editable vector identities, adaptive/themed launcher icons, illustrated first-open guides, and consistent app names. Existing in-app artwork and working local features are retained. Photography, approved exercise videos, production account integrations, and exhaustive device/accessibility QA are not implied by this artwork pass.

Use `POLISH-VERIFICATION.json` and `POLISH-STATUS.md` for this pass's actual build and phone results. Older roadmap paragraphs that say no phone was available describe historical cloud runs. Sources are in this folder's `rebuilds/`, not necessarily the latest upstream branch. Original checkouts were not overwritten. Do not publish these whole workspaces or send private backups to another assistant.

## Remaining by app

| App | Working local scope | Still needed before calling the full product finished |
|---|---|---|
| Literally Even | Offline practices, reflection, plans, learning and finite discovery | Production provider activation and account-sync acceptance tests, reviewer/moderation operations, public-access decision, store QA |
| Cooked Just Right | Dish estimates, weighed portions, recipes/yield, broad nutrient catalog, explicit preparation factors, storage history, body-context notes, intake history, backup | Reconcile real meal planner/pantry workflows; branded barcode lookup; food-specific storage models with evidence; scientific review; iOS; no validated personal absorption model |
| Smile To Your Body | Approved local session composer and practices | Approved movement media and expanded content, accessibility and content review |
| Being Tea | Brewing timer, methods and tasting journal | Locked-screen/Doze/process-death notification checks and iOS native QA |
| Aware Of My Food | Private middle-path journal, provenance-oriented copy, export/import | Additional reviewed cultural/scientific content, owner-reviewed privacy copy, iOS; retired product scoring stays retired |
| Noo You | Approved missions 01–11, observations, corrections, backup | Owner completion of adult disclosure, content/privacy review; no automatic sensor, clinical or remote-sync claims |
| Wonder Notes | Projects, notes, typed links/backlinks, pin/archive, interests, curated roulette, explicit AI context packets | Live discovery ingestion and source governance; reviewed opt-in AI connections; historical schema reconciliation where necessary |
| Brick by Brick | Attributed knowledge excerpts, goals, constraints, selection and export | Owner decision on MCP host and unlock policy, then authenticated read-only connector; retained legacy-data reconciliation |
| Life Giving Communication | Conversation preparation and canonical 40 scripts | Approved curriculum expansion and any separately designed coaching/account services |
| Personas | Owner website wrapper, preferences and existing owner tools | Real account sign-in/MFA, two-account isolation and provider permission checks, service-specific completion evidence |
| Terraseeds | Seed journal, local proposed card experiment, validated backups | Approved game canon/card design; approved photo/quantity/reminder scope; real trading/accounts design |
| AliaSpaces | Website/Social/Local modes and local social tools | Production authorization/moderation, two-account tests and sign-in/MFA; retain the owner command-center scope |

All apps still need store signing, accurate privacy/listing material, release device coverage and owner-controlled store submission. Monetization is not implemented by this pass; earlier proposals are not approved pricing or billing contracts. Retained data from removed prototype identities is backed up, not silently imported into the new schemas.

## 1. Gemini on your Mac — iOS implementation and release preparation

Copy this prompt, then provide only the relevant sanitized source folders and this checkpoint. Windows paths identify the source; they are not Mac paths.

> Continue my twelve-app mobile portfolio on my Mac. Start with Being Tea, Literally Even, Wonder Notes, Brick by Brick, Life Giving Communication and Terraseeds, then inspect the remaining hosts. I will supply the corresponding `rebuilds/` folders from `mobile-publishing-2026-09-20`, `onboarding/`, and `brand-assets/`. Read each project's instructions and current roadmap first. Preserve existing product scope, data schemas and Android package IDs. Build the iOS equivalents of the four-page purpose/features/example/setup guide, with an accessible in-app replay entry and persistent completion/checklist state. Use the supplied editable SVG identities to produce proper iOS app-icon assets and coordinated launch artwork; no default Flutter/Expo icons. Keep illustrations decorative to screen readers. Determine which apps already have an iOS host and explicitly report wrappers that need implementation. Run on an iPhone or simulator, check large text, keyboard, offline launch, persistence, share/import and safe-area layouts. Configure signing with me through the platform's own UI; never ask me to paste credentials or signing secrets into chat. Prepare reviewable archives and a per-app blocker matrix. Do not publish, charge, accept contracts or submit to stores. Return exact source changes, build commands, artifact paths, screenshots and pass/fail results. Android test signing is not production signing. Do not claim every roadmap is complete merely because an archive builds.

## 2. Cursor or Claude — bounded engineering and independent QA

Use one assistant for a particular app/branch at a time. This work can also return to Codex; another assistant is useful for independent review, not inherently required.

> Audit and finish one app from my portfolio: [APP NAME]. I will provide its current sanitized `rebuilds/` source and the mobile portfolio checkpoint. Work on an isolated branch; do not overwrite owner changes or regenerate package identities. Read instructions, roadmap, schema and existing tests before editing. First produce a concise evidence-backed list of remaining work, separating implementable local behavior, owner decisions, external account access and speculative features. Implement the unblocked local behavior and regression fixes; preserve local data and explicit import previews. Add meaningful tests for data integrity and permissions, not tests that only mirror UI markup. Review large text, focus order, labels, empty/error/offline states, first-open completion and replay, background/relaunch behavior and import/export failures. Preserve art and launcher identities. Do not connect paid APIs, upload private records or publish. For Cooked, never fabricate storage-decay or personal absorption percentages; preserve unknown nutrient values and the source/estimate distinction. For Wonder, preserve explicit user-controlled AI sharing and finite curated discovery until a reviewed live-source design exists. For Brick, do not implement a live MCP connection without the owner-approved host and unlock policy. For Terraseeds, do not turn proposed rules into canon. Return a patch/branch, tests, screenshots, migration notes, and exact unresolved decisions. Label fixture-only and service-dependent behavior honestly.

## 3. Perplexity or another research assistant — Cooked evidence package

No private meal histories or lab results are needed for this task.

> Build a primary-source evidence matrix for Cooked Just Right. The implemented app uses USDA FNDDS 2021–2023 and SR Legacy food records, explicit USDA Release 6 retention factors for matching raw-food preparation profiles, measured final recipe yield, and separate storage/body-context logs. It does not calculate individual absorption or universal nutrient decay. Research food-specific nutrient changes by cooking method, reheating, freezing/thawing, storage time, temperature, packaging and handling. Separately research documented nutrient-absorption interactions and the limits of applying population evidence to individuals. For every proposed model provide the original source URL/DOI, date, population or food matrix, baseline/raw-versus-cooked state, units, experimental conditions, uncertainty, valid range, excluded situations, licensing and reproducible calculation example. Distinguish measured data from mechanistic speculation. Identify where no trustworthy quantitative model exists. Do not infer diagnoses or deficiency from logged intake, invent personalized percentages, or give supplement dosing. Deliver a cited CSV/data dictionary plus a concise validation plan for a qualified nutrition scientist or clinician. AI-generated review is not clinical validation. Include explicit double-counting risks when source foods are already cooked and preparation retention is applied again.

## 4. Grok / Grok Bot — optional copy and creative review

This is optional; there is no need to send every app to every assistant. Supply public copy and artwork only.

> Review the supplied twelve app identities and first-open guide copy for clarity, visual distinctiveness and a beautiful minimal interface that reveals deeper tools gradually. Return specific screen-level suggestions and revised copy, grouped by app. Preserve approved names, the Life Giving Communication rename, existing persona canon and the difference between implemented, fixture and proposed features. Do not invent medical promises, trading-card lore, product capabilities, testimonials or automatic AI integrations. For each suggestion state the user problem and a concrete acceptance check. Work from supplied screenshots and copy; do not claim to have tested code or logged into services. Do not post, publish or contact anyone. Return editable text and a short prioritized critique for Codex to reconcile before implementation.

## What to bring back

Return the changed source/patch, tests and screenshots, research matrix, or iOS build report. Do not send keystores, tokens, private journal backups or entire browser profiles. Account consent, game canon, pricing approval and qualified scientific review remain owner/expert decisions; handing them to another AI does not resolve them.
