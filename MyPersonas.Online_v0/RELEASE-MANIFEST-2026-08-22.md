# Release manifest — 2026-08-22 local release candidate

**Status:** Frozen and verified as a local release candidate; not pushed, applied to the
linked database, deployed, configured, activated, or verified live unless separately
evidenced. The coordinated local freeze completed at `2026-08-23T06:54:04Z` from Git
HEAD `ae5d9636fca8617bd6a47044f1e6c62dd1eb060b` plus the reviewed dirty-worktree
package described below. These hashes and counts are local release evidence, not a
production attestation.

This manifest is the ordered release boundary for the full-name, Backup, Castleborn,
page-designer, publication, business, agent-board, research, audit-retention, email-
attestation, and AI-budget changes. A timestamped file proves repository packaging only.
It does not prove that a migration is recorded in the linked project or that its effects
were read back.

## Database order

Apply only after an authenticated inventory proves the target already contains every
required predecessor. The `supabase/migrations/` directory is **not** a complete fresh-
install history: it omits part of the canonical 019–046 chain, including security and
connector prerequisites used by this package. Never use the presence of the files below
as evidence that `supabase db push` can build a blank project safely, and never insert or
edit migration-ledger rows to conceal a prerequisite gap.

| Order | Timestamped migration | Canonical source | Final SHA-256 | Local evidence |
|---:|---|---|---|---|
| 1 | `20260822113925_persona_full_name_canon.sql` | `047-persona-full-name-canon.sql` | `863338E9CEBC75D364254AA5CEC144D33197DF9D5F6964E4AA958541672796BE` | Apply/reapply; 18 exact guarded names and no invented Abel row |
| 2 | `20260822130000_persona_backup_relationships.sql` | `048-persona-backup-relationships.sql` | `6C44E9BACA529D5EEF42C485D1F1422439DD63717FACDCC9647020AF7D9E1064` | Apply/reapply; relationship, grouping, export, and restore contracts passed |
| 3 | `20260822140000_persona_relationships_projects_businesses.sql` | `049-persona-relationships-projects-businesses.sql` | `415111B7DD91D32733232C4A3E64DF56C0560884257086A81D1533C3BDC1F53F` | Apply/reapply; 20 parent, four partner, 21 project, one WAIS-manager readback |
| 4 | `20260822150000_persona_page_layout_builder.sql` | `050-persona-page-layout-builder.sql` | `C4B7C9869F313D79D19E479114BD913DD2577BD3D88A9BCC9D1CFFAB4C9A4125` | Apply/reapply; declarative layout, snippets, preview, and inert-download contracts passed |
| 5 | `20260822160000_request_review_phase1.sql` | `043-request-review-phase1.sql` | `C7108B5EA812723B045EB48589B067FBE03F38C35759E1089A19822B0B872E88` | Apply/reapply; bounded default-off intake contracts passed; no sender exists |
| 6 | `20260822170000_publication_social_security_governance.sql` | `051-publication-social-security-governance.sql` | `D9806EF6CB8C65369AE685FAC215277BF87DD33900ED3B42866CB85A931349DE` | Apply/reapply; legacy anonymous review mutation denied with no row change |
| 7 | `20260822180000_reviewed_business_publication.sql` | `052-reviewed-business-publication.sql` | `B77899F3F20E4DF2143E4D9CEC6A8A3893C41C1DB5D72DF6FE3992603314A7DE` | Apply/reapply; exact-revision AAL2 business contracts passed |
| 8 | `20260822190000_agent_board_hardening.sql` | `053-agent-board-hardening.sql` | `0E39B18BE635F84FAA693C4E576BD3ACAE4AB7A6E517EFBAA9BD5D1F91D6BA93` | Apply/reapply; drift, idempotency, capability, recovery, and retry ceilings passed |
| 9 | `20260822200000_owner_research_content_hardening.sql` | `054-owner-research-content-hardening.sql` | `244E49E05C9720558A5A947CDAD78CC80E5E942127ABB1612D4F8F70FB6FCA99` | Apply/reapply; owner/service boundaries and AAL2 downgrade contract passed |
| 10 | `20260822210000_agent_action_retention_hardening.sql` | `055-agent-action-retention-hardening.sql` | `62580D9A2365CA4C0AB6CCD1EADD49E4FC967A0B440071A17380EFD03428EC3E` | Apply/reapply; terminal capacity, direct-DML denial, reconciliation, upgrade, and concurrency passed |
| 11 | `20260822220000_auth_email_attestation_hardening.sql` | `056-auth-email-attestation-hardening.sql` | `3B9719A97270C447BFE911BED9554AEA609B6F4E3C1EE57CA6BC884805AC7E27` | Apply/reapply; stale email-attestation invalidation contracts passed |
| 12 | `20260822230000_ai_backend_budget_guard.sql` | `057-ai-backend-budget-guard.sql` | `803FDF052F55A596579989FF21B6031759407B0AAEDF027CD73FC10EA852C5FA` | Apply/reapply; AAL2 policy, default denial, leases, concurrency, and accounting passed |

