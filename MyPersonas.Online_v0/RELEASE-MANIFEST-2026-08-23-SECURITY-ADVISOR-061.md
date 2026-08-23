# MyPersonas Security Advisor hardening manifest — migration 061

Status: **automatically applied to the linked production database by the installed
Supabase GitHub App after main commit
`098937d4cd19748793cf6569cf6088c886856db2`.** The Supabase check run
`97193164188` completed successfully in 19 seconds and production migration history now
contains version `20260823030000`, name `security_advisor_safe_hardening`, with 30 parsed
statements. No agent manually ran production DDL. This is a forward-only, transactional
hardening release. It does not configure
CAPTCHA, SMTP, WAF, log drains, payment systems, SSO, or external providers.

## Exact release artifacts

- `sql-updates/061-security-advisor-safe-hardening.sql`
- `../supabase/migrations/20260823030000_security_advisor_safe_hardening.sql`
- `../tests/security-advisor-safe-hardening.test.mjs`
- `../tests/sql/061-security-advisor-seed.sql`
- `../tests/sql/061-security-advisor-runtime.sql`
- `../scripts/test-security-advisor-hardening-sql.ps1`

The two SQL copies are identical after LF normalization. Normalized-LF SHA-256:
`5a990224930818bdc836ee4aac515e920da294245761e2b6b9323cb93043777d`.

## Live read-only baseline

The linked production catalog reported:

- zero Security Advisor errors and 216 warnings;
- 401 `SECURITY DEFINER` functions, 18 executable by `anon`, and 10 retaining database
  `PUBLIC EXECUTE`;
- six trigger implementations plus `owner_research_brief_queue` and
  `get_research_digest` unintentionally browser-executable;
- `tg_touch_updated_at()` and `touch_updated_at()` with mutable search paths;
- `noo_waitlist_anon_insert` using `WITH CHECK (true)` plus inherited broad browser
  privileges; the table contained zero rows at audit time;
- `pg_net` 0.20.3 installed in `public` with `extrelocatable=false`.

## Release boundary

Migration 061:

- pins both mutable trigger-function paths;
- removes browser execution from trigger implementations;
- makes the two owner research RPCs authenticated-only;
- removes database-PUBLIC drift while retaining exact `anon, authenticated` grants for
  the two RLS predicates;
- makes future postgres-owned public-schema functions fail closed until explicitly
  granted;
- limits anonymous waitlist insertion to normalized email plus exact
  `nooyouniverse.com` source and removes every other browser table privilege.

It deliberately preserves eight bounded anonymous public-page projections plus
`owns_persona` and `persona_visible`, which public RLS policies require. It leaves
non-relocatable provider-owned `pg_net` untouched. The waitlist remains public and needs a
same-origin Edge/Worker boundary with CAPTCHA and request-rate enforcement.

## Verification evidence

- Focused Node contract: 7/7 passed.
- Impacted/parity suite: 38/38 passed.
- Disposable PostgreSQL 16: apply, reapply, role-switched ACL/runtime assertions, and a
  bounded anonymous waitlist insert passed.
- Production postflight found every expected function, both trigger paths pinned to
  `pg_catalog`, no unintended browser or database-PUBLIC execution, authenticated-only
  research RPCs, the intentional RLS grants intact, zero waitlist rows/invalid rows, the
  bounded waitlist policy, and no future postgres-owned browser function default.
- The complete repository suite must pass again after migration 062 finishes before a
  combined source freeze.

## Automatic-deployment finding

The GitHub check named **Supabase Preview** is attached to main pushes and applied the new
production migration before the GitHub unit-test job finished. Its name did not make that
production mutation obvious. A main push containing a new timestamped migration is
therefore a production database action. Do not commit or push a migration merely to stage
it. Freeze and test the exact migration first, and use a pull request/branch or disable
production auto-apply before the next high-risk database release.

## Applied sequence and future readback contract

1. Confirm the two artifact hashes and inspect live function signatures, ACLs, extension
   location, default ACLs, waitlist columns/policies, and invalid-row count.
2. Preserve a pre-apply catalog result and current waitlist contract. Stop if any assumed
   function is absent or overloaded differently, if invalid waitlist rows exist, or if
   `pg_net` facts changed.
3. The installed GitHub App applied the exact committed 061 timestamped migration as one
   transaction and wrote migration history. No history row was inserted by hand.
4. Read back both search paths; trigger/RPC/PUBLIC/anon/authenticated grants; postgres
   default function ACLs; waitlist policy, constraint, and column privileges.
5. Re-run Security Advisor. Expected focused reduction is eleven warnings. The ten
   intentional anonymous projection/predicate warnings and non-relocatable `pg_net`
   warning remain accepted, not silently fixed.
6. Exercise the public waitlist from its real origin, then remove only an exact controlled
   test row if one was created. Verify the form cannot select, update, or delete.

If the transaction fails, PostgreSQL rolls it back. If postflight differs from this
manifest, stop further releases and restore only from the captured exact pre-apply ACL and
policy record; do not broadly regrant `PUBLIC` execution.
