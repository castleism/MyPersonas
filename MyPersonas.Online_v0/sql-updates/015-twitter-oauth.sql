-- X / Twitter OAuth 2.0 Authorization Code + PKCE.
--
-- OAuth state, PKCE verifiers, access tokens, and refresh tokens are
-- service-only. account_connections contains only non-secret, server-attested
-- identity and connection metadata. Posting remains disabled in the connector.

create extension if not exists supabase_vault with schema vault;

create table if not exists public.twitter_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create unique index if not exists twitter_oauth_transactions_owner_ledger_idx
  on public.twitter_oauth_transactions (owner, ledger_id);
create index if not exists twitter_oauth_transactions_expiry_idx
  on public.twitter_oauth_transactions (expires_at);

-- The token payload itself is stored as one encrypted JSON document in Vault.
-- These non-secret identity columns let the service verify that refreshed
-- credentials still belong to the same X account before replacing the secret.
create table if not exists public.twitter_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider_subject text not null default '',
  provider_username text not null default '',
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (provider_subject = '' or provider_subject ~ '^[0-9]{1,32}$'),
  check (
    provider_username = ''
    or provider_username ~ '^[A-Za-z0-9_]{1,15}$'
  )
);

create unique index if not exists twitter_credentials_provider_subject_idx
  on public.twitter_credentials (provider_subject)
  where provider_subject <> '';

