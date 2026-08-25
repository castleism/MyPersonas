\set ON_ERROR_STOP on

create extension if not exists pgcrypto;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
$$;

create table public.profiles(id uuid primary key);
create table public.account_ledger(
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  suspended boolean not null default false,
  unique(id,owner)
);
create table public.persona_projects(
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,owner)
);
create table public.project_resources(
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  owner uuid not null references public.profiles(id) on delete cascade,
  resource_type text not null,
  display_name text not null,
  resource_locator text not null default '',
  account_ledger_id uuid,
  access_mode text not null default 'reference',
  connection_state text not null default 'not_configured',
  enabled boolean not null default false,
  owner_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(project_id,owner) references public.persona_projects(id,owner) on delete cascade,
  foreign key(account_ledger_id,owner) references public.account_ledger(id,owner) on delete restrict
);
create table public.meta_owner_erasure_leases(
  owner uuid primary key references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One migration-049-compatible legacy row proves 067 disables an unsafe
-- enabled locator without deleting the owner's repairable metadata.
insert into public.profiles(id) values('06700000-0000-4000-8000-000000000099');
insert into public.persona_projects(id,owner,name) values(
  '06700000-0000-4000-8000-000000000199',
  '06700000-0000-4000-8000-000000000099','Legacy project'
);
insert into public.project_resources(
  id,project_id,owner,resource_type,display_name,resource_locator,
  access_mode,connection_state,enabled,owner_notes
) values(
  '06700000-0000-4000-8000-000000000299',
  '06700000-0000-4000-8000-000000000199',
  '06700000-0000-4000-8000-000000000099','website','Unsafe legacy row',
  'https://localhost./','reference','ready',true,'preserve for owner repair'
);

revoke all on public.project_resources from public,anon,authenticated,service_role;
grant select on public.project_resources to authenticated;
grant select on public.project_resources to service_role;

-- Migration 049 historical browser RPCs exist before migration 067 revokes them.
create function public.save_project_resource(
  p_resource_id uuid,p_project_id uuid,p_resource_type text,p_display_name text,
  p_resource_locator text default '',p_account_ledger_id uuid default null,
  p_access_mode text default 'reference',p_connection_state text default 'not_configured',
  p_enabled boolean default false,p_owner_notes text default ''
) returns uuid language sql security definer set search_path='' as $$select null::uuid$$;
create function public.delete_project_resource(p_resource_id uuid)
returns boolean language sql security definer set search_path='' as $$select false$$;

create or replace function public.require_aal2()
returns void language plpgsql stable security invoker set search_path='' as $$
begin
  if auth.uid() is null then raise sqlstate '28000' using message='Authentication required'; end if;
  if coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise sqlstate '42501' using message='Two-factor verification required';
  end if;
end
$$;

create or replace function public.assert_owner_erasure_inactive_066(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or auth.uid() is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0)
  );
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.expires_at<=now();
  if exists(select 1 from public.meta_owner_erasure_leases lease
    where lease.owner=p_owner and lease.expires_at>now()) then
    raise sqlstate '55000' using
      message='Persona content changes are blocked while owner erasure is running';
  end if;
end
$$;
revoke all on function public.assert_owner_erasure_inactive_066(uuid)
  from public,anon,authenticated,service_role;

create or replace function public.is_safe_credential_free_https_url(
  p_value text,p_allow_empty boolean default false
)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  v_url text:=coalesce(p_value,'');v_tail text;v_authority text;v_remainder text;
  v_host text;v_port_text text;v_label text;
begin
  if v_url='' then return p_allow_empty; end if;
  if v_url<>trim(v_url) or char_length(v_url)>2048
     or lower(left(v_url,8))<>'https://'
     or v_url~'[[:cntrl:][:space:]<>]' or position(chr(92) in v_url)>0 then return false; end if;
  v_tail:=substr(v_url,9);
  v_authority:=split_part(split_part(split_part(v_tail,'/',1),'?',1),'#',1);
  v_remainder:=substr(v_tail,char_length(v_authority)+1);
  if v_authority='' or position('@' in v_authority)>0
     or (v_remainder<>'' and left(v_remainder,1) not in ('/','?','#')) then return false; end if;
  if v_authority~':[0-9]+$' then
    v_port_text:=substring(v_authority from ':([0-9]+)$');
    v_host:=left(v_authority,char_length(v_authority)-char_length(v_port_text)-1);
    if char_length(v_port_text)>5 or v_port_text::integer not between 1 and 65535 then return false; end if;
  else
    v_host:=v_authority;if position(':' in v_host)>0 then return false; end if;
  end if;
  if char_length(v_host) not between 1 and 253 or position('.' in v_host)=0
     or lower(v_host) in ('localhost','localhost.localdomain')
     or lower(v_host)~'\.(localhost|local|internal|lan)$' or v_host~'^[0-9.]+$'
     or v_host~*'^(?:[0-9]+|0x[0-9a-f]+)(?:\.(?:[0-9]+|0x[0-9a-f]+))+$'
     then return false; end if;
  foreach v_label in array string_to_array(v_host,'.') loop
    if char_length(v_label) not between 1 and 63
       or v_label!~'^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$' then return false; end if;
  end loop;
  return true;
end
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

create or replace function public.lock_owner_persona_org_creation_quota(p_owner uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_owner is null or p_owner is distinct from auth.uid() then
    raise exception 'Authenticated owner is required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner::text,6701));
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
  if p_scope<>'project_resources' or p_limit<>50 or p_units<>1 or p_observed not between 0 and 49 then
    raise exception 'Invalid rate request';
  end if;
  return p_observed+p_units;
end
$$;
