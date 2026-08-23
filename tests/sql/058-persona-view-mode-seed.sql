\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create extension if not exists dblink;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table public.profiles(id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;

create table public.personas(
  id uuid primary key,owner uuid not null references public.profiles(id),handle text unique not null,
  name text not null,tagline text default '',title text default '',bio text default '',nsfw boolean default false,
  visibility text not null default 'private',publication_state text not null default 'unpublished',
  publication_revision bigint not null default 1,published_revision bigint,
  avatar_url text default '',banner_url text default '',bg_url text default '',feed_img_url text default '',
  music_url text default '',live_url text default '',theme text default '#ff4fa3',topics text default '',
  hashtags text default '',focus text default '',pet_project text default '',ai_disclosure text default '',
  top8 jsonb default '[]',linked jsonb default '[]',modules jsonb default '{}'
);
create table public.blocks(blocker uuid,blocked_persona uuid,kind text);
create table public.persona_publication_dependencies(persona_id uuid,dependency_persona_id uuid,dependency_kind text);
create table public.follows(id uuid primary key default gen_random_uuid(),follower uuid,target uuid,status text,created_at timestamptz default now());
create table public.persona_follows(follower_persona_id uuid,target_persona_id uuid,visibility text default 'public',created_at timestamptz default now(),primary key(follower_persona_id,target_persona_id));
create table public.persona_family_relationships(owner uuid,relationship_type text,from_persona_id uuid,to_persona_id uuid,visibility text,canon_status text);
create table public.persona_links(id uuid primary key default gen_random_uuid(),persona_id uuid,platform text,handle text,url text,sort integer default 0);
create table public.posts(id uuid primary key default gen_random_uuid(),persona_id uuid,kind text default 'post',title text default '',body text default '',tags text default '',media_url text default '',created_at timestamptz default now());
create table public.comments(id uuid primary key default gen_random_uuid(),post_id uuid,persona_id uuid,body text,created_at timestamptz default now());
create table public.reactions(post_id uuid,persona_id uuid,kind text,primary key(post_id,persona_id,kind));
create table public.persona_page_layouts(persona_id uuid primary key,owner uuid,schema_version smallint default 1,layout jsonb default '{}');
create table public.albums(id uuid primary key default gen_random_uuid(),persona_id uuid,title text,kind text default 'gallery',sort integer default 0);
create table public.album_items(id uuid primary key default gen_random_uuid(),album_id uuid,thumb_url text default '',caption text default '',link_url text default '',sort integer default 0);

-- The disposable harness keeps direct table reads fail-closed while exercising
-- the SECURITY DEFINER RPC surface through the same anon/authenticated roles
-- used by PostgREST.
alter table public.personas enable row level security;
grant select on public.personas to anon,authenticated;

create or replace function public.persona_publication_is_current(pid uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select exists(select 1 from public.personas p where p.id=pid and p.publication_state='published' and p.published_revision=p.publication_revision)
$$;
create or replace function public.lock_persona_publication_mutation(pid uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if pid is null then raise exception 'Persona id is required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pid::text,51051051));
end
$$;
create or replace function public.is_safe_credential_free_https_url(value text,allow_empty boolean default false)
returns boolean language sql immutable set search_path='' as $$
  select case when coalesce(value,'')='' then allow_empty else value ~ '^https://[^/@[:space:]]+\.[^/@[:space:]]+(?:/.*)?$' and position('@' in split_part(substr(value,9),'/',1))=0 end
$$;
create or replace function public.canonical_persona_modules(value jsonb)
returns jsonb language sql immutable as $$ select coalesce(value,'{}'::jsonb) $$;
create or replace function public.persona_relation_cards(p_source_id uuid)
returns table(dependency_kind text,relative_persona_id uuid,relative_handle text,relative_name text,relative_tagline text,relative_avatar_url text,relationship_label text,sort_order integer)
language sql stable as $$ select null::text,null::uuid,null::text,null::text,null::text,null::text,null::text,null::integer where false $$;
create or replace function public.get_public_persona_revenue_rails(p_handle text)
returns table(persona_id uuid,affiliate_enabled boolean,review_requests_enabled boolean,default_disclosure text,cta_label text,review_cta_label text,offers jsonb)
language sql stable as $$ select null::uuid,false,false,''::text,''::text,''::text,'[]'::jsonb where false $$;
create or replace function public.follow_persona(actor uuid,target uuid,show text default 'public')
returns boolean language plpgsql security definer set search_path='' as $$ begin insert into public.persona_follows values(actor,target,show,now()) on conflict do nothing;return true;end $$;
create or replace function public.unfollow_persona(actor uuid,target uuid)
returns boolean language plpgsql security definer set search_path='' as $$ begin delete from public.persona_follows f where f.follower_persona_id=actor and f.target_persona_id=target;return found;end $$;
create or replace function public.request_persona_friendship(actor uuid,target uuid,proof text default null)
returns jsonb language plpgsql security definer set search_path='' as $$ declare rid uuid;begin insert into public.follows(follower,target,status) values(actor,target,'pending') returning id into rid;return jsonb_build_object('ok',true,'request_id',rid,'message','Friend request sent');end $$;
create or replace function public.respond_persona_friendship(request_id uuid,accept boolean)
returns boolean language plpgsql security definer set search_path='' as $$ begin if accept then update public.follows f set status='accepted' where f.id=request_id;else delete from public.follows f where f.id=request_id;end if;return true;end $$;
create or replace function public.remove_persona_friendship(actor uuid,other uuid)
returns boolean language plpgsql security definer set search_path='' as $$ begin delete from public.follows f where least(f.follower,f.target)=least(actor,other) and greatest(f.follower,f.target)=greatest(actor,other);return found;end $$;
create or replace function public.add_persona_comment(post_id uuid,actor uuid,content text)
returns uuid language plpgsql security definer set search_path='' as $$ declare cid uuid;begin insert into public.comments(post_id,persona_id,body) values(post_id,actor,content) returning id into cid;return cid;end $$;
create or replace function public.toggle_persona_reaction(post_id uuid,actor uuid,reaction text)
returns boolean language plpgsql security definer set search_path='' as $$ begin insert into public.reactions values(post_id,actor,reaction) on conflict do nothing;return true;end $$;
create or replace function public.delete_persona_comment(comment_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$ begin delete from public.comments c where c.id=comment_id;return found;end $$;
