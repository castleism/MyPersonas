# AliaSpaces / MyPersonas Verification Checklist

Status: ⬜ untested · ✅ pass · ❌ fail (see note) · ⏭ skipped/blocked

Release-package status: **Implemented and tested locally; not pushed, applied to the
linked database, deployed, configured, activated, or verified live unless separately
evidenced.** The frozen coordinated local run completed at `2026-08-23T06:54:04Z`;
its exact counts and migration hashes are recorded in `RELEASE-MANIFEST-2026-08-22.md`.
That manifest also distinguishes this complete release package from the incomplete
fresh-install history in `supabase/migrations/`.

## Coordinated release 047–057 — final verification gate

- ✅ Canonical and timestamped release files now exist locally for 047, 048, 049, 050,
  hardened prerequisite 043, and 051–057. This is packaging evidence only.
- ✅ The frozen release run passed 259/259 Node tests, inline plus three external
  frontend syntax checks, all 28 Edge Function type checks, the seven-case scheduled
  AI-budget behavior suite, 12 canonical/mirror SHA-256 pairs, and PostgreSQL 16
  apply/reapply plus runtime assertions. Exact hashes and database evidence are in the
  release manifest.
- ⏭ Do not infer a safe blank-project install from `supabase/migrations/`. Its historical
  chain omits some canonical 019–046 prerequisites. Before any linked apply, inventory
  and prove the target's predecessor schema, then rehearse the manifest sequence in a
  matching isolated staging project.
- ⏭ Database application must precede Edge Function deployment, which must precede the
  Pages deployment. Both deployment workflows are manual and require the exact typed
  confirmation `MIGRATIONS-VERIFIED`; pushes run validation but do not deploy.
- ⏭ No Auth hook, SMTP sender, CAPTCHA, WAF/DNS rule, log drain, SSO, staff seed, provider
  credential/project, payment system, affiliate activation, public publication, or model
  spend is evidenced by local implementation or tests.

Final freeze record:

- [x] Git HEAD `ae5d9636fca8617bd6a47044f1e6c62dd1eb060b` plus a reviewed dirty-worktree
  inventory; no commit, push, or release tag was created.
- [x] Final SHA-256 for all 12 canonical/timestamped pairs recorded in the manifest.
- [x] Complete Node suite: 259 tests, 259 pass, zero fail/cancel/skip/todo.
- [x] Inline and external frontend syntax, XSS/static UI contracts, Markdown local links,
  high-confidence credential scan, and `git diff --check` passed.
- [x] `deno check` passed for all 28 configured Edge Function entrypoints; scheduled
  budget behavior passed 7/7 and its files passed `deno fmt --check`.
- [x] Disposable PostgreSQL 16.15 through-046 baseline, exact seed, ordered 047–057
  package apply/reapply, and exact readback passed.
- [x] AAL1/AAL2, anonymous/owner/other-owner, direct-DML, concurrency, erasure,
  idempotency, expired-run recovery, budget, and terminal-audit evidence passed locally.
- [x] Signed-out desktop browser smoke loaded the frozen Agent Board asset with no
  horizontal overflow or console warning/error and showed the truthful sign-in boundary.
- [ ] Named owner/reviewer signature, signed-in staging identities, mobile visual smoke,
  linked-project backup/readback, rollback approval, and every explicit external gate.

## Overview / Persona view and Page looks — local check 2026-08-22

- ✅ Migration 058 and its timestamped mirror are byte-identical. Disposable PostgreSQL
  16 applied the migration twice and passed exact-actor, sibling non-inheritance,
  dependency block/mute, private pending-request redaction/cancel/respond, API-role/RLS,
  internal-helper privilege, and two-session dependency-replacement race assertions.
- ✅ The complete Node suite passes 268/268, including UID-scoped mode restore,
  actor-stable asynchronous actions, server capability status, owner-chrome suppression,
  full reviewed module/layout rendering, generic metadata reset, safe asset previews, and
  uncropped Page looks contracts. Inline and all three external scripts parse.
- ✅ Rendered desktop (1280×900) and mobile (390×844) fixtures show all four tall/wide/
  square/panoramic source frames with `object-fit: contain`, zero image corner radius,
  preserved aspect ratios, and no horizontal overflow. The mode switch, action-only
  private-request card, and complete profile module grid fit both viewports; browser logs
  contain no warnings or errors.
- ⏭ Migration 058 is not applied to a linked project and the matching Pages assets are
  not deployed or verified live. Signed-in staging, real-account privacy checks, and the
  manual release workflow remain required before enabling this surface publicly.

## Publication, social, and security governance — local check 2026-08-22

- ✅ Canonical migration 051 and its timestamped mirror have been synchronized locally.
  Final parity hash evidence belongs in the frozen release record, not this working note.
  The governance contract covers explicit publication, exact manifest/dependency hashes,
  lifecycle-field denial, revision invalidation, native staging plus post-commit
  reconciliation, AI disclosure, service-only roles and retention, confirmed feature
  tickets, separate follow/friend flows, provider-sync boundaries, inert custom source,
  hashed network identifiers, and UI/RPC wiring.
