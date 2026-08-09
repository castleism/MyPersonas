# Architecture Review & Prioritized Refactor Plan

_AliaSpaces / MyPersonas — 2026-08-08_

A retrospective on what has been built, what the build taught us, and a ranked plan
for making it faster, more secure, more maintainable, and easier to operate. Written
after an extended debugging + hardening session across the Meta/Gmail connectors,
Supabase security advisors, storage, and data hygiene.

---

## 1. What we've achieved

**Product surface**
- Anonymous multi-persona platform: one owner account, many public persona pages
  (feeds, albums, music, links) with owner identity kept private.
- 28 personas, 156 saved accounts (account_ledger), 4 live Meta page connections,
  2 Meta grants, Gmail/Twitter connectors, Discord webhooks.

**Backend (Supabase / Postgres + Deno Edge Functions)**
- ~25 Edge Functions: ai-proxy, meta-oauth, gmail-oauth, twitter-oauth,
  reddit-oauth, fan-chat, mailbox-manager, run-mailbox-jobs, run-publish-queue,
  run-tasks, delete-account, erase-content, gemini-image, discord-post, sitemap,
  post-bridge, daily-discovery, and more.
- Secrets in Supabase Vault; tokens never returned to the browser.
- Fail-closed OAuth design: provider grants are revoked before local records are
  cleared; shared grants across ledgers are protected from accidental revocation.
- Server-side AI proxy: browser system prompts are discarded; persona context and
  model keys load server-side; browser CRUD is limited to key-never-returned RPCs.
- Scheduled autonomy: 5-minute pg_cron polling, UUID task leases, atomic per-owner
  daily model-call reservations — generates due drafts without duplicate calls.
- Inbox Concierge: resumable Gmail scans, report-only by default, exact-approval
  cleanup plans, bounded Undo, separate audit trail.

**Security & privacy hardening (this session)**
- Migration 025 fixed a PL/pgSQL `#variable_conflict` bug that wedged all Meta
  cleanup ("Could not lock the Meta authorization").
- Migrations 026/027: per-owner Storage buckets (persona-media public art,
  persona-docs private) with 8 RLS policies; removed public bucket file-listing;
  pinned function search_path; root `.gitignore` guard so PII/outputs can't be
  committed.
- Verified the DB is clean of transient junk (0 rows across oauth transactions,
  leases, cleanup holds) — the self-healing cleanup logic is working.

---

## 2. What the build taught us (lessons)

1. **Manual deploys are the biggest reliability tax.** Edge Functions are edited and
   deployed by hand in the dashboard Monaco editor; migrations are pasted into the
   SQL editor. During this session the dashboard repeatedly froze mid-operation,
   forcing hash-verification of pasted code and blind retries. There is no CI/CD,
   no migration ordering guarantee, and no automated rollback.

2. **Per-item provider calls don't scale.** The Meta connector fetched each page's
   linked Instagram with a separate `GET /{ig-id}` call. Meta rejected those for
   granular business-asset grants, and at 24 accounts the extra calls hit rate
   limits — so only batches of ~3 worked. Inline field expansion
   (`instagram_business_account{...}`) fixed both at once. **Lesson: prefer field
   expansion / batch endpoints over N+1 provider calls.**

3. **Every user-facing outcome must be surfaced.** The Gmail connect "failed
   silently" because `finishPendingGmail` set a notice that was never displayed
   (it resolved after the route already rendered). Silent failures destroy trust.
   **Lesson: a connect/cleanup flow must always toast success AND every failure
   reason.**

4. **Destructive controls need a safe escape.** The Meta pairing modal offered only
   "Cancel (revokes the shared grant)" or a disabled "Pair", trapping the user;
   Escape triggered the destructive cancel. **Lesson: always provide a
   non-destructive close; never bind Escape to a destructive action; retries must
   be safe (idempotent).**

5. **Exact-match without normalization is brittle.** A single mistyped ledger email
   (`girl.gamers.wp` vs `girl.gamer.wp`) failed every Gmail connect, and a DB guard
   trigger blocked correcting it in-app. **Lesson: normalize/validate identifiers at
   entry, and give users a guarded in-app way to correct them.**

6. **Never keep user PII/media in the app repo.** Persona avatars/banners and ~26
   working docs were sitting in the Git repo. **Lesson: user content belongs in
   owner-controlled storage (per-owner buckets + RLS), not source control.**

7. **A 445 KB single-file frontend hides race conditions.** No module boundaries,
   no build step, no tests — the silent-notice bug is the kind of defect that a
   modular structure + a unit test would have caught.

8. **Unbounded growth tables need retention from day one.** `mailbox_findings` and
   `mailbox_message_refs` are ~3,900 rows each and only grow; `error_logs` is
   insert-open and spam-able. There is no pruning/lifecycle job.

9. **Security-definer everywhere is powerful but noisy.** 34 advisor warnings — most
   are SECURITY DEFINER RPCs that are definer-by-design with internal auth checks,
   but a couple (`owns_persona`, `can_request`) are anonymously executable and worth
   review. Signal gets lost in the noise without a triage convention.

