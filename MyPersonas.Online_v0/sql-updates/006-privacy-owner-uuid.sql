-- 006 close the owner-uuid privacy leak (VERIFICATION.md finding 10).
--
-- Problem: the personas SELECT policy returns whole rows, including
-- personas.owner, to anyone (even signed-out). Anyone can then group all public
-- personas of one account by owner uuid, breaking the "personas are never linked
-- to each other" promise at the API level.
--
-- Fix is TWO-PHASE so it never breaks the live site:
--   Phase A (this file, safe to run now): add security-definer RPCs the client
--     will use, so the client no longer needs to SELECT the owner column.
--   Phase B (the revoke at the bottom, run ONLY after the matching client
--     changes are deployed, see DEPLOY.md): revoke column SELECT on
--     personas.owner so no client can read it.
--
-- Running Phase A alone changes nothing user-visible; it just adds functions.

-- ===== Phase A: RPCs =====

-- Owner's own roster (full rows incl owner). Replaces select('*').eq('owner',uid).
create or replace function public.my_personas()
returns setof public.personas language sql security definer stable
set search_path = public as $$
  select * from public.personas where owner = auth.uid() order by created_at asc;
$$;

-- Public discovery WITHOUT owner. Optional text search over name/handle/topics/tagline.
create or replace function public.discover_personas(q text default null, lim int default 80)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, created_at timestamptz
) language sql security definer stable set search_path = public as $$
  select id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
         bg_url, feed_img_url, music_url, live_url, theme, topics, hashtags,
         top8, modules, linked, created_at
  from public.personas
  where visibility = 'public'
    and (q is null or name ilike '%'||q||'%' or handle ilike '%'||q||'%'
         or topics ilike '%'||q||'%' or tagline ilike '%'||q||'%')
  order by created_at desc
  limit greatest(1, least(coalesce(lim,80), 200));
$$;

-- One visible persona page by handle, WITHOUT owner. persona_visible() keeps
-- private pages available to their owner/accepted friends without exposing the
-- owner's UUID.
create or replace function public.persona_by_handle(h text)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, purpose text, voice text,
  audience text, hashtags text, dont text, top8 jsonb, modules jsonb, linked jsonb,
  ai_backend uuid, created_at timestamptz
) language sql security definer stable set search_path = public as $$
  select id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
         bg_url, feed_img_url, music_url, live_url, theme, topics, purpose, voice,
         audience, hashtags, dont, top8, modules, linked, ai_backend, created_at
  from public.personas
  where handle = h and persona_visible(id)
  limit 1;
$$;

grant execute on function public.my_personas() to authenticated;
grant execute on function public.discover_personas(text,int) to anon, authenticated;
grant execute on function public.persona_by_handle(text) to anon, authenticated;

-- ===== Phase B: DO NOT RUN until the client is updated (see DEPLOY.md) =====
-- Once the client reads via the RPCs above and never selects personas.owner
-- directly, replace the broad table SELECT grant with an explicit safe-column
-- grant. A column-level revoke by itself does not override table-level SELECT:
--   revoke select on public.personas from anon, authenticated;
--   revoke select (owner) on public.personas from anon, authenticated;
--   grant select (
--     id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
--     bg_url, feed_img_url, music_url, live_url, theme, topics, purpose, voice,
--     audience, hashtags, dont, top8, modules, linked, ai_backend, created_at
--   ) on public.personas to anon, authenticated;
-- Owners still reach their own rows via my_personas(); RLS policy expressions may
-- reference owner regardless of this column grant.