- ✅ Static source inspection confirms migration 051 backfills every legacy persona with
  no lifecycle state to `unpublished`, clears its published revision/timestamp, and resets
  every legacy business to an owner-only draft. A crafted persona insert is forced to a
  draft lifecycle by the database trigger. These are migration semantics, not evidence
  that production rows have changed.
- ✅ The local public renderer contains reviewed Family and Offers & review requests
  modules. The old native auto publisher is revoked/wrapped to fail closed; an approved
  native draft stages into the page and is finalized only after exact page publication.
- ✅ Migration 051 removes the historical open `error_logs` insert policy and direct
  browser writes. `report_client_error` requires authentication, redacts a bounded shape,
  fixes server-authored fields, and applies a serialized per-account hourly cap.
- ✅ The stale source-shape and mirror assertions recorded during concurrent editing were
  repaired in the local release candidate. The frozen 259/259 suite and final 051 hash
  now replace the earlier focused checkpoints.
- ✅ The legacy phase-1 `link_review_request_to_draft` SECURITY DEFINER function now
  denies anonymous and cross-owner callers with no mutation. PostgreSQL runtime proof
  also verifies authenticated-owner success and the exact legacy RPC privilege matrix.
- ⏭ Migration 051 is not applied and the frontend is not deployed/live-verified. Auth
  hooks, rate limits, CAPTCHA, audit storage, email, WAF, log drains, SSO, staff-role seed,
  and provider sync workers remain explicit staging/owner gates.

## Castleborn family/project/business — disposable database check 2026-08-22

- ✅ Migration 049 and its mirror are byte-identical; seven focused tests pass.
- ✅ A disposable PostgreSQL 16 apply proved 20 parent rows, four partner rows, 21 project
  memberships with one WAIS manager, one blank owner-private business draft, and no
  fabricated resource or business membership.
- ✅ Owner RLS returned all 24 irreducible family rows while another owner and public
  projections returned zero. Direct write, cross-owner RPC, and ancestry-cycle attempts
  were denied; Lilly's derived family projection returned five relatives.
- ⏭ Migration 049 is not applied/deployed. A real Castleborn database resource, public
  mission/bio, and public business titles still require authoritative owner input.

## Persona asset preview and safe page designer — local check 2026-08-22

- ✅ Migration 050 and its timestamped Supabase mirror are byte-identical. Focused tests
  cover RLS/grants, the narrow public projection, strict recipe and snippet bounds,
  unknown/duplicate rejection, and owner/persona enforcement.
- ✅ Executable helper tests prove unknown modules and unsafe link widgets are removed,
  card settings normalize to allowlisted values, generated HTML/CSS/JSON remains text,
  and common code selections receive local explanations without a model call.
- ✅ Static asset tests cover the owner-only gate, profile/banner/background/feed-header,
  album and post-media entry points, accessible modal markup, credential-free fetching,
  a nonempty inert-media MIME allowlist, matching file/container signatures, rejection
  of active/unknown/mislabeled payloads, MIME-only extensions, 50 MB streaming
  cancellation, sanitized filenames, object URL revocation, and honest CORS fallback.
- ✅ The local builder supports eleven built-in modules, including Family and Offers &
  review requests. Approved-media tests cover final-byte SHA-256 hashing after watermarking,
  allowlisted PNG/JPEG/WebP/GIF and MP4/WebM types, append-only `persona-media` paths,
  duplicate-content reuse, and the persona-scoped composer path.
- ✅ The inline application script and external owner/governance/Agent Board scripts pass
  syntax checks; `git diff --check` passes. The complete frozen suite is 259/259.
- ⏭ Migration 050 is not applied and the matching page is not deployed or live-verified.
  Cross-owner/anonymous database behavior and signed-in keyboard/mobile/media smoke tests
  remain release checks.
- ⏭ Image/video widgets and video backgrounds remain blocked. Current public Storage
  URLs expose a stable owner UUID prefix that can correlate personas; release requires
  the opaque-asset remediation in `PERSONA-PAGE-LAYOUT-BUILDER.md`.
- ⏭ Legacy and external HTTPS media are not byte-integrity-bound. The manifest hashes
  URL-bearing JSON and does not fetch remote bytes; a remote host can replace content at
  the same URL after review. Owner preview/download copies current bytes without proving
  they match the reviewed bytes.

## Request-review and affiliate intake — local source check 2026-08-22

- ✅ `tests/request-review-spec.test.mjs` passes all eight focused source checks for exact
  configured CORS origin, streamed 16 KiB body cap before JSON parse, fail-closed config,
  Turnstile timeout/action/hostname, normalized field/consent/idempotency bounds, public
  HTTPS URL validation with no requester-URL fetch, rotating domain-separated HMACs,
  neutral non-enumerating receipts, service-RPC usage, and the intentional public JWT
  gateway flags.
- ✅ The TypeScript source parses with Node's type-stripping syntax check. This is not a
  Deno network run, a Turnstile verification, a database concurrency test, a deployed
  function comparison, or an email-delivery test.
- ✅ Hardened `043-request-review-phase1.sql` now has the ordered local mirror
  `20260822160000_request_review_phase1.sql`. Its presence does not apply or activate the
  feature, and it does not make the wider timestamped folder a complete fresh-install chain.