Before release, prove every canonical/timestamped pair is byte-identical and record the
final SHA-256 values in a signed release record. Migration 047 has separately documented
historical production name-readback evidence, but that SQL Editor action did not prove a
CLI migration-ledger entry and does not approve this coordinated package.

## Final coordinated local evidence

- PostgreSQL `16.15`: cloned the reproducible 87-table through-046 predecessor, seeded 21
  Castleborn personas, applied all 12 rows above twice with `ON_ERROR_STOP=1`, and ended
  with 121 public tables. Exact readback proved 18 guarded names, no Abel row, 20 parent
  edges, four normalized partner edges, all 21 project members, WAIS as the sole manager,
  one blank owner-private business, and no invented membership, mission, or resource.
- Runtime SQL passed the legacy-051 anonymous/owner/other-owner ACL matrix, the 053 exact
  review/capability/idempotency/recovery and retry ceilings, the 055 terminal-audit and
  over-limit lifecycle, and the 057 AAL1/AAL2/direct-DML/default-deny/concurrency/usage
  assertions. Separate disposable concurrency rehearsal proved audit erasure serialization.
- Node's complete frozen suite passed `259/259` with zero failures, skips, or todos.
  Frontend inline syntax plus `owner-app.js`, `platform-governance.js`, and
  `agent-board.js` passed. All `28` Edge Function entrypoints passed `deno check`; the
  scheduled-worker budget behavior suite passed `7/7` and its three files passed
  `deno fmt --check`.
- All 12 canonical/timestamped hashes above matched byte-for-byte. `git diff --check`,
  the changed-Markdown local-link scan, and a high-confidence credential scan passed.
  A fresh signed-out in-app browser load of `#/agent-board` used
  `agent-board.js?v=20260822-4`, rendered the truthful sign-in boundary at 1280 px without
  horizontal overflow, and produced no console warnings or errors. Signed-in and mobile
  visual testing remains a staging gate.

## Manual release sequence

1. Freeze source; run the complete Node suite, frontend syntax checks, all Edge Function
   type checks, migration parity, disposable PostgreSQL 16 apply/reapply, concurrency,
   erasure, and two-account RLS/runtime tests. Record exact evidence without secrets.
2. Back up the linked project and inventory its migration ledger, schema objects, Auth
   hooks, cron jobs, Vault references, function versions, public pages, and rollback path.
3. Rehearse the exact table above in an isolated staging project whose predecessor schema
   matches the linked project. Read back data and policies; do not rely on exit status alone.
4. After a named owner approval, apply the database package to the linked project and read
   back every migration and critical effect.
5. After database readback, manually dispatch `.github/workflows/supabase-deploy.yml` with
   the exact confirmation `MIGRATIONS-VERIFIED`. The workflow deploys functions but does
   not apply migrations.
6. Complete signed-in staging smoke tests and provider-safe negative tests. Keep all
   automated execution, publishing, request intake, affiliate, and spend gates off.
7. Manually dispatch `.github/workflows/pages.yml` with the exact confirmation
   `MIGRATIONS-VERIFIED`, then verify the deployed artifact and public/signed-in behavior.
8. Activate each provider, Auth, security, email, revenue, or publication capability only
   through its separate approval and rollback checklist.

Pushes to `main` run validation but do **not** deploy Edge Functions or Pages. Database
first, functions second, Pages last is mandatory for this package.

## Owner-controlled gates that remain open

- linked-project backup, migration inventory, staging project, apply window, and rollback;
- primary owner UUID, AAL2 recovery UX, staff-role seeds, SSO, Auth hooks, SMTP, CAPTCHA,
  WAF/DNS, rate limits, log drains, security mailbox, and incident-response ownership;
- provider projects, least-privilege credentials, Vault entry, trial quotas, hard budget
  ceilings, data-retention/training choices, and model-by-model live verification;
- public persona/business publication, friend/contact-proof policy, extension review and
  signing, opaque public-media remediation, and any social write permission;
- merchant identity, tax/refund/support policy, payment processor, payout destination,
  affiliate approvals, request-review notification delivery, and every money action.

The detailed approval checklist is `OWNER-APPROVAL-QUEUE-2026-08-22.md`. Nothing in this
manifest grants production authority or represents a live result.
