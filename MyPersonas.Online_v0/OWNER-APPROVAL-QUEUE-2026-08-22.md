# Owner approval queue — 2026-08-22

Nothing in this list has been applied, deployed, activated, purchased, or represented as
live. Work through it in order; record the account/project, operator, UTC time, evidence,
result, and rollback for every approved change.

Package status: **Implemented and tested locally; not pushed, applied to the linked
database, deployed, configured, activated, or verified live unless separately evidenced.**
Use `RELEASE-MANIFEST-2026-08-22.md`; do not substitute this checklist for final hashes,
test output, linked readback, or action-time approval.

## Release approvals

- [ ] Approve a staging Supabase project for the exact ordered package: 047, 048, 049,
      050, hardened request-review prerequisite 043, then 051, 052, 053, 054, 055, 056,
      and 057. Migration 047's production display-name update is separately verified
      historical evidence, but its migration-ledger entry and this coordinated package
      still require readback.
- [x] A byte-identical local Supabase mirror now exists at
      `20260822160000_request_review_phase1.sql`. This source repair is not an apply or
      deployment. Migration 051 depends on its `product_review_*` objects; do not apply a
      partial linked chain or manufacture migration-history rows.
- [ ] Approve the exact production migration window only after staging RLS, rollback,
      deletion, publication, friendship, and owner-privacy tests pass.
- [ ] Approve the matching frontend deployment only after all migrations are recorded.
- [ ] Acknowledge that `supabase/migrations/` is not a complete fresh-install chain.
      Inventory and prove every required predecessor in the target; rehearse the manifest
      in a matching isolated PostgreSQL 16/Supabase staging project. Never manufacture a
      migration-history row.
- [ ] Approve the manual Functions dispatch only after database readback; type the exact
      `MIGRATIONS-VERIFIED` confirmation and record commit/workflow/function evidence.
- [ ] Approve the manual Pages dispatch only after the matching functions and signed-in
      staging smoke pass; the same confirmation does not waive live verification.
- [ ] Approve a signed-in two-account visual smoke test; identify disposable test
      personas and confirm they may be deleted afterward.
- [ ] Acknowledge the migration-051 safety impact: every existing persona without
      lifecycle state is backfilled `unpublished`, with no published revision/timestamp.
      Inventory the legacy public roster, preserve an owner export, and choose which
      personas will be individually reviewed and republished afterward. Do not rewrite
      the migration during the release window to keep pages implicitly public.
- [ ] Approve migration 051 returning every legacy business page to an owner-only draft,
      followed by migration 052's exact-revision AAL2 business review/publish workflow.
      Mission-item and persona-title edits force the business back to draft; no legacy
      business is implicitly republished.
- [ ] Approve migration 053 only after tests prove browser JWTs cannot invoke automated
      AI modes, approval binds every execution input and backend, one idempotency key cannot
      produce two provider calls, empty task allowlists deny proposals, expired runs are
      reconciled safely, and pre-provider budget denials preserve re-reviewable authority.
- [ ] Approve migration 054 only after owner/service RPC, quota-deletion resistance,
      provider-receipt authority, cross-owner denial, export, and erasure tests pass.
- [ ] Approve migration 055 only after exact row/byte counter seeding, reserved terminal
      audit capacity, started-to-completed/failed/denied transitions, direct service DML
      denial, over-limit recovery, and concurrent writer/erasure tests pass.
- [ ] Approve migration 056 only after Auth-email change and unconfirmation revoke stale
      AliaSpaces email attestations while preserving independent OAuth/provider connections.
- [ ] Approve migration 057 only after automated modes default-deny, AAL2 policy writes,
      per-mode request/token ceilings, idempotent reserve/finalize, lease expiry, concurrency,
      and provider-error accounting pass. A database budget is not a provider hard cap.
- [ ] Resolve the public Storage privacy blocker before enabling new public media widgets:
      current public object paths expose a stable owner UUID that can correlate otherwise
      unlinked personas. Choose opaque public asset keys or an authenticated delivery
      proxy plus a backfill plan.
