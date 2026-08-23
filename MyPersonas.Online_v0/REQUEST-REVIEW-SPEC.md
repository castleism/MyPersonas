# Product and request-review specification

Status: approved specification with phase-1 intake **implemented and tested locally; not
pushed, applied to the linked database, deployed, configured, activated, or verified live
unless separately evidenced.** The notification
sender, owner evidence/review queue, `product_reviews` lifecycle, and published review UI
remain future phases.

Current implementation boundary: `043-request-review-phase1.sql` creates fail-closed
private intake/rate/audit/notification-queue storage and the service acceptance RPC;
`supabase/functions/request-review/index.ts` performs the public CAPTCHA/HMAC intake; the
revenue/settings UI can configure a persona and render a CTA only through migration 051's
current-page gate. Phase 1 queues a notification record but sends no email. The hardened
043 file now has the ordered local mirror
`20260822160000_request_review_phase1.sql`; it must be applied before 051. The wider
timestamped directory remains incomplete as a fresh-install history.

Purpose: let a visitor ask a persona/brand to consider a product, notify the owner through that persona's verified mailbox route, and let the owner test/research it before an AI-assisted persona draft is approved. A request is not an endorsement, review, affiliate relationship, purchase promise, or permission to market to the requester.

## Public promise

Every published product card/review must distinguish:

- what the owner personally tested or observed;
- what a primary source or manufacturer reports;
- what is inferred, unknown, not tested, or time-sensitive;
- whether the link is affiliate/sponsored/gifted/paid or ordinary;
- that AI assisted with drafting in the persona's voice and the human owner reviewed/approved it;
- the review date, material limitations, corrections link, and conflict/compensation.

Never state that disclosure alone makes content legally compliant. Health, financial, legal, safety, children's, regulated-goods, adult, charity, and professional-service claims require their separate policy/legal gates.

## State model

```text
request_received
  -> triaged
  -> declined
  -> owner_testing
  -> evidence_ready
  -> persona_draft
  -> owner_approved
  -> published
  -> corrected_or_withdrawn
```

Only the owner changes review state. No model, requester, affiliate feed, or email event can approve/publish.

## Data model

### `product_review_requests`

- `id uuid primary key`
- `persona_id uuid not null`
- `requester_email citext null` — encrypted or access-restricted; not public
- `requester_name text null`
- `product_name text not null`
- `product_url text null`
- `reason text null`
- `consent_to_reply boolean not null default false`
- `marketing_consent boolean not null default false` — separate, unchecked, optional
- `status text not null`
- `captcha_verified_at timestamptz not null`
- `request_fingerprint text not null` — rotating server HMAC; never raw IP
- `created_at`, `updated_at`, `retention_expires_at`
- unique idempotency key for accepted form submission

No browser can select or read a private mailbox address. Persona routing is resolved server-side from an owner-verified, nonsuspended email ledger/connection and a dedicated request-review destination setting.

### `product_reviews`

Target model; not implemented in phase 1.

- owner/persona/product identity and canonical URL
- state plus `approved_by`, `approved_at`, immutable approved-content hash
- `owner_tested boolean`, `tested_at`, `test_method`, `items_tested`
- structured evidence records with `kind=observed|reported|inferred|unknown`, source URL/title/publisher/date/retrieved date, and bounded claim text
- `limitations`, `conflicts`, `corrections`, `withdrawn_reason`
- `relationship=none|affiliate|sponsored|gifted|paid_review|other`
- `affiliate_program`, destination, disclosure text, compensation description
- exact approved headline/body/alt text/media hashes and publication destinations
- `published_at`, provider/content IDs, last verification date

Affiliate URLs never come directly from requester input. The owner selects a verified program/link after acceptance. Do not cloak destinations, copy marketplace media without rights, or republish vendor descriptions as owner findings.

### `product_review_events`

Append-only audit: request accepted/rejected, rate-limited, routed, notification attempted/sent/failed, state transitions, evidence edits, approval invalidation, publication, correction, withdrawal, and erasure. Store provider message IDs and hashes, not raw credentials or unnecessary email bodies.

## Public `request-review` function

1. Accept POST only; exact CORS origin; bounded body read before JSON parse.
2. Validate persona is public/eligible and the feature is enabled. Do not reveal a private persona or mailbox.
3. Verify Turnstile/hCaptcha server-side with timeout and hostname/action checks.
4. Normalize and limit fields: product name 160 chars, HTTPS URL 2,048, reason 1,500, name 100, email 320.
5. Reject private/internal/IP-literal URLs and unsupported schemes; never fetch requester URLs in the public request path.
6. Rate-limit atomically by rotating HMAC fingerprint, email hash, persona, and global queue. Use low burst/daily caps, TTL, and abuse pause.
7. Deduplicate similar recent product URL/name requests and return the same neutral receipt.
8. Insert the request through a service RPC that writes the audit event transactionally.
9. Queue, do not synchronously send, the owner notification. Do not disclose whether a mailbox exists.
10. Return a generic accepted response. Never promise review, purchase, reply, publication, compensation, or deadline.

