-- 027-advisor-warning-fixes.sql
-- Clears safe Supabase Security Advisor warnings (2026-08-08). Owner-run in the
-- Supabase SQL editor. Safe / idempotent.
--
-- 1) "Public Bucket Allows Listing" on storage.media and storage.persona-media.
--    Both buckets are public=true and the app serves files only via
--    getPublicUrl() (the /object/public/ path, which does NOT use RLS). The broad
--    SELECT policy `using (bucket_id = '<bucket>')` added nothing for serving but
--    let anonymous clients ENUMERATE every file across all owners. Dropping it
--    removes enumeration; public URL serving is unaffected. (persona-media's
--    policy was introduced by migration 026 earlier today — this corrects it.)
--    We also assert public=true so serving is guaranteed after the drop.
--
-- 2) "Function Search Path Mutable" on public.concept_touch — a 157-char trigger
--    that references no tables, so pinning search_path is behavior-neutral.

update storage.buckets set public = true where id in ('media', 'persona-media');

drop policy if exists "media public read" on storage.objects;
drop policy if exists "persona media public read" on storage.objects;

alter function public.concept_touch() set search_path = '';

-- Not changed here (deliberate):
--   * SECURITY DEFINER function warnings (~29): the app's RPCs are definer by
--     design with internal auth.uid() ownership checks; revoking EXECUTE risks
--     breaking public persona pages / RLS and needs a separate careful pass.
--   * Extension in Public (pg_net): moving it out of `public` can break cron/
--     webhook references; low value, deferred.
--   * Leaked Password Protection: enabled via Auth settings toggle, not SQL.
