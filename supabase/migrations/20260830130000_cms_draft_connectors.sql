-- Native Wix Blog and WordPress draft-only connectors.
--
-- Provider credentials and Wix instance identifiers are capabilities. They are
-- stored only in Supabase Vault and are never exposed to browser roles. The
-- first release can create, read back, reconcile, and trash provider drafts;
-- it deliberately contains no provider publish or scheduling path.
begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.cms_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  provider text not null check (provider in ('wix','wordpress')),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  requested_site text not null default '' check (char_length(requested_site) <= 500),
  return_origin text not null check (char_length(return_origin) between 1 and 255),
  launched_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
create unique index if not exists cms_oauth_transactions_owner_ledger_provider_idx
  on public.cms_oauth_transactions(owner,ledger_id,provider);
create index if not exists cms_oauth_transactions_expiry_idx
  on public.cms_oauth_transactions(expires_at);

create table if not exists public.cms_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('wix','wordpress')),
  provider_mode text not null check (
    (provider='wix' and provider_mode='wix_app_instance') or
    (provider='wordpress' and provider_mode in ('wordpress_com_oauth','wordpress_application_password'))
  ),
  provider_subject text not null default '' check (char_length(provider_subject) <= 500),
  site_id text not null check (char_length(site_id) between 1 and 255),
  site_url text not null check (site_url ~ '^https://[^[:space:]]+$' and char_length(site_url) <= 500),
  site_name text not null default '' check (char_length(site_name) <= 200),
  author_id text not null default '' check (char_length(author_id) <= 200),
  author_name text not null default '' check (char_length(author_name) <= 200),
  vault_secret_id uuid not null unique,
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade
);
-- Wix is stored once before an exact author is selected. Empty subjects must
-- therefore remain repeatable, while every usable site+author target is unique.
create unique index if not exists cms_credentials_owner_subject_idx
  on public.cms_credentials(owner,provider_subject)
  where provider_subject<>'';

create table if not exists public.cms_draft_attempts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  ledger_id uuid not null,
  provider text not null check (provider in ('wix','wordpress')),
  provider_mode text not null check (provider_mode in (
    'wix_app_instance','wordpress_com_oauth','wordpress_application_password'
  )),
  exact_target_id text not null check (char_length(exact_target_id) between 1 and 500),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'claimed' check (status in (
    'claimed','definitive_failure','outcome_unknown','provider_created','verified',
    'delete_claimed','delete_outcome_unknown','provider_deleted'
  )),
  attempt_count integer not null default 1 check (attempt_count between 1 and 20),
  provider_draft_id text not null default '' check (char_length(provider_draft_id) <= 255),
  provider_http_status integer,
  last_error text not null default '' check (char_length(last_error) <= 1000),
  started_at timestamptz not null default now(),
  provider_accepted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  unique(owner,draft_id,request_fingerprint)
);
create index if not exists cms_draft_attempts_owner_idx
  on public.cms_draft_attempts(owner,updated_at desc);

create table if not exists public.cms_provider_drafts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete restrict,
  ledger_id uuid not null,
  attempt_id uuid not null unique references public.cms_draft_attempts(id) on delete restrict,
  provider text not null check (provider in ('wix','wordpress')),
  provider_mode text not null check (provider_mode in (
    'wix_app_instance','wordpress_com_oauth','wordpress_application_password'
  )),
  exact_target_id text not null check (char_length(exact_target_id) between 1 and 500),
  draft_content_hash text not null check (draft_content_hash ~ '^[0-9a-f]{64}$'),
  provider_content_hash text not null check (provider_content_hash ~ '^[0-9a-f]{64}$'),
  provider_draft_id text not null check (char_length(provider_draft_id) between 1 and 255),
  provider_status text not null check (provider_status in ('draft','trash')),
  provider_preview_url text not null default '' check (
    char_length(provider_preview_url) <= 1000 and (provider_preview_url='' or provider_preview_url~'^https://[^[:space:]]+$')
  ),
  provider_edit_url text not null default '' check (
    char_length(provider_edit_url) <= 1000 and (provider_edit_url='' or provider_edit_url~'^https://[^[:space:]]+$')
  ),
  title text not null check (char_length(title) between 1 and 200),
  verified_at timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id,owner) references public.account_ledger(id,owner) on delete cascade,
  unique(provider,provider_mode,provider_draft_id),
  unique(owner,draft_id,draft_content_hash,exact_target_id)
);
create index if not exists cms_provider_drafts_owner_idx
  on public.cms_provider_drafts(owner,created_at desc);

