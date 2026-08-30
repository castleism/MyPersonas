-- TikTok OAuth + approval-bound Content Posting foundation.
--
-- This migration is intentionally forward-only. It does not enable a cron
-- worker or publish anything. Tokens and transient OAuth material remain
-- service-only; owners can read only the non-secret, exact preview approvals.

begin;

create extension if not exists supabase_vault with schema vault;

create table if not exists public.tiktok_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  requested_scopes text[] not null,
  access_mode text not null check (access_mode in ('upload','direct')),
  return_origin text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create unique index if not exists tiktok_oauth_transactions_owner_ledger_idx
  on public.tiktok_oauth_transactions(owner, ledger_id);
create index if not exists tiktok_oauth_transactions_expiry_idx
  on public.tiktok_oauth_transactions(expires_at);

create table if not exists public.tiktok_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider_open_id text not null,
  provider_username text not null,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (provider_open_id ~ '^[A-Za-z0-9._~-]{1,200}$'),
  check (provider_username ~ '^[A-Za-z0-9._]{2,64}$')
);

create unique index if not exists tiktok_credentials_open_id_idx
  on public.tiktok_credentials(provider_open_id);

create table if not exists public.tiktok_token_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null
    check (operation_kind in ('connect','refresh','disconnect','reset','publish','status')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create index if not exists tiktok_token_operation_leases_expiry_idx
  on public.tiktok_token_operation_leases(expires_at);

create table if not exists public.tiktok_draft_approvals (
  draft_id uuid primary key references public.drafts(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  provider_open_id text not null,
  approved_content_hash text not null check (approved_content_hash ~ '^[0-9a-f]{64}$'),
  preview_version text not null check (preview_version = 'tiktok-platform-preview-v1'),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  publish_mode text not null check (publish_mode in ('upload_inbox','direct_post')),
  approved_media_sha256 text not null check (approved_media_sha256 ~ '^[0-9a-f]{64}$'),
  approved_media_mime text not null
    check (approved_media_mime in ('video/mp4','video/quicktime','video/webm')),
  approved_media_bytes bigint not null check (approved_media_bytes between 1 and 4294967296),
  approved_media_url text not null,
  approved_settings jsonb not null,
  approved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (provider_open_id ~ '^[A-Za-z0-9._~-]{1,200}$'),
  check (
    char_length(approved_media_url) between 9 and 2048
    and approved_media_url ~ '^https://[^[:space:]]+$'
    and position(approved_media_sha256 in lower(approved_media_url)) > 0
  )
);

create index if not exists tiktok_draft_approvals_owner_idx
  on public.tiktok_draft_approvals(owner, approved_at desc);

alter table public.tiktok_oauth_transactions enable row level security;
alter table public.tiktok_credentials enable row level security;
alter table public.tiktok_token_operation_leases enable row level security;
alter table public.tiktok_draft_approvals enable row level security;

revoke all on public.tiktok_oauth_transactions from anon, authenticated;
revoke all on public.tiktok_credentials from anon, authenticated;
revoke all on public.tiktok_token_operation_leases from anon, authenticated;
revoke all on public.tiktok_draft_approvals from anon, authenticated;
grant all on public.tiktok_oauth_transactions to service_role;
grant all on public.tiktok_credentials to service_role;
grant all on public.tiktok_token_operation_leases to service_role;
grant all on public.tiktok_draft_approvals to service_role;

drop policy if exists "TikTok approvals owner read only" on public.tiktok_draft_approvals;
create policy "TikTok approvals owner read only" on public.tiktok_draft_approvals
  for select using (auth.uid() = owner);
grant select (
  draft_id, owner, ledger_id, provider_open_id, approved_content_hash,
  preview_version, preview_hash, publish_mode, approved_media_sha256,
  approved_media_mime, approved_media_bytes, approved_media_url,
  approved_settings, approved_at, updated_at
) on public.tiktok_draft_approvals to authenticated;

comment on table public.tiktok_oauth_transactions is
  'Service-only single-use TikTok OAuth state, same-browser nonce, requested scopes, and PKCE verifier.';
comment on table public.tiktok_credentials is
  'Service-only mapping from one TikTok ledger record and open_id to a Vault token bundle.';
comment on table public.tiktok_draft_approvals is
  'Owner-readable, service-written exact TikTok preview, media, destination, settings, and consent snapshot.';

create or replace function public.consume_tiktok_oauth_state(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(
  owner uuid,
  ledger_id uuid,
  code_verifier text,
  requested_scopes text[],
  access_mode text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from public.tiktok_oauth_transactions as tx
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.expires_at > now()
  returning tx.owner, tx.ledger_id, tx.code_verifier,
    tx.requested_scopes, tx.access_mode;
end;
$$;

create or replace function public.claim_tiktok_token_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_operation_kind text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_claimed boolean := false;
begin
  if p_operation_kind not in ('connect','refresh','disconnect','reset','publish','status') then
    raise exception 'Invalid TikTok token operation';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 180 then
    raise exception 'TikTok token-operation lease must be between 15 and 180 seconds';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'tiktok'
  ) then
    raise exception 'Owned TikTok ledger entry not found';
  end if;

  insert into public.tiktok_token_operation_leases as lease (
    ledger_id, owner, lease_id, operation_kind, expires_at, created_at
  ) values (
    p_ledger_id, p_owner, p_lease_id, p_operation_kind,
    now() + make_interval(secs => p_ttl_seconds), now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    lease_id = excluded.lease_id,
    operation_kind = excluded.operation_kind,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at
  where lease.expires_at <= now()
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.release_tiktok_token_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer := 0;
begin
  delete from public.tiktok_token_operation_leases
  where ledger_id = p_ledger_id and owner = p_owner and lease_id = p_lease_id;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

create or replace function public.tiktok_store_token_bundle(
  p_ledger_id uuid,
  p_owner uuid,
  p_expected_ledger_username text,
  p_provider_open_id text,
  p_provider_username text,
  p_access_token text,
  p_refresh_token text,
  p_token_type text,
  p_scopes text[],
  p_expires_at timestamptz,
  p_refresh_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'tiktok_oauth_' || p_ledger_id::text;
  v_ledger_username text;
  v_provider_username text := lower(regexp_replace(trim(coalesce(p_provider_username,'')), '^@+', ''));
  v_expected_username text := lower(regexp_replace(trim(coalesce(p_expected_ledger_username,'')), '^@+', ''));
  v_scopes text[];
  v_bundle text;
begin
  if trim(coalesce(p_access_token,'')) = '' or trim(coalesce(p_refresh_token,'')) = '' then
    raise exception 'TikTok access and refresh tokens are required';
  end if;
  if char_length(p_access_token) > 16384 or char_length(p_refresh_token) > 16384 then
    raise exception 'TikTok token exceeds the storage limit';
  end if;
  if lower(trim(coalesce(p_token_type,''))) <> 'bearer' then
    raise exception 'TikTok token type must be bearer';
  end if;
  if coalesce(p_provider_open_id,'') !~ '^[A-Za-z0-9._~-]{1,200}$' then
    raise exception 'Invalid TikTok open_id';
  end if;
  if v_provider_username !~ '^[A-Za-z0-9._]{2,64}$' then
    raise exception 'Invalid TikTok username';
  end if;
  if p_expires_at is null or p_expires_at <= now()
    or p_refresh_expires_at is null or p_refresh_expires_at <= now() then
    raise exception 'TikTok token expiries must be in the future';
  end if;

  select lower(regexp_replace(trim(coalesce(username,'')), '^@+', ''))
    into v_ledger_username
  from public.account_ledger
  where id = p_ledger_id and owner = p_owner and provider = 'tiktok'
  for update;
  if not found or v_ledger_username = ''
    or v_ledger_username <> v_expected_username
    or v_ledger_username <> v_provider_username then
    raise exception 'Owned TikTok ledger identity changed or does not match the provider';
  end if;

  select coalesce(array_agg(distinct lower(trim(scope)) order by lower(trim(scope))), '{}')
    into v_scopes
  from unnest(coalesce(p_scopes,'{}')) scope
  where trim(scope) ~ '^[A-Za-z0-9._:-]{1,128}$';
  if not ('user.info.basic' = any(v_scopes))
    or not ('user.info.profile' = any(v_scopes))
    or not (('video.upload' = any(v_scopes)) or ('video.publish' = any(v_scopes))) then
    raise exception 'TikTok token is missing required identity or content scope';
  end if;

  v_bundle := jsonb_build_object(
    'access_token', p_access_token,
    'refresh_token', p_refresh_token,
    'token_type', 'bearer',
    'scopes', to_jsonb(v_scopes),
    'expires_at', p_expires_at,
    'refresh_expires_at', p_refresh_expires_at,
    'stored_at', now()
  )::text;

  select vault_secret_id into v_secret_id
  from public.tiktok_credentials
  where ledger_id = p_ledger_id and owner = p_owner
  for update;
  if v_secret_id is null then
    select id into v_secret_id from vault.secrets where name = v_secret_name;
  end if;
  if v_secret_id is null then
    select vault.create_secret(
      v_bundle, v_secret_name,
      'TikTok OAuth token bundle for ledger ' || p_ledger_id::text
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id, v_bundle, v_secret_name,
      'TikTok OAuth token bundle for ledger ' || p_ledger_id::text
    );
  end if;

  insert into public.tiktok_credentials as credential (
    ledger_id, owner, provider_open_id, provider_username,
    vault_secret_id, updated_at
  ) values (
    p_ledger_id, p_owner, p_provider_open_id, v_provider_username,
    v_secret_id, now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider_open_id = excluded.provider_open_id,
    provider_username = excluded.provider_username,
    vault_secret_id = excluded.vault_secret_id,
    updated_at = excluded.updated_at;

  insert into public.account_connections as connection (
    ledger_id, owner, provider, provider_subject, provider_email,
    granted_scopes, connection_state, verification_method,
    connected_at, last_checked_at, expires_at, error_code, updated_at
  ) values (
    p_ledger_id, p_owner, 'tiktok', p_provider_open_id, v_provider_username,
    v_scopes, 'connected', 'tiktok_oauth2_pkce',
    now(), now(), p_expires_at, '', now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider = excluded.provider,
    provider_subject = excluded.provider_subject,
    provider_email = excluded.provider_email,
    granted_scopes = excluded.granted_scopes,
    connection_state = excluded.connection_state,
    verification_method = excluded.verification_method,
    connected_at = excluded.connected_at,
    last_checked_at = excluded.last_checked_at,
    expires_at = excluded.expires_at,
    error_code = '',
    updated_at = excluded.updated_at;
  return v_secret_id;
end;
$$;

create or replace function public.tiktok_get_token_bundle(
  p_ledger_id uuid,
  p_owner uuid
)
returns table(
  provider_open_id text,
  provider_username text,
  token_bundle jsonb
)
language sql
security definer
set search_path = ''
as $$
  select credential.provider_open_id, credential.provider_username,
    secret.decrypted_secret::jsonb
  from public.tiktok_credentials credential
  join vault.decrypted_secrets secret on secret.id = credential.vault_secret_id
  where credential.ledger_id = p_ledger_id and credential.owner = p_owner;
$$;

create or replace function public.delete_tiktok_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

drop trigger if exists tiktok_credentials_delete_vault_secret on public.tiktok_credentials;
create trigger tiktok_credentials_delete_vault_secret
  after delete on public.tiktok_credentials
  for each row execute function public.delete_tiktok_vault_secret();

create or replace function public.tiktok_delete_token_bundle(
  p_ledger_id uuid,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer := 0;
begin
  delete from public.tiktok_credentials
  where ledger_id = p_ledger_id and owner = p_owner;
  get diagnostics v_count = row_count;
  update public.account_connections set
    connection_state = 'disconnected', provider_subject = '', provider_email = '',
    granted_scopes = '{}', connected_at = null, expires_at = null,
    error_code = '', last_checked_at = now(), updated_at = now()
  where ledger_id = p_ledger_id and owner = p_owner and provider = 'tiktok';
  return v_count > 0;
end;
$$;

create or replace function public.tiktok_valid_approval_settings(
  p_mode text,
  p_settings jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys integer;
  v_duration numeric;
  v_cover numeric;
begin
  if jsonb_typeof(p_settings) <> 'object' then return false; end if;
  select count(*) into v_keys from jsonb_object_keys(p_settings);
  if p_mode = 'upload_inbox' then
    return v_keys = 4
      and p_settings ?& array[
        'explicit_upload_consent','completion_required_in_tiktok',
        'caption_not_transferred_acknowledged','video_duration_seconds'
      ]
      and p_settings->'explicit_upload_consent' = 'true'::jsonb
      and p_settings->'completion_required_in_tiktok' = 'true'::jsonb
      and p_settings->'caption_not_transferred_acknowledged' = 'true'::jsonb
      and jsonb_typeof(p_settings->'video_duration_seconds') = 'number'
      and (p_settings->>'video_duration_seconds')::numeric > 0
      and (p_settings->>'video_duration_seconds')::numeric <= 600;
  end if;
  if p_mode <> 'direct_post' then return false; end if;
  if v_keys <> 12 or not p_settings ?& array[
    'privacy_level','disable_comment','disable_duet','disable_stitch',
    'brand_content_toggle','brand_organic_toggle','is_aigc',
    'music_usage_confirmed','branded_content_policy_confirmed',
    'explicit_direct_post_consent','video_duration_seconds',
    'video_cover_timestamp_ms'
  ] then return false; end if;
  if p_settings->>'privacy_level' not in (
    'PUBLIC_TO_EVERYONE','MUTUAL_FOLLOW_FRIENDS',
    'FOLLOWER_OF_CREATOR','SELF_ONLY'
  ) then return false; end if;
  if exists (
    select 1 from unnest(array[
      'disable_comment','disable_duet','disable_stitch',
      'brand_content_toggle','brand_organic_toggle','is_aigc',
      'music_usage_confirmed','branded_content_policy_confirmed',
      'explicit_direct_post_consent'
    ]) key where jsonb_typeof(p_settings->key) <> 'boolean'
  ) then return false; end if;
  if p_settings->'music_usage_confirmed' <> 'true'::jsonb
    or p_settings->'explicit_direct_post_consent' <> 'true'::jsonb then
    return false;
  end if;
  if (p_settings->'brand_content_toggle')::boolean
    is distinct from (p_settings->'branded_content_policy_confirmed')::boolean then
    return false;
  end if;
  if (p_settings->'brand_content_toggle')::boolean
    and p_settings->>'privacy_level' = 'SELF_ONLY' then
    return false;
  end if;
  if jsonb_typeof(p_settings->'video_duration_seconds') <> 'number'
    or jsonb_typeof(p_settings->'video_cover_timestamp_ms') <> 'number' then
    return false;
  end if;
  v_duration := (p_settings->>'video_duration_seconds')::numeric;
  v_cover := (p_settings->>'video_cover_timestamp_ms')::numeric;
  return v_duration > 0 and v_duration <= 600
    and v_cover = trunc(v_cover) and v_cover >= 0 and v_cover <= v_duration * 1000;
exception when others then
  return false;
end;
$$;

create or replace function public.tiktok_preview_hash(
  p_content_hash text,
  p_preview_version text,
  p_ledger_id uuid,
  p_provider_open_id text,
  p_publish_mode text,
  p_media_sha256 text,
  p_media_mime text,
  p_media_bytes bigint,
  p_media_url text,
  p_settings jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(concat_ws(chr(31),
    coalesce(p_content_hash,''), coalesce(p_preview_version,''),
    coalesce(p_ledger_id::text,''), coalesce(p_provider_open_id,''),
    coalesce(p_publish_mode,''), coalesce(p_media_sha256,''),
    coalesce(p_media_mime,''), coalesce(p_media_bytes::text,''),
    coalesce(p_media_url,''), coalesce(p_settings,'{}'::jsonb)::text
  ), 'sha256'), 'hex');
$$;

create or replace function public.store_tiktok_draft_approval_service(
  p_draft_id uuid,
  p_owner uuid,
  p_ledger_id uuid,
  p_provider_open_id text,
  p_content_hash text,
  p_preview_version text,
  p_preview_hash text,
  p_publish_mode text,
  p_media_sha256 text,
  p_media_mime text,
  p_media_bytes bigint,
  p_media_url text,
  p_settings jsonb
)
returns public.tiktok_draft_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.drafts%rowtype;
  v_ledger public.account_ledger%rowtype;
  v_connection public.account_connections%rowtype;
  v_expected_preview text;
  v_result public.tiktok_draft_approvals%rowtype;
  v_required_scope text;
begin
  select * into v_draft from public.drafts
  where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Owned TikTok draft not found'; end if;
  if v_draft.platform <> 'tiktok' or v_draft.account_id is distinct from p_ledger_id then
    raise exception 'Draft is not assigned to this TikTok account';
  end if;
  if v_draft.approval_state <> 'approved'
    or v_draft.approved_content_hash = ''
    or v_draft.approved_content_hash is distinct from p_content_hash then
    raise exception 'Exact generic draft approval is required';
  end if;
  if lower(coalesce(v_draft.content_kind,'')) not in ('video','reel')
    or coalesce(v_draft.media_url,'') = ''
    or v_draft.media_url is distinct from p_media_url then
    raise exception 'TikTok publishing requires the exact approved video';
  end if;
  if p_preview_version <> 'tiktok-platform-preview-v1'
    or p_media_sha256 !~ '^[0-9a-f]{64}$'
    or p_media_mime not in ('video/mp4','video/quicktime','video/webm')
    or p_media_bytes not between 1 and 4294967296
    or char_length(p_media_url) not between 9 and 2048
    or p_media_url !~ '^https://[^[:space:]]+$'
    or position(p_media_sha256 in lower(p_media_url)) = 0 then
    raise exception 'TikTok approved-media metadata is invalid';
  end if;
  if not public.tiktok_valid_approval_settings(p_publish_mode, p_settings) then
    raise exception 'TikTok privacy, interaction, commercial, AI, music, or consent settings are incomplete';
  end if;

  select * into v_ledger from public.account_ledger
  where id = p_ledger_id and owner = p_owner and provider = 'tiktok'
  for share;
  if not found or coalesce(v_ledger.suspended,false) then
    raise exception 'TikTok ledger destination is unavailable';
  end if;
  if v_ledger.persona_id is distinct from v_draft.persona_id and not exists (
    select 1 from public.account_persona_links link
    where link.owner = p_owner and link.ledger_id = p_ledger_id
      and link.persona_id = v_draft.persona_id
  ) then
    raise exception 'TikTok account is no longer assigned to this persona';
  end if;

  select * into v_connection from public.account_connections
  where ledger_id = p_ledger_id and owner = p_owner and provider = 'tiktok'
  for share;
  v_required_scope := case when p_publish_mode = 'direct_post'
    then 'video.publish' else 'video.upload' end;
  if not found or v_connection.connection_state <> 'connected'
    or v_connection.verification_method <> 'tiktok_oauth2_pkce'
    or v_connection.provider_subject is distinct from p_provider_open_id
    or not ('user.info.basic' = any(v_connection.granted_scopes))
    or not ('user.info.profile' = any(v_connection.granted_scopes))
    or not (v_required_scope = any(v_connection.granted_scopes)) then
    raise exception 'TikTok identity or required posting scope is not currently connected';
  end if;

  v_expected_preview := public.tiktok_preview_hash(
    p_content_hash, p_preview_version, p_ledger_id, p_provider_open_id,
    p_publish_mode, p_media_sha256, p_media_mime, p_media_bytes,
    p_media_url, p_settings
  );
  if p_preview_hash is distinct from v_expected_preview then
    raise exception 'The TikTok preview no longer matches the exact approved post';
  end if;

  insert into public.tiktok_draft_approvals as approval (
    draft_id, owner, ledger_id, provider_open_id, approved_content_hash,
    preview_version, preview_hash, publish_mode, approved_media_sha256,
    approved_media_mime, approved_media_bytes, approved_media_url,
    approved_settings, approved_at, updated_at
  ) values (
    p_draft_id, p_owner, p_ledger_id, p_provider_open_id, p_content_hash,
    p_preview_version, p_preview_hash, p_publish_mode, p_media_sha256,
    p_media_mime, p_media_bytes, p_media_url, p_settings, now(), now()
  )
  on conflict (draft_id) do update set
    owner = excluded.owner,
    ledger_id = excluded.ledger_id,
    provider_open_id = excluded.provider_open_id,
    approved_content_hash = excluded.approved_content_hash,
    preview_version = excluded.preview_version,
    preview_hash = excluded.preview_hash,
    publish_mode = excluded.publish_mode,
    approved_media_sha256 = excluded.approved_media_sha256,
    approved_media_mime = excluded.approved_media_mime,
    approved_media_bytes = excluded.approved_media_bytes,
    approved_media_url = excluded.approved_media_url,
    approved_settings = excluded.approved_settings,
    approved_at = excluded.approved_at,
    updated_at = excluded.updated_at
  returning * into v_result;

  insert into public.agent_actions (
    owner, persona_id, action_type, entity_type, entity_id, outcome, detail
  ) values (
    p_owner, v_draft.persona_id, 'tiktok.preview_approved', 'draft',
    p_draft_id, 'approved', jsonb_build_object(
      'ledger_id',p_ledger_id,'provider_open_id',p_provider_open_id,
      'content_hash',p_content_hash,'preview_version',p_preview_version,
      'preview_hash',p_preview_hash,'publish_mode',p_publish_mode,
      'media_sha256',p_media_sha256,'media_mime',p_media_mime,
      'media_bytes',p_media_bytes,'settings',p_settings
    )
  );
  return v_result;
end;
$$;

-- Bind the one-shot action-time preview receipt to the durable TikTok draft
-- claim in one transaction. A provider request can start only after this RPC
-- returns the exact locked snapshot.
create or replace function public.claim_tiktok_publish_with_preview_service(
  p_owner uuid,p_draft_id uuid,p_receipt_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  d public.drafts%rowtype;
  claimed public.drafts%rowtype;
  a public.tiktok_draft_approvals%rowtype;
  l public.account_ledger%rowtype;
  c public.account_connections%rowtype;
  credential public.tiktok_credentials%rowtype;
  v_claim_id uuid:=p_draft_id;
  v_draft_hash text;
  v_generic_preview_hash text;
  v_tiktok_preview_hash text;
  v_required_scope text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
    then raise exception 'TikTok preview claims are service-only'; end if;

  -- Lock order is draft -> platform approval -> owner/account state -> receipt.
  select * into d from public.drafts
  where id=p_draft_id and owner=p_owner for update;
  if not found or lower(trim(coalesce(d.platform,'')))<>'tiktok'
    or d.account_id is null or d.persona_id is null
    or d.approval_state<>'approved'
    or coalesce(d.approved_content_hash,'')!~'^[0-9a-f]{64}$'
    or d.publish_state not in ('not_queued','queued','failed','blocked')
    or coalesce(d.provider_post_id,'')<>''
    or (d.publish_at is not null and d.publish_at>now()) then
    raise exception 'The exact approved TikTok draft is not claimable';
  end if;
  v_draft_hash:=public.agent_draft_hash(
    d.title,d.body,d.tags,d.media_url,d.content_kind,d.persona_id,
    d.account_id,d.platform,d.publish_at
  );
  if v_draft_hash is distinct from d.approved_content_hash then
    raise exception 'The TikTok draft changed after approval'; end if;

  select * into a from public.tiktok_draft_approvals
  where draft_id=d.id and owner=p_owner for update;
  if not found or a.ledger_id is distinct from d.account_id
    or a.approved_content_hash is distinct from d.approved_content_hash
    or a.approved_at>now() or a.preview_version<>'tiktok-platform-preview-v1'
    or a.publish_mode not in ('upload_inbox','direct_post')
    or a.approved_media_url is distinct from d.media_url
    or not public.tiktok_valid_approval_settings(a.publish_mode,a.approved_settings) then
    raise exception 'The exact TikTok platform approval is unavailable';
  end if;
  v_tiktok_preview_hash:=public.tiktok_preview_hash(
    a.approved_content_hash,a.preview_version,a.ledger_id,a.provider_open_id,
    a.publish_mode,a.approved_media_sha256,a.approved_media_mime,
    a.approved_media_bytes,a.approved_media_url,a.approved_settings
  );
  if a.preview_hash is distinct from v_tiktok_preview_hash then
    raise exception 'The TikTok approval failed integrity verification'; end if;

  if not exists(select 1 from public.agent_owner_settings settings
    where settings.owner=p_owner and not settings.automation_paused for share)
    then raise exception 'Owner automation is paused or unavailable'; end if;
  select * into l from public.account_ledger
  where id=d.account_id and owner=p_owner and provider='tiktok'
    and not coalesce(suspended,false) for share;
  if not found or (l.persona_id is distinct from d.persona_id and not exists(
    select 1 from public.account_persona_links link
    where link.owner=p_owner and link.ledger_id=l.id and link.persona_id=d.persona_id
  )) then raise exception 'The TikTok destination is no longer assigned to this persona'; end if;
  select * into c from public.account_connections
  where ledger_id=l.id and owner=p_owner and provider='tiktok' for share;
  v_required_scope:=case when a.publish_mode='direct_post' then 'video.publish' else 'video.upload' end;
  if not found or c.connection_state<>'connected'
    or c.verification_method<>'tiktok_oauth2_pkce'
    or c.provider_subject is distinct from a.provider_open_id
    or not ('user.info.basic'=any(coalesce(c.granted_scopes,array[]::text[])))
    or not ('user.info.profile'=any(coalesce(c.granted_scopes,array[]::text[])))
    or not (v_required_scope=any(coalesce(c.granted_scopes,array[]::text[]))) then
    raise exception 'The exact TikTok authorization is unavailable';
  end if;
  select * into credential from public.tiktok_credentials
  where ledger_id=l.id and owner=p_owner for share;
  if not found or credential.provider_open_id is distinct from a.provider_open_id then
    raise exception 'The exact TikTok credential is unavailable'; end if;

  v_generic_preview_hash:=public.agent_draft_preview_hash(
    d.approved_content_hash,d.approved_preview_version,d.approved_preview_target_id
  );
  if d.approved_preview_version<>'platform-preview-v1'
    or d.approved_preview_target_id is distinct from a.provider_open_id
    or d.approved_preview_target_id is distinct from public.agent_draft_expected_preview_target(
      p_owner,d.persona_id,d.account_id,d.platform
    )
    or d.approved_preview_hash is distinct from v_generic_preview_hash
    or d.approved_previewed_at is null or d.approved_previewed_at>now() then
    raise exception 'The exact TikTok destination preview changed';
  end if;

  perform public.consume_provider_action_preview_for_claim_service(
    p_owner,d.id,l.id,'tiktok','tiktok.'||a.publish_mode,p_receipt_id,
    a.provider_open_id,d.approved_content_hash,a.preview_hash,v_claim_id,'tiktok_publish'
  );
  update public.drafts set publish_state='publishing',publish_error='',updated_at=now()
  where id=d.id and owner=p_owner and approval_state='approved'
    and approved_content_hash=d.approved_content_hash
    and coalesce(provider_post_id,'')=''
    and publish_state in ('not_queued','queued','failed','blocked')
  returning * into claimed;
  if not found then raise exception 'The exact TikTok draft claim conflicted'; end if;
  return jsonb_build_object('claimId',v_claim_id,'draft',to_jsonb(claimed));
end; $$;

create or replace function public.invalidate_tiktok_draft_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.provider_post_id,'') = '' and (
    new.approval_state <> 'approved'
    or new.approved_content_hash = ''
    or new.approved_content_hash is distinct from old.approved_content_hash
    or new.account_id is distinct from old.account_id
    or new.persona_id is distinct from old.persona_id
    or new.platform is distinct from old.platform
    or new.media_url is distinct from old.media_url
    or new.publish_at is distinct from old.publish_at
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.tags is distinct from old.tags
    or new.content_kind is distinct from old.content_kind
  ) then
    delete from public.tiktok_draft_approvals where draft_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists invalidate_tiktok_draft_approval on public.drafts;
create trigger invalidate_tiktok_draft_approval
  after update of approval_state, approved_content_hash, account_id, persona_id,
    platform, media_url, publish_at, title, body, tags, content_kind
  on public.drafts for each row execute function public.invalidate_tiktok_draft_approval();

create or replace function public.guard_connected_tiktok_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' and (
    exists (select 1 from public.tiktok_credentials where ledger_id = old.id)
    or exists (
      select 1 from public.account_connections
      where ledger_id = old.id and owner = old.owner and provider = 'tiktok'
        and connection_state in ('connected','error')
    )
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect TikTok before deleting this account';
    end if;
    if new.provider is distinct from old.provider
      or lower(regexp_replace(trim(coalesce(new.username,'')), '^@+', ''))
        is distinct from lower(regexp_replace(trim(coalesce(old.username,'')), '^@+', '')) then
      raise exception 'Disconnect TikTok before changing its provider or username';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_connected_tiktok_ledger_change on public.account_ledger;
create trigger guard_connected_tiktok_ledger_change
  before delete or update of provider, username on public.account_ledger
  for each row execute function public.guard_connected_tiktok_ledger_change();

revoke all on function public.consume_tiktok_oauth_state(text,uuid,text)
  from public, anon, authenticated;
revoke all on function public.claim_tiktok_token_operation(uuid,uuid,uuid,text,integer)
  from public, anon, authenticated;
revoke all on function public.release_tiktok_token_operation(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.tiktok_store_token_bundle(
  uuid,uuid,text,text,text,text,text,text,text[],timestamptz,timestamptz
) from public, anon, authenticated;
revoke all on function public.tiktok_get_token_bundle(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.tiktok_delete_token_bundle(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.store_tiktok_draft_approval_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,text,jsonb
) from public, anon, authenticated;
revoke all on function public.claim_tiktok_publish_with_preview_service(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.tiktok_valid_approval_settings(text,jsonb)
  from public, anon, authenticated;
revoke all on function public.tiktok_preview_hash(
  text,text,uuid,text,text,text,text,bigint,text,jsonb
) from public, anon, authenticated;
revoke all on function public.delete_tiktok_vault_secret()
  from public, anon, authenticated;
revoke all on function public.invalidate_tiktok_draft_approval()
  from public, anon, authenticated;
revoke all on function public.guard_connected_tiktok_ledger_change()
  from public, anon, authenticated;

grant execute on function public.consume_tiktok_oauth_state(text,uuid,text)
  to service_role;
grant execute on function public.claim_tiktok_token_operation(uuid,uuid,uuid,text,integer)
  to service_role;
grant execute on function public.release_tiktok_token_operation(uuid,uuid,uuid)
  to service_role;
grant execute on function public.tiktok_store_token_bundle(
  uuid,uuid,text,text,text,text,text,text,text[],timestamptz,timestamptz
) to service_role;
grant execute on function public.tiktok_get_token_bundle(uuid,uuid)
  to service_role;
grant execute on function public.tiktok_delete_token_bundle(uuid,uuid)
  to service_role;
grant execute on function public.store_tiktok_draft_approval_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,text,jsonb
) to service_role;
grant execute on function public.claim_tiktok_publish_with_preview_service(uuid,uuid,uuid)
  to service_role;
grant execute on function public.tiktok_preview_hash(
  text,text,uuid,text,text,text,text,bigint,text,jsonb
) to service_role;

commit;