The response should be the same for accepted, duplicate, and privacy-safe suppressed requests where practical to limit enumeration.

## Notification worker

Not implemented in phase 1. The current database row is a private queue record, not a
delivery attempt or sent email. A later worker must satisfy all requirements below.

- Requires the global email/AI/publishing pauses as appropriate and an eligible persona mailbox destination.
- Rechecks owner/persona/destination/suspension immediately before sending.
- Renders a fixed template; requester fields are escaped plain text. Do not render requester HTML or fetch links.
- Includes request ID, product name/domain, reason, reply-consent status, and an owner-only review-queue link. It does not include an auto-endorsement draft.
- Atomically claims one queued notification, uses an idempotency key, checkpoints provider message ID, and treats timeout/5xx/missing ID as reconciliation-required rather than blind retry.
- Respects bounce/suppression, owner quiet hours, daily caps, and a global stop.
- A marketing list receives nothing unless separate explicit consent exists; review-request consent is not newsletter consent.

## Owner queue

Migration 043 did not include an owner queue. Migration 051 now adds a private inbox for
accepted requests, bounded notification-state evidence, explicit workflow transitions,
and AAL2-gated requester-PII erasure. It does not send the notification email, author the
owner's evidence, or publish a persona review; those remain separate reviewed steps.

Owner actions: decline, request clarification, mark testing, add evidence, create persona draft, approve exact review, correct, withdraw, and erase requester PII where legally permitted. High-impact actions require AAL2.

The AI receives only owner-approved evidence and persona public-safe canon. It cannot browse a product page and convert vendor claims into owner observations. A material edit to evidence, relationship, disclosure, destination, text, media, or link invalidates approval.

## Public UI

- Button label: `Request a review`
- Supporting text: `Suggest a product for possible owner review. Submission does not guarantee purchase, response, endorsement, or publication.`
- Separate consent checkbox: `You may email me about this request.`
- Separate optional unchecked checkbox for any marketing list.
- Do not expose persona email addresses.
- Success: `Request received. The owner decides what to test or review.`
- Published reviews show relationship/disclosure before the first outbound product link, evidence/limitations, reviewed date, AI-assistance disclosure, and corrections/withdrawal status.

## Minimum tests

- missing/invalid CAPTCHA, wrong hostname/action, oversized/chunked body;
- private/IP-literal/non-HTTPS URL and redirect/fetch absence;
- duplicate, burst, email-hash, persona, and global limits under concurrency;
- private/ineligible persona and missing/suspended mailbox without enumeration;
- HTML/script/header injection in every field;
- notification claim overlap, timeout after provider success, missing message ID, pause race, bounce/suppression;
- requester consent does not become marketing consent;
- owner-only/RLS/AAL2 state changes; other-owner denial;
- approval invalidation after evidence/link/disclosure/media change;
- affiliate/non-affiliate disclosure rendering;
- withdrawal/correction and PII retention erasure;
- export contains owner review records but does not leak unrelated requesters or secrets.

## Release gates

Do not build on a raw browser-to-email shortcut. First require AAL2, production SMTP,
CAPTCHA, CSP/security headers, exact redirect/origin configuration,
budget/rate-limit/audit primitives, and a tested email reconciliation path.

The phase-1 Edge deployment requires one exact HTTPS
`REQUEST_REVIEW_ALLOWED_ORIGIN`, `TURNSTILE_SECRET_KEY`,
`REQUEST_REVIEW_TURNSTILE_ACTION=request_review`, the exact
`REQUEST_REVIEW_TURNSTILE_HOSTNAME`, a random `REQUEST_REVIEW_HMAC_SECRET` of at least
32 bytes, and a matching public `CONFIG.TURNSTILE_SITE_KEY`. Missing/invalid server
configuration must return 503. `verify_jwt=false` is intentional only because the endpoint
is public CAPTCHA intake; exact Origin, streamed 16 KiB body limit, five-second
Turnstile verification, rotating HMACs, service-role RPC, and neutral receipt are the
mandatory function boundary.

Before deployment, prove the frozen canonical/mirror pair, then apply and read back the
hardened 043 schema before 051 using `RELEASE-MANIFEST-2026-08-22.md`. Keep the global gate at
`accepting_requests=false` and `abuse_paused=true`, with every persona disabled. Deploy
database → intake function → notification worker → owner evidence UI → public button.
Keep the public button last and default-off per persona. Until the worker and SMTP reconciliation
exist, a successfully queued phase-1 request must never be described as an email or review.