alter table public.cms_oauth_transactions enable row level security;
alter table public.cms_credentials enable row level security;
alter table public.cms_draft_attempts enable row level security;
alter table public.cms_provider_drafts enable row level security;

revoke all on public.cms_oauth_transactions,public.cms_credentials,
  public.cms_draft_attempts from anon,authenticated;
grant all on public.cms_oauth_transactions,public.cms_credentials,
  public.cms_draft_attempts to service_role;
revoke all on public.cms_provider_drafts from anon,authenticated;
grant select on public.cms_provider_drafts to authenticated;
grant all on public.cms_provider_drafts to service_role;
drop policy if exists "cms provider drafts owner read" on public.cms_provider_drafts;
create policy "cms provider drafts owner read" on public.cms_provider_drafts
  for select using (owner=auth.uid());

create or replace function public.cms_get_app_secret_service(p_name text)
returns text language plpgsql security definer set search_path='' as $$
declare v_secret text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_name not in ('wix_app_secret','wordpress_com_client_secret') then
    raise exception 'Unknown CMS app secret';
  end if;
  select s.decrypted_secret into v_secret
  from vault.decrypted_secrets s where s.name=p_name;
  if v_secret is null or octet_length(v_secret) not between 16 and 32768 then return null; end if;
  return v_secret;
end; $$;

