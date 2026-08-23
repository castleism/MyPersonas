# Security and access runbook

Updated 2026-08-23. This is the minimum takeover contract for programmers, agents, and account operators.

## Identity and authentication truth

- MyPersonas currently supports email/password, magic-link, and Google social/federated sign-in.
- Google sign-in is not enterprise SSO and does not create one session across OpenAI, Anthropic, cloud consoles, payment systems, or social providers.
- Enrollment alone is not MFA enforcement. The app's TOTP post-login challenge,
  private-data hold at AAL1, and the current owner's AAL2 completion are now verified in
  production. Recovery policy, factor-loss
  exercise, unrelated-account coverage, and real-phone proof remain open.
- Supabase SAML SSO and several providers' organization SSO features may require paid plans. Trial status must never be documented as full SSO.

## Production Auth and abuse-control checkpoint — 2026-08-23

Read-only dashboard and catalog review plus the current-owner sign-in established this
configuration. Re-read it before relying on it because provider settings can drift.

- TOTP is enabled with at most ten factors. Enhanced MFA limits AAL1 sessions to 15
  minutes. Email and Google are enabled; SAML and the other reviewed providers are off.
- New signups and email confirmation are on. Anonymous sign-in and manual identity
  linking are off. Leaked-password protection is on; CAPTCHA is off.
- Custom SMTP is off. The built-in email rate is two per hour and is not a production
  sender. SMTP delivery, bounce handling, and security-email delivery remain unproved.
- Access tokens last 3,600 seconds. Refresh-token replay detection is on with a ten-second
  reuse interval. Single-session enforcement, maximum session lifetime, and inactivity
  timeout are off pending an owner recovery/session policy.
- Sign-up/sign-in and token-verification limits are 30 per five minutes per IP; refresh is
  150 per five minutes per IP. SMS is 30 per hour. IP forwarding is off.
- Database-backed Auth audit retention was enabled during this review. It has no backfill;
  zero rows immediately after enablement is not evidence that future events are missing.
- Site URL is `https://mypersonas.online`. The redirect list still includes development
  localhost entries and a literal, nonfunctional `192.168.x.x` placeholder. Remove a
  development redirect only after the desktop/local callback inventory is complete.
- Security Advisor reported zero errors and 216 warnings. Migration 061 is the narrow
  reviewed fix for proven ACL/search-path/waitlist findings. It intentionally does not
  move provider-owned `pg_net`, weaken public-profile projections, or claim CAPTCHA/WAF.
- The installed Supabase GitHub App's check is labeled **Supabase Preview**, but a main
  push containing migration 061 applied it to production and wrote migration history
  before GitHub unit tests finished. Treat every main push with a new timestamped
  migration as a production database action. Stage database work on a non-production
  branch or disable production auto-apply; never rely on the check name or CI ordering.

## Required AAL2 contract

When a user has a verified second factor, block private app loading while `currentLevel=aal1` and `nextLevel=aal2`, then present the factor challenge. Recheck AAL at the server.

Require current AAL2 for:

- provider credential creation, rotation, deletion, OAuth start, callback completion, disconnect, and revocation;
- L2/L3 activation, unpause, approvals, external publishing, mailbox mutation, and schedule activation;
- account export, content erasure, account deletion, email/password changes, factor changes, and recovery actions;
- future payment, payout, tax, affiliate-routing, and administrator operations.

Public routes, OAuth callbacks, and cron use their own narrow state/secret contracts. They do not bypass user AAL2 by accepting a browser-supplied owner ID.

Test AAL1-denied and AAL2-allowed behavior in UI, RLS, RPC, and every sensitive Edge Function. Handle interrupted/unverified factor enrollment explicitly.

## Secret architecture

1. A provider issues one scoped key for one environment/workload.
2. The owner handles the secret at the provider or trusted secret-entry screen; agents never receive it in chat or logs.
3. An owner-authenticated AAL2 broker validates the provider, exact official host/path, project, model, scopes, expiry, and default-zero budget.
4. The broker stores the secret server-side and returns only a backend ID plus non-secret metadata.
5. Runtime functions resolve secrets server-side, reserve budget atomically, enforce host/path and timeout, call the provider, and write an audit record.
6. Export and UI return metadata only. Erasure verifies local deletion and reports any provider-side revocation still required.

OpenRouter OAuth must be exchanged and stored server-side. Its plaintext result must not pass through browser JavaScript. Do not store a provider management/master key merely to automate deletion.

## Provider endpoint policy

Known providers use code-owned exact host/path maps. A user-selectable `provider` label or `base_url` must never decide where a known-provider secret is sent. Custom endpoints require an owner/admin-reviewed allowlist, DNS/IP revalidation, HTTPS, redirect refusal or strict same-host rules, and an explicit data classification.

Google/Gemini keys should use supported authentication headers rather than URL query parameters when possible. Never log a URL containing a credential.

## Key record

Store metadata, never the key:

