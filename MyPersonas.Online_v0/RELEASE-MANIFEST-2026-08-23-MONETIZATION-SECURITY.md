# Monetization, security, and staging release handoff — 2026-08-23

Status: **validated local release candidate; not pushed, applied, deployed, or
provider-configured.** The working branch is
`release/monetization-security-integration`. The runtime code validated in this
manifest ends at `173e365`; the later commit that refreshes this validation
record is documentation only.

The current remote `main` observed during this release remains
`569f0029c0ddd95b7fcf09e497a1b2d629b09591`. A fresh response from
`https://mypersonas.online/` still did not reference `billing.js`. That is why
the locally completed billing, refund, staging, and security work is not visible
on the public site.

No Stripe Product, Price, Customer, subscription, refund, portal, webhook,
secret, bank destination, tax setting, or live charge was created or changed.
No Supabase project or key, GitHub environment or ruleset, Cloudflare widget or
zone, WAF rule, SMTP credential, DNS record, production migration, deployment,
publication, or paid cloud resource was created or changed.

## Release-state ledger

| Workstream | Local implementation | Disposable/local validation | External or live state |
|---|---|---|---|
| Intentional pricing and cancellation policy | Complete: USD 20/week, USD 50/month, USD 333/year; same features; monthly/yearly interval discounts; coupons off; seven-day verified-email trial; period-end cancellation without automatic proration | Passed | No Stripe objects exist from this release |
| Developer access | Complete: AAL2 global administrator only; renewable billing must be scheduled to cancel first; grant/revoke never changes provider billing | Passed | No account grant was changed |
| Duplicate-subscription cancellation and refunds | Complete: canonical duplicate detection, immediate non-prorating cancellation, durable recovery, opaque AAL2 refund review, exact original-method refund, idempotent retry, signed-event reconciliation, accessible owner UI | Passed | No provider duplicate was remediated and no refund was sent |
| Customer deletion and retention | Complete: terminal-subscription inventory, canonical Customer deletion before content erasure, closure tombstone, bounded 90-day/400-day/seven-year retention classes and daily purge worker | Passed | Real Stripe deletion and scheduled retention job remain untested/unconfigured |
| Trial-fingerprint rotation | Complete: current, previous, and ordered retired key ring with same-account rekeying and no raw-email storage | Passed | Provider secret values and a recovery/rotation drill remain unconfigured |
| Opaque media 062–064 | Complete forward-only release, protected origins, public and approved opaque handles, private legacy inventory/preview, cutover/finalizer gates | Six migration/order paths passed, including 062, 063, 064 and combined release | Not applied; public Storage remains the primary production release blocker |
| Billing 068 | Complete in mandatory shadow mode with `enforcement_enabled=false`, `checkout_enabled=false`, and no Price bindings | Migration/reapply/runtime passed | Not applied; no paywall is active |
| Operations 069 | Complete: redacted AAL2 staff inbox, bounded retention, 36-hour maintenance heartbeat, `CRON_SECRET` worker | Migration before/after billing and combined release passed | Not applied; worker schedule and delivery destinations are not configured |
| Staging bootstrap | Complete guarded capture/validate/apply/readback path; release accepts 062–064 then 068/069 and rejects 065–067 | Combined staging harness passed | Separate Supabase and Pages staging projects do not exist from this release |
| GitHub release protection | Workflows split by staging/production, credentials environment-scoped, actions/tooling pinned, production CAPTCHA key injected only during packaging | Workflow contracts, YAML lint, shell syntax and repository tests passed | Environments, reviewers, branch/ruleset protection and secrets are not configured in GitHub |
| CAPTCHA, Auth limiting, WAF and SMTP | Frontend/Auth token path, fail-closed public intake, protected packaging, runbook and release scopes complete | Source and adversarial tests passed | Turnstile, Supabase Auth settings, SMTP, WAF/DNS and alert routing are not configured |
| Stripe lifecycle QA | Versioned 70-case fail-closed matrix, evidence schema, test-clock helper and provider preflight complete | Runner and evidence validator passed | No staging provider evidence exists; matrix is not 70/70 |
| Signed-in mobile and two-account privacy | Exact test script covers entitlement, private rows, media, social handles, stale responses, cache/logout, preview/download and AAL2 | Billing/refund UI rendered at 1280×720 and 390×844 without horizontal overflow | Unrelated-account staging runs and physical iOS Safari/Android Chrome remain required |

