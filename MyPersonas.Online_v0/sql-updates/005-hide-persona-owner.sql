-- Privacy fix (VERIFICATION.md finding #10, 2026-07-10): the personas SELECT
-- policy exposes whole rows -- including `owner` -- to anyone, even signed
-- out (verified: anon-role `select=owner` returns 200). The uuid doesn't
-- reveal an email (profiles are self-read-only), but it lets anyone GROUP
-- all public personas of one account by owner -- breaking the "never linked
-- to each other" promise at the API level even though the UI never shows it.
--
-- Fix: revoke column-level SELECT on personas.owner from anon/authenticated.
-- Security-definer functions (owns_persona, my_personas below) are unaffected
-- -- they run with the table owner's privileges, not the caller's -- so
-- ownership checks and "my roster" queries keep working with no
-- client-visible uuid grouping. The app must stop selecting owner directly:
-- see index.html changes in the same commit (explicit column lists on public
-- reads, my_personas() RPC replacing the raw .eq("owner",...) query, and
-- .select("id") instead of .select() on persona insert so the RETURNING
-- representation doesn't request the now-restricted column).
--
-- Not touched: personas.linked (jsonb array of the owner's OTHER persona ids
-- a given persona chooses to reveal). That's an intentional opt-in disclosure
-- feature (round findings #34), not a leak -- left public.
-- Run in Supabase SQL Editor.

revoke select (owner) on public.personas from anon, authenticated;

create or replace function public.my_personas()
returns setof public.personas
language sql security definer stable set search_path = public as $$
  select * from public.personas where owner = auth.uid() order by created_at;
$$;
grant execute on function public.my_personas() to authenticated;
