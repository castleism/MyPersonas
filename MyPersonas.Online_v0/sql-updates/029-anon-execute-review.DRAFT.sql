-- 029-anon-execute-review.DRAFT.sql
-- Security Advisor follow-up (ARCHITECTURE-REVIEW.md P1): tighten which public
-- SECURITY DEFINER functions are executable by anonymous (unauthenticated) callers.
--
-- STATUS: DRAFT — DO NOT APPLY BLINDLY. The REVOKEs below are commented out on
-- purpose. Several public functions MUST stay anon-callable (they render public
-- persona pages). Revoking the wrong one breaks the public site. Test each change
-- on a branch/staging DB first, then uncomment only the safe ones.
--
-- Written 2026-08-08. Not run against prod.

-- ── Step 1: see the current landscape (read-only). Run this first. ──
-- Lists every SECURITY DEFINER function in public and whether anon/authenticated
-- can execute it.
select
  p.oid::regprocedure::text                          as function,
  has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef                                    -- SECURITY DEFINER only
order by anon_can desc, function;

-- ── Step 2: classification (from the 2026-08-08 advisor run) ──
-- MUST remain anon-executable (public persona pages / discovery):
--   public.persona_by_handle(text)
--   public.persona_visible(uuid)
--   public.discover_personas(text, integer)
--
-- REVIEW candidates — likely should require sign-in (owner-scoped concepts):
--   public.owns_persona(uuid)      -- ownership check; anon has no persona to own
--   public.can_request(uuid, uuid) -- confirm no anonymous fan-chat/request path
--
-- Before revoking, grep the frontend + edge functions for anon calls:
--   rg "owns_persona|can_request" MyPersonas.Online_v0/index.html supabase/functions
-- and confirm neither is invoked on a logged-out code path.

-- ── REVIEW CONCLUSION (2026-08-09): NO CHANGE RECOMMENDED. ──
-- Ran Step 1 against prod. Exactly five public SECURITY DEFINER functions are
-- anon-executable: persona_by_handle, persona_visible, discover_personas (all
-- required for the public pages) plus the two review candidates below.
--
--   owns_persona(uuid): used pervasively inside RLS USING/WITH CHECK clauses
--     (account_ledger 008, agent-automation 011, comments/reactions 005). It has
--     no auth.uid() to satisfy for anon, so it already returns false for anon —
--     there is no info leak. Revoking anon EXECUTE risks breaking RLS evaluation
--     on any anon-reachable path that transitively references it, for no benefit.
--     DECISION: leave as-is.
--
--   can_request(uuid,uuid): SECURITY DEFINER, 494 chars, does NOT check auth.uid,
--     and is unreferenced in the versioned repo (index.html / functions /
--     sql-updates) — most likely an RLS helper defined in the core schema. Its
--     call sites must be traced in the live schema before touching its grants;
--     revoking blind could break an anon-reachable policy.
--     DECISION: leave as-is pending a core-schema usage trace.
--
-- Net: the anon-EXECUTE advisor warnings are acceptable for this app's design.
-- The REVOKEs below stay commented (do not apply).
-- revoke execute on function public.owns_persona(uuid) from anon;
-- revoke execute on function public.can_request(uuid, uuid) from anon;
