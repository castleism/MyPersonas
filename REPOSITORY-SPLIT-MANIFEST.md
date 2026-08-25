# MyPersonas / AliaSpaces Repository Split Manifest

**Manifest date:** 2026-08-24

**Manifest state:** Planning and extraction control

**Production state:** Unchanged. No production deploy, migration, DNS edit, or provider action is authorized by this manifest.

This manifest turns the boundary in `REPOSITORY-BOUNDARIES.md` into an
auditable split sequence. Checkboxes are evidence gates, not estimates.

## Repository records

| Product | Local checkout | Remote | Intended default-branch responsibility |
| --- | --- | --- | --- |
| MyPersonas | `C:\Users\Justice Right\Documents\GitHub\MyPersonas` | `https://github.com/castleism/MyPersonas.git` | Automation, shared core contracts, and initial shared database release authority |
| AliaSpaces | `C:\Users\Justice Right\Documents\GitHub\aliaspaces.com` | `https://github.com/castleism/aliaspaces.com.git` | Persona social application and its product-specific Pages release |

### Source provenance snapshot

These values describe the inspected source and may change after later commits.
They must be re-read before release.

| Ref or checkpoint | Inspected SHA | Meaning | Destination |
| --- | --- | --- | --- |
| `rescue/pre-split-mixed-worktree-20260824` | `21703a9252d56f155f7210affa373d7d69f07e92` | Preserved mixed source after quarantining 065 and separating profile/resource work into descriptive commits | Extraction source only; never deploy directly |
| Local MyPersonas `main` | `ad683198ee1bcd8131a140184d7a095a085adcab` | Local opaque-media candidate lineage | Historical integration input |
| MyPersonas `origin/main` | `569f0029c0ddd95b7fcf09e497a1b2d629b09591` | Remote default branch at inspection | Current default-branch source, not proof of live production |
| `release/opaque-media-062-064` | `c0484ba6a83aff42af32770e54aebb66f3aa6351` | Mixed public/approved/legacy media release candidate | Split 062 to AliaSpaces, 063 to MyPersonas, keep 064 shared initially |
| `release/monetization-security-integration` | `c93c34cf088786410fa84f60aabd99be5c4d001a` | Integrated billing, operations, staging, and security baseline | MyPersonas |
| `feature/account-subscriptions` | `ff068fb6bde91e8ecb56ab6891fe6eb237716188` | Original account subscription feature branch | MyPersonas; compare with integrated successor before merging |
| `codex/operational-alert-inbox` | `d155d15af1a384420442807b1196e12bd2848fb0` | Original operational alert feature branch | MyPersonas; compare with integrated successor before merging |
| `codex/refund-admin-ui` | `6cc42a491e754f8fcaf6fbc00a9ffe02af20d0cf` | Original refund review UI branch | MyPersonas; compare with integrated successor before merging |
| `codex/staging-bootstrap-readiness` | `f5ad0cdda2c78488116fb4dd0aa8de59f1f3f7b4` | Original staging bootstrap branch | MyPersonas; compare with integrated successor before merging |
| `codex/staging-billing-ops-release` | `57a9449d4db418e4348ae3e7b1833079d9230a07` | Original staging billing/operations release branch | MyPersonas; compare with integrated successor before merging |
| `feature/persona-source-library` | `1cd68819f6cdf506969cf659cbb14e7d8cdb5997` | Private Persona Source Library | MyPersonas |
| AliaSpaces `main` | `f546fa1` | Redirect-only GitHub Pages front door | Preserve as rollback until social cutover passes |

Do not merge every branch tip merely because it exists. Several feature branch
changes have richer integrated successors in `c93c34c`. Compare trees, tests,
and patch intent; mark a branch superseded when its behavior is already present.

## Commit-to-product extraction map

