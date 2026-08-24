\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create schema private;

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
  select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'')
$$;

create table public.profiles(id uuid primary key);
create table public.platform_role_assignments(
  account_id uuid not null references public.profiles(id),
  role_key text not null,
  active boolean not null default true,
  expires_at timestamptz,
  primary key(account_id,role_key)
);
create or replace function public.has_platform_role(p_roles text[])
returns boolean language sql security definer stable set search_path='' as $$
  select auth.uid() is not null and exists(
    select 1 from public.platform_role_assignments assignment
    where assignment.account_id=auth.uid() and assignment.active
      and (assignment.expires_at is null or assignment.expires_at>now())
      and assignment.role_key=any(coalesce(p_roles,'{}'::text[]))
  )
$$;
create or replace function public.require_aal2()
returns void language plpgsql stable security invoker set search_path='' as $$
begin
  if auth.uid() is null then
    raise sqlstate '28000' using message='Authentication required';
  end if;
  if coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise sqlstate '42501' using message='Two-factor verification required';
  end if;
end
$$;
revoke all on function public.has_platform_role(text[]),public.require_aal2()
  from public,anon;
grant execute on function public.has_platform_role(text[]) to authenticated;

create table public.platform_security_events(
  id bigint generated always as identity primary key,
  actor_id uuid,
  event_type text not null,
  severity text not null check(severity in('info','warning','high','critical')),
  source text not null check(source in('application','auth_hook','waf','log_drain','edge_function','staff')),
  subject_type text not null default '',
  subject_id text not null default '',
  subject_account_id uuid,
  identifier_hash text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
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
create or replace function public.billing_run_retention(
  p_limit integer default 500
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return jsonb_build_object('reconciliation_alerts',0,'webhook_events',0);
end
$$;
revoke all on function public.purge_ai_backend_budget_retention(integer),
  public.billing_run_retention(integer) from public,anon,authenticated;
grant execute on function public.purge_ai_backend_budget_retention(integer),
  public.billing_run_retention(integer) to service_role;

alter table public.platform_role_assignments enable row level security;
alter table public.platform_security_events enable row level security;
alter table public.account_security_states enable row level security;
alter table public.error_logs enable row level security;
alter table public.product_review_notifications enable row level security;
revoke all on public.platform_role_assignments,public.platform_security_events,
  public.account_security_states,public.error_logs,
  public.product_review_notifications from public,anon,authenticated;
