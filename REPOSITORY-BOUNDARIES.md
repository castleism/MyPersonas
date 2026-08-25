# MyPersonas and AliaSpaces Repository Boundaries

**Status:** Transitional architecture contract

**Recorded:** 2026-08-24

**Production effect:** None. This document does not approve or perform a deployment, database migration, DNS change, provider change, or publication.

## Purpose

MyPersonas and AliaSpaces are becoming separate products and separate GitHub
repositories:

- **MyPersonas** is the private automation and orchestration control plane.
- **AliaSpaces** is the first-party persona social network.

The current source is still a fused, transitional application. File location is
therefore not proof of final ownership. The assignments below govern extraction,
future development, release authority, and incident response.

## Product boundary

### MyPersonas owns automation

MyPersonas owns capabilities that plan, generate, coordinate, authenticate, or
execute work for a persona:

- AI provider configuration, encrypted credentials, model routing, provider
  verification, budget policies, usage leases, and local-model benchmarking.
- Agent Board proposals, approval gates, schedules, tasks, action logs, research
  briefs, private source libraries, and reusable automation instructions.
- The Account Ledger, external-provider OAuth grants, mailbox management, and
  provider-specific adapters for Meta, X, Reddit, Discord, Gmail, and future
  services.
- Draft composition, per-provider renditions, approval records, immutable
  provider media, scheduled queues, reconciliation, retries, and kill switches.
- Subscription entitlements, developer status, customer portal operations,
  refund review, Stripe reconciliation, and operational alerting.
- The local workroom bridge and other owner-only automation applications.
- Shared platform contracts listed below until a separately reviewed extraction
  transfers their ownership.

MyPersonas must not become a public social feed or duplicate AliaSpaces profile,
friend, discovery, or public-page behavior. It may show a private read-only
preview or a link to the corresponding AliaSpaces page when needed to configure
automation.

### AliaSpaces owns the social network

AliaSpaces owns capabilities through which people present and interact as
personas:

- Public, unlisted, and private persona pages and business pages.
- Persona appearance, profile-image placement, banners, backgrounds, page
  layouts, custom field boxes, reusable presentation snippets, and page modules.
- Discovery, search, tags, feeds, albums, posts, comments, reactions, follows,
  friends, friend invitations, blocks, mutes, and persona-perspective mode.
- Backup-persona presentation, family trees, relationships, projects,
  businesses, mission pages, memberships, and public business titles.
- Page publication review, profile visibility, field visibility, social account
  display preferences, and public content disclosures.
- Fan-facing chat sessions and their owner moderation experience. AI inference
  for those sessions remains a MyPersonas service contract.
- Public affiliate offers, sponsored disclosures, review-request intake, and
  social-page revenue modules.
- Social PWA behavior, social sitemap, public navigation, and AliaSpaces product
  policies.

AliaSpaces must not store provider API keys, operate external-provider refresh
tokens, execute unattended provider publishing, or directly mutate MyPersonas
automation tables.

## Shared contracts initially owned by MyPersonas

The two repositories do not create a third shared repository during the initial
split. The following contracts remain owned and released by MyPersonas while
AliaSpaces consumes narrow, versioned interfaces:

1. **Identity and authentication** — Supabase Auth user identity, PKCE sign-in,
   MFA/AAL2, recovery decisions, staff-role assertions, and canonical account
   identifiers.
2. **Canonical persona identity** — immutable persona UUID, owner UUID, handle
   uniqueness, minimal identity projection, and lifecycle state. AliaSpaces owns
   the social presentation attached to that identity.
3. **Entitlements** — trial, paid, developer, suspended, cancelled, and deleted
   account decisions. AliaSpaces may read a fail-closed entitlement projection;
   it must not calculate billing state itself.
4. **Deletion and export orchestration** — account-wide holds, byte-first media
   erasure, provider revocation evidence, cross-product tombstones, and completion
   receipts.