| Commit or work unit | Ownership decision | Required action |
| --- | --- | --- |
| `21fe42d` migration 065 quarantine | MyPersonas shared contract initially | Preserve rejection/quarantine evidence; do not deploy 065 from either repo. |
| `344302b` custom persona fields and project resources | AliaSpaces | Extract social schema/UI/tests after shared persona-ID contract is fixed. |
| `21703a9` profile crop and mobile release wiring | AliaSpaces plus shared media calls | Extract presentation code; retain ingest/provenance through MyPersonas APIs. |
| Migration 062 public persona media | AliaSpaces | Own public social handles; consume the existing shared gateway contract. |
| Migration 063 approved provider media | MyPersonas | Keep with third-party publication approval and reconciliation. |
| Migration 064 legacy media discovery/remediation | MyPersonas shared contract initially | One inventory and erasure authority for both products. |
| Migration 065 canonical legacy remediation | Quarantined shared work | Remains release-rejected until its recorded safety blockers are closed. |
| Migration 066 custom persona field boxes | AliaSpaces | Social page/editor schema and UI. |
| Migration 067 project resource editor | AliaSpaces | Social project/business collaboration surface; private resource access still owner scoped. |
| Migration 068 account subscriptions | MyPersonas shared contract | AliaSpaces reads only the fail-closed entitlement result. |
| Migration 069 operational alert inbox | MyPersonas | Platform operations and technician/global-admin workflow. |
| Migration 070 Persona Source Library | MyPersonas | Private research/content source intake and study queue. |

## Migration ownership ledger

Historical applied migrations stay in the MyPersonas lineage and are never
replayed by AliaSpaces. The table below assigns ongoing maintenance and future
successor migrations.

| Migration family | Ongoing owner | Notes |
| --- | --- | --- |
| 001-006 profile/persona/social base | AliaSpaces feature owner; MyPersonas historical ledger owner | Core persona UUID/owner fields remain a shared MyPersonas contract. |
| 007 AI backend | MyPersonas | Automation provider configuration. |
| 008-025 account ledger, OAuth, mailbox, agents, provider hardening | MyPersonas | External-account automation and provider credentials. |
| 026 persona storage buckets | MyPersonas shared contract initially | One provenance, ingest, erasure, and quota authority. |
| 027-029 advisor, retention, anonymous-execute review | MyPersonas shared contract | Security and database operations. |
| 030-031 persona context and chat workspaces | MyPersonas | Private automation memory/workspaces. |
| 032 persona pet project | AliaSpaces | Social persona identity/presentation. |
| 033-036 post drafts, approval, schedule queue | MyPersonas | Third-party and automated publication pipeline. |
| 037 friend request Realtime | AliaSpaces | First-party social graph. |
| 038-040 context CAS, Reddit lease, AI model routes | MyPersonas | Automation consistency and provider/model routing. |
| 041 AAL2 credential boundary | MyPersonas shared contract | Auth/security boundary consumed by both products. |
| 041 affiliate/review rails | AliaSpaces | Public offers and review-request experience. |
| 042 Discord, backend editing, human-gated Agent Board | MyPersonas | Automation/provider control. |
| 043 repost media schedule | MyPersonas | Automated repost planning and provider scheduling. |
| 043 request review phase 1 | AliaSpaces | Public intake and social-page controls. |
| 044 research briefs | MyPersonas | Private research automation. |
| 045 owner mobile command center | Mixed; split by route | Briefs/schedule to MyPersonas; notifications/social activity to AliaSpaces. |
| 046 fan inbox/live chat privacy | AliaSpaces session owner; MyPersonas inference owner | Split behind a versioned inference contract. |
| 047-050 names, backups, relationships, projects, businesses, page layout | AliaSpaces | Social identity and page presentation; canonical UUID remains shared. |
| 051 publication/social/security governance | Mixed; decompose before successor work | Publication/friends/extensions to AliaSpaces; roles/security/rate limits/agent storage to MyPersonas. |
| 052 reviewed business publication | AliaSpaces | Social business page publication. |
| 053-055 Agent Board, research, action retention | MyPersonas | Automation and audit. |
| 056 auth email attestation | MyPersonas shared contract | Do not conflate sign-in identity with provider OAuth. |
| 057 AI backend budget guard | MyPersonas | Automation spend control. |
| 058 persona view mode | AliaSpaces | Acting and interacting as the selected persona. |
| 059-061 provenance and security hardening | MyPersonas shared contract initially | One disclosure, watermark, security, and migration authority. |
| 062 opaque public media | AliaSpaces feature owner | Shared MyPersonas gateway initially serves the stable media origin. |
| 063 opaque approved media | MyPersonas | Provider publication media. |
| 064-065 legacy media remediation | MyPersonas shared contract initially | 065 remains quarantined/rejected. |
| 066-067 custom fields and project resources | AliaSpaces | Social editor and collaboration UI. |
| 068-070 billing, operations, source library | MyPersonas | Shared entitlement plus private automation/operations. |

