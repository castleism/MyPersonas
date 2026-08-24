\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create schema extensions;
create schema storage;
create extension if not exists pgcrypto with schema extensions;

create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;
create or replace function auth.role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role',true),'') ,'')
$$;

create table public.profiles(id uuid primary key);
create table public.personas(
  id uuid primary key,
  owner uuid not null references public.profiles(id)
);
create table storage.buckets(
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects(
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  metadata jsonb not null default '{}'::jsonb,
  unique(bucket_id,name)
);

alter table public.profiles enable row level security;
alter table public.personas enable row level security;
alter table storage.objects enable row level security;
grant usage on schema public,storage to anon,authenticated,service_role;

insert into public.profiles(id) values
  ('07000000-0000-4000-8000-000000000001'),
  ('07000000-0000-4000-8000-000000000002');
insert into public.personas(id,owner) values
  ('07000000-0000-4000-8000-000000000011','07000000-0000-4000-8000-000000000001'),
  ('07000000-0000-4000-8000-000000000013','07000000-0000-4000-8000-000000000001'),
  ('07000000-0000-4000-8000-000000000012','07000000-0000-4000-8000-000000000002');

-- Migration 068 supplies this service-only entitlement function in the real
-- release chain. The isolated 070 harness controls it with a transaction-local
-- setting so both denied and allowed claim paths are executable.
create or replace function public.account_has_billing_access(p_account_id uuid)
returns boolean language sql security definer stable set search_path='' as $$
  select p_account_id='07000000-0000-4000-8000-000000000001'::uuid
    and coalesce(nullif(current_setting('test.billing_access',true),''),'false')::boolean
$$;