- ⏭ `CONFIG.TURNSTILE_SITE_KEY` is blank and the required Edge values are not documented
  as installed. The global request gate and every persona start disabled. No notification
  sender/claim worker or owner evidence/review queue exists, so no email or review outcome
  is claimed.
- ✅ The local `affiliate-redirect` source now fails closed without a distinct
  `AFFILIATE_CLICK_HMAC_SECRET`, bounds the offer URL and attribution fields, derives
  rotating domain-separated HMAC identifiers, and permits only credential-free HTTPS
  destinations. The latest canonical 051 source adds an atomic current-page resolver,
  global/offer/fingerprint caps, click deduplication, conditional analytics, and a
  service-only 400-day retention RPC.
- ✅ The stale affiliate source-shape assertion and the missing 051 mirror additions were
  repaired locally. Final focused/full-suite output and pair hashes remain freeze evidence.
- ⏭ No Edge secret, deployment, live source-parity check, real Turnstile verification,
  email notification, or approved service-role retention schedule is evidenced.

## Business, agent-board, research, audit, auth, and budget hardening — local check 2026-08-22

- ✅ Migration 052 adds exact-revision, owner-reviewed, AAL2 business publication and
  returns changed public business material to draft. It does not publish a business.
- ✅ Migration 053 and the board endpoints/UI implement a bounded owner queue whose
  automated execution path is default-off, human-approved, exact-request/idempotency
  bound, and recoverable after expiration. Frozen static and PostgreSQL runtime checks
  prove browser calls cannot invoke automated proxy modes, reviewed inputs cannot drift,
  and exact retries cannot create a second run or provider authority.
- ✅ Migration 054 moves research/content writes behind bounded owner/service RPCs,
  durable daily/lifetime counters, and server-authored approval/provenance fields. It
  requires AAL2 after the exact row lock before a draft save can downgrade an approved or
  scheduled package; it neither performs research nor publishes content.
- ✅ Migration 055 places agent audit inserts and terminal updates behind reserved
  capacity, row/byte/mutation ceilings, narrow service RPCs, and erasure serialization.
  Frozen PostgreSQL checks cover over-limit recovery, started-to-terminal behavior,
  direct-DML denial, rolling-worker compatibility, and writer/erasure concurrency.
- ✅ Migration 056 revokes only stale `aliaspaces_confirmed_email` attestations when the
  Auth email is changed or unconfirmed; provider/OAuth connection attestations remain
  separate and are not silently disconnected.
- ✅ Migration 057 adds durable per-owner/backend/mode request-token budgets and leases.
  `agent_board` and `automation` remain denied unless an owner saves an enabled AAL2 policy
  with nonzero limits; it stores no provider pricing and does not authorize spend. The
  scheduled worker now reuses its exact v2 audit UUID as the automation-budget request
  key and cannot cross the provider boundary without a successful claim. Frozen Deno
  behavior covers no-provider denial, known-zero/known-usage accounting, and conservative
  ambiguous post-fetch accounting.
- ⏭ Migrations 052–057 and their matching functions/UI are local release-candidate source.
  None is applied, deployed, configured, activated, or live-verified.

## Private persona backup relationships — local check 2026-08-22

- ✅ The two migration paths are byte-identical. Static checks cover the same-owner
  composite cascades, one-main/one-backup constraints, self and role-conflict rejection,
  serialized owner validation, RLS, revoked browser DML, and authenticated setter RPC.
- ✅ Executable grouping tests prove a backup appears once beneath its main, a main click
  expands it, an active backup auto-expands its parent, and missing/corrupt relationship
  data fails flat without hiding any persona.
- ✅ Editor save/removal, readback verification, mobile picker labeling, JSON/CSV/XLSX
  export, version-2 UUID-remapped restore, version-1 compatibility, and the repaired
  `account_persona_links` export state are covered by eight feature tests.
- ✅ At the backup-feature checkpoint, the full local Node suite passed 119 tests with no
  failures and the syntax/diff checks passed. That historical checkpoint is not the current
  release result; use the publication-governance section above for today's unresolved run.
- ⏭ The in-app browser blocks `file:` and synthetic `data:` navigation, so a visual local
  fixture could not be opened there. No alternate browser-policy workaround was used.
  A signed-in visual smoke test remains part of the release checklist.
- ⏭ Migration 048 is not applied, the page is not deployed, no backup pair was written to
  a live account, and cross-owner/direct-DML/deletion behavior still requires a rollback
  test in a non-production Supabase environment before release.

## Persona full-name canon — production data check 2026-08-22

- ✅ The exact handle-keyed statement in
  `supabase/migrations/20260822113925_persona_full_name_canon.sql` completed in the
  production Supabase SQL Editor without an error.
- ✅ An independent public REST read matched all 19 expected existing handles and names
  against `content/persona-full-name-canon-2026-08-22.json`: 19 matched, 0 mismatched.
  `castleborn.abel` remained absent as intended; no persona row was created.
