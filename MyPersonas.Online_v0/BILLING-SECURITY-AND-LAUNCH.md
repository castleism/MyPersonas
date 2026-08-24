# MyPersonas account billing — security and launch runbook

Status: **local feature branch only** (`feature/account-subscriptions`). No Stripe
account, Product, Price, webhook, portal, secret, bank, tax setting, production
database, deployment, charge, subscription, or entitlement enforcement was
created or changed by this work.

## Product contract currently encoded

One owner account covers every persona it owns. The billing intervals are not
feature tiers:

| Plan code | Checkout copy | Exact recurring Price |
|---|---|---:|
| `account_weekly` | 7 days free, then $20 every 7 days | USD 20.00/week |
| `account_monthly` | 7 days free, then $50 monthly | USD 50.00/month |
| `account_yearly` | 7 days free, then $333 yearly, billed annually | USD 333.00/year |

The seven-day trial starts only after Stripe creates a verified `trialing`
subscription through Checkout. A payment method is required in hosted Checkout.
The same account UUID or the same verified, lowercased and trimmed email can
never receive a second trial. The database retains only an HMAC-SHA-256 email
fingerprint, never the raw email, in the private anti-abuse ledger.

This is literal verified-email enforcement, not proof that two addresses belong
to different people. Provider-specific alias rewriting is intentionally not
guessed: for example, plus-address variants remain different verified emails.
Rate limits, bot protection, Stripe Radar, and an approved abuse policy are still
needed before treating the trial as fraud-resistant.

`BILLING_EMAIL_FINGERPRINT_SECRET` is an anti-abuse data key, not a disposable
runtime password. Keep it in the environment secret manager and back it up
under the approved recovery process. Rotation is versioned: the current key is
required, one previous key can be staged through the dedicated pair, and any
older still-retained generations remain in the ordered retired-key secret ring.
Every newly presented verified email is checked under the complete ring, and a
same-account old-key tombstone is atomically rewritten under the current key.
Remove a retired key only after the seven-year closed-account anti-abuse
retention window has elapsed for every record it protected. Never rotate while
dropping a generation that can still match a retained consumed-trial claim.

Current lifecycle choices:

- `trialing` with a verified unexpired trial claim grants access.
- `active` grants access only while the required invoice is paid and the current
  period has not ended.
- cancellation is scheduled for the paid-period end; access remains until then.
- `past_due`, `unpaid`, `paused`, `incomplete`, `incomplete_expired`, and
  effective cancellation suspend paid capabilities immediately.
- an active AAL2 global-admin developer grant supplies free access. It is not a
  staff role and grants no maintenance authority.
- a renewable paid subscription must be scheduled to cancel before the database
  will accept a developer grant. A grant never hides continued billing.
- an open Checkout reservation or Session must expire and reconcile before a
  developer grant can be added. Every later Checkout boundary rechecks that no
  developer grant or renewable subscription appeared concurrently.
- revoking developer status never starts or resumes a charge.

When suspended, the account can still sign in, edit private data, recover billing,
export, and delete data. The MyPersonas directory is unavailable, reviewed persona
and business pages are removed from effective public projections, and AI/provider
work is halted. Reviewed publication state is preserved: an unchanged exact-
reviewed page can return after access recovery; a changed, stale, moderated, or
otherwise ineligible page cannot.

## Shadow-mode release boundary

Migration 068 installs the complete ledger and enforcement hooks with
`private.billing_runtime_config.enforcement_enabled = false` and
`checkout_enabled = false`. Shadow mode keeps existing access working. The
database—not only the browser—rejects direct Checkout invocation. This is
intentional. Applying the migration must never silently place existing users
behind a paywall or create test Stripe data in a production database.