10. **Deprecated platform keys are a ticking clock.** Supabase now marks the legacy
    anon/service_role JWT keys deprecated; they still work but should be migrated to
    the new `sb_publishable_`/`sb_secret_` keys before retirement.

---

## 3. What we'd do differently (target architecture)

- **Infra as code + CI/CD.** Manage functions and migrations with the Supabase CLI
  in the repo; deploy via GitHub Actions on merge. Migrations become ordered,
  reviewable, and rollback-friendly; no more dashboard paste-and-pray.
- **Connector abstraction.** The five OAuth connectors duplicate token exchange,
  vault storage, revocation, and lease logic. Extract a shared connector core
  (token lifecycle, appsecret_proof, retry/backoff, lease helpers) so each provider
  is a thin adapter. Standardize on field-expansion/batch reads.
- **Frontend modules + build.** Split index.html into modules with a light bundler;
  add unit tests for pure helpers (parseBindings, instagramAssetFromLinked,
  safeExpiry) and integration tests for the OAuth return handlers.
- **Data lifecycle.** Retention/pruning pg_cron jobs for mailbox findings,
  error_logs, and expired transient state; an `archive` schema convention (started
  this session) for reversible cleanups; soft-delete where user recovery matters.
- **Observability.** Structured logs with correlation ids instead of ad-hoc
  console.error probes; a small owner/admin health view; alerting on connector
  error spikes.
- **Security posture.** search_path pinned on all functions; review anonymous
  EXECUTE grants; enable leaked-password protection; rotate off deprecated keys;
  keep PII out of the repo (done) and out of URL params.

---

## 4. Prioritized refactor backlog (impact × effort)

**P0 — highest impact, do first**
- CI/CD: Supabase CLI + GitHub Actions for migrations and function deploys.
  Removes the manual-deploy reliability tax that cost the most time this session.
  _Effort: M · Impact: XL_
- Enable leaked-password protection (Auth → Attack Protection). _Effort: XS · Impact: M_
- Finish moving persona media + private docs to Storage and remove `assets/personas/`
  from the repo. _Effort: M · Impact: L (privacy)_
- Retention jobs for `mailbox_findings`/`mailbox_message_refs`, `error_logs`, and
  expired transient state. _Effort: S · Impact: L_

**P1 — near-term**
- Frontend: introduce modules + a build step; add tests for OAuth return handlers
  (would have caught the silent-Gmail bug). _Effort: L · Impact: L_
- Email/identifier normalization at entry + a guarded in-app "correct login email"
  flow (disconnect-aware). _Effort: S · Impact: M_
- Review anonymous EXECUTE on `owns_persona` / `can_request` and other public
  SECURITY DEFINER RPCs. _Effort: S · Impact: M (security)_
- Non-destructive close + non-destructive Escape across all connector modals
  (Meta done in code; apply the pattern everywhere). _Effort: S · Impact: M_

**P2 — platform maturity**
- Extract shared connector core; make each provider a thin adapter. _Effort: L · Impact: L_
- Structured logging + a minimal admin health view. _Effort: M · Impact: M_
- Rotate off deprecated anon/service_role keys to `sb_*` keys. _Effort: M · Impact: M_
- Move `pg_net` out of the `public` schema. _Effort: S · Impact: S_

**P3 — later**
- Event-driven / queue-based scheduling to cut the up-to-5-minute dispatch latency.
- Data soft-delete conventions + user-facing "download/delete my data" surfacing.
- Performance pass once modularized (bundle size, lazy loading).

---

## 5. Data hygiene findings (2026-08-08 audit)

Read-only audit of the production database:

- **Transient/junk tables are already clean:** meta_oauth_transactions (0),
  expired leases (0), cleanup holds (0). The self-heal logic is doing its job.
- **Only genuinely stale-safe row:** 1 old `error_logs` entry (archived to
  `archive.error_logs_20260808`, deletion submitted).
- **Active — do NOT delete:** `meta_oauth_candidates` (1, an in-progress pairing),
  `meta_grants` (2, live connections).
- **Needs owner review (not auto-deleted):** 97 of 156 `account_ledger` rows have
  no connection (inventory-only saved accounts) — intentional in many cases;
  requires human judgment on which are truly abandoned.
- **Watch (unbounded growth):** `mailbox_findings` and `mailbox_message_refs`
  ~3,900 rows each across 11 scan runs — candidates for a retention job (P0), not
  one-off deletion.

Backup convention established: reversible cleanups copy rows into an `archive`
schema table (`archive.<table>_<date>`) before deletion, restorable via
`insert into public.<table> select * from archive.<table>_<date>`.

---

## 6. Immediate next actions

1. Owner: enable leaked-password protection; push the queued repo commits (clear
   `.git/index.lock` first).
2. Review the 97 unconnected ledger records and tell me which providers/records are
   abandoned; I'll archive-then-delete in batches.
3. Stand up CI/CD (P0) so future migrations and function deploys stop depending on a
   flaky dashboard.
