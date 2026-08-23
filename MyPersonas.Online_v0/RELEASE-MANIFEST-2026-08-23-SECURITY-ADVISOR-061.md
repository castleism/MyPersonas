# MyPersonas Security Advisor hardening manifest — migration 061

Status: **reviewed release candidate; not yet applied to production at this source
freeze.** This is a forward-only, transactional hardening release. It does not configure
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
- The complete repository suite must pass again after migration 062 finishes before a
  combined source freeze.

## Approved apply and readback sequence

1. Confirm the two artifact hashes and inspect live function signatures, ACLs, extension
   location, default ACLs, waitlist columns/policies, and invalid-row count.
2. Preserve a pre-apply catalog result and current waitlist contract. Stop if any assumed
   function is absent or overloaded differently, if invalid waitlist rows exist, or if
   `pg_net` facts changed.
3. Apply the exact committed 061 SQL as one transaction. Do not insert Supabase migration
   history rows by hand.
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