- [ ] Decide which legacy/external media must be ingested into first-party immutable
      storage. New first-party uploads are final-byte content-addressed, but external HTTPS
      and legacy URLs are not byte-integrity-bound and can change after page review.

## Account authority and authentication

- [ ] Confirm the exact primary owner Auth UUID and approve one reviewed
      `global_administrator` assignment. Do not infer the UUID from email or persona data.
- [ ] Name at least two break-glass maintainers or explicitly accept the single-owner
      recovery risk. Later move maintenance roles to a business/organization authority
      model rather than persona identities.
- [ ] Decide which login methods remain supported. Record redirect URLs and recovery
      ownership for each OAuth/SSO provider.
- [ ] Approve AAL2 enforcement for destructive owner/admin operations after recovery and
      trusted-session UX are tested.
- [ ] Approve CAPTCHA provider and domains only after its browser token is wired and
      verified; create the secret in the provider/dashboard, never in source.
- [ ] Confirm Supabase plan eligibility before enabling password or MFA verification
      hooks. Rehearse targeted-lockout, unlock, email notification, and administrator
      recovery cases first.

## Edge security, logging, and incident response

- [ ] Choose the public edge/WAF authority (for example Cloudflare) and approve DNS only
      after an inventory/rollback export. Configure managed DDoS protection, request
      limits, bot controls, and emergency rules there—not in browser JavaScript.
- [ ] Configure and test Supabase Auth rate limits appropriate to real traffic.
- [ ] Decide whether Auth audit events should be stored in the database, respecting plan,
      retention, and access requirements.
- [ ] Choose a log destination and approve a log drain only after redaction review. Never
      export secrets, OAuth tokens, passwords, raw friend proofs, or full request bodies.
- [ ] Approve an environment-specific keyed hash strategy at the edge for abuse
      identifiers. Migration 051 accepts only 64-character hashes and intentionally does
      not collect raw IP addresses.
- [ ] Before releasing `affiliate-redirect`, retain the now-verified canonical/mirror-051
      parity, set a distinct 32-byte-or-longer `AFFILIATE_CLICK_HMAC_SECRET`, and audit every
      legacy/current destination. Verify bounded inputs, rotating HMAC identifiers,
      credential-free HTTPS-only redirects, atomic current-page/cap/deduplication behavior,
      the deployed source hash, and an approved service-role retention schedule before
      exposing offer buttons.
- [ ] Choose the security mailbox, SMTP/provider, templates, and escalation owners for
      timeout/account-lock notifications. A pending database flag alone sends nothing.
- [ ] Approve a schedule for the service-only retention purge after legal/privacy review.
- [ ] Write and rehearse account recovery, suspected takeover, credential rotation,
      provider revocation, WAF lockdown, restore, and public status-message procedures.

## Provider connections and sync workers

For every requested platform—OpenAI/ChatGPT, Anthropic/Claude, GitHub/Copilot, Kimi,
Ollama, Perplexity, OpenRouter, Groq, Mistral, Together AI, Fireworks, Cohere, Azure
AI/Foundry, ElevenLabs, LM Studio, AWS, Hugging Face, Gemini/Google, DeepSeek, Meta AI,
IBM watsonx, xAI/Grok, Supabase, and any later connector—complete this checklist before
calling it functional:

- [ ] Confirm an official API exists for the intended action and that trial/commercial
      terms allow it.
- [ ] Create one named least-privilege project/service identity; do not reuse a personal
      browser session as an API credential.
- [ ] Record owner, purpose, environment, quota/cost cap, expiration, data region,
      training/data-retention setting, allowed origins/redirects, and revocation path.
- [ ] Enter each secret directly into the approved server-side secret store. Do not paste
      it into chat, Git, SQL, browser storage, persona notes, screenshots, or documentation.
- [ ] Add a server-side connector/worker, capability map, health check, bounded timeout,
      retry/backoff, reconciliation, sanitized audit, and erasure coverage.
- [ ] Prove scopes and one disposable read action before any write action.
- [ ] Approve every publishing/payment/write scope separately. Keep browser-only AI handoff
      as copy/open/paste unless the provider has an approved connector.