- ✅ The connected Accounts spreadsheet range `Sheet1!A6:A24` was read back as the same
  19 full names and visually inspected in Google Sheets. Existing row colors and the other
  account/provider columns were preserved.
- ✅ At the full-name checkpoint, the full local Node test suite passed 111 tests with no
  failures and `git diff --check` passed. This remains evidence for that data change, not
  a current whole-release result.
- ⏭ Direct SQL Editor execution does not write Supabase CLI migration history. A later
  linked `supabase db push` may rerun this idempotent file once to record version
  `20260822113925`; do not fabricate the history row manually.

## Provider management and Meta Page pairing — release check 2026-07-29

- ✅ Migration 018 is live on project `nwsqyuucwzihruszocge`. All eight Meta tables
  have row-level security; `anon` and `authenticated` have no direct table-read or
  function-execute access; all 21 connector functions are service-role-only. The Meta
  transaction, candidate, grant, cleanup-hold, Page-connection, and erasure-lease tables
  were empty after deployment.
- ✅ Rollback-only production tests proved the owner-locked state machine: erasure
  atomically cancels pending OAuth, blocks new OAuth, cannot be released by the wrong
  lease ID, and refuses to begin while a code exchange is in fail-closed processing.
- ✅ Active Edge versions are `delete-account` v17 and `erase-content` v10 with gateway
  JWT verification on, plus `meta-oauth` v1 with gateway verification off for the
  provider callback. The Meta function validates signed-in POST actions itself.
- ✅ Production probes accepted the exact MyPersonas origin, rejected an unapproved
  origin for both preflight and POST, rejected unsigned capabilities, returned the
  expected configuration-required response for start, and safely redirected an invalid
  callback state without reflecting it.
- ✅ Deno format/type/lint checks passed for all changed functions. Independent
  high-severity review covered OAuth single-use processing, ambiguous exchanges,
  immutable identity reservation, exact manual-revocation checkpoints, shared-grant
  disconnect, owner erasure leases, cross-request acknowledgements, and profile deletion;
  no release blocker remained.
- ✅ All five public HTML files parsed with no duplicate IDs, broken local references, or
  inline-JavaScript errors. The account ledger, setup page, and owner guide contain the
  same 39 providers; the Pages artifact includes every intended public policy/setup file.
  Migration 018 exactly matches its consolidated-schema copy.
- ⏭ `META_APP_ID`, `META_APP_SECRET`, and `META_LOGIN_CONFIG_ID` are not installed, so a
  real Facebook Page/linked-Instagram authorization is correctly configuration-gated.
  Publishing permissions and external Meta posting remain intentionally absent.
- ⏭ Real signed-in owner, Gmail re-consent/mailbox action, Meta asset selection, X
  authorization, and phone interaction remain owner-run smoke tests. No mailbox was
  scanned, no Page was connected, and no external content was posted during this release.

## Grouped accounts and X OAuth foundation — backend/static check 2026-07-23

- ✅ Migration 015 applied to project `nwsqyuucwzihruszocge`. The three service-only
  X tables exist with RLS enabled; the Vault-cleanup and ledger-guard triggers exist;
  all six token/state RPCs exist; `anon` and `authenticated` cannot execute the token
  retrieval RPC or select the credential table; `service_role` can.
- ✅ Active Edge versions are `twitter-oauth` v1 with gateway JWT verification off,
  `delete-account` v12 with it on, and `erase-content` v5 with it on. X callback CORS
  accepted the production origin, and an unsigned capabilities request was rejected.
- ✅ No `X_CLIENT_ID` or `X_CLIENT_SECRET` is installed. The deployed start endpoint
  returned the expected setup-required response without creating an OAuth transaction.
  This is an explicit operational blocker, not a simulated connection.
- ✅ Deno formatting, type-checking, and linting passed for `twitter-oauth`,
  `delete-account`, and `erase-content`. The main inline app script parsed, migration
  015 exactly matched its one consolidated-schema copy, SQL structural assertions
  passed, required grouping/connector markers were present, and Git whitespace checks
  passed.
- ✅ Independent fail-closed review covered concurrent OAuth completion, malformed or
  ambiguous token/refresh responses, shared-grant cleanup, missing credentials,
  revocation failure, provider-specific erasure acknowledgment, and direct ledger
  deletion/identity changes. No blocking static or security defect remained.
- ⏭ A real X authorization, refresh, revocation, and username-match test is blocked
  until a production X Web App, exact callback, client credentials, and current API
  access are installed. Automated X posting remains intentionally disabled and no
  `tweet.write` permission is requested.
- ⏭ Signed-in phone/browser interaction was not exercised in this release pass; no
  owner account, persona assignment, or existing connection was mutated.

## Agent control center release — backend smoke run 2026-07-20

Repository implementation, backend deployment, and signed-in browser behavior are separate
evidence. The backend smoke checks below were observed against project
`nwsqyuucwzihruszocge`; user-flow checks remain blank until exercised with a real persona,
model, schedule, and draft.

Observed in this release:

- ✅ Migration 011 is live and its historical file remains unchanged. The fresh-install
  schema embeds that immutable migration followed by exact copies of deltas 012–014.