## Function deployment allowlists

The final workflows must fail when a function appears in both allowlists.

### MyPersonas allowlist

`agent-board-propose`, `agent-board-run`, `ai-proxy`, `approve-post-draft`,
`approved-media`, `compose-post`, `delete-account`, `discord-post`,
`erase-content`, `gemini-image`, `gmail-oauth`, `import-research-brief`,
`legacy-media-remediation`, `mailbox-manager`, `media-ingest`, `meta-oauth`,
`meta-post`, `openrouter-connect`, `owner-media-preview`, `post-bridge`,
`reddit-oauth`, `reddit-post`, `research-brief-run`, `run-mailbox-jobs`,
`run-post-queue`, `run-publish-queue`, `run-tasks`, `twitter-oauth`, plus the
billing, Stripe, refund, reconciliation, operations-maintenance, and
Persona-Source-Library functions introduced on the MyPersonas feature branches.

### AliaSpaces allowlist after extraction

`affiliate-redirect`, `request-review`, `sitemap`, `public-media`, and the
AliaSpaces social-session portion of `fan-chat` after that split exists.

### Transitional exception

Today, `fan-chat` is one fused function and `public-media` relies on a shared
gateway. Until explicit extraction commits exist, they remain deployable only by
the MyPersonas release authority. AliaSpaces must not deploy a copied function.

## Repository layout target

### MyPersonas

```text
apps/
  automation-web/
  workroom-bridge/
contracts/
  aliaspaces/
supabase/
  functions/       # MyPersonas and shared allowlist only
  migrations/      # sole shared-project release authority initially
docs/
tests/
```

### AliaSpaces

```text
apps/
  social-web/
contracts/
  mypersonas/       # version pins and generated client schemas, no secrets
supabase/
  functions/       # AliaSpaces allowlist only
  migration-candidates/  # non-deploying while MyPersonas owns shared DB release
docs/
tests/
```

The target does not require a bulk rename during the rescue. Move code in small,
testable slices and preserve import/redirect compatibility until cutover.

## Required contract artifacts

- [ ] Versioned persona identity projection with exact public/private columns.
- [ ] Versioned entitlement response and fail-closed behavior.
- [ ] Versioned fan-chat inference request/response contract.
- [ ] Versioned native AliaSpaces draft handoff with idempotency key and revision.
- [ ] Versioned media provenance/handle contract.
- [ ] Cross-product deletion request, tombstone, retry, and completion receipt.
- [ ] Cross-product export manifest that identifies data owner and binary scope.
- [ ] Error schema that does not expose owner UUIDs, secrets, prompts, or provider IDs.
- [ ] Compatibility policy stating how long the previous contract version remains valid.

## Extraction checklist

### 1. Preserve and reconcile source

- [ ] Confirm there is no active Git writer or stale index lock.
- [ ] Record `git status`, worktree list, local refs, remote refs, and current
      default branch without discarding changes.
- [ ] Commit preservation work with descriptive, scoped messages.
- [ ] Reconcile local/remote divergence without force-push or destructive reset.
- [ ] Compare feature branch tips with `c93c34c`; mark integrated equivalents as
      superseded instead of blindly merging them.
- [ ] Create and push a reviewed immutable pre-split tag.
- [ ] Run repository tests, migration repeat-apply/runtime tests, syntax checks,
      secret history scan, and `git diff --check` on the exact checkpoint.

### 2. Establish AliaSpaces source

- [ ] Keep `f546fa1` reachable as the redirect rollback.
- [ ] Create a non-deploying extraction branch in `aliaspaces.com`.
- [ ] Add a provenance receipt naming the exact MyPersonas source SHA and copied
      file hashes.