| Field | Requirement |
|---|---|
| Owner/provider/environment/workload | Required |
| Project/workspace and region | Required |
| Key fingerprint | Last safe characters or one-way fingerprint only |
| Scopes and allowed host/path | Explicit, least privilege |
| Issued/expiry/rotation | Required; short initial life |
| Budget and limit type | Record whether the provider limit is hard or merely an alert |
| Auto-recharge | Off by default |
| Retention/training/ZDR settings | Record current provider evidence/date |
| Consumers | Backend/function IDs only |
| Revoke/delete drill | Exact steps and last verified result |
| MFA/SSO/recovery owner | Non-secret ownership metadata |

Use separate `mypersonas-rnd`, `mypersonas-dev`, `mypersonas-stage`, and `mypersonas-prod` boundaries only where needed. Do not create a key per persona.

## Cost and recursion controls

- Paid budget defaults to $0 until the owner sets a nonzero amount.
- Do not enable auto-top-up or dedicated GPU capacity during trials.
- Reserve cost atomically before a request; reconcile actual usage afterward.
- Enforce per-request tokens/price/time, per-backend daily/monthly budget, concurrency, queue depth/TTL, tool-call count, model-to-model hop count, and total task wall time.
- Add a global AI-spend pause independent of the external-publishing pause.
- Fail closed when budget, key, owner, audit, or destination state is missing or stale.
- Dashboard budgets are not assumed to be hard stops; keep an application circuit breaker.

## Browser and frontend boundary

The current static single-page app uses inline script/style and persistent Supabase browser sessions. Before mass keys:

- move executable JS/CSS and inline event handlers into versioned assets;
- vendor dependencies or pin them with integrity metadata;
- use a header-capable host/proxy;
- deploy and verify a restrictive CSP, `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options: nosniff`, strict `Referrer-Policy`, and minimal `Permissions-Policy`;
- avoid placing secrets, OAuth codes, task IDs, or personal data in URLs;
- clear OAuth parameters promptly and prevent account/session switching during callbacks.

## Production auth mail and abuse controls

- Configure custom SMTP; the default Supabase mail service is for limited testing, not production delivery.
- Use exact Site URL and redirect allowlists, not broad wildcards.
- Verify signup confirmation, magic link, password reset, email change, security notification, unsubscribe, bounce, and abuse handling.
- Explicit magic-link sign-in should not silently create a new user when a separate account-creation path exists.
- Add Turnstile/hCaptcha and rate limits to account, review-request, fan-chat, intake, and email endpoints.
- Never claim an email workflow works until inbox delivery, link destination, replay/expiry, and durable state have been tested.

## Supabase credentials

- Publishable keys are expected in browser code and are safe only with correct RLS/RPC/function authorization.
- Service-role/secret keys stay server-side and bypass RLS. Do not give them to programmers, agents, browser code, local task prompts, or direct client scripts.
- New Supabase `sb_*` publishable/secret keys are API keys, not JWT bearer tokens. Send them in the `apikey` header. Do not disable legacy JWT-based keys until every caller and Edge auth contract is migrated and tested.
- Production deployment credentials belong in a protected GitHub environment with required reviewers, narrow use, rotation, pinned tooling, and a function allowlist.

## Account setup ceremony

For each provider:

1. Verify the official domain, signed-in owner, trial terms, expiry, included models, retention/training policy, region, billing method, auto-recharge, and rate limits.
2. Enable MFA. The owner scans QR codes/enters OTPs and stores recovery codes offline.
3. Create or select the minimum environment project.
4. Set a $0 or tiny explicit budget, no auto-recharge, and provider-side restrictions.
5. At the final key/OAuth screen, state the exact key name, project, scopes, destination, spend ceiling, expiry, consuming service, and revocation path; obtain owner confirmation.
6. Store through the AAL2 server broker; never paste the secret into chat, source, screenshots, or documentation.
7. Run the fixed redacted benchmark and one negative permission test.
8. Test rotation, revocation, erasure, cost stop, and audit before promotion.

## External-action gates

Owner confirmation is required immediately before:

- key issuance/revocation or OAuth consent;
- cloud/repo/social/email/storage permission changes;
- security/MFA/SSO, DNS, SMTP, or auth configuration changes;
- deployments and production migrations;
- external posts, emails, affiliate submissions, public forms/products, payments, prices, payout/tax details, charges, or refunds;
- any trial conversion, paid capacity, auto-recharge, or nonzero budget.

The agent may prepare and verify everything up to the final action. The owner handles passwords, live OTPs, TOTP seeds, recovery codes, cookies, master keys, service-role credentials, and payment authentication.

## Incident response

For a leaked or ambiguous credential/provider outcome:

1. Pause the narrow integration and global AI spend/publishing as appropriate.
2. Preserve audit/log timestamps without copying secrets.
3. Revoke at the provider; do not merely delete the local copy.
4. Reconcile provider-side objects, charges, posts, messages, and sessions.
5. Rotate dependent credentials and invalidate sessions if exposure is possible.
6. Fix the root cause and add a regression test.
7. Run a fresh least-privilege setup ceremony.
8. Record local, provider, and user-notification truth separately.

For ambiguous posting or payment results, never retry blindly. Reconcile the provider object/transaction first.