- ✅ Migrations 012, 013, and 014 are live. Retry and approval hardening, fair owner
  rotation, durable queue state, server-side input and active-schedule limits, and atomic
  persona saves all passed object, trigger, and role-grant checks.
- ✅ Final Edge versions are active: `ai-proxy` v9, `post-bridge` v4, `run-tasks` v10,
  `run-publish-queue` v4, `fan-chat` v4, `gmail-oauth` v4, `delete-account` v9, and
  `erase-content` v2, each with its documented JWT setting.
- ✅ `CRON_SECRET` and `FAN_CHAT_SALT` are installed. Vault contains exactly one
  `mypersonas_cron_secret`; stored cron commands contain only the Vault lookup.
- ✅ With both jobs paused, production requests 50 and 51 called the final workers through
  `pg_net` using the Vault secret. Both returned HTTP 200 with zero due work; the two
  five-minute jobs were then resumed and independently read back as active. Their first
  scheduled runs at 15:55 UTC succeeded, and resulting requests 52 and 53 also returned
  HTTP 200 with zero due work.
- ✅ Final inline application JavaScript, JSON-LD, eight touched Edge functions, SQL parser,
  all-zone time conversion, migration 014 transactional rollback, and Git whitespace
  checks passed. Supabase's advisor warning for the authenticated atomic-save function is
  expected: that security-definer RPC is intentionally authenticated-only and performs
  owner checks with an empty search path.
- ✅ Commit `9de2a78` reached `mypersonas.online` at 2026-07-20 15:51:56 UTC. A signed-in
  smoke check loaded the owner Matrix, all six control-center tabs, the manual cadence,
  batch account picker, quick-create persona option, and connected Gmail state with no
  browser-console errors. No persona, account, schedule, draft, or connection was changed.
- ✅ The live Pages artifact serves the app and runtime assets, while verification/setup
  notes, the consolidated schema, individual migrations, and Supabase deployment notes
  each return HTTP 404.

Prerequisites: the new Edge code staged while both workers are paused; migrations 001–014
applied in order; `erase-content` deployed before the compatible `index.html`;
`CRON_SECRET` and `FAN_CHAT_SALT` set;
all eight release functions deployed with the documented JWT settings; both workers
scheduled every five minutes; at least one owner-linked model and one SFW public test
persona available. If custom model hosts are used, set `SCHEDULE_AI_HOSTS` and
`FAN_CHAT_AI_HOSTS` independently.

### Database and privacy

- [ ] A1. Before migration 011, the newly deployed `ai-proxy` can still use an existing
      legacy owner key; the new workers remain unscheduled until their RPCs exist — ⏭ no
      legacy model key existed to exercise; workers remained unscheduled until migration
- [x] A2. Migration 011 completes without error; the Vault credential map, model CRUD/key
      RPCs, task leases, daily usage table, fan reservation RPCs, atomic native publisher,
      triggers, and partial indexes exist — ✅ live apply and object/signature checks passed
- [x] A2b. Migration 012 completes in one transaction; its retry/due/dequeue RPCs, new
      columns/indexes, narrowed persona/fan grants, durable message id, and invalid-approval
      repair exist before either worker resumes — ✅ live object, grant, and repair checks
- [x] A2c. Migration 013 installs service-only fair candidate/claim RPCs, a protected
      owner-rotation state table, prompt-byte triggers on all four input sources, and the
      100-active-schedule trigger before the final worker resumes — ✅ live objects,
      service/auth/anon grants, RLS, and five trigger attachments checked
- [x] A2d. Migration 014 installs one authenticated-only atomic persona-bundle save with
      owner, linked-persona, Top 8, model, size, and count validation — ✅ compiled and
      transactionally exercised twice under rollback, then applied live; anon execute is
      false and authenticated execute is true
- [ ] A3. Every non-empty legacy model key has a Vault mapping and an empty legacy
      `api_key`; the linked model still responds through `ai-proxy` after migration — ⏭
      no linked model/key existed; confirmed zero non-empty plaintext keys
- [ ] A4. Browser model create/update/delete uses the owner RPCs. The browser cannot read
      Vault mappings, execute `ai_backend_get_key`, or directly write `ai_backends` — ⬜
- [ ] A5. Deleting one model connection and deleting all model connections remove their
      associated Vault secrets without affecting another owner — ⬜
- [ ] A6. A signed-in browser can load its own personas through `my_personas`, but anon
      and authenticated table reads cannot select `personas.owner` — ⬜
- [ ] A7. A new/existing persona has one binding and one native destination; account and
      persona assignment guards reject cross-owner or mismatched rows — ⬜

### Direction and safety controls

- [ ] A8. Matrix shows Direction, Targets, Schedule, Queue, Fan inbox, and Audit on phone
      and desktop widths; a database-not-ready state appears cleanly before migration —
      ✅ live signed-in desktop tabs; ⬜ final real-phone width check remains
- [ ] A9. Direction fields persist and are present in a generated draft's server-built
      prompt; persona hard rules remain authoritative — ⬜
- [ ] A10. L0 allows co-writing only and L1 enables scheduled drafts. Under migration 051,
      neither L2 nor L3 auto-publishes native page content: an exact-approved draft is
      staged, advances the persona revision, and remains nonpublic until the owner reviews
      and publishes that exact page revision — ⬜