- [ ] Extract social routes and assets; do not ship the fused `index.html` as the
      permanent two-product architecture.
- [ ] Remove provider credentials, automation workers, billing internals, and
      service-role operations from AliaSpaces source.
- [ ] Give AliaSpaces its own name, icons, manifest scope, cache namespace,
      canonical URLs, policies, and Pages artifact allowlist.
- [ ] Add CI that rejects MyPersonas-only functions and migrations.

### 3. Slim MyPersonas

- [ ] Create the automation app shell and preserve owner access to providers,
      research, schedules, approvals, billing, and operations.
- [ ] Replace public social routes with authenticated previews or explicit links
      to AliaSpaces.
- [ ] Remove AliaSpaces-owned functions from the MyPersonas deployment allowlist
      only after the new owner is verified and rollback is documented.
- [ ] Add CI that rejects AliaSpaces-only functions and social Pages assets.
- [ ] Update MyPersonas README, policies, app metadata, and sitemap to describe
      the automation product accurately.

### 4. Shared platform safety

- [ ] Keep one Supabase/Auth production project during the first cutover.
- [ ] Confirm only one workflow can apply production migrations.
- [ ] Enforce disjoint Edge Function deployment allowlists in both repositories.
- [ ] Configure exact origin allowlists rather than wildcard or reflected CORS.
- [ ] Register both product origins and exact OAuth callbacks where required.
- [ ] Keep provider tokens, Stripe secrets, service-role keys, CAPTCHA secrets,
      SMTP credentials, WAF secrets, and signing keys server-side.
- [ ] Verify account deletion and content erasure cover both product schemas and
      every storage prefix before reporting completion.

## Staging and cutover verification checklist

No production cutover begins until every applicable item below has evidence from
the exact candidate commits.

### Repository and release evidence

- [ ] MyPersonas candidate SHA and AliaSpaces candidate SHA are immutable and pushed.
- [ ] Required reviewers protect staging and production environments in both repos.
- [ ] CI, dependency review, credential scanning, and build/test artifacts pass.
- [ ] Every migration/function has exactly one owner and one deployment path.
- [ ] Release manifests distinguish local, pushed, staged, deployed, and verified live.

### Authentication and account security

- [ ] New sign-up, existing sign-in, sign-out, reload, and expired-session flows pass on both origins.
- [ ] TOTP enrollment, AAL2 step-up, recovery decision, and account lock flows pass.
- [ ] Two unrelated accounts cannot read, infer, or mutate each other's personas, assets, friends, drafts, research, billing, or provider connections.
- [ ] Switching accounts clears cached persona/media state and never reuses the previous user's selection.
- [ ] Global-admin and technician actions require the intended role and AAL2 boundary.

### AliaSpaces social behavior

- [ ] Public, unlisted, private, unpublished, suspended, and deleted persona behavior is correct.
- [ ] Search/discovery disappears when entitlement policy requires it without exposing unpublished personas.
- [ ] Persona editing, crop placement, page builder, custom fields, family tree, project resources, and business pages persist correctly.
- [ ] Friend/follow/block/mute/invite rules pass with two accounts and configurable friend verification.
- [ ] Feed, albums, comments, reactions, fan chat, affiliate disclosure, and review requests pass desktop and mobile QA.
- [ ] Publication review invalidates stale revisions and never publishes an unapproved revision.

### MyPersonas automation behavior

- [ ] AI providers remain server-side and credentials are never readable from either browser app.
- [ ] Research, source-library study, Agent Board, schedules, and queues halt when entitlement policy requires it.
- [ ] Developer status bypass is global-admin only and fully audited.
- [ ] External publishing remains approval-gated unless an explicitly reviewed bounded-autonomy policy applies.
- [ ] Provider idempotency, retries, reconciliation, kill switch, and duplicate-subscription remediation pass.
- [ ] Mailbox operations remain report/approval bounded and cannot send email or permanently delete messages.

### Billing and lifecycle