Stripe test-mode end-to-end work must use a separate Supabase staging project.
The prepared billing browser origin for that project is the exact
`https://mypersonas-staging.pages.dev` origin. The exact
`https://staging.mypersonas.online` custom-domain origin is also allowlisted for
a later reviewed cutover; its DNS and deployment remain external release
actions. Do not substitute localhost, a `*.pages.dev` or other wildcard, a
query-supplied origin, or a production frontend, and never place production and
test provider credentials in the same project.
The deployment workflow rejects the configured production project ref for the
`billing-test-boundary` scope and requires the dispatch input to exactly match
the `BILLING_STAGING_PROJECT_REF` secret in a protected `billing-staging`
GitHub environment. The workflow binds every other deployment scope to a
separate protected `production` environment. Configure required reviewers and
use only the environment-scoped `BILLING_STAGING_SUPABASE_ACCESS_TOKEN` and
`PRODUCTION_SUPABASE_ACCESS_TOKEN`; do not provide a repository-wide fallback
token. Test and live Customer, Price, trial, and
subscription rows do not share one database ledger.
The deployment workflow pins the reviewed Supabase setup action commit and CLI
`2.115.0`; update either only through a separate changelog and workflow review.

Enforcement is a separate production change only after:

1. every existing account is classified as developer, paid, or notified grace;
2. Stripe sandbox and two-account tests pass;
3. opaque media migrations 062–064 are released and verified;
4. the owner approves seller, tax, refund, dispute, payout, and legal copy;
5. live Product/Price/webhook/portal objects and secrets are separately verified.

Do not push migration 068 to `main` merely to preview it. This repository's
installed Supabase GitHub integration has previously applied a main-branch
migration before CI completed. GitHub workflow gates cannot stop that provider
integration. Live release is blocked until automatic production migration is
disabled and schema apply is moved behind the protected, reviewed release path.

## Security architecture

- Card and wallet entry occurs only in Stripe-hosted Checkout. MyPersonas never
  receives card or bank details.
- Billing history, Stripe identifiers, trial claims, developer grants, webhook
  events, financial holds, reconciliation alerts, and access transitions are in
  the non-exposed `private` schema.
- Browsers receive only self-scoped status and AAL2 global-admin exact-account
  RPCs. The bounded financial-hold review RPC returns only an internal random
  hold UUID, account UUID, masked email, event category/type, and opened time;
  it never returns Stripe identifiers, webhook payloads, card, bank, Customer,
  Price, or payment-method data.
- Creating either a hosted Checkout or Customer Portal session requires a
  server-validated AAL2 token after a browser step-up. An email-confirmed AAL1
  session cannot create or manage a renewable membership.
- Checkout accepts one internal plan code. Amount, currency, interval, Product,
  Price, environment, origin, and redirect URLs are asserted independently in
  environment configuration, PostgreSQL, and Stripe's canonical object.
- One account is bound to one canonical Stripe Customer. Stable account and
  reservation idempotency keys, one active reservation, provider leases, and a
  `provider_pending` recovery state prevent concurrent duplicate Customers or
  Checkout Sessions and recover a lost database attach.
- The server-side Checkout kill switch is rechecked for `reserved`,
  `provider_pending`, `session_created`, Customer binding, and Session attach
  boundaries. An expired unbound `provider_pending` reservation is never expired
  from the local clock: it stays quarantined and blocks another Checkout until a
  canonically retrieved completed/expired Session or operator reconciliation
  proves the provider outcome. A delayed completed webhook can still attach the
  exact Session and subscription to that reservation.
- A Checkout return never grants access. Only verified, idempotently recorded
  Stripe webhook state can change a subscription entitlement.
- Webhook signatures are checked against the exact raw bytes with a five-minute
  timestamp tolerance before JSON parsing. Event IDs and payload digests prevent
  replay/conflict; canonical Stripe objects are retrieved before reduced scalars
  reach PostgreSQL.
- A webhook that exhausts its bounded retries is atomically moved to
  `review_required` with a critical reconciliation alert. Stripe then receives a
  terminal response instead of an infinite retry loop, while the financial event
  remains visibly unresolved for an operator.