- [ ] A11. Global pause and persona pause each stop new persona AI calls, draft generation,
      publishing, and new fan-chat requests; resume restores only previously enabled
      paths — ⬜
- [ ] A12. Direction, pause, autonomy, destination, generation, approval, publish, and fan
      events appear in the owner-only audit view — ⬜

### Scheduling and drafts

- [ ] A13. A daily schedule and a weekly schedule calculate the expected next generation
      and publication time in the selected time zone, including preparation lead time — ⬜
- [x] A14. Both stored cron commands read `mypersonas_cron_secret` from
      `vault.decrypted_secrets` and contain no literal credential. Both endpoints reject a
      missing/wrong `X-Cron-Secret` with HTTP 403 — ✅ final workers probed while paused:
      both HTTP 200 with zero due work; jobs then resumed, ran on schedule, and produced
      two more HTTP 200 responses
- [ ] A15. `run-tasks` ignores future, inactive, paused, L0, invalid-claim, mismatched, and
      quiet-hour tasks and records a useful status/audit reason — ⬜
- [ ] A16. Concurrent calls for one due task produce only one UUID lease, one reserved
      daily model-call unit, at most one provider request, and one task/time-slot draft — ⬜
- [ ] A17. The owner's local-day cap is atomic across different tasks. A reserved provider
      call counts even if the provider fails, and an over-cap call is never sent — ⬜
- [ ] A18. A lease expires/retries safely after an interrupted worker; transient failures
      retain the intended slot for at most three exponential retries, permanent failures
      advance it, and an old lease token cannot mutate a newer worker's task — ⬜
- [ ] A19. A due eligible task produces an unapproved draft. Generation never sets exact
      approval or silently enables a destination — ⬜
- [ ] A20. Approving stores the exact-content hash and queues the selected time. Editing
      content, target, format, or time clears approval and removes the draft from queue — ⬜

### Publishing boundary

- [ ] A21. `post-bridge` rejects signed-out users, non-owners, inactive claims/bindings,
      insufficient autonomy, manual targets, invalid approvals, caps, and quiet hours — ⬜
- [ ] A22. An eligible L2 exact-approved draft remains waiting when cron runs, then
      publishes exactly once only after the owner presses Publish now — ⬜
- [ ] A23. An eligible exact-approved native draft stages idempotently into the persona
      page but cannot become public from a queue invocation. Only exact owner page review
      and `publish_persona_page` finalize it; repeated reconciliation is idempotent — ⬜
- [ ] A24. Staging/publishing cannot expose a post without the matching current page
      revision, unchanged approved-draft hash, finalized draft provenance, and audit row — ⬜
- [ ] A25. Every external destination returns a clear gated/no-write-connector result even
      when the ledger account is ownership verified or Gmail API connected — ⬜
- [ ] A26. After the owner posts externally by hand, “mark manually posted” records the
      state; it cannot be used for a native draft — ⬜

### AI and fan chat

- [ ] A27. `ai-proxy` requires a valid owner session, refuses another owner's persona or
      model, strips browser system messages, honors pause/binding controls, and audits the
      persona request without logging credentials — ⬜
- [ ] A28. `SCHEDULE_AI_HOSTS` plus its Matrix confirmation extends only scheduled
      generation; `FAN_CHAT_AI_HOSTS` plus its separate confirmation extends only fan chat;
      an unlisted or unconfirmed custom host is refused — ⬜
- [ ] A29. Fan chat is off by default and unavailable for private, paused, inactive,
      unclaimed, or NSFW personas. A client-side 18+ acknowledgment does not bypass the
      server NSFW block — ⬜
- [ ] A30. Two concurrent messages for one session cannot both obtain the response lease.
      Hourly visitor and persona-local-day quotas, fan-message storage, audit, session
      state, and the 90-second response lease are reserved atomically — ⬜
- [ ] A31. Only the matching response UUID can store the assistant reply and clear the
      lease; retrying an old completion cannot create a duplicate reply — ⬜
- [ ] A32. The fixed disclosure says AI and owner review. Commercial, dispute, self-harm,
      or hard-rule signals flag the inbox without promising an owner reply or takeover — ⬜
- [ ] A33. Export includes owner-visible automation/chat data without visitor hashes.
      Delete-my-data removes daily usage, automation, messages, transcripts, and audit
      rows, including Vault secrets through model deletion — ⬜
- [ ] A34. Authenticated `erase-content` capabilities report protocol v2,
      `contentOnly:true`, and `fullAccount:false`; the page refuses every older or
      ambiguous contract — ⬜
- [ ] A35. On a disposable owner, confirmed content erasure preserves the auth login but
      removes every owned persona/post/media/ledger/model/automation/chat row plus profile
      display name and preferences. Gmail revocation happens first, and any OpenRouter
      backend requires provider-side key-revocation acknowledgment — ⬜
- [x] A36. The Pages artifact contains only `index.html`, runtime assets, CNAME,
      `.nojekyll`, robots, and sitemap; it contains no setup guides, SQL, verification
      notes, source snapshots, or private mailbox addresses — ✅ workflow allowlist plus
      live 200 checks for app/assets and 404 checks for representative internal files
