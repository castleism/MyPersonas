# MyPersonas monetization model — review brief

**Status:** source-backed proposal and implementation checkpoint. This document
is not a price publication, forecast, legal approval, Stripe configuration,
bank instruction, or authorization to charge anyone.

## Current owner-directed account contract

One account covers all personas owned by that account. The intervals are not
feature tiers.

| Interval | Customer-facing price | Annualized cash cost |
|---|---:|---:|
| Weekly | 7 days free, then $20 every 7 days | $1,040 |
| Monthly | 7 days free, then $50 each month | $600 |
| Yearly | 7 days free, then $333 each year | $333 |

The discounts are intentionally material: monthly is about 42.3% below paying
weekly for 52 weeks; yearly is 44.5% below twelve monthly payments and about
68.0% below 52 weekly payments. Checkout and pricing pages must show the exact
billing frequency, post-trial charge, renewal behavior, and total clearly so
the discount does not become confusing or misleading.

The older six-year portfolio draft proposed free / $9 / $29 / $99 monthly
persona tiers. That is a planning artifact, not the current implementation
contract, and must not be mixed into checkout or financial projections unless
the owner deliberately reopens pricing.

## Entitlement behavior already specified

- Trial access begins only after a verified Stripe `trialing` subscription is
  created in hosted Checkout with a payment method.
- One account UUID or the same verified normalized email receives at most one
  trial, enforced with a versioned HMAC fingerprint rather than stored raw
  email.
- `trialing` and paid-current `active` states grant paid capabilities.
- Cancellation takes effect at the paid-period end; access remains until then.
- Past-due, unpaid, paused, incomplete, expired, or effective cancellation
  suspends paid capabilities.
- Suspended accounts retain sign-in, private editing, billing recovery, export,
  and deletion. Search/discovery is unavailable, effective public projections
  disappear, and AI/provider automation halts.
- Recovery must not silently republish stale or changed pages or restart
  external posting.
- AAL2 global administrators may grant developer status only after renewable
  billing is scheduled to stop and open Checkout state has reconciled.

The implementation source remains the local `feature/account-subscriptions`
branch and its `BILLING-SECURITY-AND-LAUNCH.md`. No live Stripe object, secret,
bank route, production enforcement, subscription, or charge is evidenced by
this brief.

## Recommended launch order

1. Create a separate Supabase staging project and protected `billing-staging`
   GitHub environment with required reviewers.
2. Create test-mode Stripe Product/Prices, Checkout, customer portal, and a
   restricted webhook for the staging origin only.
3. Run the complete lifecycle, duplicate-subscription, cancellation, refund,
   developer-grant, trial-abuse, and two-account privacy matrices.
4. Release and verify opaque media migrations 062–064 before entitlement-driven
   unpublication can expose or correlate storage ownership.
5. Approve seller/entity, tax, refund/dispute, payout, retention, customer copy,
   and recovery policy.
6. Classify every existing account as developer, paid, or notified grace.
7. Only then create and verify live Stripe objects and bank payout routing under
   owner MFA, followed by a separately approved enforcement release.

## Measures that should precede growth claims

Track verified activated trials, trial-to-paid conversion, voluntary and failed-
payment churn, refund/chargeback rate, compute cost per paid account, support
load, and paid retention by interval. Do not convert the portfolio's proposed
revenue ranges into forecasts until real cohorts exist.
