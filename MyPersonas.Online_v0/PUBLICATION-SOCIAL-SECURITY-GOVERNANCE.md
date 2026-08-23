# Publication, social relationships, and security governance

Status: **Implemented and tested locally; not pushed, applied to the linked database,
deployed, configured, activated, or verified live unless separately evidenced.** Migration
051 belongs to the exact package in `RELEASE-MANIFEST-2026-08-22.md`; no production
security/provider setting was changed by this work.

## What this release adds

Canonical migration `sql-updates/051-publication-social-security-governance.sql` and its
local timestamped mirror add a review-first publication lifecycle, account-level
maintenance roles, a confirmed feature-request queue, separate follow and friend
relationships, provider-sync preferences, inert extension submissions, and bounded
security telemetry. The matching local browser release also contains public Family and
Offers & review requests modules, owner-side family/project/business and revenue editors,
and a phase-1 public request-review form. These are repository capabilities, not evidence
that any migration, Edge Function, page, provider, or email path is live. The two 051 files
are synchronized locally; final frozen hashes and linked readback remain release evidence.

The browser layer is split into `platform-governance.js` and
`platform-governance.css`. It is owner-only and fails with a setup-required message when
the migration is absent; it never pretends that a missing database object was saved.

## Publication contract

Persona pages now use these states:

1. `draft` — editable by the owner and not publicly discoverable.
2. `in_review` — the owner recorded the page intention, disclosure, and review notes.
3. `published` — the reviewed revision is public, subject to the persona visibility rule.
4. `unpublished` — explicitly removed from public view.

`changes_requested` is a review-record state, not a persona publication state.

New personas start as drafts. Migration 051 deliberately backfills every existing persona
whose lifecycle is not yet initialized to `unpublished`, with no published revision or
published timestamp. Applying it therefore removes legacy pages from anonymous discovery
until each exact page revision is reviewed and explicitly published. This is an intentional
fail-closed release impact, not a compatibility backfill and not an owner decision that may
be silently reversed during deployment. Any material edit to a published public field
increments the revision and returns the page to draft. Publishing requires all required
readiness checks, a completed owner review, and an exact matching review revision.

The revision boundary covers profile/public persona fields; layouts; posts, public links,
albums, and album items; both endpoints of a family edge; revenue settings, affiliate
offers, linked product public fields, and request-review destination settings; and the
AI-backend/credential/fan-chat-binding configuration represented in the review manifest.
Moving content or a family edge between personas invalidates every affected revision
exactly once per transaction. Top 8, linked-persona, and family cards are captured as
one-hop reviewed dependencies and fail closed if their reviewed projection drifts.
Direct changes to lifecycle columns are rejected; only the bounded review, publish,
unpublish, layout, content, organization, revenue, and configuration paths can change
them. Anonymous/direct table reads use the same published-current-page gate, and the
service-role fan-chat endpoint rejects status, messages, polling, and reply completion
after a page becomes unpublished or stale.

The old native-feed publisher is not an automatic publication path after migration 051.
An exact-approved native draft may be staged into the persona's draft page, which advances
the page revision; only an authenticated owner review and `publish_persona_page` can make
that revision public. Publication then reconciles only the exact unchanged staged draft.
The browser performs a second committed reconciliation call after publishing to activate
cyclically dependent staged pages safely; a failed reconciliation is a warning, not a
false publish success.

Business pages are deliberately stricter: migration 051 returns every legacy business
page to an owner-only draft and revokes migration 049's direct browser publication path.
Follow-on migration 052 adds a dedicated exact-revision review/publish/unpublish workflow;
owner publication requires AAL2, and profile, mission-item, or persona-title edits
invalidate the reviewed revision and return the page to draft. Both migrations and the
matching UI remain local and unapplied, so no business page is represented as released.

The mandatory disclosure is editable because persona-specific wording matters, but it
cannot be blank. The sanitized review packet can be copied to a signed-in browser AI
chat. The generated manifest excludes private notes, owner/account identifiers, model
connections, contact proofs, credentials, tokens, and extension source. Asset URLs and
full outbound paths are removed from the clipboard form. Owner-entered public copy and
page intention are scanned and visibly redacted for common credential/contact patterns,
but the owner must still inspect the exact packet before pasting it into another service.

