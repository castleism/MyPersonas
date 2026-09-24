# MyPersonas roadmap progress — 2026-09-24

This is an evidence ledger, not a completion or release claim. Local, tested,
committed, pushed, deployed, configured, and verified live remain separate.

## Reconciled product direction

MyPersonas is the private automation and owner-control plane. It owns provider
credentials and workers, AI routing and budgets, research/source libraries,
billing internals, staff operations, audit/retention, and the current production
migration authority. AliaSpaces owns the first-party social presentation and
interaction product. Shared identity, entitlement, media, provenance, audit,
and account-lifecycle boundaries must be narrow versioned contracts.

The six-year portfolio document still treats the two products as one strategic
platform engine; that remains useful portfolio framing, but it is not repository
ownership. Its revenue figures are planning targets, not forecasts or approved
pricing.

## Completed and pushed for review

Branch: `codex/mypersonas-roadmap-progress-20260924`, based on current
`origin/main` (`00d7c7dae44db15c6ff5d45f54643d497c3842bc`). Commit
`35954874381f8f41a7d48577f7bdb9329efa372b` was pushed and opened as
[PR #13](https://github.com/castleism/MyPersonas/pull/13). At this checkpoint,
the PR was open and awaiting its required CI; it was not yet merged or deployed,
and no Supabase migration was applied or repaired by this work.

- Corrected the root README, package description, and roadmap heading/vision so
  they no longer assign the AliaSpaces social product to MyPersonas.
- Added `PROJECT-BOUNDARY.md` with current ownership and transition rules.
- Added `REVENUE-MODEL-PROPOSAL.md`, preserving the current owner-directed
  one-account contract: seven days free, then $20/week, $50/month, or $333/year.
  It explicitly separates that contract from the older `$9/$29/$99` planning
  proposal and from any live Stripe claim.
- Added `MIGRATION-INTEGRATION-PLAN-2026-09-24.md` with the concrete logical
  migration collisions and a forward-only recovery sequence.
- Added `PERSONA-REPUBLICATION-REVIEW-PLAN-2026-09-24.md`; it corrects the
  existing 17 property rows to 16 unique personas, identifies the missing 11,
  and defines a fail-closed 27-person owner-review packet without publishing.
- Pinned every third-party GitHub Action to an immutable commit and pinned the
  reviewed Supabase CLI version (`2.115.0`) instead of `latest`.
- Added regression tests that reject mutable workflow action references and an
  unpinned Supabase CLI.

Validation on this branch:

- `npm test`: **496/496 passed**.
- Frontend inline-script syntax: passed.
- Workflow YAML parse: passed.
- Production migration 060 was reverified read-only on 2026-09-24: ledger
  version/name and the recorded normalized-LF SHA-256 matched the reviewed SQL;
  the critical functions, tables, trigger, constraint, RLS, privileges, and
  one-time 118-reference grandfather snapshot all read back successfully.
- No production database, provider, account, billing, or website mutation was
  performed by the branch or that verification.

## Verified current release state

- Remote `main` is `00d7c7d`; its GitHub CI and Pages run `35928736784` passed.
- The public MyPersonas homepage and icon/manifest set were verified live for
  that release on 2026-09-23.
- Migration 060 and provider migrations 065–076 had release readback evidence
  for that deployment. This does not prove later migration 077 was applied.
- The released frontend contains Backup persona organization, family/tree and
  business draft workspaces, phase-1 page designer and learning console,
  Overview/Persona mode, whole-image editor previews, Save a copy, crop
  placement, publication/intention review, and Save & view page.
- The last production read found all 27 visibility-public personas unpublished.
  No profile is considered approved merely because its fields or assets exist.

## Not completed or not live

| Area | Current state | Blocking condition |
|---|---|---|
| Canonical checkout | Local `main` is 12 commits behind with preserved modified/untracked work | Use the isolated branch; do not pull/reset/clean over owner work |
| Supabase migration ledger | Authenticated remote inventory completed; migration 060 is verified, while the latest preview still reports `Remote migration versions not found in local migrations directory` | Forward-only reconciliation of remaining local/remote drift |
| Migration 077 | Present in source | Not proven applied/read back |
| Opaque media 062–064 | Pushed release branch only; names now collide with current main's 063–064 meanings | Renumber after remote inventory, disposable runtime, staging release |
| Custom fields/project resources | Pushed integration branch only | Split by AliaSpaces ownership and rebase after ledger repair |
| Billing/entitlements/refunds | Local/pushed feature work; checkout and enforcement default off | Staging project, Stripe test objects, lifecycle matrix, policy decisions |
| Operational alerts | Pushed branch only | New forward migration, alert destination, staging evidence |
| Persona Source Library | Pushed branch only | New forward migration, storage/provider policy, staging evidence |
| Public rich media widgets | Deliberately blocked | Opaque asset delivery must hide stable owner UUID/storage paths |
| Public signups | Auth foundations exist | SMTP, CAPTCHA/WAF, recovery, unrelated-account MFA/privacy proof |
| Provider publishing | Source and some historical owner tests exist | Exact credentials/scopes/account binding, preview, proof post, reconciliation |
| 27-profile republication | All remain unpublished at last read | Complete owner review of exact fields, disclosure, media, links, visibility |
| 3D persona capability | Specification only | No audited 3D source model; do not market as implemented |

## Integration blocker details

Current main uses 063–077 for different work than the older integration branch,
which uses 062–070 for opaque media, custom fields, project resources, billing,
alerts, and source-library work. The dirty canonical checkout also contains a
third unrelated `062-persona-media-unchanged-url-compatibility.sql`. A merge or
renumber based only on filenames could apply the wrong schema change. No feature
branch should be combined until the linked production ledger is read back and a
new forward-only sequence is reviewed.

## Remaining owner/external actions

Smallest actions that unblock the next safe engineering slices:

1. In Supabase, provide an authenticated read-only local/remote migration list;
   then create a separate staging project for migration and billing tests.
2. In GitHub, create protected `supabase-staging` and `production` environments
   with required reviewers and environment-scoped credentials. Only
   `github-pages` exists today.
3. In Stripe test mode, create the exact weekly/monthly/yearly Prices, Checkout,
   customer portal, and restricted staging webhook. Banking is not needed for
   sandbox work; payout routing waits until immediately before a separately
   approved first live payment.
4. Supply two unrelated MFA-enabled test accounts and physical iOS/Android
   devices for signed-in privacy, recovery, and mobile verification.
5. Review each persona's exact public fields, synthetic/AI disclosure, media,
   destinations, visibility, and family/business dependencies. Publication is a
   separate per-profile approval.
6. Confirm the canonical AliaSpaces/MyPersonas public account set and verify
   roles, recovery, 2FA, provider linkage, and write authority in each provider.
7. Approve seller/entity, tax, refund/dispute, payout, trial consent, retention,
   CAPTCHA/WAF/rate-limit, SMTP, and alert-recipient policies before production
   monetization or public signup activation.

## Recommended next sequence after those gates

1. Repair the migration ledger and disable implicit production auto-apply.
2. Release opaque media to staging under new non-colliding migration identities.
3. Rebase shadow billing, alerts, and Source Library as separate reviewable
   changes with default-off money/provider behavior.
4. Complete signed-in two-account and physical-device evidence.
5. Run the full Stripe lifecycle matrix in staging.
6. Prepare the complete 27-profile owner-review packet; publish nothing until
   each exact revision is approved.