-- Refresh tokens may rotate. Serialize every operation that can rotate, revoke,
-- or delete a token bundle so concurrent tabs/workers cannot overwrite a newer
-- refresh token with a stale one. Leases are bounded and safely reclaimable.
create table if not exists public.twitter_token_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null
    check (operation_kind in ('connect', 'refresh', 'disconnect', 'reset')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create index if not exists twitter_token_operation_leases_expiry_idx
  on public.twitter_token_operation_leases (expires_at);

alter table public.twitter_oauth_transactions enable row level security;
alter table public.twitter_credentials enable row level security;
alter table public.twitter_token_operation_leases enable row level security;

-- Deliberately no browser policies. Only service_role and SECURITY DEFINER
-- helpers can touch authorization transactions or encrypted credentials.
revoke all on public.twitter_oauth_transactions from anon, authenticated;
revoke all on public.twitter_credentials from anon, authenticated;
revoke all on public.twitter_token_operation_leases from anon, authenticated;
grant all on public.twitter_oauth_transactions to service_role;
grant all on public.twitter_credentials to service_role;
grant all on public.twitter_token_operation_leases to service_role;

comment on table public.twitter_oauth_transactions is
  'Service-only, single-use X OAuth state, same-browser nonce, and PKCE verifier records.';
comment on table public.twitter_credentials is
  'Service-only map from an X ledger entry to an encrypted Supabase Vault token bundle.';
comment on table public.twitter_token_operation_leases is
  'Service-only bounded leases that serialize X connect, refresh, disconnect, and reset operations per ledger.';

create or replace function public.consume_twitter_oauth_state(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(owner uuid, ledger_id uuid, code_verifier text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from public.twitter_oauth_transactions as tx
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.expires_at > now()
  returning tx.owner, tx.ledger_id, tx.code_verifier;
end;
$$;

create or replace function public.claim_twitter_token_operation(
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
declare
  v_claimed boolean := false;
begin
  if p_operation_kind not in ('connect', 'refresh', 'disconnect', 'reset') then
    raise exception 'Invalid X token operation';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 180 then
    raise exception 'X token-operation lease must be between 15 and 180 seconds';
  end if;
  if not exists (
    select 1
    from public.account_ledger
    where id = p_ledger_id
      and owner = p_owner
      and provider = 'twitter'
  ) then
    raise exception 'Owned X ledger entry not found';
  end if;

  insert into public.twitter_token_operation_leases as lease (
    ledger_id,
    owner,
    lease_id,
    operation_kind,
    expires_at,
    created_at
  ) values (
    p_ledger_id,
    p_owner,
    p_lease_id,
    p_operation_kind,
    now() + make_interval(secs => p_ttl_seconds),
    now()
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

create or replace function public.release_twitter_token_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.twitter_token_operation_leases
  where ledger_id = p_ledger_id
    and owner = p_owner
    and lease_id = p_lease_id;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

create or replace function public.twitter_store_token_bundle(
  p_ledger_id uuid,
  p_owner uuid,
  p_expected_ledger_username text,
  p_provider_subject text,
  p_provider_username text,
  p_access_token text,
  p_refresh_token text,
  p_token_type text,
  p_scope text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'twitter_oauth_' || p_ledger_id::text;
  v_provider text;
  v_ledger_username text;
  v_expected_username text :=
    lower(regexp_replace(trim(coalesce(p_expected_ledger_username, '')), '^@+', ''));
  v_provider_username text :=
    regexp_replace(trim(coalesce(p_provider_username, '')), '^@+', '');
  v_bundle text;
begin
  if trim(coalesce(p_access_token, '')) = ''
    or trim(coalesce(p_refresh_token, '')) = '' then
    raise exception 'X access and refresh tokens are required';
  end if;
  if char_length(p_access_token) > 16384
    or char_length(p_refresh_token) > 16384 then
    raise exception 'X token exceeds the storage limit';
  end if;
  if lower(trim(coalesce(p_token_type, ''))) <> 'bearer' then
    raise exception 'X token type must be bearer';
  end if;
  if char_length(coalesce(p_scope, '')) > 2048 then
    raise exception 'X scope exceeds the storage limit';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'X access-token expiry must be in the future';
  end if;
  if trim(coalesce(p_provider_subject, '')) <> ''
    and p_provider_subject !~ '^[0-9]{1,32}$' then
    raise exception 'Invalid X provider subject';
  end if;
  if v_provider_username <> ''
    and v_provider_username !~ '^[A-Za-z0-9_]{1,15}$' then
    raise exception 'Invalid X provider username';
  end if;
  if (trim(coalesce(p_provider_subject, '')) = '')
    is distinct from (v_provider_username = '') then
    raise exception 'X provider subject and username must be stored together';
  end if;

  select
    provider,
    lower(regexp_replace(trim(coalesce(username, '')), '^@+', ''))
    into v_provider, v_ledger_username
  from public.account_ledger
  where id = p_ledger_id and owner = p_owner
  for update;

  if not found
    or v_provider <> 'twitter'
    or v_ledger_username = ''
    or v_ledger_username <> v_expected_username then
    raise exception 'Owned X ledger entry changed during authorization';
  end if;

  v_bundle := jsonb_build_object(
    'access_token', p_access_token,
    'refresh_token', p_refresh_token,
    'token_type', 'bearer',
    'scope', trim(coalesce(p_scope, '')),
    'expires_at', p_expires_at,
    'stored_at', now()
  )::text;

  select vault_secret_id into v_secret_id
  from public.twitter_credentials
  where ledger_id = p_ledger_id and owner = p_owner
  for update;

  if v_secret_id is null then
    select id into v_secret_id
    from vault.secrets
    where name = v_secret_name;
  end if;

  if v_secret_id is null then
    select vault.create_secret(
      v_bundle,
      v_secret_name,
      'X OAuth token bundle for ledger ' || p_ledger_id::text
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id,
      v_bundle,
      v_secret_name,
      'X OAuth token bundle for ledger ' || p_ledger_id::text
    );
  end if;

  insert into public.twitter_credentials as credential (
    ledger_id,
    owner,
    provider_subject,
    provider_username,
    vault_secret_id,
    updated_at
  ) values (
    p_ledger_id,
    p_owner,
    trim(coalesce(p_provider_subject, '')),
    v_provider_username,
    v_secret_id,
    now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider_subject = excluded.provider_subject,
    provider_username = excluded.provider_username,
    vault_secret_id = excluded.vault_secret_id,
    updated_at = excluded.updated_at;

  return v_secret_id;
end;
$$;

create or replace function public.twitter_get_token_bundle(
  p_ledger_id uuid,
  p_owner uuid
)
returns table(
  provider_subject text,
  provider_username text,
  token_bundle jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    credential.provider_subject,
    credential.provider_username,
    secret.decrypted_secret::jsonb
  from public.twitter_credentials as credential
  join vault.decrypted_secrets as secret
    on secret.id = credential.vault_secret_id
  where credential.ledger_id = p_ledger_id
    and credential.owner = p_owner;
end;
$$;

create or replace function public.delete_twitter_vault_secret()
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

drop trigger if exists twitter_credentials_delete_vault_secret
  on public.twitter_credentials;
create trigger twitter_credentials_delete_vault_secret
  after delete on public.twitter_credentials
  for each row execute function public.delete_twitter_vault_secret();

-- A direct or stale browser write must not orphan a confirmed or ambiguous X
-- grant by deleting its ledger or changing the provider identity underneath it.
create or replace function public.guard_connected_twitter_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The service erasure path holds the same per-ledger disconnect lease while
  -- it revokes the provider grant, deletes the Vault bundle, and deletes the
  -- ledger row. Once the credential is gone, allow only that exact
  -- service_role operation to finish before the lease is released.
  if tg_op = 'DELETE'
    and auth.role() = 'service_role'
    and not exists (
      select 1
      from public.twitter_credentials
      where ledger_id = old.id
    )
    and exists (
      select 1
      from public.twitter_token_operation_leases
      where ledger_id = old.id
        and owner = old.owner
        and operation_kind = 'disconnect'
        and expires_at > now()
    ) then
    return old;
  end if;

  if exists (
    select 1
    from public.twitter_credentials
    where ledger_id = old.id
  ) or exists (
    select 1
    from public.account_connections
    where ledger_id = old.id
      and owner = old.owner
      and provider = 'twitter'
      and connection_state in ('connected', 'error')
  ) or exists (
    select 1
    from public.twitter_token_operation_leases
    where ledger_id = old.id and expires_at > now()
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect X before deleting this account';
    end if;
    if new.provider is distinct from old.provider
      or lower(regexp_replace(trim(coalesce(new.username, '')), '^@+', ''))
        is distinct from
        lower(regexp_replace(trim(coalesce(old.username, '')), '^@+', '')) then
      raise exception 'Disconnect X before changing its provider or username';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_connected_twitter_ledger_change
  on public.account_ledger;
create trigger guard_connected_twitter_ledger_change
  before delete or update of provider, username on public.account_ledger
  for each row execute function public.guard_connected_twitter_ledger_change();

create or replace function public.twitter_delete_token_bundle(
  p_ledger_id uuid,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.twitter_credentials
  where ledger_id = p_ledger_id and owner = p_owner;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

revoke all on function public.consume_twitter_oauth_state(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_twitter_token_operation(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
revoke all on function public.release_twitter_token_operation(
  uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.twitter_store_token_bundle(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.twitter_get_token_bundle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.twitter_delete_token_bundle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.delete_twitter_vault_secret()
  from public, anon, authenticated;
revoke all on function public.guard_connected_twitter_ledger_change()
  from public, anon, authenticated;

grant execute on function public.consume_twitter_oauth_state(text, uuid, text)
  to service_role;
grant execute on function public.claim_twitter_token_operation(
  uuid, uuid, uuid, text, integer
) to service_role;
grant execute on function public.release_twitter_token_operation(
  uuid, uuid, uuid
) to service_role;
grant execute on function public.twitter_store_token_bundle(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) to service_role;
grant execute on function public.twitter_get_token_bundle(uuid, uuid)
  to service_role;
grant execute on function public.twitter_delete_token_bundle(uuid, uuid)
  to service_role;

comment on function public.consume_twitter_oauth_state(text, uuid, text) is
  'Service-only atomic consume for X OAuth state bound to its owner and initiating browser tab.';
comment on function public.claim_twitter_token_operation(
  uuid, uuid, uuid, text, integer
) is
  'Service-only atomic claim of a bounded per-ledger X token-operation lease.';
comment on function public.release_twitter_token_operation(
  uuid, uuid, uuid
) is
  'Service-only release of an X token-operation lease by its unguessable lease id.';
comment on function public.twitter_store_token_bundle(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) is
  'Service-only storage of an X OAuth access/refresh token bundle in encrypted Supabase Vault.';
comment on function public.twitter_get_token_bundle(uuid, uuid) is
  'Service-only retrieval of an X OAuth token bundle from Supabase Vault.';
comment on function public.twitter_delete_token_bundle(uuid, uuid) is
  'Service-only deletion of an X OAuth token bundle and its Vault secret.';
