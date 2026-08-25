\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role',true),'')
$$;

create table public.profiles(id uuid primary key);
create table public.meta_owner_erasure_leases(
  owner uuid primary key references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.personas(
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  handle text not null unique,
  visibility text not null default 'private',
  publication_state text not null default 'draft',
  publication_revision bigint not null default 1,
  published_revision bigint,
  unpublished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(id,owner)
);
create table public.persona_publication_reviews(
  persona_id uuid primary key references public.personas(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  review_state text not null default 'draft',
  updated_at timestamptz not null default now()
);
create table public.follows(
  id uuid primary key default gen_random_uuid(),follower uuid not null,target uuid not null,
  status text not null
);
create table public.persona_follows(
  follower_persona_id uuid not null,target_persona_id uuid not null,
  primary key(follower_persona_id,target_persona_id)
);
create table public.persona_page_layouts(
  persona_id uuid primary key,owner uuid not null,layout jsonb not null default '{}'
);
create table public.persona_page_code_snippets(
  id uuid primary key default gen_random_uuid(),owner uuid not null,persona_id uuid,code text not null default ''
);

create or replace function public.lock_owner_content_creation_quota(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text,51051056));
end
$$;
create or replace function public.lock_persona_publication_mutation(p_persona_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_persona_id is null then raise exception 'Persona id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,51051051));
end
$$;
create or replace function public.consume_owner_daily_rate(
  p_owner uuid,p_scope text,p_limit integer,p_units integer default 1,p_observed integer default 0
)
returns integer language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  if p_scope<>'persona_custom_fields' or p_limit<>200 or p_units<>1
     or p_observed not between 0 and 199 then raise exception 'Invalid rate request'; end if;
  return p_observed+p_units;
end
$$;
create or replace function public.is_safe_credential_free_https_url(
  p_value text,p_allow_empty boolean default false
)
returns boolean language sql immutable set search_path='' as $$
  select case when coalesce(p_value,'')='' then p_allow_empty
    else p_value ~ '^https://[^/@[:space:]]+(?:\.[^/@[:space:]]+)+(?:/[^[:space:]]*)?$'
      and position('@' in split_part(substr(p_value,9),'/',1))=0 end
$$;
create or replace function public.project_resource_text_has_secret(p_value text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_value,'') ~* concat(
    '(password|passcode|api[ _-]?key|client[ _-]?secret|secret[ _-]?access[ _-]?key|',
    'access[ _-]?token|refresh[ _-]?token|authorization|bearer|private[ _-]?key)',
    '[[:space:]]*[:=][[:space:]]*[^[:space:]]{4,}|',
    'bearer[[:space:]]+[A-Za-z0-9._~+/-]{12,}|',
    '(^|[^A-Za-z0-9])(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|',
    'AKIA[A-Z0-9]{16})([^A-Za-z0-9]|$)|',
    '-----BEGIN[[:space:]][A-Z0-9 ]*PRIVATE KEY-----|',
    '[A-Za-z][A-Za-z0-9+.-]*://[^/?#[:space:]]+@')
$$;
create or replace function public.persona_publication_is_current(p_persona_id uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.publication_state='published'
      and persona.published_revision=persona.publication_revision)
$$;
create or replace function public.persona_visible(p_persona_id uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select exists(select 1 from public.personas persona where persona.id=p_persona_id
    and (persona.owner=auth.uid() or (persona.visibility in ('public','unlisted')
      and public.persona_publication_is_current(persona.id))))
$$;
create or replace function public.persona_mode_can_view(
  p_actor_persona_id uuid,p_target_persona_id uuid
)
returns boolean language sql security definer stable set search_path='' as $$
  select exists(select 1 from public.personas actor
    join public.personas target on target.id=p_target_persona_id
    where actor.id=p_actor_persona_id and actor.owner=auth.uid()
      and (target.id=actor.id or (public.persona_publication_is_current(target.id)
        and (target.visibility in ('public','unlisted') or exists(
          select 1 from public.follows friendship where friendship.status='accepted'
            and least(friendship.follower,friendship.target)=least(actor.id,target.id)
            and greatest(friendship.follower,friendship.target)=greatest(actor.id,target.id))))))
$$;
create or replace function public.invalidate_persona_review_revision(p_persona_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  update public.personas persona set
    publication_revision=publication_revision+1,
    publication_state=case when publication_state in ('published','in_review') then 'draft' else publication_state end,
    unpublished_at=case when publication_state='published' then now() else unpublished_at end,
    updated_at=now()
  where persona.id=p_persona_id;
  update public.persona_publication_reviews review
    set review_state='stale',updated_at=now() where review.persona_id=p_persona_id;
end
$$;
create or replace function public.persona_publication_review_manifest(p_persona_id uuid)
returns jsonb language plpgsql security definer stable set search_path='' as $$
begin
  if not exists(select 1 from public.personas persona
    where persona.id=p_persona_id and persona.owner=auth.uid()) then
    raise exception 'Owned persona not found';
  end if;
  return jsonb_build_object('schema_version',1,'complete',true,
    'counts','{}'::jsonb,'limits','{}'::jsonb,'truncation_reasons','[]'::jsonb,
    'withheld',jsonb_build_array('credentials'));
end
$$;
create table public.test_066_manifest_oid(original_oid oid not null);
insert into public.test_066_manifest_oid(original_oid)
values('public.persona_publication_review_manifest(uuid)'::regprocedure::oid);

revoke all on public.persona_page_layouts,public.persona_page_code_snippets
  from public,anon,authenticated,service_role;
