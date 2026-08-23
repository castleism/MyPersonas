\set ON_ERROR_STOP on

create schema extensions;
create extension pgcrypto with schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role',true),'')
$$;

create table storage.objects(
  id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null,
  metadata jsonb not null default '{}'::jsonb
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon,authenticated,service_role;
grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
create policy "persona media owner insert" on storage.objects for insert to authenticated
  with check(bucket_id='persona-media' and split_part(name,'/',1)=auth.uid()::text);

create table public.profiles(id uuid primary key);
create table public.ai_backends(id uuid primary key,owner uuid not null references public.profiles(id));
create table public.personas(
  id uuid primary key,owner uuid not null references public.profiles(id),handle text unique not null,
  avatar_url text not null default '',banner_url text not null default '',bg_url text not null default '',
  feed_img_url text not null default '',publication_revision integer not null default 1,
  published_revision integer,publication_state text not null default 'draft'
);
create table public.posts(
  id uuid primary key default gen_random_uuid(),persona_id uuid not null references public.personas(id),
  media_url text not null default ''
);
create table public.albums(
  id uuid primary key default gen_random_uuid(),persona_id uuid not null references public.personas(id)
);
create table public.album_items(
  id uuid primary key default gen_random_uuid(),album_id uuid not null references public.albums(id),
  thumb_url text not null default ''
);
create table public.drafts(
  id uuid primary key default gen_random_uuid(),persona_id uuid not null references public.personas(id),
  media_url text not null default ''
);
create table public.post_drafts(
  id uuid primary key default gen_random_uuid(),owner uuid not null references public.profiles(id),
  persona_id uuid not null references public.personas(id),status text not null default 'draft'
    check(status in ('draft','approved','scheduled','publishing','posted','failed','skipped')),
  source_image_url text not null default '',fb_image_url text not null default '',
  ig_image_url text not null default '',x_image_url text not null default '',
  targets text[] not null default array['facebook','instagram','twitter']::text[],
  approved_fb_media_sha256 text not null default '',
  approved_fb_media_url text not null default '',
  approved_ig_media_sha256 text not null default '',
  approved_ig_media_url text not null default '',
  -- Simulates a database that saw the earlier fail-open draft of migration 059.
  media_provenance_required boolean not null default false
);
create table public.persona_media_assets(
  id uuid primary key default gen_random_uuid(),owner uuid not null,
  persona_id uuid not null references public.personas(id) on delete cascade,
  post_draft_id uuid references public.post_drafts(id) on delete set null,
  media_type text not null default 'image' check(media_type in ('image','video','audio','document')),
  storage_path text not null default '',public_url text not null default '',
  alt_text text not null default '',caption text not null default '',
  source text not null default 'generated' check(source in ('generated','uploaded','sourced','remixed')),
  generation_prompt text not null default '',generation_backend uuid,
  tags text[] not null default '{}',metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check(status in ('active','archived','flagged')),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);

create or replace function public.add_media_asset(
  uuid,text,text,text,text,text,text,text,uuid,text[],jsonb
) returns uuid language sql as $$ select gen_random_uuid() $$;

create or replace function public.persona_publication_review_manifest(uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('complete',true,'truncation_reasons','[]'::jsonb)
$$;
create or replace function public.require_aal2() returns void language plpgsql as $$ begin return;end $$;
create or replace function public.invalidate_persona_review_revision(p_persona_id uuid)
returns void language sql security definer as $$
  update public.personas set publication_revision=publication_revision+1,
    publication_state=case when publication_state in('published','in_review') then 'draft' else publication_state end
  where id=p_persona_id
$$;

insert into public.profiles(id) values ('05900000-0000-4000-8000-000000000099');
insert into public.personas(id,owner,handle,avatar_url) values (
  '05900000-0000-4000-8000-000000000199',
  '05900000-0000-4000-8000-000000000099','legacy-provenance-backfill',
  'https://legacy.example.test/preexisting-avatar.png'
);
insert into public.post_drafts(id,owner,persona_id,media_provenance_required) values (
  '05900000-0000-4000-8000-000000000299',
  '05900000-0000-4000-8000-000000000099',
  '05900000-0000-4000-8000-000000000199',false
);

grant usage on schema public to anon,authenticated,service_role;
grant select,insert,update,delete on all tables in schema public to authenticated,service_role;
grant execute on all functions in schema public to authenticated,service_role;
