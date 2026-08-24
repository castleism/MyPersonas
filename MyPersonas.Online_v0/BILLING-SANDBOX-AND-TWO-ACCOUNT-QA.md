# Billing sandbox and signed-in two-account QA

Status: executable local harness and operator procedure. Running unit tests does
not produce Stripe, mobile, privacy, or release evidence. Provider and signed-in
steps must run only against the separate protected staging project in Stripe
test mode.

The prepared staging frontend origin is the exact
`https://mypersonas-staging.pages.dev` URL. The exact
`https://staging.mypersonas.online` URL is reserved for a later reviewed custom
domain cutover; its DNS and frontend deployment remain external actions. The
billing functions deliberately reject localhost, `*.pages.dev` and all other
wildcards, query-supplied origins, the production frontend paired with staging,
and a staging frontend paired with production credentials.

## What the harness proves

`tests/fixtures/billing-sandbox-lifecycle-matrix.json` is the release inventory.
It currently contains 70 required cases covering configuration, all three plans,
payment failures, webhook order/replay, refunds/disputes, races, developer grants,
entitlements, mobile sessions, unrelated-account privacy, deletion, retention,
reconciliation, backup, and key rotation.

`scripts/billing-sandbox-matrix.mjs` makes that inventory executable:

- `list` prints the current case inventory;
- `init` creates an ignored, redacted evidence template;
- `preflight` retrieves and validates the canonical Stripe test Prices, Product,
  staging webhook endpoint, and exact event allowlist without printing ids or
  secrets;
- `summary` validates partial evidence and shows the honest result counts; and
- `verify` exits nonzero until every case passes with timestamped, hashed,
  redacted evidence. A failure, blocked case, missing case, placeholder, email,
  phone, UUID, token, key, or provider id makes verification fail.

The harness does not manufacture a pass. It validates evidence; it does not
replace the physical-device, browser, Stripe, Supabase, or operator action that
creates that evidence.

## Exact accounts required

Use disposable, verified staging identities. Do not use the founder's primary
account, production email aliases, production MFA recovery factors, or live
Customer records.

| Alias | Required state | Purpose |
|---|---|---|
| `owner-a` | ordinary owner, TOTP enrolled, no staff/developer role | weekly trial/renewal and owner-A surface |
| `owner-monthly` | ordinary owner, TOTP enrolled | monthly trial/renewal |
| `owner-yearly` | ordinary owner, TOTP enrolled | yearly trial/renewal |
| `viewer-b` | unrelated ordinary account, TOTP enrolled, no shared friend/family/business/project/account link | cross-account privacy and denial |
| `technician` | active technician only, TOTP enrolled | staff-role denial |
| `global-admin` | global administrator, TOTP enrolled | developer/hold operations; never reuse as owner-A or viewer-B |
| `deletion-fixture` | disposable owner with no real content | same-email replay and billed/unbilled deletion drills |

Each account that consumes a real test trial needs its own verified address.
Supabase Auth normally prevents two simultaneous users with the same email, so
same-fingerprint concurrency belongs in the isolated SQL harness, not in a fake
two-email browser setup. The deleted/recreated case uses the same approved
disposable address sequentially after the first account's cleanup completes.

Before testing, confirm `viewer-b` is unrelated to every disposable owner at the database level:
no friendship, follow, family relationship, backup relationship, business role,
project membership, authenticated connection, staff assignment, developer grant,
or shared owner account. Record only the aliases above in evidence, never their
email addresses or UUIDs.

## Exact devices and sessions required

Release evidence needs all of the following:

1. Desktop Edge or Chrome in two isolated browser profiles.
2. A physical iPhone or iPad running Safari.
3. A physical Android phone or tablet running Chrome.
4. Two concurrent signed-in sessions: owner-A in one isolated profile/device and
   viewer-B in another. Responsive desktop emulation is useful supplemental QA,
   but it is not physical mobile evidence.
5. Access to the staging site's browser network panel on desktop and a way to
   capture redacted mobile screenshots. Never capture TOTP QR codes, recovery
   codes, addresses, payment values beyond the approved prices, or provider ids.

At minimum record OS/browser versions, physical versus emulated, viewport,
orientation, network condition, and whether a service worker was active. Test
portrait and landscape, software-keyboard open/closed, 200 percent zoom, and a
throttled request during account switch.

## Stage 1 — local contract tests

From the repository root:

```powershell
npm run test:billing-matrix
npm run test:billing-sql
npm test
```

These prove static/SQL contracts only. They do not close any provider or browser
case in the evidence file.

## Stage 2 — provider preflight

