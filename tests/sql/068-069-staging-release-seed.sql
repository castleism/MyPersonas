\set ON_ERROR_STOP on

create schema storage;
create table storage.buckets(
  id text primary key,
  name text not null,
  public boolean not null default false
);
create table storage.objects(id uuid primary key default gen_random_uuid());
insert into storage.buckets(id,name,public)
values('post-approved-media','post-approved-media',false);

create schema vault;
create table vault.secrets(id uuid primary key default gen_random_uuid());

create schema supabase_migrations;
create table supabase_migrations.schema_migrations(
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations(version,name) values
  ('20260823035000','staging_predecessor_through_061'),
  ('20260823040000','opaque_public_media_delivery'),
  ('20260823050000','opaque_approved_media_delivery'),
  ('20260823060000','legacy_media_remediation');

create or replace function auth.role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'')
$$;

create table public.media_environment_config_062(
  singleton boolean primary key default true,
  environment_name text not null,
  supabase_origin text not null,
  public_media_origin text not null,
  locked_at timestamptz
);
insert into public.media_environment_config_062(
  singleton,environment_name,supabase_origin,public_media_origin,locked_at
) values(
  true,
  'staging',
  'https://abcdefghijklmnopqrst.supabase.co',
  'https://media-staging.mypersonas.online',
  now()
);
create or replace function public.media_environment_config_service()
returns table(
  environment_name text,
  supabase_origin text,
  public_media_origin text,
  locked_at timestamptz
)
language sql stable security definer set search_path='' as $$
  select config.environment_name,config.supabase_origin,
    config.public_media_origin,config.locked_at
  from public.media_environment_config_062 config
  where config.singleton
$$;
create table public.post_approved_media_handles(id uuid primary key default gen_random_uuid());
create table public.legacy_media_references(id uuid primary key default gen_random_uuid());
create or replace function public.approved_media_delivery_url(p_id uuid)
returns text language sql immutable as $$select null::text$$;
create or replace function public.inventory_legacy_media_references_service(
  p_cursor uuid,p_limit integer
)
returns integer language sql immutable as $$select 0$$;
create or replace function public.resolve_legacy_media_preview_service(
  p_account_id uuid,p_asset_id uuid
)
returns text language sql immutable as $$select null::text$$;

create table public.account_security_states(
  user_id uuid primary key,
  notification_pending boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.error_logs(
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  message text not null default '',
  context jsonb not null default '{}'::jsonb,
  severity text not null default 'error'
    check(severity in('info','warning','error','critical')),
  created_at timestamptz not null default now()
);
create table public.product_review_notifications(
  id uuid primary key default gen_random_uuid(),
  status text not null check(status in(
    'queued','claimed','sent','failed','reconciliation_required','cancelled'
  )),
  attempt_count integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error_code text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.product_review_rate_limits(
  scope text not null,
  key_hash text not null,
  window_start timestamptz not null,
  hit_count integer not null default 1,
  expires_at timestamptz not null,
  primary key(scope,key_hash,window_start)
);
create table public.affiliate_click_rate_limits(
  scope text not null,
  key_hash text not null,
  window_start timestamptz not null,
  hit_count integer not null default 1,
  expires_at timestamptz not null,
  primary key(scope,key_hash,window_start)
);
create table public.affiliate_click_events(
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table public.friend_request_security_events(
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now()
);
create table public.persona_friend_invites(
  id uuid primary key default gen_random_uuid(),
  max_uses integer not null default 1,
  use_count integer not null default 0,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.security_network_blocks(
  identifier_hash text primary key,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.product_review_requests(
  id uuid primary key default gen_random_uuid(),
  retention_expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table public.platform_feature_requests(
  id uuid primary key default gen_random_uuid(),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.persona_extension_submissions(
  id uuid primary key default gen_random_uuid(),
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create or replace function public.purge_ai_backend_budget_retention(
  p_limit integer default 1000
)
returns integer language plpgsql security definer set search_path='' as $$
begin
  return least(greatest(coalesce(p_limit,1000),1),5000);
end
$$;