- [ ] A37. A persona with more than 30 posts exposes Load more; repeated loads use stable
      newest-first created-at/id ordering, and Posts/Reels/search filters continue through
      older pages without duplicates or silently stopping at 50 — ⬜
- [ ] A38. Switching directly between two signed-in accounts immediately removes the old
      owner's Matrix, draft, fan, audit, and chat UI; late requests and OAuth callbacks
      cannot repopulate it — ⬜ requires two disposable signed-in accounts
- [ ] A39. Discovery, recent/tag feeds, persona posts, and audit history load stable keyset
      pages on demand, preserve filters, and neither duplicate nor skip equal-timestamp
      rows — ⬜ live multi-page data set required
- [ ] A40. A manually queued wall-clock time is stored and displayed in the configured
      owner time zone, independent of phone location; a DST-gap time is rejected — ⬜
- [ ] A41. Fan replies remain default-off and SFW-only; unsafe generated output is discarded,
      replaced by the bounded refusal, escalated, and audited before any response is stored
      or returned — ⬜ disposable fan session and intentionally unsafe model fixture required

## Yahoo and iCloud account records — 2026-07-23

- [x] M1. Yahoo Mail and iCloud Mail are present in the private account-ledger provider
      picker and inherit saved-account autofill, editing, persona assignment, and quick
      persona creation from the generic ledger flow.
- [x] M2. Case-insensitive duplicate detection uses the recorded email independently for
      each mail provider; distinct addresses and different providers remain distinct.
- [x] M3. Yahoo and iCloud remain private-ledger-only choices, do not appear in the public
      persona-link selector, never expose Gmail OAuth actions, and state that mailbox/API
      access and external publishing are unavailable.
- [x] M4. The final inline application JavaScript parses and targeted provider, picker,
      public-link exclusion, duplicate-identity, and safety-guidance assertions pass.
- [ ] M5. Add, edit, assign, export, and delete disposable Yahoo and iCloud records in a
      signed-in production session — ⬜ intentionally not performed against the owner's
      real account records during this code-only release.

## Historical v0 verification (2026-07-10)

Prereqs: sql-updates 001, 002, 003, 004 run in Supabase; latest commit pushed and
deployed (Actions green); hard refresh.

Verification round 2026-07-10 run by Claude (browser automation) + Christian.

## Setup & shell
- [x] 1. SQL updates 001-004 applied — ✅ (004 added this round: persona-create RLS fix)
- [x] 2. https://aliaspaces.com loads with padlock; favicon shows the blue P — ✅ (favicon.svg served 200)
- [ ] 3. Signed out (incognito): welcome hero + 3 "What is AliaSpaces" cards + Get started — ⬜ needs signed-out browser (Christian)
- [x] 4. Signed in: DNA background appears behind pages — ✅
- [x] 5. Nav reads Entangle / Matrix; no emojis anywhere; blue glowing icons on card headings — ✅