Run preflight only inside the protected `supabase-staging` environment. Supply
these values through its secret manager, not command arguments, shell history,
chat, screenshots, or committed files:

- `BILLING_STAGING_PROJECT_REF`
- `BILLING_STAGING_SUPABASE_URL`
- `BILLING_STAGING_APP_ORIGIN`
- `STRIPE_TEST_SECRET_KEY`
- `STRIPE_TEST_PORTAL_CONFIGURATION_ID`
- `STRIPE_TEST_PLANS_JSON`

Then run:

```powershell
npm run billing:matrix -- preflight
```

The command refuses the known production Supabase ref, a production app origin,
a live key, a non-test Stripe object, a mismatched amount/currency/interval,
multiple Products, Portal settings that drift from the reviewed contract, or a
webhook event set that is broader or narrower than the application parser. The safe output
contains booleans, counts, and only the last six project-ref characters.

The webhook key must have read access to webhook endpoint configuration. If the
application's restricted runtime key intentionally lacks that permission, inject
a separate short-lived test configuration key into this one protected job. Do
not broaden the long-lived application key merely to make the preflight pass.

## Stage 3 — create clock-backed disposable Customers

There is a real sequencing constraint: Stripe test clocks are attached when a
Customer is created, while the normal Checkout function creates its own
Customer. Therefore the weekly/monthly/yearly clock cases need a disposable
staging account prebound to a clock-backed test Customer before that account
opens hosted Checkout.

`scripts/billing-test-clock-fixture.mjs` performs that narrow fixture operation.
It creates a Stripe test clock and test Customer with exact `account_id`
metadata, invokes the service-only `billing_bind_customer` RPC, and writes the
provider ids only to a private file below ignored `outputs/`. It never prints
those ids or credentials.

Provide these through the protected staging runner:

- `BILLING_STAGING_PROJECT_REF`
- `BILLING_STAGING_SUPABASE_URL`
- `BILLING_STAGING_SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_TEST_SECRET_KEY` with test-clock and test-Customer permissions
- `BILLING_TEST_ACCOUNT_ID` for one approved disposable account

Create one fixture per plan account:

```powershell
npm run billing:test-clock -- create --alias weekly-fixture --confirm-staging-test-clock-customer
npm run billing:test-clock -- create --alias monthly-fixture --confirm-staging-test-clock-customer
npm run billing:test-clock -- create --alias yearly-fixture --confirm-staging-test-clock-customer
```

The helper will not run against production, a live key, a mismatched Supabase
URL, or without the exact confirmation flag. The state files are operational
secrets-by-context: do not commit, attach, screenshot, or copy them into evidence.
Use only disposable accounts because binding is durable.

After the corresponding owner finishes hosted Checkout, advance one clock at a
time by an exact ISO-8601 UTC instant. For example, to advance seven days from
the current UTC time in a newly created fixture:

```powershell
$billingClockTargetUtc = (Get-Date).ToUniversalTime().AddDays(7).ToString("yyyy-MM-ddTHH:mm:ssZ")
npm run billing:test-clock -- advance --alias weekly-fixture --to $billingClockTargetUtc --confirm-advance-test-clock
```

Stripe limits one advance based on the shortest subscription interval. Advance
to trial end, wait for `ready` and webhook convergence, record redacted state,
then advance one renewal interval. Never jump the three clocks together; that
makes webhook ordering and alert evidence ambiguous. The helper waits at most 45
seconds per advance and fails rather than claiming completion while Stripe still
reports `advancing`.

For the seven-day trial evidence, advance first to the trial-will-end boundary,
record the webhook result, then to trial end, wait for convergence, and only then
advance one complete renewal interval. Use the clock's recorded frozen time as
the authority; the PowerShell calculation above is an example for a fresh
fixture, not a substitute for reading that timeline.

Use the approved billed-account deletion/retention workflow for cleanup. Do not
manually delete provider objects while trying to prove that workflow.