## Roles and feature requests

`platform_role_assignments` contains account-level `global_administrator`,
`technician`, and `security_auditor` assignments. Browser users have no insert, update,
or delete permission. Migration 051 deliberately seeds no role: the owner's Auth UUID
must be verified and assigned through a separately reviewed service/admin operation.

A missing capability first becomes a private `draft` feature request. The owner sees the
exact title and description and must explicitly confirm submission. Only then does it
enter the administrator/technician queue. No intention parser, AI review, or page render
can auto-submit a ticket.

These roles are platform-maintenance authority, not persona presentation fields. A
business title such as “Spokesperson” never grants database, connector, publishing, or
administrator permission.

## Follow and friend model

Following and friendship intentionally use separate tables and actions:

- A public persona may be followed immediately by an authenticated persona. Following
  does not grant private-page access or friendship.
- Friend requests obey the target persona's policy: `open`, expiring hashed invite proof,
  a future contact-proof service, or `closed`.
- This release does not store email addresses or phone numbers as friend proof. The
  `contact_proof` mode fails closed until a server-side proof service can compare a
  one-time claim without revealing either person's contact data.
- Target owners can bound daily and pending requests. Repeated blocked attempts are
  recorded without raw email, phone, token, password, or IP data. Random/unavailable
  target probes have a hard per-requester audit budget so they cannot grow the table
  without bound.
- Existing accepted friendship continues to use the current `follows` relationship;
  direct authenticated insert/update is revoked and new requests use bounded RPCs.
- Accepted friendship is mutual for private-page access. Blocks are checked in both
  directions, remove follow/friend edges through one bounded RPC, and remain fail-closed
  for page visibility even if a client cleanup call fails.
- A private persona can bootstrap friendship only through an explicit owner invite or a
  future contact proof. The owner receives a private request link plus a one-time token;
  the link reveals no profile fields and the token is verified only in the database.

## Connected-account sync boundary

The settings screen lists only ledger accounts assigned to the selected persona. Each
persona/account pair may store direction, allowed post kinds, reply/repost choices, and a
publication policy. These rows are preferences only. They do not prove authentication,
activate a provider, start a worker, import a post, or grant a write scope.

Every provider still needs its own server-side worker with:

- server-attested connection state and scopes;
- least-privilege OAuth and a documented refresh/revocation path;
- cursor, lease, rate-limit, deduplication, and retry behavior;
- content filtering supported by that provider's official API;
- review-before-publication as the default;
- reconciliation and owner-visible errors;
- erasure and retention coverage.

Removing a persona/account assignment now deletes its saved sync preference immediately,
so a future worker cannot rely on stale enabled rows. Every worker must still revalidate
current assignment, connection state, scopes, and publication policy at execution time.

## Custom widgets and the learning console

Extension source is stored only as an inert review submission. Public pages never use
`eval`, `Function`, inline stored scripts, stored SVG, or unsanitized HTML. An approved
extension will still require a separate sandboxed build, declared permissions, CSP and
network review, integrity/signing metadata, versioning, kill switch, moderation, and a
staff-controlled release record.

For everyday customization, use the declarative page-layout schema from migration 050.
The visual builder teaches a useful combination rather than naming one “best language”:

- semantic HTML for document structure and accessibility;
- CSS for layout, shape, color, and responsive presentation;
- TypeScript for reusable, testable behavior;
- JSON for the safe stored component/layout contract.

The console is explanatory and read-only. Saved snippets are owner-private source notes;
they are never executed by a persona page.

## Family, revenue, request-review, and affiliate boundaries

The local renderer has first-class `family` and `revenue` layout modules. Family cards
come only from the reviewed one-hop relation-card RPC; owner notes and nonpublic family
edges never render. Revenue cards come only from `get_public_persona_revenue_rails` for a
currently published page and show the reviewed disclosure before any affiliate button.
Changing family or revenue data returns every affected page to draft. Neither module is
evidence of a deployed migration, configured affiliate program, valid product rights,
payment processing, revenue, or a sent notification.