## Auth
- [ ] 6. Google sign-in round-trips back signed in — ⬜ (Christian — automation can't handle credentials)
- [ ] 7. Magic link email arrives and signs you in — ⬜ (Christian)
- [ ] 8. Sign out → sign back in works — ⬜ (Christian)

## Onboarding & settings
- [ ] 9. Fresh account (no personas): onboarding page with "Create your first persona" + settings card at bottom — ✅ hero + button shown; settings card was NOT on the welcome page (it shows in Matrix) — confirm whether card had already been saved once
- [ ] 10. Save settings → card collapses; doesn't reappear on welcome page later — ⬜ (needs fresh account to observe)
- [ ] 11. Autofilled fields render white immediately (no gray boxes) — ⬜ (needs real browser autofill)

## Personas
- [x] 12. New persona form shows basics only; no example placeholder text — ✅
- [x] 13. Quick setup: step 1 multi-select; suggestions merge from multiple categories; platform placeholders added to links — ✅ (Product reviewer + Gamer merged into topics/voice/purpose; 9 platform link placeholders added)
- [x] 14. Persona SAVES without RLS error — ✅ after sql-updates/004. ROOT CAUSE (was ❌): insert().select() returns the new row; the returned row must pass the personas SELECT policy; persona_visible() (security definer, STABLE) re-queries personas and cannot see the row inserted in the same statement → 42501. Edits worked (no representation requested), creates always failed — hence "intermittent". NOT a session-expiry bug.
- [x] 15. Page looks: Choose file → upload → preview updates; Clear empties the slot — ✅ (avatar uploaded to media/<uid>/ folder, preview updated, Clear emptied, avatar persisted after save; OS picker itself un-automatable but the full pipeline verified)
- [ ] 16. SD panel docks bottom-right; generates via local A1111/Forge — ⏭ needs Christian's local SD with --api --cors-allow-origins=https://aliaspaces.com
- [x] 17. Saved page renders: banner, avatar, song player, link chips, Top 8, theme color — ✅ (theme-gradient banner fallback + avatar placeholder with no images; YouTube song player; 9 link chips; Top 8 empty → section hidden; theme color applied)
- [x] 18. Share button copies a working page link — ✅ copies https://aliaspaces.com/#/p/nova_qa

## Content
- [x] 19. Publish a post and a reel (reel displays vertical; Reels chip filters) — ✅ both published; reel badge + vertical video + page-URL overlay; Reels chip filters correctly
- [x] 20. Uploaded post image has the page-URL watermark burned in — ✅ (published "Watermark check" post; fetched the raw stored -wm.jpg from Supabase storage: diagonal tiled page-URL + solid bottom-right label are in the pixels)
- [x] 21. Page search finds posts by word and tag; feed type chips work — ✅ (note: search is scoped to the active type chip — searching while "Reels" selected only searches reels)
- [x] 22. Albums: gallery + sponsored created; items render and click out; sponsored label shows — ✅ (also rel="noopener sponsored" on affiliate links)
- [x] 23. Live URL set → LIVE pill + embedded player; module checkboxes hide/show sections — ✅ (Twitch player embedded — channel happened to be offline; modules Links/Song hidden and restored)

## Social (needs a second account)
- [ ] 24. Friend request → badge → accept → friend count — ⬜
- [ ] 25. Block prevents requests; mute hides from Entangle — ⬜
- [ ] 26. Private invisible to non-friends; unlisted only via link; 18+ gate — ⬜
- [x] 34. Linked personas reveal one-way — ✅ (deployed & tested: nova_qa shows "More of me → Echo QA"; echo_qa's page reveals nothing about Nova). Stranger-view double-check still worthwhile with the second account.

## AI & drafts
- [ ] 27. Model linked → HQ Assistant responds knowing the roster — ⬜ (needs an API key linked)
- [ ] 28. Persona chat responds in voice; "Save draft" lands in Matrix drafts — ⬜
- [ ] 29. Task ▶ Run works; drafts advance idea → ready → posted; Copy copies — ⬜
- [x] 30. Extensions card shows Concept entry (minimal, no GitHub release yet); Personas app download works — ✅ zip serves 200 (42 KB). FINDING: static fallback assets/Extensions/Concept/releases.json referenced by registry.json does not exist (404) — create it so the GitHub-rate-limit fallback works
- [x] 31. Historical pre-051 check: Report a problem created an `error_logs` row in the
      then-deployed release. Migration 051 deliberately supersedes that insert path with
      authenticated `report_client_error`; rerun the bounded/redaction/rate-limit checks
      after deployment. The historical row is not proof of the current source contract.
​
## Growth
- [x] 32. Promote panel: 3 ad variants, Copy works, X share opens pre-filled — ✅ (deployed & tested; variants personalized from tagline/topics, clipboard verified, twitter.com/intent/tweet pre-filled)
- [ ] 33. Page link pasted in Discord/X shows hero image + description preview — ✅ meta side: static HTML head carries og:image (hero.png), og/twitter description + summary_large_image. Actual paste test: Christian. (Per-persona OG images = v0.5 roadmap.)

---
Progress: 19 / 34 (4 need second account, 3 need Christian-side auth, 1 needs local SD, AI checks need a linked model)

7. FIXED: route renders don't cancel superseded ones — navigating while a page render's queries are in flight lets the old render resolve late and clobber the new view (seen live: edit form replaced by the previous persona page). Added a renderEpoch counter: route() and every direct render call (post publish/delete, age-gate continue) claim a new epoch; renderDiscover/renderPersonaPage/renderEdit check it before their final DOM write and bail if superseded. Syntax-checked and smoke-tested locally (rapid hash-navigation sequence lands on the correct final view, no console errors) — NEEDS RE-VERIFICATION on a live deploy with real network latency to confirm the original repro (fast nav into an edit form) no longer clobbers.
8. FINDING (onboarding): fetching localhost (SD panel / local Ollama) from the https site triggers Chrome's local-network-access permission prompt, which blocks the page until answered. Expected browser behavior, but the SD/extensions docs should tell users to click Allow.
9. SECURITY NOTE: API keys were pasted into a chat during verification — owner advised to rotate the OpenRouter, xAI and ollama.com keys. As designed, keys should only ever be entered directly into Matrix → AI Models by the owner.

## Round findings (2026-07-10)
1. FIXED — persona create RLS (sql-updates/004): SELECT policy now checks owner/public inline; persona_visible() kept for private-friends case.
2. FIXED & VERIFIED LIVE — every Supabase query fired twice on page load. First attempt (event-name guard) didn't hold: SIGNED_IN and INITIAL_SESSION both fire at startup in varying order. Final fix dedupes by user-id in onAuthStateChange; deployed and confirmed single-fire via resource timing.
3. Live deploy is behind the working tree (no Promote, no linked personas). Push to deploy, then verify #32/#34 and the double-fetch fix.
4. assets/Extensions/Concept/releases.json missing — registry fallback 404s.
5. Minor: handle field label doesn't mention hyphens are rejected (validation toast easy to miss when Save silently no-ops).
6. Minor: test personas nova_qa (posts/albums/live/song) and echo_qa (linked-reveal target) left in place for further testing — delete both when verification wraps.