Primary Stripe references: [create a test clock](https://docs.stripe.com/api/test_clocks/create),
[advance a test clock](https://docs.stripe.com/api/test_clocks/advance), and
[test subscriptions with clocks](https://docs.stripe.com/billing/testing/test-clocks).

## Stage 4 — execute the lifecycle matrix

Create the evidence template with a nonidentifying run alias, the staging app
origin, and only the last 6–12 characters of the staging project ref:

```powershell
npm run billing:matrix -- init outputs/billing-sandbox-evidence.json --origin https://STAGING_ORIGIN --project-ref-suffix STG123 --run-id weekend-release-qa
```

Use `npm run billing:matrix -- list` or `--area AREA` as the operator queue.
Run cases in this order so later evidence depends on known-good foundations:

1. `CFG-*` — separate environment, exact Prices/Product/webhook/Portal.
2. `PLAN-*` and `PAY-*` — three clocks, payment method, SCA, failures,
   cancellation, past-due and recovery.
3. `HOOK-*` — duplicate, digest conflict, old/out-of-order, invalid signature,
   unsupported event, and retry exhaustion.
4. `FIN-*` — first prove the bounded refund-review list exposes only an opaque
   remediation UUID, masked email, workflow state, exact amount/currency, and
   timestamps. Prove that technicians and AAL1 administrators cannot list or
   approve cases. Then approve a canonically proven duplicate using the exact
   typed amount/currency, a substantive reason, explicit acknowledgement, and an
   AAL2 global-admin session. Verify the exact discounted and tax-inclusive net
   amount returns to the original payment method; exercise lost-response
   idempotent retry; and reconcile signed success, pending, failed, ambiguous,
   stale, and replayed webhooks. Also cover unrelated refunds, disputes,
   ownership fallback, and exact AAL2 hold reconciliation. Generic
   reconciliation never means that MyPersonas issued a refund or resolved a
   dispute.
5. `RACE-*`, `TRIAL-*`, `DEV-*` — one fault at a time in disposable fixtures.
6. `ENT-*` — observe provider-call counters as well as browser copy; a hidden
   button alone is not enforcement evidence.
7. `MOB-*` and `PRIV-*` — physical mobile and unrelated accounts.
8. `DEL-*` and `OPS-*` — cleanup, retention, reconciliation, alerts, restore and
   retained-key-ring rotation.

For each case record:

- `status`: `pass`, `fail`, or `blocked`;
- an ISO-8601 UTC `executedAt`;
- a nonidentifying `testerAlias`;
- every actor alias and device class required by that matrix case;
- a substantive redacted observation; and
- at least one relative artifact path plus its lowercase SHA-256 digest.

Keep artifacts below ignored `outputs/`. A screenshot or log summary is not safe
merely because it is ignored: redact before hashing. Do not record raw email,
phone, UUID, access/refresh token, service key, webhook secret, Stripe object id,
raw webhook body, card data, private media URL, or local absolute path.

Check progress and final completion:

```powershell
npm run billing:matrix -- summary outputs/billing-sandbox-evidence.json
npm run billing:matrix -- verify outputs/billing-sandbox-evidence.json
```

Only the second command exiting zero means the defined matrix is complete. It is
still staging evidence, not authorization to enable production billing.

## Two-account privacy script

Seed owner-A with unique, unmistakable canary text in every private surface:
persona draft, business draft, family relationship, backup relationship, custom
field box, project/group membership, authenticated account inventory, private
social handle, sync filter, unpublished media, owner preview, AI draft, billing
status and export. Canary text must contain no real personal data.

For each surface:

1. Confirm owner-A can read and, where intended, edit it after AAL2.
2. Copy only the route shape—not secret URLs or tokens—to the test worksheet.
3. As viewer-B, try normal navigation, a copied exact route, direct REST request,
   reload, back/forward, a second tab and a throttled response.
4. Log owner-A out on a primed browser, use offline/back/reload, then sign in as
   viewer-B in the same profile.
5. Inspect response bodies, DOM, image requests, cache/service-worker entries,
   download names, counts, disabled controls and error timing. An empty UI with a
   leaking JSON response is a failure.
6. For public data, verify only the explicitly public revision/handle is visible.
   A private row's existence, stable owner UUID, authenticated connection, sync
   preference or unpublished asset must not be inferable.
7. Archive/revoke the asset and repeat from viewer-B and anonymous sessions.
8. Repeat the critical paths on physical iOS Safari and Android Chrome.

Fail immediately and preserve a redacted artifact if any owner canary, stable
owner UUID, provider id, private URL, private count, authenticated connection,
cached byte, or cross-account stale response appears. Do not continue filling
the matrix as though a later pass erases the exposure; fix, rotate affected URLs
or sessions if needed, and rerun the complete impacted area.

## Release interpretation

- Unit/SQL pass: code contract only.
- Provider preflight pass: exact current Stripe test configuration only.
- Matrix `summary`: honest partial state.
- Matrix `verify` pass: complete redacted staging evidence for this matrix
  version.
- Production-ready: still requires a reviewed production configuration, legal
  and tax decisions, live merchant verification, protected deployment approval,
  and an explicit production activation. None is implied by this document.