## Validation record

The final local validation performed after integration was:

- 459 of 459 Node tests passed;
- credential scan passed for 694 tracked and untracked candidate files plus the
  complete reachable Git history (more than 1,200 blobs) without printing raw
  matches or filenames;
- frontend JavaScript and the production inline-script extraction parsed;
- Deno 2.9.5 `check --frozen` passed for all 39 Edge Function entrypoints;
- all six disposable PostgreSQL 16 harnesses exited zero: opaque public 062,
  approved media 063, legacy remediation 064, billing 068, operations 069, and
  the exact staging sequence 062–064 plus 068/069 while rejecting 065–067;
- GitHub workflow YAML lint, deploy-shell parse, and `git diff --check` passed;
- desktop and narrow-mobile billing/refund fixture checks found no horizontal
  overflow or off-screen interactive controls; and
- the matrix runner inventories exactly 70 required provider, lifecycle,
  race, trial, entitlement, mobile, privacy, deletion, retention and operations
  cases. This last item is coverage definition, not provider execution evidence.

## Required protected GitHub configuration

Before any migration-bearing branch can reach `main`:

1. Disable or replace the installed Supabase GitHub integration that can apply
   migrations automatically from `main`. GitHub review cannot contain that
   provider-side path.
2. Create `supabase-staging`, `github-pages`, and `production` environments.
   Require a trusted reviewer other than the deployment initiator and enable
   prevention of self-review. Do not weaken this to accommodate a one-person
   reviewer list; obtain a second trusted GitHub account or team first.
3. Store staging and production values only in their matching environment. Do
   not add a repository-wide Supabase access token, Stripe key, Turnstile secret,
   SMTP credential, media-origin secret, or cron secret.
4. Protect `main` and the release path with pull-request review and these six
   exact CI job names:
   - `Unit tests (pure helpers)`
   - `Deno type-check edge functions`
   - `Billing migration runtime contract`
   - `Opaque media and operations migration runtime contracts`
   - `Repository credential scan`
   - `Frontend script syntax`
5. Confirm the repository plan supports the required environment-review
   behavior for a private repository. If it does not, upgrade the plan or keep
   the deployment manual and external; do not pretend an unavailable rule is
   active.

## Exact staging release order

1. Create a separate Supabase project and a separate noindex Pages preview.
   Enter its database password and all secrets directly in the provider UI or
   protected environment; never copy them into chat, Git, screenshots, command
   arguments, or evidence.
2. Capture and validate the production schema-only baseline through migration
   061. Restore only into a fresh empty staging project; do not copy production
   users, Storage objects, Vault values, provider rows, or personal content.
3. Apply 062. Configure and irreversibly lock the exact staging Supabase origin
   and staging media origin. Read back the lock and browser-role denials.
4. Apply and verify 063, then 064. Exercise real staging Storage bytes and the
   private legacy preview with two unrelated AAL2 owners.
5. Apply 068 in shadow mode, then 069. Read back that billing enforcement and
   Checkout remain false, every Price binding remains null, the staff inbox is
   redacted, and no operations scheduler was silently installed. Migrations
   065–067 are explicitly outside this release and must remain excluded.
6. Deploy only the reviewed staging function scopes, in order: opaque
   foundation, staging intake pilot, producers, billing test boundary,
   entitlement consumers, public intake, and operations maintenance. Each scope
   has a distinct exact confirmation string; do not use a broad all-functions
   deployment. Before the first browser-facing scope, set
   `MYPERSONAS_DEPLOYMENT_ENVIRONMENT=staging` and
   `MYPERSONAS_STAGING_PROJECT_REF` to the exact protected staging ref. Injected
   `SUPABASE_URL` must equal `https://<that-ref>.supabase.co`; otherwise the
   shared boundary fails closed. Retain evidence that only
   `https://mypersonas-staging.pages.dev` and
   `https://staging.mypersonas.online` pass, while production, wildcard, `null`,
   missing, and other origins are denied.