- [ ] Free-trial eligibility, fingerprint rotation, intentional discounts, weekly/monthly/annual prices, cancellation, grace behavior, refunds, disputes, and duplicate subscriptions pass the Stripe test-clock matrix.
- [ ] Webhooks verify signatures, tolerate replay, and reconcile out-of-order delivery.
- [ ] Cancelling or losing entitlement unpublishes social personas and pauses automation exactly once.
- [ ] Restoring entitlement does not silently publish pages or resume risky automation without the documented owner decision.
- [ ] Customer deletion, retention, exports, and refund evidence satisfy the product policies.

### Media, privacy, and provenance

- [ ] Private originals and owner UUIDs are never exposed through public paths or error text.
- [ ] Public persona media and approved provider media use their correct, distinct opaque-handle contracts.
- [ ] Uploaded AI-use declarations and site-generated watermark rules survive crop/transform operations.
- [ ] Full preview and Save a copy work only for authorized owners.
- [ ] Deletion races with upload, study, archive, publication, and download fail closed and retry safely.
- [ ] `media.mypersonas.online` gateway, WAF, rate limits, origin bypass, secret rotation, and rollback are verified if activated.

### Mobile and browser matrix

- [ ] Signed-in desktop and real mobile testing pass for both products.
- [ ] Two simultaneous accounts in isolated browser profiles pass privacy testing.
- [ ] Back/Forward, deep links, refresh, offline shell, install, update, and cache invalidation behave per product.
- [ ] No horizontal overflow, clipped dialogs, inaccessible controls, or stale persona identity remains at supported widths.
- [ ] Production browser console and network logs contain no uncaught errors or secret-bearing responses.

### Domain, SEO, and redirect cutover

- [ ] `aliaspaces.com` serves the social application with valid TLS and expected canonical metadata.
- [ ] `mypersonas.online` serves the automation application with valid TLS and expected canonical metadata.
- [ ] Old `mypersonas.online/#/p/<handle>` and business links transition without losing the fragment route.
- [ ] The eight known brand repositories with legacy MyPersonas persona links are inventoried and updated only after the redirect is verified.
- [ ] Sitemaps, robots rules, social previews, email links, provider callbacks, CAPTCHA hostnames, and allowed origins point to the correct product.
- [ ] Rollback can restore the AliaSpaces redirect and previous MyPersonas artifact without reverting database migrations.

### Operations and incident readiness

- [ ] SMTP, CAPTCHA, WAF, application rate limits, authentication throttles, and operational alerts are tested.
- [ ] Repeated authentication failures escalate through timeout, account notification/lock, and network controls without unsafe permanent lockout.
- [ ] Error aggregation groups recurring failures without exposing private content.
- [ ] On-call/owner contacts, rollback operator, migration operator, and provider-revocation operator are named.
- [ ] Post-cutover monitoring window and success/error thresholds are recorded.

## Cutover order

1. Verify the exact MyPersonas and AliaSpaces staging candidates.
2. Verify shared contracts and database readback; do not move Auth or production
   data during this repository split.
3. Deploy only the disjoint, reviewed Edge Function sets.
4. Deploy AliaSpaces social Pages while retaining the redirect rollback artifact.
5. Run signed-in, mobile, two-account, billing, media, deletion, and provider
   regression checks.
6. Change canonical social routing only after those checks pass.
7. Deploy the slim MyPersonas automation Pages artifact.
8. Update external persona links after route preservation is verified.
9. Monitor, record deployment IDs/source hashes, and close the rollback window
   only after the owner approves the evidence.

## Stop conditions

Stop the release and keep the current live behavior if any of the following is
true:

- A migration or function has two possible deployment owners.
- The exact current production source cannot be identified.
- Auth/MFA, billing entitlement, deletion, or provider callbacks disagree across origins.
- Any unrelated-account privacy test fails.
- A public media URL exposes a stable owner UUID or bypasses provenance controls.
- Migration 065 or another rejected migration is included accidentally.
- A required secret, provider permission, CAPTCHA, legal acceptance, cost
  approval, or owner decision is missing.
- Rollback requires reversing an applied migration or deleting unrecoverable data.

Until the stop condition is closed with evidence, the source may be committed
and reviewed, but it must not be deployed to production.
