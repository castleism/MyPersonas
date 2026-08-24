\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists dblink;

create table auth.users(
  id uuid primary key,
  email text,
  email_confirmed_at timestamptz
);
create or replace function auth.uid() returns uuid
language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create or replace function auth.jwt() returns jsonb
language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;

create table public.profiles(
  id uuid primary key,
  email text,
  display_name text,
  prefs jsonb default '{}'::jsonb
);

create table public.platform_role_assignments(
  account_id uuid not null,
  role_key text not null,
  active boolean not null default true,
  expires_at timestamptz,
  primary key(account_id,role_key)
);
create or replace function public.has_platform_role(p_roles text[])
returns boolean language sql security definer stable set search_path='' as $$
  select exists(
    select 1 from public.platform_role_assignments role_row
    where role_row.account_id=auth.uid() and role_row.active
      and role_row.role_key=any(p_roles)
      and (role_row.expires_at is null or role_row.expires_at>now())
  )
$$;
create or replace function public.require_aal2()
returns void language plpgsql security definer stable set search_path='' as $$
begin
  if coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'AAL2 required'; end if;
end;
$$;

create table public.platform_security_events(
  id bigint generated always as identity primary key,
  actor_id uuid,
  event_type text not null check (char_length(event_type) between 1 and 100),
  severity text not null default 'info'
    check (severity in ('info','warning','high','critical')),
  source text not null default 'application'
    check (source in ('application','auth_hook','waf','log_drain','edge_function','staff')),
  subject_type text,
  subject_id text,
  identifier_hash text default '',
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  subject_account_id uuid
);

create table public.personas(
  id uuid primary key,
  owner uuid not null,
  handle text not null,
  name text not null,
  tagline text default '',
  bio text default '',
  nsfw boolean default false,
  visibility text default 'public',
  avatar_url text default '',
  banner_url text default '',
  bg_url text default '',
  feed_img_url text default '',
  music_url text default '',
  live_url text default '',
  theme text default '',
  topics text default '',
  hashtags text default '',
  top8 jsonb default '[]'::jsonb,
  modules jsonb default '{}'::jsonb,
  linked jsonb default '[]'::jsonb,
  title text default '',
  focus text default '',
  pet_project text default '',
  ai_disclosure text default '',
  publication_state text default 'draft',
  publication_revision bigint default 1,
  published_revision bigint,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.personas enable row level security;

create table public.persona_publication_reviews(
  persona_id uuid,
  owner uuid,
  review_state text,
  reviewed_revision bigint,
  readiness_snapshot jsonb default '{}'::jsonb
);
create table public.persona_publication_dependency_sets(
  persona_id uuid,
  owner uuid,
  reviewed_revision bigint,
  manifest_sha256 text,
  dependency_count bigint
);
create table public.persona_publication_dependencies(
  persona_id uuid,
  dependency_persona_id uuid,
  dependency_kind text,
  dependency_revision bigint,
  projection_sha256 text
);
create or replace function public.persona_public_urls_safe(uuid)
returns boolean language sql immutable as $$select true$$;
create or replace function public.persona_modules_are_canonical(jsonb)
returns boolean language sql immutable as $$select true$$;
create or replace function public.persona_dependency_projection_hash(uuid,text)
returns text language sql immutable as $$select ''::text$$;
create or replace function public.canonical_persona_modules(p jsonb)
returns jsonb language sql immutable as $$select coalesce(p,'{}'::jsonb)$$;
create or replace function public.persona_visible(uuid)
returns boolean language sql immutable as $$select true$$;

create table public.businesses(
  id uuid primary key,
  owner uuid not null,
  page_status text,
  visibility text,
  published_at timestamptz,
  published_revision bigint,
  publication_revision bigint
);
create table public.business_publication_reviews(
  business_id uuid,
  owner uuid,
  review_state text,
  reviewed_revision bigint,
  required_missing integer,
  published_at timestamptz,
  readiness_snapshot jsonb
);
create or replace function public.business_publication_review_manifest(uuid)
returns jsonb language sql immutable as $$select '{"complete":true}'::jsonb$$;

create table public.ai_tasks(
  id uuid primary key,
  owner uuid not null,
  active boolean not null default true,
  cadence text not null default 'daily',
  schedule_day smallint,
  schedule_time time not null default '09:00',
  timezone text not null default 'UTC',
  lead_minutes integer not null default 60,
  next_run_at timestamptz,
  next_publish_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_status text default '',
  last_error text default '',
  updated_at timestamptz not null default now()
);
create table public.post_drafts(
  id uuid primary key,
  owner uuid not null,
  status text not null default 'draft'
    check (status in ('draft','approved','scheduled','posted','failed','skipped')),
  scheduled_for timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
create table public.drafts(
  id uuid primary key,
  owner uuid not null,
  status text default 'idea' check (status in ('idea','ready','posted')),
  approval_state text not null default 'draft',
  publish_state text not null default 'not_queued'
    check (publish_state in ('not_queued','queued','publishing','published','failed','blocked')),
  publish_at timestamptz,
  publish_next_attempt_at timestamptz,
  publish_error text not null default '',
  updated_at timestamptz not null default now()
);
create or replace function public.next_content_occurrence(
  p_cadence text,p_schedule_day smallint,p_schedule_time time,
  p_timezone text,p_after timestamptz
)
returns timestamptz language sql immutable as $$
  select p_after + case when p_cadence='weekly' then interval '7 days' else interval '1 day' end
$$;
create table public.agent_generation_queue_state(
  owner uuid primary key,
  last_claimed_at timestamptz not null default now(),
  claim_count bigint not null default 0,
  updated_at timestamptz not null default now()
);

grant usage on schema public to anon,authenticated,service_role;
grant select on public.personas to anon,authenticated;