7. Configure Turnstile, Supabase Auth rate limits, custom SMTP, and redacted
   alert delivery in staging. Prove token replay/hostname failures, bounded 429
   responses, mail alignment/bounces, heartbeat staleness and retention batches.
8. In Stripe test mode, rotate the previously exposed sandbox secret before use.
   Create one Product, the three exact recurring Prices, a dedicated restricted
   server key, exact webhook/event allowlist, and a dedicated Customer Portal
   configuration with period-end cancellation, no plan switching, no coupons,
   and no portal-login bypass. Keep every identifier in protected staging
   configuration and run the provider preflight before Checkout is enabled.
9. Execute the complete 70-case matrix with redacted hashed artifacts. Include
   test clocks for all intervals, SCA and failed payments, webhook reorder and
   replay, cancellation, refunds/disputes, duplicate cancellation/refund,
   deletion, retention, trial-key rotation, provider outages and races.
10. Run the unrelated-account script in two isolated browser profiles, then
    repeat critical paths on physical iOS Safari and Android Chrome. A UI-only
    pass is insufficient: inspect responses, private object requests, caches,
    service worker state, downloads, counts and stale account responses.

Only `billing:matrix -- verify` exiting zero against the complete redacted
staging evidence means the defined sandbox matrix is complete. It still does
not authorize production billing.

## Production boundary

Opaque media remains first. Production 062–064 requires its protected gateway,
matching origin secret, WAF/rate controls, exact byte and revocation tests,
legacy cleanup, owner publication approvals, two-account privacy evidence and
private-bucket finalization. Rich public media widgets must remain disabled
until stable owner UUID paths are no longer exposed.

Production billing is a later, separate change. It requires live merchant and
tax configuration, legal/refund/dispute copy, payout destination, live Product,
Prices, webhook, Portal and restricted key, existing-account classification,
notification/grace policy, recovery drills, staging matrix 70/70, and a new
explicit activation approval. Bank and identity details must be entered by the
owner directly in Stripe; they must never pass through this repository or chat.

Turnstile can be staged without a DNS move. A site-wide Cloudflare WAF requires
traffic to traverse Cloudflare, which under the current Wix-authoritative DNS
means a separately reviewed full-zone/nameserver cutover or an appropriate paid
partial-setup plan. No nameserver or DNS cutover belongs in the staging release.

The AWS opaque-media gateway remains review-only until the owner approves a hard
monthly spending ceiling, an alert threshold, and an alert recipient. The
planning baseline in the current runbook is approximately USD 11/month plus
usage; it is not a quote or authorization to spend.

## Owner inputs still required

- action-time approval before creating or saving provider resources/settings;
- a second trusted GitHub reviewer account or team;
- direct entry of staging database, API, webhook, SMTP, Turnstile, cron, media
  origin and Stripe secrets, including rotation of the exposed Stripe test key;
- a transactional SMTP provider/sending-subdomain choice and control of the DNS
  records it supplies;
- two disposable unrelated test identities, separate MFA enrollment and access
  to physical iOS Safari and Android Chrome;
- an AWS hard monthly ceiling, alert threshold and recipient if that gateway is
  approved; and
- later production decisions for merchant identity, tax, payout bank, support,
  grace, refund/dispute handling and individual page publication.

The detailed implementation and evidence contracts remain in
`BILLING-SECURITY-AND-LAUNCH.md`,
`BILLING-SANDBOX-AND-TWO-ACCOUNT-QA.md`,
`DNS-WAF-SMTP-RELEASE-PLAN.md`, and
`RELEASE-MANIFEST-2026-08-23-OPAQUE-MEDIA.md`.