5. **Media provenance** — AI-use declarations, generation events, exact-byte
   hashes, watermark policy, immutable provider renditions, and canonical public
   handles.
6. **Security and audit** — bounded error intake, operational alerts, immutable
   security events, rate-limit decisions, and incident evidence.

Shared does not mean copied and independently deployed. Each contract has one
owner, one migration authority, and one production implementation.

## Current transitional source

The substantive fused checkout is:

`C:\Users\Justice Right\Documents\GitHub\MyPersonas`

The separate AliaSpaces repository is:

`C:\Users\Justice Right\Documents\GitHub\aliaspaces.com`

At the time this contract was recorded:

- The current rescue branch was
  `rescue/pre-split-mixed-worktree-20260824` at source commit
  `21703a9252d56f155f7210affa373d7d69f07e92`.
- That commit follows `21fe42d` (quarantined migration 065), `344302b`
  (custom fields and project resources), and `21703a9` (profile-crop and mobile
  release wiring), based on local `main` commit `ad68319`.
- Local `main` and `origin/main` were divergent. A branch name or pushed commit
  is not evidence that a production deployment occurred.
- `aliaspaces.com` was a clean redirect-only Pages repository at `f546fa1`.
- The rescue branch is a preservation branch, not a production release branch.

Re-read all refs before relying on this snapshot. Never force-push, reset, or
delete a worktree because this document names an older commit.

## Frontend ownership map

| Current source | Initial owner | Extraction rule |
| --- | --- | --- |
| `MyPersonas.Online_v0/index.html` | Mixed/transitional | Split by route and capability; never copy it unchanged as the final app for both products. |
| `persona-view.js`, `persona-view.css` | AliaSpaces | Persona-perspective social navigation and interaction. |
| `profile-image-crop.js`, `profile-image-crop.css` | AliaSpaces | Social profile presentation; retain MyPersonas provenance/ingest calls through a contract. |
| `owner-app.js`, `owner-app.css` | Mixed/transitional | Move social home, fan inbox, notifications, and social activity to AliaSpaces; keep briefs, automation schedule, and automation status in MyPersonas. |
| `platform-governance.js`, `platform-governance.css` | Mixed/transitional | AliaSpaces owns publication/friend/field/page controls; MyPersonas owns staff operations, security events, billing gates, and automation audit. |
| `agent-board.js`, `agent-board.css` | MyPersonas | Private human-gated automation control. |
| `ai-content-provenance.js`, `ai-content-provenance.css` | MyPersonas shared contract | Both apps consume the same versioned disclosure/presentation rules; one canonical policy implementation. |
| `provider-setup.html` and provider setup docs | MyPersonas | Provider authentication and automation setup. |
| `privacy.html`, `terms.html`, `data-deletion.html` | Product-specific after split | Each product receives accurate policies; shared account deletion links to the canonical MyPersonas orchestrator. |
| `manifest.webmanifest`, `service-worker.js`, `pwa.js`, `offline.html` | Product-specific after split | Distinct names, scopes, caches, icons, origins, and update lifecycles. |
| `apps/workroom-bridge/**` | MyPersonas | Owner-only external-account workroom. |
| `infrastructure/aws/media-gateway/**` | MyPersonas shared contract initially | Preserve stable media URLs while AliaSpaces consumes them; do not create a second gateway. |

## Edge Function ownership map

### MyPersonas automation functions

- `agent-board-propose`, `agent-board-run`, `ai-proxy`
- `compose-post`, `approve-post-draft`, `approved-media`
- `gmail-oauth`, `mailbox-manager`, `run-mailbox-jobs`
- `meta-oauth`, `meta-post`, `twitter-oauth`
- `reddit-oauth`, `reddit-post`, `discord-post`
- `openrouter-connect`, `gemini-image`
- `import-research-brief`, `research-brief-run`
- `post-bridge`, `run-post-queue`, `run-publish-queue`, `run-tasks`
- Billing, Stripe, refund, reconciliation, Persona Source Library, and operations
  functions introduced on their feature branches.