- Refund and dispute payload scalars are not trusted. The webhook refetches the
  exact Refund/Dispute/Charge, maps its PaymentIntent through Stripe Invoice
  Payments, then retrieves the exact Invoice and Subscription. Only a complete
  canonical chain matching one locally owned Customer/subscription records exact
  Invoice/subscription evidence. If that chain becomes unprovable only after a
  canonical Charge and Customer are known, the immutable local Customer binding
  opens a more conservative account hold with nullable Invoice/subscription
  evidence; no account is inferred when even that Customer binding is absent. An
  open hold revokes every entitlement and blocks
  Checkout, developer grants, and account deletion until an AAL2 global
  administrator explicitly reconciles that exact event with a reason. A stale
  `charge.dispute.closed` event opens another review hold; event ordering or a
  provider status scalar never clears one silently.
- The runtime configuration singleton cannot be deleted or truncated. All access
  checks treat a missing singleton as enforced-but-unavailable, Checkout remains
  disabled, and public projections fail closed.
- Provider credentials and network requests are behind entitlement checks. Due
  AI work is filtered in SQL, rechecked when claimed, and checked again before
  provider access. Suspended scheduled occurrences advance without provider
  work, so reactivation does not release a catch-up backlog. Overdue tasks are
  also advanced under the account billing lock before a paid subscription or
  developer grant restores access, and claims take that same lock. Due Meta post
  drafts and native publish drafts are terminalized for explicit owner review
  under that lock instead of bursting after recovery. Research briefs, fan chat,
  mailbox classification, scheduled generation, and Agent Board provider calls
  reserve a default-deny automation budget before provider work, conservatively
  retain uncertain usage, and withhold output when exact accounting cannot be
  finalized. The mailbox AI classifier checks before Gmail access, key
  resolution, provider work, and finding persistence. Scheduled Meta/native
  publishers stop before credentials and recheck immediately before each
  provider/native mutation. Billing verification failure is fail-closed.
- Full account erasure uses the same account lock as Checkout. A UUID-only
  closure tombstone is established and rechecked before irreversible work;
  Checkout/customer/session/subscription state blocks deletion until canonical
  cleanup. Late financial events remain private, grant no access, and create a
  critical operator-review alert.
- Full erasure of a terminal subscriber establishes the closure tombstone
  before provider work, verifies the complete bounded Stripe subscription list
  is terminal, deletes the exact canonical Customer with a stable idempotency
  key, and records provider deletion before owned content is touched. Reduced
  Customer, terminal-subscription, and consumed-trial evidence is retained for
  seven years after closure; abandoned/expired Checkout rows are eligible after
  90 days and ordinary processed-event/alert/transition evidence after 400
  days. The UUID-only closure tombstone remains indefinitely for late-event
  fail-closed handling. `billing_run_retention(integer)` performs a bounded
  service-only purge and must run from an authenticated daily operations job.
- Account closure and Stripe Customer deletion are blocked while a duplicate
  cancellation, refund approval, provider refund, or manual refund review is
  unresolved. Once closure begins, a new refund approval is rejected under the
  same account lock so money-moving reconciliation cannot race erasure.
- A canonical newly detected duplicate renewable subscription on the account's
  already-bound Stripe Customer is canceled immediately without proration by
  the webhook worker before its reduced
  canceled snapshot is applied. A private `cancel_pending` intent commits
  before the provider mutation, so a lost response or a database failure after
  cancellation resumes from the canonical canceled object instead of losing
  the audit. Cancellation is idempotent. If its latest canonical invoice was
  paid, its exact net invoice total and currency are durably retained and a high
  severity refund-review alert remains open; no refund is issued silently.
- Duplicate refund approval accepts only the opaque remediation UUID and a
  10–1000 character reason from an AAL2 global administrator. Provider Customer,
  Subscription, Invoice, Invoice Payment, PaymentIntent, Charge, amount,
  currency, discounts, and tax are all resolved and refetched server-side. A
  refund is sent to the original charge for exactly the collected invoice total
  with a stable per-remediation idempotency key. Durable `refund_pending` state
  is committed before Stripe is called, and a timed-out response is recovered by
  listing and canonically matching the provider refund before any retry.