An open tab, signed-in desktop app, ledger placeholder, saved username, or trial account
is not proof of API authentication or supported automation.

Proposed first trial ceremony after the migration/security release is green:

- [x] Local Ollama is currently listening only on `127.0.0.1:11434` with
      `gpt-oss:20b`, `gemma3:12b`, and `embeddinggemma`. A zero-cost strict-JSON smoke
      passed for GPT-OSS and failed for Gemma; no cloud key or spend was involved.
- [ ] Approve creation of only `mypersonas-rnd` projects for Groq, Mistral, Perplexity,
      DeepSeek, Together, Fireworks, and Cohere, with public/synthetic benchmark data,
      no repository/cloud/social permissions, no auto-recharge, the smallest available
      hard cap, and immediate key revocation after the comparison unless retained.
- [ ] Approve the exact benchmark models: Groq `openai/gpt-oss-20b` and
      `openai/gpt-oss-120b`; Mistral OCR 4.1 plus the live Small/Medium candidate;
      Perplexity `sonar` then `sonar-pro`; DeepSeek `deepseek-v4-flash`; Cohere
      `embed-v4.0` plus `rerank-v4.0-fast`; and the same GPT-OSS 120B / Kimi K2.6 /
      GLM 5.1 class on Together and Fireworks where the live catalog offers it.
- [ ] For Gemini, keep `gemini-3.6-flash` as the stable text candidate and
      `gemini-3.1-flash-image` as the high-volume image candidate; do not replace the
      production moving alias until the fixed benchmark and release gates pass.
- [ ] Keep Claude Sonnet 5 for architecture/canon review, escalating to Opus 5 only for
      a difficult final decision. Recheck the live desktop allowance before starting.
- [ ] Keep ElevenLabs voice generation blocked until the exact persona, voice/likeness
      rights, disclosure, output count, and credit ceiling are approved. Use Scribe v2
      only for a bounded transcription test and Flash v2.5 for a later low-cost voice
      smoke; Eleven v3 is final-output escalation, not bulk generation.

## Commerce, sites, and public launch

- [ ] Identify the legal merchant, bank destination, currencies, countries, refund and
      dispute policy, sales-tax/VAT responsibility, product catalog, prices, fulfillment,
      and support address before payment processing is implemented or activated.
- [ ] Select the payment processor and approve test-mode onboarding first. Production
      activation, live products, payout destinations, and webhooks require separate exact
      approval and verified signing secrets.
- [ ] Supply the authoritative business names, missions, bios, public persona titles, and
      field visibility. Migration 049 intentionally creates only an owner-private draft
      Castleborn shell with blank mission/bio because these facts were not supplied.
- [ ] Approve the local migration-052 business-page review specification and staging
      results. A signed-in owner can publish only through its AAL2 RPC after reviewing the
      exact current revision; direct browser table mutation and service-role publication
      remain unavailable.
- [ ] Inventory every domain, repository, live host, DNS zone, social handle, app-store
      account, and current deployment before any cutover.
- [ ] Approve public persona/page publication individually through the new review screen.
- [ ] Approve affiliate networks, exact products, material-connection disclosures,
      geography-specific advertising language, tracking consent, and review policy before
      publishing affiliate content.
- [ ] Configure the request-review email sender/recipient and deliverability records only
      after the mailbox and consent policy are approved. Until then, keep requests queued
      on-site; do not claim an email was sent.

## Request-review phase-1 activation

- [ ] Create a Turnstile widget restricted to the final production hostname and record
      its owner/recovery path. Put only the public site key in
      `CONFIG.TURNSTILE_SITE_KEY`.
- [ ] Set `REQUEST_REVIEW_ALLOWED_ORIGIN` to one exact HTTPS origin,
      `TURNSTILE_SECRET_KEY`, `REQUEST_REVIEW_TURNSTILE_ACTION=request_review`,
      `REQUEST_REVIEW_TURNSTILE_HOSTNAME` to the exact production hostname, and a random
      `REQUEST_REVIEW_HMAC_SECRET` of at least 32 bytes directly in the Edge environment.
      Never place values in Git, Markdown, SQL, screenshots, logs, or chat.