### AliaSpaces social functions

- `affiliate-redirect`
- `request-review`
- `sitemap`
- `public-media` after its shared gateway contract is extracted and versioned
- The social session/moderation portion of `fan-chat`

### Shared or mixed functions retained by MyPersonas initially

- `delete-account`, `erase-content`
- `media-ingest`, `owner-media-preview`
- `legacy-media-remediation`
- The inference/provider portion of `fan-chat`
- Shared helpers for AAL2, provenance, approved media, public media, provider
  endpoints, mailbox behavior, and publish reconciliation

No function name may be deployed by both repositories. A later ownership
transfer requires a reviewed handoff commit, contract version, rollback plan,
and removal from the former owner's deployment allowlist before the new owner
can deploy it.

## Data ownership model

During the initial split, both applications may use the existing Supabase Auth
and database project. This avoids a simultaneous live account, MFA, billing,
media, and deletion migration. Logical ownership still applies:

- **MyPersonas/core:** accounts, canonical personas, auth/security, entitlement,
  provenance, audit, deletion, and export orchestration.
- **MyPersonas/automation:** AI backends, credentials, routes, tasks, agent
  records, research, source library, Account Ledger, provider grants, mailbox
  records, drafts, approved provider media, queues, and reconciliation.
- **AliaSpaces/social:** profile presentation, page layout, posts, albums,
  comments, reactions, friends, follows, blocks, family, projects, businesses,
  publication reviews, social chat records, offers, and review requests.

AliaSpaces receives only the columns and operations required for social
behavior. It must not use service-role credentials in the browser or query
MyPersonas credential, provider-token, billing-event, or private research tables.

## No-dual-deploy rules

1. One production database migration authority exists while the products share
   a Supabase project. Initially that authority remains MyPersonas.
2. Historical migrations are never replayed from the AliaSpaces repository.
   Their presence in MyPersonas records lineage, not current product branding.
3. A new AliaSpaces social migration may be authored in AliaSpaces, but it is
   release-candidate material until the single database authority applies its
   exact reviewed hash once. Do not keep two independently editable copies.
4. Every Edge Function appears in exactly one deployment allowlist.
5. MyPersonas Pages can deploy only the MyPersonas origin; AliaSpaces Pages can
   deploy only the AliaSpaces origin.
6. GitHub environment secrets, provider credentials, Supabase tokens, and
   signing material are never copied between repositories as source files.
7. Exact CORS origins and OAuth return URLs are configured per function. A broad
   two-domain allowlist is transitional and must not be the permanent default.
8. A commit, successful CI run, saved dashboard setting, or pushed branch is not
   deployment proof. Record deployment ID, source SHA, artifact hash, database
   readback, and live verification separately.
9. Neither repository may auto-apply a migration merely because code is merged.
   Migration-bearing releases require the protected environment and typed
   release confirmation defined by the owning runbook.
10. Production rollback never rewinds an applied migration. Use forward fixes,
    feature flags, dormant producers, and reversible routing changes.

## Domain and routing policy

- `mypersonas.online` becomes the MyPersonas automation product.
- `aliaspaces.com` becomes the AliaSpaces social product.
- Old `mypersonas.online/#/p/<handle>` and business links require a
  fragment-preserving transition because URL fragments are not sent to the
  server.
- Keep `media.mypersonas.online` stable during the first split unless a separate
  reviewed migration proves every stored reference, cache, signature, provider
  fetch, and deletion path can change safely.
- Do not reverse the current AliaSpaces-to-MyPersonas redirect until signed-in
  AliaSpaces social testing and rollback are complete.

## Change-control rule

Before modifying a mixed file, migration, or function, the author must state:

1. Which product owns the behavior.
2. Which shared contract it consumes.
3. Which repository will deploy it.
4. How the other product is prevented from deploying a duplicate.
5. What tests prove cross-product compatibility.

If those answers are unclear, the work remains on a non-deploying extraction
branch.
