# Setup conductor handoff

Updated 2026-08-14. This document is the takeover entry point for the 50-hour portfolio sprint. It replaces earlier unverified statements about migrations, deployment, SSO, MFA, and model availability.

## Read first

1. `AI-TOOLING-AND-SPRINT-PLAN.md`
2. `50-HOUR-COMMAND-BOARD.md`
3. `SECURITY-AND-ACCESS-RUNBOOK.md`
4. `AGENT-ROLE-PACKETS.md` and `AI-TASK-PACKET-TEMPLATE.md`
5. `LOCAL-AI-SETUP-2026-08-14.md`
6. `REQUEST-REVIEW-SPEC.md`
7. `HANDOFF-CHATGPT.md`
8. `ROADMAP-EXECUTION-2026-08-13.md`
9. `POST-QUEUE-ACTIVATION.md`
10. `BRAND-MANAGER-HANDOFF.md`
11. `supabase/functions/DRIFT.md`

## Release truth, not aspiration

| Layer | State on 2026-08-14 | Meaning |
|---|---|---|
| Git | `main` and `origin/main` were at `a8b1ab0` when audited | Source was pushed; this does not prove backend deployment. |
| Public frontend | `https://mypersonas.online` returned 200 and matched current `index.html` | Pages is live. `aliaspaces.com` and `www` fail TLS. |
| Local tests | 63/63 Node contract tests pass | Not DB, provider, concurrency, migration, or live integration proof. |
| GitHub CI | Red on Deno edge-function typecheck | Do not release another commit until fixed and green. |
| Supabase CD | Repeatedly stops because `SUPABASE_ACCESS_TOKEN` is unavailable to the workflow | Some functions appear manually deployed; exact source parity is unproven. |
| Migration 035 | Live-visible through a safe permission probe | Presence only; signed-in behavior still needs QA. |
| Migration 038 | Live-visible through a safe permission probe | Presence only; signed-in behavior still needs QA. |
| Migration 037 | Unknown | Requires SQL/publication and RLS evidence. |
| Migration 039 | Not visible in the live schema cache | Reddit lease protection is not usable live and current callers do not use it locally. |
| Migration 036 | Must remain dormant | Cron inventory is unverified and queue/reconciliation gates remain. |
| Discord | Current dormant/503 response is live | Keep disabled until rebuilt and Vault erasure is complete. |
| Reddit | Public capability says `configured:false` | OAuth/posting is not ready. |
| Meta | Earlier owner-triggered FB/IG success is documented | Hardened current release and scheduled pipeline are not freshly live-proven. |
| Auth | Email and Google social OAuth; TOTP enrollment | Not enterprise SSO; no AAL2 login/step-up enforcement. |
| AI backend | One live Google backend using `gemini-flash-latest` | Moving alias; replace only after a controlled pinned-model test. |

Never collapse `local`, `pushed`, `deployed`, `verified live`, `revenue-ready`, and `blocked` into the word “done.”

## Conductor contract

- One primary writer owns a file/branch/worktree at a time. Other models review read-only or in isolated worktrees.
- Every task packet names scope, forbidden actions, evidence inputs, expected files, tests, cost/token/time ceiling, stop conditions, owner gates, and rollback.
- Do not send passwords, OTPs, TOTP seeds, recovery codes, browser cookies, service-role keys, payment credentials, or unredacted production data to any model.
- Agents may prepare forms and navigate to the final control. The owner confirms and personally handles MFA/secret material at the action boundary.
- No deploy, migration, provider permission, external post/email, public product, price, checkout, billing change, or nonzero spend occurs without a named owner approval.
- All automation remains default-deny with an independent AI-spend stop and publishing stop.

## Immediate ordered work

### 1. Contain public exposure

- Deploy the prepared allowlisted artifacts for Aware Of My Food and Lifegiving Compassion after owner approval.
- Add the same allowlist boundary for Smile To Your Body.
- Verify every known internal path returns 404 after deployment.
- Repair TLS/HTTPS redirect issues for Fix My Frozen PC, Always Cooked Just Right, Just Right Speech, and Noo YouNiverse. Do not hide certificate errors with client-side redirects.

### 2. Restore the MyPersonas release path

- Fix the Deno typecheck errors and require green validation in every production workflow.
- Pin deployment tooling; use a reviewed function allowlist and a protected/manual production environment.
- Inventory live migrations, cron commands, `publishing` rows, Vault secrets, and deployed function versions from authenticated admin evidence.
- Complete and wire the Reddit owner-operation lease before applying it. Fix access-only revocation and reject unsupported body+media posts.
- Add last-moment fail-closed pause checks before every Meta provider POST.
- Add Discord Vault-secret erasure/orphan inventory while keeping the connector dormant.
- Do not apply migration 036.

### 3. Build the security boundary before adding keys

- Add AAL2 login challenge/step-up and enforce it in RLS/RPCs/Edge Functions for sensitive actions.
- Move OpenRouter OAuth exchange and Vault storage server-side; the browser must never receive its plaintext key.
- Enforce official provider host/path maps. A configured provider key must never be sent to an arbitrary URL.
- Move to a header-capable hosting path and verify CSP, frame denial, HSTS, nosniff, referrer, and permissions policies.
- Add default-zero atomic provider budgets, queue/concurrency/hop limits, expiry, audit, and a global AI-spend kill switch.
- Verify production SMTP, exact redirects, CAPTCHA, confirmation, and recovery.

### 4. Onboard one model, not fifteen

After steps 1–3 are live-verified, create one low-value, expiring, tightly capped `mypersonas-stage` key. Run the fixed benchmark and an erasure/revocation drill. Only then promote a provider to production or add a second provider.

### 5. Revenue sequence

1. PrintMason: release current shop pages; create one hidden $19 Payhip product; test purchase, delivery, refund, receipt, tax/payout assumptions; then make it public.
2. Being Tea Co: verify the full consent email sequence, Search Console, and Bookshop application. Use the existing editorial library instead of generating more content.
3. Fix My Frozen PC: fix TLS and deploy bounded intake/Ask Brom; publish real owner-supplied hours, territory, and prices.
4. MyPersonas: build one centralized spam-safe request-review workflow with owner approval, persona email routing, evidence fields, and visible AI/human disclosure. It is not currently built.

Do not rush charity donations, health claims, adult production, native-store submission, MSP endpoint software, or payment routing where legal/provider verification is still missing.

## Setup record required for every external service

Record without storing the secret itself:

- provider, account owner, project/workspace, environment, region;
- exact model/deployment and date verified;
- key fingerprint, purpose, scopes, issuer, creation/expiry/rotation dates;
- budget, hard/soft nature of limit, auto-recharge state;
- data retention/training/ZDR/region settings;
- allowed host/path, IP/referrer restrictions;
- MFA/SSO state and recovery owner;
- MyPersonas backend ID or consuming service;
- revoke/delete steps and last successful drill;
- live evidence and reviewer.

## Release handoff format

Every shift ends with:

1. changed files and uncommitted work;
2. tests run and what they do not prove;
3. source commit and branch;
4. migration state with SQL evidence;
5. function deployment/version evidence;
6. frontend deployment evidence;
7. live signed-in checks and provider object IDs where safe;
8. spend to date and trial balance/expiry;
9. blocked actions and the exact owner confirmation required;
10. rollback or revocation procedure.