- [ ] Approve deployment of `request-review` with intentional `verify_jwt=false` only
      after the function's exact-origin, bounded-body, Turnstile, URL, rotating-HMAC,
      neutral-receipt, and service-RPC checks pass in staging. Missing configuration must
      remain a 503, not a permissive fallback.
- [ ] Keep `accepting_requests=false`, `abuse_paused=true`, and every persona disabled
      until one disposable staging persona has a currently published revision, active
      binding, connected nonsuspended Gmail ledger, and reviewed request CTA.
- [ ] Approve a later notification claim/sender worker, SMTP identity, fixed escaped
      template, provider-id reconciliation, retry/suppression policy, and real delivery
      test. Phase 1 currently queues a row only; no email is sent.
- [ ] Approve a later owner request/evidence/review workflow. The current local source
      accepts phase-1 requests but does not implement the full `product_reviews` state
      model, owner evidence queue, or published-review correction/withdrawal flow.
- [ ] Keep the public button last and default-off per persona. Enable it only after the
      database, intake, notification worker, owner evidence UI, SMTP reconciliation, and
      one disposable end-to-end staging flow are all verified.

## Decisions still required

- [ ] Prioritize the exact existing persona pages to review and republish after the
      migration-051 unpublished backfill.
- [ ] Decide if follows are persona-to-persona only or may also originate from a human
      account with no persona.
- [ ] Define “friend” contact-proof rules and privacy-preserving verification authority.
- [ ] Choose which page modules may be public, friends-only, followers-only, or owner-only.
- [ ] Define extension publisher identity, review SLA, permissions, signing, sandbox,
      moderation, revocation, and revenue-share policy.
- [ ] Identify the exact Castleborn database/resource to attach to the Castleborn project.
      WAIS is manager metadata only until that resource is configured and tested.
- [ ] Confirm Abel/Enki canon and whether either needs a persona row. No row was invented.

## Known residual engineering work

These are not represented as fixed by the 047–057 package. The public Storage correlation
issue above remains the P1 release blocker for richer public media widgets; the items below
are bounded P2/design follow-ups unless staging proves otherwise.

- [ ] Replace stable owner-UUID public media paths with opaque public asset identities,
      backfill reviewed media, and prove unlinked-persona non-correlation before enabling
      public image/video widgets or animated/video backgrounds.
- [ ] Decide whether a second ambiguous automation-budget claim should reconcile sooner
      than the existing 60–3600-second lease TTL. Current behavior fails closed and makes
      no provider call, but temporarily retains the reservation. Also decide whether a
      budget-denied scheduled run should consume its separate daily generation slot.
- [ ] Add a new forward-only hardening migration for the legacy email-verification
      provenance overwrite in migration 009; do not rewrite the already-applied migration.
- [ ] Give research `sources` a strict per-entry schema with unknown-key rejection instead
      of only a bounded-array contract.
- [ ] Design whole-business archive/delete and decide whether friends/followers business
      visibility will be implemented; current public projections intentionally fail closed
      to `public` only.
- [ ] Decide whether restore requires a server-side staged transaction/job. The current
      many-RPC restore is session-stable and reports partial private drafts, but cannot be
      atomic across the complete import.
- [ ] Add an explicit consent/interstitial policy for external embeds, which necessarily
      disclose a viewer's network request to the remote host.
- [ ] Reduce Agent Board service-role blast radius with a narrower execution identity,
      fixed egress/DNS controls, provider/executor revision pinning, and whole-prompt secret
      scanning before enabling third-party automated execution.
- [ ] Add queue/hop limits, provider-price metadata, and an independently operated global
      emergency spend stop. Database token/request limits are not provider billing caps.

## Evidence required to close the queue

“Done” requires the exact artifact or dashboard, current state, test identity, expected and
observed result, timestamp, sanitized screenshot/log, rollback, and a second readback.
Local source, a passing static test, an open browser tab, a saved key, and a queued
migration remain distinct states.