create or replace function public.cms_store_credential_service(
  p_ledger_id uuid,p_owner uuid,p_provider text,p_provider_mode text,
  p_provider_subject text,p_site_id text,p_site_url text,p_site_name text,
  p_author_id text,p_author_name text,p_secret jsonb,p_granted_scopes text[]
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_secret_id uuid; v_name text; v_ledger_provider text;
  v_existing public.cms_credentials%rowtype; v_has_existing boolean:=false;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_provider not in ('wix','wordpress')
    or (p_provider='wix' and p_provider_mode<>'wix_app_instance')
    or (p_provider='wordpress' and p_provider_mode not in (
      'wordpress_com_oauth','wordpress_application_password'
    )) then raise exception 'Invalid CMS credential mode'; end if;
  if trim(coalesce(p_site_id,''))='' or coalesce(p_site_url,'')!~'^https://[^[:space:]]+$'
    or char_length(p_site_url)>500 or jsonb_typeof(p_secret)<>'object'
    or octet_length(p_secret::text)>32768 then raise exception 'Invalid CMS credential'; end if;
  if p_provider='wordpress' and (
    trim(coalesce(p_author_id,''))='' or trim(coalesce(p_provider_subject,''))=''
  ) then raise exception 'WordPress requires an exact site and author binding'; end if;
  if p_provider='wix' and (
    (trim(coalesce(p_author_id,''))='')<>(trim(coalesce(p_provider_subject,''))='')
  ) then raise exception 'Wix author and exact target must be selected together'; end if;
  select provider into v_ledger_provider from public.account_ledger
    where id=p_ledger_id and owner=p_owner and not suspended for update;
  if not found or v_ledger_provider<>p_provider then raise exception 'Owned CMS ledger changed'; end if;
  select * into v_existing from public.cms_credentials
    where ledger_id=p_ledger_id and owner=p_owner for update;
  v_has_existing:=found;
  if v_has_existing and exists(
    select 1 from public.cms_draft_attempts a where a.ledger_id=p_ledger_id
      and a.owner=p_owner and a.status in (
        'claimed','outcome_unknown','provider_created','delete_claimed','delete_outcome_unknown'
      )
  ) then raise exception 'Reconcile the unfinished provider attempt before replacing this authorization'; end if;
  if v_has_existing and exists(
    select 1 from public.cms_provider_drafts d where d.ledger_id=p_ledger_id
      and d.owner=p_owner and d.provider_status='draft'
  ) then raise exception 'Move every provider draft to Trash before replacing this authorization'; end if;
  if v_has_existing and (
    v_existing.provider is distinct from p_provider
    or v_existing.provider_mode is distinct from p_provider_mode
    or v_existing.provider_subject is distinct from coalesce(p_provider_subject,'')
    or v_existing.site_id is distinct from p_site_id
    or v_existing.site_url is distinct from p_site_url
    or v_existing.author_id is distinct from coalesce(p_author_id,'')
  ) then raise exception 'Disconnect the existing CMS authorization before rebinding its site or author'; end if;
  v_name:='cms_'||p_provider||'_'||p_ledger_id::text;
  if v_has_existing then v_secret_id:=v_existing.vault_secret_id; end if;
  if v_secret_id is null then select id into v_secret_id from vault.secrets where name=v_name; end if;
  if v_secret_id is null then
    select vault.create_secret(p_secret::text,v_name,
      'CMS credential for '||p_provider||' ledger '||p_ledger_id::text) into v_secret_id;
  else
    perform vault.update_secret(v_secret_id,p_secret::text,v_name,
      'CMS credential for '||p_provider||' ledger '||p_ledger_id::text);
  end if;
  insert into public.cms_credentials as c(
    ledger_id,owner,provider,provider_mode,provider_subject,site_id,site_url,
    site_name,author_id,author_name,vault_secret_id,updated_at
  ) values(
    p_ledger_id,p_owner,p_provider,p_provider_mode,coalesce(p_provider_subject,''),
    p_site_id,p_site_url,left(coalesce(p_site_name,''),200),coalesce(p_author_id,''),
    left(coalesce(p_author_name,''),200),v_secret_id,now()
  ) on conflict(ledger_id) do update set provider=excluded.provider,
    provider_mode=excluded.provider_mode,provider_subject=excluded.provider_subject,
    site_id=excluded.site_id,site_url=excluded.site_url,site_name=excluded.site_name,
    author_id=excluded.author_id,author_name=excluded.author_name,
    vault_secret_id=excluded.vault_secret_id,updated_at=now();
  insert into public.account_connections as ac(
    ledger_id,owner,provider,provider_subject,provider_email,granted_scopes,
    connection_state,verification_method,verified_at,connected_at,last_checked_at,
    expires_at,error_code,updated_at
  ) values(
    p_ledger_id,p_owner,p_provider,coalesce(p_provider_subject,''),'',
    coalesce(p_granted_scopes,'{}'),
    case when trim(coalesce(p_provider_subject,''))='' then 'verified' else 'connected' end,
    p_provider_mode,now(),case when trim(coalesce(p_provider_subject,''))='' then null else now() end,
    now(),null,case when trim(coalesce(p_provider_subject,''))='' then 'author_selection_required' else '' end,now()
  ) on conflict(ledger_id) do update set owner=excluded.owner,provider=excluded.provider,
    provider_subject=excluded.provider_subject,provider_email='',
    granted_scopes=excluded.granted_scopes,connection_state=excluded.connection_state,
    verification_method=excluded.verification_method,verified_at=excluded.verified_at,
    connected_at=case when excluded.connection_state='connected'
      then coalesce(ac.connected_at,excluded.connected_at) else null end,
    last_checked_at=excluded.last_checked_at,expires_at=null,error_code=excluded.error_code,
    updated_at=now();
  return v_secret_id;
end; $$;

create or replace function public.cms_get_credential_service(p_ledger_id uuid,p_owner uuid)
returns table(
  provider text,provider_mode text,provider_subject text,site_id text,site_url text,
  site_name text,author_id text,author_name text,secret jsonb
) language plpgsql security definer set search_path='' as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  return query select c.provider,c.provider_mode,c.provider_subject,c.site_id,c.site_url,
    c.site_name,c.author_id,c.author_name,s.decrypted_secret::jsonb
  from public.cms_credentials c join vault.decrypted_secrets s on s.id=c.vault_secret_id
  where c.ledger_id=p_ledger_id and c.owner=p_owner;
end; $$;

create or replace function public.cms_set_wix_author_service(
  p_ledger_id uuid,p_owner uuid,p_member_id text,p_member_name text
) returns text language plpgsql security definer set search_path='' as $$
declare c public.cms_credentials%rowtype; v_target text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if coalesce(p_member_id,'')!~'^[0-9A-Za-z_-]{8,100}$' then raise exception 'Invalid Wix member'; end if;
  select * into c from public.cms_credentials where ledger_id=p_ledger_id and owner=p_owner
    and provider='wix' and provider_mode='wix_app_instance' for update;
  if not found then raise exception 'Wix installation is not connected'; end if;
  v_target:='wix:'||c.site_id||':'||p_member_id;
  if trim(coalesce(c.provider_subject,''))<>'' and c.provider_subject<>v_target then
    raise exception 'Disconnect the existing Wix author binding before selecting another author';
  end if;
  if exists(
    select 1 from public.cms_draft_attempts a where a.ledger_id=p_ledger_id
      and a.owner=p_owner and a.status in (
        'claimed','outcome_unknown','provider_created','delete_claimed','delete_outcome_unknown'
      )
  ) or exists(
    select 1 from public.cms_provider_drafts d where d.ledger_id=p_ledger_id
      and d.owner=p_owner and d.provider_status='draft'
  ) then raise exception 'Finish every Wix provider draft attempt before changing its author binding'; end if;
  update public.cms_credentials set provider_subject=v_target,author_id=p_member_id,
    author_name=left(coalesce(p_member_name,''),200),updated_at=now()
    where ledger_id=p_ledger_id and owner=p_owner;
  update public.account_connections set provider_subject=v_target,
    -- The OAuth edge function proves both calls immediately before invoking
    -- this service-only binding function: List Members (Read Members) and
    -- Query Draft Posts (Manage Blog).
    granted_scopes=array['READ_MEMBERS','MANAGE_BLOG'],connection_state='connected',
    verification_method='wix_app_instance',connected_at=coalesce(connected_at,now()),
    last_checked_at=now(),error_code='',updated_at=now()
    where ledger_id=p_ledger_id and owner=p_owner and provider='wix';
  return v_target;
end; $$;

create or replace function public.cms_delete_credential_service(p_ledger_id uuid,p_owner uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if exists(
    select 1 from public.cms_provider_drafts d
    where d.ledger_id=p_ledger_id and d.owner=p_owner and d.provider_status='draft'
  ) then raise exception 'Move every provider draft for this connection to Trash before disconnecting'; end if;
  if exists(
    select 1 from public.cms_draft_attempts a where a.ledger_id=p_ledger_id
      and a.owner=p_owner and a.status in (
        'claimed','outcome_unknown','provider_created','delete_claimed','delete_outcome_unknown'
      )
  ) then raise exception 'Reconcile every unfinished provider draft attempt before disconnecting'; end if;
  delete from public.cms_credentials where ledger_id=p_ledger_id and owner=p_owner;
  get diagnostics v_count=row_count;
  update public.account_connections set provider_subject='',granted_scopes='{}',
    connection_state='disconnected',connected_at=null,last_checked_at=now(),
    expires_at=null,error_code='',updated_at=now()
    where ledger_id=p_ledger_id and owner=p_owner;
  return v_count>0;
end; $$;

create or replace function public.delete_cms_credential_vault_secret()
returns trigger language plpgsql security definer set search_path='' as $$
begin delete from vault.secrets where id=old.vault_secret_id; return old; end; $$;
drop trigger if exists cms_credentials_delete_vault_secret on public.cms_credentials;
create trigger cms_credentials_delete_vault_secret after delete on public.cms_credentials
  for each row execute function public.delete_cms_credential_vault_secret();

create or replace function public.guard_connected_cms_ledger_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' and old.provider in ('wix','wordpress') and exists(
    select 1 from public.cms_credentials where ledger_id=old.id and owner=old.owner
  ) then
    raise exception 'Disconnect the CMS authorization before deleting this ledger entry';
  end if;
  if tg_op='UPDATE' and old.provider in ('wix','wordpress') and exists(
    select 1 from public.cms_credentials where ledger_id=old.id and owner=old.owner
  ) and (
    new.owner is distinct from old.owner
    or new.provider is distinct from old.provider
    or new.username is distinct from old.username
    or new.login_email is distinct from old.login_email
    or new.url is distinct from old.url
  ) then raise exception 'Disconnect the CMS authorization before retargeting this ledger entry'; end if;
  return case when tg_op='DELETE' then old else new end;
end; $$;
drop trigger if exists guard_connected_cms_ledger_change on public.account_ledger;
create trigger guard_connected_cms_ledger_change before update or delete on public.account_ledger
  for each row execute function public.guard_connected_cms_ledger_change();

create or replace function public.guard_active_cms_source_draft_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_active boolean:=false;
begin
  select exists(
    select 1 from public.cms_draft_attempts a where a.owner=old.owner and a.draft_id=old.id
      and a.status in (
        'claimed','outcome_unknown','provider_created','delete_claimed','delete_outcome_unknown'
      )
  ) or exists(
    select 1 from public.cms_provider_drafts d where d.owner=old.owner and d.draft_id=old.id
      and d.provider_status='draft'
  ) into v_active;
  if not v_active then return case when tg_op='DELETE' then old else new end; end if;
  if tg_op='DELETE' then
    raise exception 'Reconcile or trash the active provider draft before deleting its source';
  end if;
  if new.owner is distinct from old.owner or new.persona_id is distinct from old.persona_id
    or new.account_id is distinct from old.account_id or new.platform is distinct from old.platform
    or new.title is distinct from old.title or new.body is distinct from old.body
    or new.tags is distinct from old.tags or new.media_url is distinct from old.media_url
    or new.content_kind is distinct from old.content_kind or new.publish_at is distinct from old.publish_at
    or new.approved_content_hash is distinct from old.approved_content_hash then
    raise exception 'Reconcile or trash the active provider draft before changing its approved source';
  end if;
  return new;
end; $$;
drop trigger if exists guard_active_cms_source_draft_change on public.drafts;
create trigger guard_active_cms_source_draft_change before update or delete on public.drafts
  for each row execute function public.guard_active_cms_source_draft_change();

create or replace function public.cms_exact_preview_is_current_service(
  p_owner uuid,p_draft_id uuid,p_provider text
) returns boolean language plpgsql security definer set search_path='' as $$
declare d public.drafts%rowtype; l public.account_ledger%rowtype;
  c public.account_connections%rowtype; v_hash text; v_preview_hash text;
  v_target text; v_platform text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_provider not in ('wix','wordpress') then return false; end if;
  select * into d from public.drafts where id=p_draft_id and owner=p_owner;
  if not found or d.account_id is null or d.persona_id is null
    or d.approval_state<>'approved' or d.publish_state in ('publishing','published')
    or coalesce(d.provider_post_id,'')<>'' or trim(coalesce(d.title,''))=''
    or char_length(d.title)>200 or octet_length(coalesce(d.body,''))>200000
    or trim(coalesce(d.media_url,''))<>'' then return false; end if;
  v_platform:=lower(trim(coalesce(d.platform,'')));
  if p_provider='wix' and v_platform<>'wix' then return false; end if;
  if p_provider='wordpress' and v_platform not in (
    'wordpress','wordpress_com','wordpress_self_hosted'
  ) then return false; end if;
  select * into l from public.account_ledger where id=d.account_id and owner=p_owner
    and provider=p_provider and persona_id=d.persona_id and not suspended;
  if not found then return false; end if;
  select * into c from public.account_connections where ledger_id=l.id and owner=p_owner
    and provider=p_provider and connection_state='connected';
  if not found or trim(coalesce(c.provider_subject,''))='' then return false; end if;
  v_hash:=public.agent_draft_hash(d.title,d.body,d.tags,d.media_url,d.content_kind,
    d.persona_id,d.account_id,d.platform,d.publish_at);
  v_target:=public.agent_draft_expected_preview_target(
    d.owner,d.persona_id,d.account_id,d.platform
  );
  v_preview_hash:=public.agent_draft_preview_hash(
    d.approved_content_hash,d.approved_preview_version,d.approved_preview_target_id
  );
  return d.approved_content_hash=v_hash
    and d.approved_preview_version='platform-preview-v1'
    and d.approved_preview_target_id=c.provider_subject
    and d.approved_preview_target_id=v_target
    and d.approved_preview_hash=v_preview_hash
    and d.approved_previewed_at is not null
    and d.approved_previewed_at<=now();
end; $$;

create or replace function public.cms_draft_request_fingerprint(
  p_provider text,p_provider_mode text,p_content_hash text,p_exact_target_id text
) returns text language sql immutable set search_path='' as $$
  select encode(extensions.digest(convert_to(array_to_json(array[
    'cms-draft-v1',coalesce(p_provider,''),coalesce(p_provider_mode,''),
    coalesce(p_content_hash,''),coalesce(p_exact_target_id,'')
  ]::text[])::text,'UTF8'),'sha256'),'hex');
$$;

-- A CMS provider request may begin only after this transaction both consumes
-- the exact acknowledged preview receipt and inserts/reclaims its durable
-- attempt. The receipt's claim id is the attempt primary key.
create or replace function public.claim_cms_draft_with_preview_service(
  p_owner uuid,p_draft_id uuid,p_provider text,p_receipt_id uuid
) returns public.cms_draft_attempts language plpgsql security definer set search_path='' as $$
declare
  d public.drafts%rowtype;
  l public.account_ledger%rowtype;
  c public.account_connections%rowtype;
  credential public.cms_credentials%rowtype;
  attempt public.cms_draft_attempts%rowtype;
  result public.cms_draft_attempts%rowtype;
  v_provider text:=lower(trim(coalesce(p_provider,'')));
  v_fingerprint text;
  v_attempt_id uuid;
begin
  if coalesce(auth.role(),'')<>'service_role'
    then raise exception 'CMS preview claims are service-only'; end if;
  if v_provider not in ('wix','wordpress') then
    raise exception 'Unsupported CMS provider'; end if;

  -- Lock order is draft -> owner/account state -> all prior attempts -> receipt.
  select * into d from public.drafts
  where id=p_draft_id and owner=p_owner for update;
  if not found or d.account_id is null or d.persona_id is null
    or d.approval_state<>'approved'
    or d.publish_state in ('publishing','published')
    or coalesce(d.provider_post_id,'')<>''
    or trim(coalesce(d.title,''))='' or char_length(d.title)>200
    or octet_length(coalesce(d.body,''))>200000
    or trim(coalesce(d.media_url,''))<>''
    or (v_provider='wix' and lower(trim(coalesce(d.platform,'')))<>'wix')
    or (v_provider='wordpress' and lower(trim(coalesce(d.platform,''))) not in (
      'wordpress','wordpress_com','wordpress_self_hosted'
    )) then raise exception 'The exact approved CMS draft is not claimable'; end if;
  if not public.cms_exact_preview_is_current_service(p_owner,d.id,v_provider) then
    raise exception 'The exact CMS preview is no longer current'; end if;
  if not exists(select 1 from public.agent_owner_settings settings
    where settings.owner=p_owner and not settings.automation_paused for share)
    then raise exception 'Owner automation is paused or unavailable'; end if;

  select * into l from public.account_ledger
  where id=d.account_id and owner=p_owner and provider=v_provider
    and persona_id=d.persona_id and not coalesce(suspended,false) for share;
  if not found then raise exception 'The exact CMS ledger destination is unavailable'; end if;
  select * into c from public.account_connections
  where ledger_id=l.id and owner=p_owner and provider=v_provider for share;
  if not found or c.connection_state<>'connected'
    or trim(coalesce(c.provider_subject,''))='' then
    raise exception 'The exact CMS connection is unavailable'; end if;
  select * into credential from public.cms_credentials
  where ledger_id=l.id and owner=p_owner and provider=v_provider for share;
  if not found or credential.provider_subject is distinct from c.provider_subject
    or trim(coalesce(credential.author_id,''))=''
    or credential.provider_mode is distinct from c.verification_method then
    raise exception 'The exact CMS site and author authorization changed'; end if;
  if (v_provider='wix' and (
      credential.provider_mode<>'wix_app_instance'
      or not ('READ_MEMBERS'=any(coalesce(c.granted_scopes,array[]::text[])))
      or not ('MANAGE_BLOG'=any(coalesce(c.granted_scopes,array[]::text[])))
    )) or (credential.provider_mode='wordpress_com_oauth'
      and not (coalesce(c.granted_scopes,array[]::text[])&&array['posts','global']::text[]))
    or (credential.provider_mode='wordpress_application_password' and (
      not ('posts'=any(coalesce(c.granted_scopes,array[]::text[])))
      or not ('application-password'=any(coalesce(c.granted_scopes,array[]::text[])))
    )) then raise exception 'The CMS credential no longer grants draft creation'; end if;
  if d.approved_preview_target_id is distinct from c.provider_subject
    or d.approved_preview_target_id is distinct from public.agent_draft_expected_preview_target(
      p_owner,d.persona_id,d.account_id,d.platform
    ) then raise exception 'The exact CMS destination preview changed'; end if;

  v_fingerprint:=public.cms_draft_request_fingerprint(
    v_provider,credential.provider_mode,d.approved_content_hash,c.provider_subject
  );
  -- Lock all attempt rows for this draft in primary-key order. The draft lock
  -- serializes first inserts, while these locks serialize every retry/reconcile.
  perform 1 from public.cms_draft_attempts existing
  where existing.owner=p_owner and existing.draft_id=d.id
  order by existing.id for update;
  select * into attempt from public.cms_draft_attempts existing
  where existing.owner=p_owner and existing.draft_id=d.id
    and existing.request_fingerprint=v_fingerprint;
  if found then
    if attempt.status<>'definitive_failure' then
      raise exception 'The existing CMS attempt must be reconciled before another provider request';
    end if;
    if attempt.attempt_count>=20 then raise exception 'The CMS attempt retry limit was reached'; end if;
    v_attempt_id:=attempt.id;
  else
    if exists(select 1 from public.cms_draft_attempts existing
      where existing.owner=p_owner and existing.draft_id=d.id
        and existing.status in (
          'claimed','outcome_unknown','provider_created','verified',
          'delete_claimed','delete_outcome_unknown'
        )) then raise exception 'Another CMS attempt must be reconciled first'; end if;
    v_attempt_id:=gen_random_uuid();
  end if;

  perform public.consume_provider_action_preview_for_claim_service(
    p_owner,d.id,l.id,v_provider,v_provider||'.create_draft',p_receipt_id,
    c.provider_subject,d.approved_content_hash,v_fingerprint,v_attempt_id,'cms_draft'
  );
  if attempt.id is null then
    insert into public.cms_draft_attempts(
      id,owner,draft_id,ledger_id,provider,provider_mode,exact_target_id,
      request_fingerprint,status,attempt_count,started_at,updated_at
    ) values(
      v_attempt_id,p_owner,d.id,l.id,v_provider,credential.provider_mode,
      c.provider_subject,v_fingerprint,'claimed',1,now(),now()
    ) returning * into result;
  else
    update public.cms_draft_attempts set status='claimed',
      attempt_count=attempt.attempt_count+1,provider_draft_id='',
      provider_http_status=null,last_error='',started_at=now(),
      provider_accepted_at=null,completed_at=null,updated_at=now()
    where id=attempt.id and owner=p_owner and status='definitive_failure'
      and attempt_count=attempt.attempt_count
    returning * into result;
    if not found then raise exception 'The failed CMS attempt claim conflicted'; end if;
  end if;
  return result;
end; $$;

-- The provider has already confirmed a reversible Trash operation when this
-- function is called. Keep the provider checkpoint and its attempt transition
-- in one database transaction so the browser is never told the local ledger
-- is complete after only one of the two rows changed.
create or replace function public.cms_mark_provider_draft_trashed_service(
  p_owner uuid,p_record_id uuid,p_attempt_id uuid,p_provider text,
  p_provider_draft_id text,p_exact_target_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if p_provider not in ('wix','wordpress') or trim(coalesce(p_provider_draft_id,''))=''
    or trim(coalesce(p_exact_target_id,''))='' then
    raise exception 'Invalid provider Trash checkpoint';
  end if;
  update public.cms_provider_drafts set provider_status='trash',deleted_at=now(),updated_at=now()
  where id=p_record_id and owner=p_owner and attempt_id=p_attempt_id
    and provider=p_provider and provider_draft_id=p_provider_draft_id
    and exact_target_id=p_exact_target_id and provider_status='draft';
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Provider draft checkpoint changed before Trash was recorded'; end if;
  update public.cms_draft_attempts set status='provider_deleted',completed_at=now(),
    updated_at=now(),last_error=left(
      case when p_provider='wix' then 'Wix' else 'WordPress' end||
      ' moved the provider draft to trash.',1000
    )
  where id=p_attempt_id and owner=p_owner and provider=p_provider
    and provider_draft_id=p_provider_draft_id and exact_target_id=p_exact_target_id
    and status in ('delete_claimed','delete_outcome_unknown');
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Provider draft attempt changed before Trash was recorded'; end if;
  return true;
end; $$;

-- Durable pre-mutation claim for a reversible provider Trash request. If the
-- provider response or the final local checkpoint is interrupted, the queue
-- remains visibly recovery-only after a reload and cannot issue DELETE again.
create or replace function public.cms_claim_provider_draft_trash_service(
  p_owner uuid,p_record_id uuid,p_attempt_id uuid,p_provider text,
  p_provider_draft_id text,p_exact_target_id text
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
  if not exists(
    select 1 from public.cms_provider_drafts d
    where d.id=p_record_id and d.owner=p_owner and d.attempt_id=p_attempt_id
      and d.provider=p_provider and d.provider_draft_id=p_provider_draft_id
      and d.exact_target_id=p_exact_target_id and d.provider_status='draft'
  ) then raise exception 'Provider draft checkpoint changed before Trash claim'; end if;
  update public.cms_draft_attempts set status='delete_claimed',updated_at=now(),
    last_error='Provider Trash request claimed; no duplicate provider delete is allowed.'
  where id=p_attempt_id and owner=p_owner and provider=p_provider
    and provider_draft_id=p_provider_draft_id and exact_target_id=p_exact_target_id
    and status='verified';
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'Provider Trash attempt is already claimed or changed'; end if;
  return true;
end; $$;

-- Browser-safe recovery state for queue hydration. It reveals no credential,
-- provider ID, endpoint, or content and only returns the caller's unfinished
-- attempts for draft IDs already visible to that caller.
create or replace function public.my_cms_draft_recovery_status(p_draft_ids uuid[])
returns table(draft_id uuid,provider text,recovery_state text)
language plpgsql security definer set search_path='' stable as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_draft_ids is null or cardinality(p_draft_ids)>200 then
    raise exception 'Between 0 and 200 draft IDs are required';
  end if;
  return query
  select distinct on (a.draft_id) a.draft_id,a.provider,a.status
  from public.cms_draft_attempts a
  join public.drafts d on d.id=a.draft_id and d.owner=a.owner
  where a.owner=auth.uid() and a.draft_id=any(p_draft_ids)
    and a.status in (
      'claimed','outcome_unknown','provider_created','delete_claimed','delete_outcome_unknown'
    )
  order by a.draft_id,a.updated_at desc,a.id desc;
end; $$;

revoke all on function public.cms_store_credential_service(
  uuid,uuid,text,text,text,text,text,text,text,text,jsonb,text[]
) from public,anon,authenticated;
revoke all on function public.cms_get_app_secret_service(text)
  from public,anon,authenticated;
revoke all on function public.cms_get_credential_service(uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.cms_set_wix_author_service(uuid,uuid,text,text)
  from public,anon,authenticated;
revoke all on function public.cms_delete_credential_service(uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.cms_exact_preview_is_current_service(uuid,uuid,text)
  from public,anon,authenticated;
revoke all on function public.cms_draft_request_fingerprint(text,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.claim_cms_draft_with_preview_service(uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.cms_mark_provider_draft_trashed_service(
  uuid,uuid,uuid,text,text,text
) from public,anon,authenticated;
revoke all on function public.cms_claim_provider_draft_trash_service(
  uuid,uuid,uuid,text,text,text
) from public,anon,authenticated;
revoke all on function public.my_cms_draft_recovery_status(uuid[])
  from public,anon;
revoke all on function public.delete_cms_credential_vault_secret()
  from public,anon,authenticated;
revoke all on function public.guard_connected_cms_ledger_change()
  from public,anon,authenticated;
revoke all on function public.guard_active_cms_source_draft_change()
  from public,anon,authenticated;
grant execute on function public.cms_store_credential_service(
  uuid,uuid,text,text,text,text,text,text,text,text,jsonb,text[]
) to service_role;
grant execute on function public.cms_get_app_secret_service(text) to service_role;
grant execute on function public.cms_get_credential_service(uuid,uuid) to service_role;
grant execute on function public.cms_set_wix_author_service(uuid,uuid,text,text) to service_role;
grant execute on function public.cms_delete_credential_service(uuid,uuid) to service_role;
grant execute on function public.cms_exact_preview_is_current_service(uuid,uuid,text) to service_role;
grant execute on function public.claim_cms_draft_with_preview_service(uuid,uuid,text,uuid)
  to service_role;
grant execute on function public.cms_mark_provider_draft_trashed_service(
  uuid,uuid,uuid,text,text,text
) to service_role;
grant execute on function public.cms_claim_provider_draft_trash_service(
  uuid,uuid,uuid,text,text,text
) to service_role;
grant execute on function public.my_cms_draft_recovery_status(uuid[]) to authenticated;

comment on table public.cms_provider_drafts is
  'Provider-side Wix or WordPress drafts verified by readback; these records do not represent publication.';
comment on function public.cms_exact_preview_is_current_service(uuid,uuid,text) is
  'Service-only gate requiring migration-069 exact platform preview evidence and text-only draft scope.';
comment on function public.cms_get_app_secret_service(text) is
  'Service-only allowlisted reader for CMS developer client secrets stored in Supabase Vault.';
comment on function public.my_cms_draft_recovery_status(uuid[]) is
  'Owner-scoped unfinished CMS attempt state for durable queue reconciliation after a reload.';

commit;
