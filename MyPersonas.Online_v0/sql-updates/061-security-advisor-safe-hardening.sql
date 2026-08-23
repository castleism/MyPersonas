-- 061-security-advisor-safe-hardening.sql
-- Forward-only, provider-independent fixes for the 2026-08-23 live Security
-- Advisor review. This migration is intentionally narrower than the full
-- warning count: it closes proven default-grant drift while preserving the
-- reviewed anonymous profile projections that make public pages work.
--
-- Safe live facts used by this migration:
--   * tg_touch_updated_at() and touch_updated_at() are the only mutable-path
--     functions reported by the live advisor.
--   * six trigger functions and two owner research RPCs are anonymously
--     executable only because old/default grants were left behind.
--   * owns_persona(uuid) and persona_visible(uuid) are intentionally available
--     to anon because PUBLIC RLS policies call them; both fail closed for an
--     unauthenticated owner check.
--   * pg_net 0.20.3 is provider-installed in public and extrelocatable=false.
--     Moving it requires a provider/dashboard maintenance decision, so this
--     migration never drops, recreates, or moves that extension.

begin;

-- ---------------------------------------------------------------------------
-- Mutable function search paths
-- ---------------------------------------------------------------------------

alter function public.touch_updated_at()
  set search_path = pg_catalog;

-- touch_updated_at is a trigger implementation, not a browser RPC.
revoke all on function public.touch_updated_at()
  from public, anon, authenticated;

-- tg_touch_updated_at is live/manual drift and is not present in every local
-- seed. Harden its ACL only when the exact zero-argument trigger exists.
do $security_advisor$
begin
  if pg_catalog.to_regprocedure('public.tg_touch_updated_at()') is not null then
    execute 'alter function public.tg_touch_updated_at() set search_path = pg_catalog';
    execute 'revoke all on function public.tg_touch_updated_at() from public, anon, authenticated';
  end if;
end
$security_advisor$;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER default-grant drift
-- ---------------------------------------------------------------------------

-- Trigger functions execute only through their installed triggers. Removing
-- browser-role EXECUTE does not remove or disable those triggers.
revoke all on function public.auto_create_research_settings()
  from public, anon, authenticated;
revoke all on function public.cleanup_deleted_fan_chat_notification()
  from public, anon, authenticated;
revoke all on function public.invalidate_content_package_approval()
  from public, anon, authenticated;
revoke all on function public.notify_content_package_review()
  from public, anon, authenticated;
revoke all on function public.notify_new_research_brief()
  from public, anon, authenticated;
revoke all on function public.notify_owner_fan_message()
  from public, anon, authenticated;

-- These return owner research data and already enforce auth.uid(). Keep their
-- intended authenticated caller while removing anonymous/default execution.
revoke all on function public.owner_research_brief_queue(date,text)
  from public, anon, authenticated;
revoke all on function public.get_research_digest(uuid,integer)
  from public, anon, authenticated;
grant execute on function public.owner_research_brief_queue(date,text)
  to authenticated;
grant execute on function public.get_research_digest(uuid,integer)
  to authenticated;

-- These predicates are referenced by RLS policies that apply to PUBLIC. Keep
-- the exact anon/authenticated access, but remove the database PUBLIC default.
revoke all on function public.owns_persona(uuid)
  from public, anon, authenticated;
revoke all on function public.persona_visible(uuid)
  from public, anon, authenticated;
grant execute on function public.owns_persona(uuid)
  to anon, authenticated;
grant execute on function public.persona_visible(uuid)
  to anon, authenticated;

-- Intentionally anonymous, bounded read projections left unchanged:
--   business_page_by_slug(text)
--   discover_personas(text,integer)
--   get_public_persona_revenue_rails(text)
--   persona_by_handle(text)
--   persona_family_by_handle(text)
--   persona_page_layout(uuid)
--   persona_relation_cards(uuid)
--   public_persona_friend_policy(uuid)
-- Security Advisor will continue to describe these as anonymous SECURITY
-- DEFINER functions until they are replaced by an equally tested view/RLS
-- design. That warning is accepted; their projection contracts are intentional.

-- Future functions created by the application migration owner fail closed.
-- supabase_admin defaults are provider-owned and deliberately untouched.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- Noo YouNiverse write-only waitlist
-- ---------------------------------------------------------------------------

-- The public form posts exactly a normalized email and this source value. Keep
-- that live contract while removing inherited TRUNCATE/TRIGGER/REFERENCES and
-- authenticated table privileges. This does not replace CAPTCHA or rate limits.
alter table public.noo_waitlist
  drop constraint if exists noo_waitlist_input_contract;
alter table public.noo_waitlist
  add constraint noo_waitlist_input_contract check (
    email = pg_catalog.lower(pg_catalog.btrim(email))
    and pg_catalog.char_length(email) between 3 and 254
    and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and source = 'nooyouniverse.com'
  ) not valid;
alter table public.noo_waitlist
  validate constraint noo_waitlist_input_contract;

drop policy if exists noo_waitlist_anon_insert on public.noo_waitlist;
create policy noo_waitlist_anon_insert
  on public.noo_waitlist
  for insert
  to anon
  with check (
    email = pg_catalog.lower(pg_catalog.btrim(email))
    and pg_catalog.char_length(email) between 3 and 254
    and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    and source = 'nooyouniverse.com'
  );

-- Remove both the old column grant and broad provider defaults before restoring
-- only the two columns sent by the public landing page.
revoke insert (email,source) on public.noo_waitlist from anon;
revoke all privileges on table public.noo_waitlist
  from public, anon, authenticated;
grant insert (email,source) on public.noo_waitlist to anon;

comment on policy noo_waitlist_anon_insert on public.noo_waitlist is
  'Write-only public waitlist contract. Email and source are bounded in RLS and by a table constraint; CAPTCHA and request rate limits remain an edge/WAF control.';

commit;