- Only a signed Refund event—or a full `charge.refunded` event containing one
  exact succeeded MyPersonas duplicate refund—can reconcile this expected
  mutation without the ordinary account-wide financial hold. Wrong metadata,
  linkage, amount, currency, multiple/partial refunds, credits, disputes, or
  failed canonical proof fall through to the fail-closed hold or the durable
  manual-review queue. Failed and canceled expected refunds never retry
  automatically.
- For an account that never reached a Stripe Customer/subscription, successful
  full deletion removes reserved trial/abandoned Checkout rows, developer-grant
  text/events, and access transitions; only the UUID-only closure tombstone is
  retained. A post-Auth finalization failure creates a durable critical alert.
- Developer grant/revoke requires an active `global_administrator` assignment,
  AAL2, exact target account, reason, optional expiry, confirmation, immutable
  billing audit, and a platform security event. Technicians cannot grant it.

The governance panel uses these bounded database RPCs:

- `billing_admin_financial_holds(p_account_id uuid default null, p_limit int
  default 100)` lists at most 200 unresolved safe summaries for an AAL2 global
  administrator.
- `billing_admin_duplicate_refund_reviews(p_limit int default 100)` lists only
  opaque remediation IDs, masked account email, state, exact minor-unit amount,
  currency, status, and timestamps. It never exposes Stripe identifiers.
- `billing_admin_approve_duplicate_refund(p_remediation_id uuid, p_reason text)`
  performs the AAL2 global-admin approval and persists the durable provider
  intent. The authenticated `billing-admin-refund-duplicate` Edge Function is
  the only approved execution path; do not call Stripe directly from a browser.
- `billing_admin_reconcile_financial_hold(p_hold_id uuid, p_reason text)` closes
  only the exact internal hold UUID, requires a 10-1000 character reason, and writes both
  the private access transition and public platform-security audit. It never
  calls Stripe or infers that a refund/dispute was resolved; the operator must
  first verify the canonical provider outcome.

Relevant primary guidance:

- [Stripe-hosted Checkout and free trials](https://docs.stripe.com/payments/checkout/free-trials)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe API key security and restricted keys](https://docs.stripe.com/keys)
- [Stripe webhook signatures and delivery](https://docs.stripe.com/webhooks)
- [Stripe Invoice Payments](https://docs.stripe.com/api/invoice-payment)
- [Supabase Stripe webhook example](https://supabase.com/docs/guides/functions/examples/stripe-webhooks)
- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)

## Test-mode configuration (do not paste secret values into this file)

Create one Stripe test Product and three test recurring Prices with the exact
amounts above. Copy identifiers only after verifying the Dashboard is in test
mode. Create a dedicated test Customer Portal configuration for invoice history,
payment-method updates, and cancellation at period end. Keep subscription
switching off. Allow only billing name and address updates; the verified account
email remains authoritative in MyPersonas and phone collection stays off. The
Portal login page must remain off so all sessions enter through the application's
AAL2 boundary. The Edge Function pins this exact configuration on every Portal
session and refetches its mutable provider settings immediately before and after
session creation; any drift fails closed. Restrict Dashboard access, require MFA,
and treat every configuration edit as a reviewed production change. Do not enable
unreviewed coupons, prorations, or refund automation.

Required Edge Function secrets:

| Secret | Purpose |
|---|---|
| `STRIPE_TEST_SECRET_KEY` | Test-mode server API key; prefer an `rk_test_` restricted key with only the reviewed Customer, Checkout Session, Portal Session and Configuration, Price, Subscription, Invoice, Invoice Payment, Charge, Refund, and Dispute permissions |
| `STRIPE_TEST_WEBHOOK_SECRET` | Signing secret for this exact test webhook endpoint |
| `STRIPE_TEST_PORTAL_CONFIGURATION_ID` | Exact dedicated test Billing Portal configuration (`bpc_...`); every Portal session pins it and verifies its current settings before and after creation |
| `STRIPE_TEST_PLANS_JSON` | Exact Product/Price/amount/currency/interval assertions for all three plans |
| `BILLING_EMAIL_FINGERPRINT_SECRET` | Random 32+ character HMAC secret, unique to this environment |
| `BILLING_EMAIL_FINGERPRINT_KEY_ID` | Non-secret stable version label for the current HMAC key, for example `k2026_08` |
| `BILLING_EMAIL_FINGERPRINT_PREVIOUS_SECRET` | Optional prior 32+ character secret used only during a controlled dual-key rotation |
| `BILLING_EMAIL_FINGERPRINT_PREVIOUS_KEY_ID` | Optional prior version label; must be supplied or removed with the prior secret |
| `BILLING_EMAIL_FINGERPRINT_RETIRED_KEYS_JSON` | Optional ordered array of older `{key_id,secret}` keys retained only in the secret manager; preserve every key that can still match a retained consumed-trial claim |
| `BILLING_APP_ORIGIN` | One exact allowlisted app origin: `https://mypersonas.online` for production, `https://mypersonas-staging.pages.dev` for the prepared isolated staging host, or `https://staging.mypersonas.online` after its reviewed custom-domain cutover |
| `BILLING_RECONCILE_SECRET` | Separate random 32+ character service secret for the read-only reconciliation probe |

`SUPABASE_URL` and the platform-supplied server credential remain function
secrets. Never place any of these in `index.html`, JavaScript, Git, a browser
field, an AI dashboard, chat, issue text, screenshots, or documentation output.

The environment JSON must use this shape (identifiers intentionally fake):

```json
{
  "account_weekly": {
    "price_id": "price_TEST_REPLACE_WEEKLY",
    "product_id": "prod_TEST_REPLACE",
    "amount": 2000,
    "currency": "usd",
    "interval": "week",
    "interval_count": 1,
    "trial_days": 7
  },
  "account_monthly": {
    "price_id": "price_TEST_REPLACE_MONTHLY",
    "product_id": "prod_TEST_REPLACE",
    "amount": 5000,
    "currency": "usd",
    "interval": "month",
    "interval_count": 1,
    "trial_days": 7
  },
  "account_yearly": {
    "price_id": "price_TEST_REPLACE_YEARLY",
    "product_id": "prod_TEST_REPLACE",
    "amount": 33300,
    "currency": "usd",
    "interval": "year",
    "interval_count": 1,
    "trial_days": 7
  }
}
```

After migration 068 is approved on a non-production project, a database owner
must bind the separately verified test Price IDs in the private catalog. Use an
approval-specific script with exact expected values; never accept browser input.

```sql
begin;
update private.billing_plan_catalog set
  stripe_price_id = case plan_code
    when 'account_weekly' then 'price_TEST_REPLACE_WEEKLY'
    when 'account_monthly' then 'price_TEST_REPLACE_MONTHLY'
    when 'account_yearly' then 'price_TEST_REPLACE_YEARLY'
  end,
  livemode = false,
  updated_at = now();
commit;
```

On that staging project only, activate enforcement and Checkout together after
the test Price bindings and Edge secrets are independently verified. The same
transaction must skip every already-due AI occurrence for accounts that will
lose preview access before it flips the gate; this closes the shadow-to-enforced
catch-up boundary:

```sql
begin;
do $activation$
declare v_account uuid;
begin
  for v_account in
    select profile.id
    from public.profiles profile
    cross join lateral public.billing_entitlement_snapshot(profile.id) snapshot
    where snapshot.source='preview'
    order by profile.id
  loop
    perform private.advance_account_ai_tasks_past_due(v_account,now());
  end loop;
end
$activation$;
update private.billing_runtime_config
set enforcement_enabled = true,
    checkout_enabled = true,
    livemode = false,
    updated_by = 'REPLACE_WITH_APPROVING_ACCOUNT_UUID'::uuid,
    updated_at = now()
where singleton
  and enforcement_enabled = false
  and checkout_enabled = false
  and livemode = false;
commit;
```

Never use this staging activation block against the configured production
project. Production activation requires a separately reviewed transition script.

Safe rollout order for each environment is: keep both gates false; apply migration
068; deploy and type-check Checkout, Portal, webhook, reconciliation, deletion,
AI, mailbox, scheduled-task, post-queue, and native-publish consumers; verify the
frontend build and test matrix; only then run the separate activation transaction.
This avoids enabling financial creation while an older consumer can bypass a new
entitlement boundary. A failed consumer deployment leaves Checkout disabled.

The legacy opaque-media deployment scopes now require combined migration-068
shadow evidence because they contain billing-aware `run-post-queue`,
`delete-account`, or `gemini-image` code. The Pages workflow likewise requires
both opaque-foundation and billing-shadow readback before it can ship the
membership assets. Do not weaken these combined confirmations to release one
roadmap slice independently.

The webhook endpoint is the deployed `stripe-webhook` function. Create it with
the same pinned `2026-02-25.clover` API version used by the server requests and
subscribe only to the reviewed Checkout, subscription, and invoice lifecycle
event set plus the reviewed Charge, Refund, and Dispute financial-review events.
The
webhook endpoint has gateway JWT verification off because Stripe signs the raw
request; Checkout and Portal keep gateway JWT verification on and then reverify
the user and confirmed email with Supabase Auth.

## Required sandbox test matrix

- test-clock trial creation, trial end, weekly/monthly/yearly conversion and
  renewal;
- payment method required; 3DS/SCA action, failure, recovery and expiration;
- cancellation during trial and cancellation at paid-period end;
- immediate `past_due` suspension and recovery after `invoice.paid`;
- duplicate, modified, old, out-of-order and conflicting webhook events;
- canonically linked full and partial refunds, refund failure/update, dispute
  creation/update/closure, unknown-Customer events, exact-subscription holds,
  Customer-binding fallback holds, and AAL2 global-admin reconciliation by the
  internal hold UUID only;
- completed-but-unreconciled Checkout, duplicate renewable subscription,
  expired-Session idempotency, and consumed-trial rebinding attempts;
- unknown Product/Price, wrong amount/currency/interval and test/live crossover;
- same account, changed email, deleted/recreated account and same-email trial
  replay/concurrency attempts;
- concurrent Checkout, account erasure, Customer creation, lost Session attach,
  canonical Session expiration, late completion, and webhook delivery;
- Checkout kill-switch changes during `provider_pending` and Session attach;
  developer-grant attempts during every active Checkout state;
- ordinary user, technician and AAL1 admin denied developer changes; AAL2 global
  admin grant/revoke audited; active renewal blocks a free grant;
- paid owner, suspended owner, developer owner and unrelated viewer across
  directory, exact public link, persona/business publication, friend/follow,
  AI chat, scheduled generation, research, image generation and Agent Board;
- suspended scheduled mailbox, Meta and native publication jobs, including an
  entitlement change immediately before every provider/native write and no
  stale-burst publication after recovery;
- status/Checkout/Portal on desktop and signed-in mobile, including account
  switching, AAL2 enrollment/step-up/recovery, stale requests, keyboard access,
  cancel return and recovery;
- logs contain no secret, raw webhook payload, email fingerprint, card data, or
  private Stripe identifier;
- daily read-only reconciliation, alert routing, backup and recovery.

Stripe [test clocks](https://docs.stripe.com/billing/testing/test-clocks) should
be used for lifecycle tests. A real card or live mode is not needed for this phase.

## Live merchant, bank and legal gate

Bank routing is **not needed for coding or sandbox testing**. It is needed after
the complete sandbox matrix passes and before the first live payment is accepted.
Enter it only in the legal account owner's Stripe Dashboard payout settings,
with account-owner MFA—never in MyPersonas, Supabase, source control, chat, or an
AI service. Stripe documents payout account setup and schedules in its
[payout guide](https://docs.stripe.com/payouts).

Before live activation, approve and record:

- legal seller/entity, seller country, beneficial-owner verification and support
  contact;
- statement descriptor, receipt sender and trial-ending/failed-payment emails;
- Terms, Privacy, recurring-charge consent, exact first-charge date/cadence,
  cancellation, refund, partial annual refund, dispute and chargeback policy;
- tax registrations, whether prices display tax-inclusive or tax-exclusive, and
  whether Stripe Tax is enabled;
- card/wallet payment methods, fraud/Radar rules, CAPTCHA/WAF/rate limits and
  alert destinations;
- trial-data and financial-record retention/deletion exceptions;
- hard hosted-AI request/token/concurrency limits for trials, paid accounts and
  developer accounts. The listed prices do not safely support unlimited hosted AI.

Online trial-to-paid conversion is a recurring/negative-option transaction. The
checkout must present material recurring terms next to consent, record consent,
and provide simple cancellation. Obtain seller-specific legal and tax review
before broad sales; this runbook is an engineering control, not legal advice.

## Known release blockers

- Migrations 062–064 must reach production before suspension can revoke opaque
  public media. Already-known legacy public Storage URLs cannot be recalled by
  hiding a database page alone.
- Dirty local migrations 065–067 are not approved release prerequisites and
  must not be accidentally bundled with billing.
- Invoice lifecycle, refund/dispute policy, subscriber account-deletion cleanup,
  email notifications, tax behavior, AI quotas and signed-in two-account/mobile
  evidence must be closed before live activation.
- The Customer-deletion, seven-year closed financial/trial retention,
  90-day abandoned-Checkout purge, 400-day operational purge, retained-key-ring rotation,
  and provider duplicate-cancellation code is implemented and locally tested.
  It remains inactive until migration 068/functions are deployed to staging,
  Stripe grants the exact reviewed Customer/subscription DELETE permissions,
  and a protected daily service job invokes `billing_run_retention`.
- Duplicate cancellation deliberately does not auto-refund a paid duplicate
  invoice. The AAL2 operator must explicitly approve its opaque review record;
  the service then refetches and proves the exact provider chain before issuing
  the full tax-inclusive net refund to the original payment method. Stripe test
  permissions and signed webhook reconciliation still require staging evidence.
- A duplicate on an unbound or mismatched Customer remains quarantined for
  manual provider review; metadata alone is not sufficient authority for an
  automatic destructive provider action.
- `billing-reconcile` writes only bounded monitoring timestamps/results and
  durable drift/unavailable alerts. It does not synthesize events, mutate money,
  or repair entitlement state silently.
- A hard mailbox-worker crash after the classifier provider responds but before
  budget finalization keeps the conservative reservation charged, but a later
  scan can classify that page again. A durable per-page provider-start lifecycle
  and reconciliation RPC are still required before this can be called exactly
  once.
- Application-side entitlement checks narrow cancellation races around research,
  Agent Board, mailbox, and fan-chat result writes. Full transaction-level
  atomicity requires those mutation RPCs to take the common account billing lock
  and recheck entitlement in the same database transaction.
- Every selected AI backend needs an explicitly enabled `automation` budget
  policy with hard request/token/concurrency ceilings. Missing policy is
  intentionally default-deny rather than unlimited provider spend.
- Production enforcement remains disabled until a separate owner-approved SQL
  activation records the actor and exact existing-account transition plan.

## Evidence commands

Run from the repository root with the bundled runtime where needed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-account-subscription-sql.ps1
npm test
npm run test:secrets
```

CI must also type-check every Edge Function, run secret scanning, compare the
canonical/timestamped migration bytes, package the exact reviewed frontend, and
prove the deployed function configuration before any release claim.

For a credential-free responsive review of the suspended-account membership
panel, serve the repository root locally and open
`tests/fixtures/billing-visual.html`. It uses inert stubs, creates no Checkout,
and contains no account or processor data.