The public `request-review` Edge Function is implemented in repository source as a
fail-closed phase-1 intake. It requires all of the following configuration:

- `REQUEST_REVIEW_ALLOWED_ORIGIN` — one exact HTTPS origin, with no wildcard or path;
- `TURNSTILE_SECRET_KEY`;
- `REQUEST_REVIEW_TURNSTILE_ACTION` — currently `request_review`, matching the page;
- `REQUEST_REVIEW_TURNSTILE_HOSTNAME` — the exact production hostname;
- `REQUEST_REVIEW_HMAC_SECRET` — at least 32 random bytes, kept server-side;
- the platform-provided `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; and
- a matching public `CONFIG.TURNSTILE_SITE_KEY` in the page configuration.

Missing or invalid server configuration returns 503. The function requires the exact
Origin, streams and caps the JSON body before parsing, verifies Turnstile server-side with
a five-second timeout plus exact action/hostname, rejects internal/IP-literal/non-HTTPS
product URLs without fetching them, and passes only rotating domain-separated HMAC
fingerprints to the service RPC. Accepted, duplicate, ineligible, and privacy-suppressed
valid requests receive the same neutral 202 receipt where practical. The endpoint has
`verify_jwt=false` intentionally because it is public CAPTCHA ingress; its own checks and
the service-role RPC are therefore mandatory, not optional substitutes for the gateway.

Migration 043 only queues a private notification record. There is no sender/claim worker,
SMTP delivery, owner request queue, evidence workflow, or published-review workflow in
this phase, so no documentation or UI may claim an email was sent or a review will occur.
The global request gate starts closed (`accepting_requests=false`, `abuse_paused=true`),
every persona starts disabled, and the CTA stays hidden until the page, mailbox, binding,
global control, and current reviewed revision all pass.

The hardened `043-request-review-phase1.sql` now has the ordered local mirror
`20260822160000_request_review_phase1.sql`. Migration 051 still depends on those objects,
so 043 must be applied and read back first. This mirror does not make the wider timestamped
directory a complete fresh-install history.

`affiliate-redirect` is also intentionally JWT-free because it is a public navigation
endpoint. The current local Edge source fails closed without a separate 32-byte-or-longer
`AFFILIATE_CLICK_HMAC_SECRET`, accepts only a bounded UUID offer and bounded attribution,
derives rotating domain-separated HMAC identifiers, and accepts only credential-free HTTPS
destinations. The migration-051 service RPC atomically rechecks the current reviewed page,
applies global/offer/fingerprint caps and click deduplication, and conditionally records
analytics; a service-only retention RPC removes expired limiter rows and click events older
than 400 days. The canonical 051 source and timestamped mirror are synchronized locally;
the frozen pair hash, linked application, and deployed function parity remain unproven.
The retention RPC also needs an approved scheduler/runbook. An active offer row or a 302
response is not payment-processing or revenue proof.

## Public asset integrity boundary

Migration 051 makes new first-party `persona-media` uploads append-only and requires a
SHA-256 filename under the authenticated owner's public prefix. The current upload UI
hashes the final bytes (after any watermark), allows only PNG/JPEG/WebP/GIF or MP4/WebM,
uses `upsert:false`, and reuses only an identical-content duplicate path.

That guarantee does not extend to legacy URLs or arbitrary external HTTPS avatar, banner,
background, post, album, product-image, audio, live-embed, or link fields. The review
manifest commits their URL text, not independently fetched bytes, and the public render
path never fetches those URLs to establish a content hash. A remote host can therefore
change bytes at the same URL after review. External assets are URL-reviewed but are not
byte-integrity-bound; owners must migrate release-critical media into the first-party
immutable path or add a server-side ingest/hash/provenance system before claiming byte
immutability. First-party paths also retain the owner-UUID correlation blocker documented
in `PERSONA-PAGE-LAYOUT-BUILDER.md`.

## Security controls and limits

Migration 051 supplies database primitives, not a complete edge defense:

- optional Auth password/MFA verification hooks with progressive timeouts;
- account lock state with Auth-user cascade deletion;
- severity-classified security events;
- SHA-256 identifier slots and network blocks, with no raw IP storage;
- staff-readable sanitized application errors;
- a service-only retention purge for 90-day friend-request telemetry, 400-day security
  telemetry, expired invites, and expired network blocks.

The historical insert-open `error_logs` path is removed in migration 051. Anonymous
sessions keep errors in the local browser buffer; authenticated users can call only the
bounded `report_client_error` RPC, which fixes server-authored fields, redacts common
credential/contact/URL patterns, and enforces a per-account hourly cap. Direct browser
insert/update/delete is revoked and only staff may read sanitized rows. This source state
is not proof that the legacy production policy has already been replaced.

Production DDoS and abusive-login handling must be enforced at Supabase Auth plus the
CDN/WAF edge. A browser cannot reliably enforce an IP block. Email notification requires
configured SMTP/provider delivery and a tested recovery flow. A database row marked
`notification_pending` is not an email.

The optional password/MFA hooks must not be enabled casually: a targeted attacker could
otherwise lock a known account. Test rate limits, CAPTCHA, recovery, AAL2, trusted-session
behavior, and break-glass administrator recovery in staging first.

Staff feature and extension decisions require AAL2 in the database. Draft/withdrawn
feature requests, owner review notes, and unsubmitted extension source are not exposed to
staff. Extension approval remains only a recorded review decision; it does not execute or
release source.

## Export, restore, and erasure

Portable JSON, XLSX, and the complete privacy export cover family/groups, projects and
resources, business drafts and memberships, publication reviews, feature requests,
friend policy/follows, account-sync preferences, extension drafts, and the caller's
bounded security records. Export fails closed if any required section cannot load.

Restore remaps persona/project/business/group UUIDs, forces persona and business pages to
unpublished owner-safe states, pauses projects, disconnects and disables resources, and
restores only owner-authored feature/extension drafts. It never restores provider
connections, account-sync authority, follows/friends, invitation hashes, staff roles,
staff decisions, or security state. Content-only and full-account erasure explicitly
remove the new owner data before ledgers/personas; full deletion additionally removes
self-attributable security events and account-scoped network blocks.

The browser validates a backup before the first mutation: files are limited to 20 MB,
restorable sections and the aggregate row count are bounded by the matching database
storage contracts, and every awaited restore write is bracketed by the initiating account
and auth-generation check. Logout or account switching aborts the remaining work without
reloading or presenting a success result under the new session; any earlier committed rows
remain a partial restore and must be reviewed before retrying.

## Release order

1. Back up the project and inventory every currently visible persona, business page,
   active offer, request-review object, and legacy public asset URL. Treat migration 051's
   persona-unpublication and business-draft backfills as expected release effects.
2. Prove the predecessor schema, hash-check the final canonical/mirror pairs, and rehearse
   the exact `RELEASE-MANIFEST-2026-08-22.md` sequence in a matching non-production
   Supabase/PostgreSQL 16 project. Do not record migration history by hand.
3. Run the static and browser tests documented in `VERIFICATION.md`.
4. Verify RLS with two unrelated Auth users, anonymous access, direct-DML denial,
   deletion cascades, and rollback.
5. Deploy `request-review` and `affiliate-redirect` only after their database contracts,
   exact versions, secrets, HTTPS/privacy checks, and rollback are verified. Keep the
   request-review global gate closed and every persona disabled.
6. Manually deploy matching functions only after database readback, then manually deploy
   the frontend only after functions and signed-in staging smoke succeed. Both workflows
   require `MIGRATIONS-VERIFIED`; a push deploys neither.
7. Verify every legacy persona is absent from anonymous discovery immediately after 051;
   publish only separately reviewed exact revisions.
8. Verify an edited published page returns to draft and cannot be republished without a
   matching review.
9. Verify friend/follow behavior with two real test accounts and no production personas.
10. Assign the initial maintenance role only after confirming the exact owner Auth UUID.
11. Configure provider, Auth, CAPTCHA, WAF, log, SMTP, and retention operations one at a
   time, recording the evidence and rollback for each.

See `OWNER-APPROVAL-QUEUE-2026-08-22.md` for the exact owner-gated operations.
