-- Fix: creating a persona always failed with
--   "new row violates row-level security policy for table personas" (42501)
-- Cause: the app inserts with .select() (RETURNING). Returned rows must pass
-- the SELECT policy, which called persona_visible() — a security-definer
-- STABLE function that re-queries personas. Within the same INSERT statement
-- the new row is not yet visible in that function's snapshot, so the policy
-- evaluated false and the whole insert was rejected.
-- (Updates never hit this because the update path returns no representation —
-- that is why the bug looked intermittent: edits worked, creates failed.)
--
-- Fix: check ownership and public/unlisted visibility INLINE on the row
-- (evaluated directly on the returned tuple — no table re-query), and keep
-- persona_visible() only for the friends-of-private case.
-- Run in Supabase SQL Editor.

drop policy "personas visible read" on public.personas;
create policy "personas visible read" on public.personas for select
  using (
    visibility in ('public','unlisted')
    or owner = auth.uid()
    or persona_visible(id)
  );
