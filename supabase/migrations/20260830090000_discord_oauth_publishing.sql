-- 066-discord-oauth-publishing.sql
-- Production-safe, owner-pressed Discord channel publishing.
--
-- This forward migration replaces pasted webhook URLs with Discord's official
-- OAuth2 webhook.incoming authorization-code flow. Sensitive webhook and OAuth
-- values remain only in Supabase Vault; browser-readable rows contain only the
-- exact non-secret guild/channel/webhook binding selected by the owner.
-- Scheduled/background Discord publication remains disabled.

begin;

create extension if not exists supabase_vault with schema vault;

-- Retire the legacy browser RPCs. Existing legacy webhook values remain
-- readable only through the service-only compatibility path so Disconnect and
-- account erasure can delete the provider webhook before local erasure.
revoke all on function public.discord_set_webhook(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.discord_clear_webhook(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.discord_get_webhook_service(uuid)
  from public, anon, authenticated, service_role;

comment on function public.discord_set_webhook(uuid, text) is
  'RETIRED: Discord connections now use the official webhook.incoming OAuth2 flow.';
comment on function public.discord_clear_webhook(uuid) is
  'RETIRED: provider deletion and OAuth revocation must complete before local cleanup.';
comment on function public.discord_get_webhook_service(uuid) is
  'RETIRED: use the service-only OAuth bundle accessor from migration 066.';

create table if not exists public.discord_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  browser_nonce_hash text not null
    check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null check (char_length(return_origin) between 8 and 255),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create unique index if not exists discord_oauth_transactions_owner_ledger_idx
  on public.discord_oauth_transactions(owner, ledger_id);
create index if not exists discord_oauth_transactions_expiry_idx
  on public.discord_oauth_transactions(expires_at);

-- Non-secret destination identity selected in Discord's consent screen.
create table if not exists public.discord_channel_bindings (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  guild_id text not null check (guild_id ~ '^[0-9]{10,25}$'),
  channel_id text not null check (channel_id ~ '^[0-9]{10,25}$'),
  webhook_id text not null unique check (webhook_id ~ '^[0-9]{10,25}$'),
  application_id text not null check (application_id ~ '^[0-9]{10,25}$'),
  webhook_name text not null default '' check (char_length(webhook_name) <= 80),
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create unique index if not exists discord_channel_bindings_owner_channel_idx
  on public.discord_channel_bindings(owner, channel_id);

-- The only mapping to the encrypted Vault bundle. No browser policy exists.
create table if not exists public.discord_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

-- Serialize connect/disconnect/publish so a provider write cannot race with
-- credential replacement or deletion. Leases are short and reclaimable.
create table if not exists public.discord_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null
    check (operation_kind in ('connect','disconnect','publish')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create index if not exists discord_operation_leases_expiry_idx
  on public.discord_operation_leases(expires_at);

-- Durable, owner-readable (but service-written) provider outcome ledger.
create table if not exists public.discord_publish_attempts (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid not null references public.drafts(id) on delete cascade,
  ledger_id uuid not null,
  approval_hash text not null check (approval_hash ~ '^[0-9a-f]{64}$'),
  webhook_id text not null check (webhook_id ~ '^[0-9]{10,25}$'),
  channel_id text not null check (channel_id ~ '^[0-9]{10,25}$'),
  message_id text not null default ''
    check (message_id = '' or message_id ~ '^[0-9]{10,25}$'),
  status text not null default 'claimed' check (status in (
    'claimed','provider_accepted','completed','definitive_failure',
    'outcome_unknown','provider_deleted'
  )),
  provider_http_status integer
    check (provider_http_status is null or provider_http_status between 100 and 599),
  error_code text not null default '' check (char_length(error_code) <= 120),
  error_message text not null default '' check (char_length(error_message) <= 1000),
  claimed_at timestamptz not null default now(),
  provider_accepted_at timestamptz,
  completed_at timestamptz,
  last_verified_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create unique index if not exists discord_publish_attempts_active_draft_idx
  on public.discord_publish_attempts(draft_id)
  where status in ('claimed','provider_accepted','completed','outcome_unknown');
create index if not exists discord_publish_attempts_owner_created_idx
  on public.discord_publish_attempts(owner, claimed_at desc);

alter table public.discord_oauth_transactions enable row level security;
alter table public.discord_channel_bindings enable row level security;
alter table public.discord_credentials enable row level security;
alter table public.discord_operation_leases enable row level security;
alter table public.discord_publish_attempts enable row level security;

drop policy if exists "discord channel bindings owner read"
  on public.discord_channel_bindings;
create policy "discord channel bindings owner read"
  on public.discord_channel_bindings for select to authenticated
  using ((select auth.uid()) = owner);

drop policy if exists "discord publish attempts owner read"
  on public.discord_publish_attempts;
create policy "discord publish attempts owner read"
  on public.discord_publish_attempts for select to authenticated
  using ((select auth.uid()) = owner);

revoke all on public.discord_oauth_transactions from anon, authenticated;
revoke all on public.discord_channel_bindings from anon, authenticated;
revoke all on public.discord_credentials from anon, authenticated;
revoke all on public.discord_operation_leases from anon, authenticated;
revoke all on public.discord_publish_attempts from anon, authenticated;
grant all on public.discord_oauth_transactions to service_role;
grant all on public.discord_channel_bindings to service_role;
grant all on public.discord_credentials to service_role;
grant all on public.discord_operation_leases to service_role;
grant all on public.discord_publish_attempts to service_role;
grant select (
  ledger_id, owner, guild_id, channel_id, webhook_id, application_id,
  webhook_name, connected_at, last_verified_at, updated_at
) on public.discord_channel_bindings to authenticated;
grant select (
  id, owner, draft_id, ledger_id, approval_hash, webhook_id, channel_id,
  message_id, status, provider_http_status, error_code, error_message,
  claimed_at, provider_accepted_at, completed_at, last_verified_at,
  deleted_at, updated_at
) on public.discord_publish_attempts to authenticated;

comment on table public.discord_oauth_transactions is
  'Service-only, single-use Discord OAuth state bound to owner, ledger, expiry, and initiating browser nonce.';
comment on table public.discord_channel_bindings is
  'Non-secret exact Discord server/channel/webhook identity selected through webhook.incoming consent.';
comment on table public.discord_credentials is
  'Service-only map to a Vault JSON bundle containing Discord webhook and OAuth bearer secrets.';
comment on table public.discord_publish_attempts is
  'Durable Discord provider outcome, message checkpoint, verification, and deletion history. No scheduled worker consumes this table.';

create or replace function public.consume_discord_oauth_state(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(owner uuid, ledger_id uuid, return_origin text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from public.discord_oauth_transactions as tx
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.expires_at > now()
  returning tx.owner, tx.ledger_id, tx.return_origin;
end;
$$;

create or replace function public.claim_discord_operation_service(
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
  if p_operation_kind not in ('connect','disconnect','publish') then
    raise exception 'Invalid Discord operation';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 180 then
    raise exception 'Discord operation lease must be between 15 and 180 seconds';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'discord'
  ) then
    raise exception 'Owned Discord ledger entry not found';
  end if;
  if p_operation_kind = 'disconnect' and exists (
    select 1 from public.discord_publish_attempts
    where ledger_id = p_ledger_id and owner = p_owner
      and status in ('claimed','provider_accepted','outcome_unknown')
  ) then
    raise exception 'Reconcile the unfinished Discord publish attempt before disconnecting';
  end if;

  insert into public.discord_operation_leases as lease (
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

create or replace function public.release_discord_operation_service(
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
  v_deleted integer := 0;
begin
  delete from public.discord_operation_leases
  where ledger_id = p_ledger_id and owner = p_owner and lease_id = p_lease_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

create or replace function public.delete_discord_vault_secret()
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

drop trigger if exists discord_credentials_delete_vault_secret
  on public.discord_credentials;
create trigger discord_credentials_delete_vault_secret
  after delete on public.discord_credentials
  for each row execute function public.delete_discord_vault_secret();

create or replace function public.discord_store_oauth_connection_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_webhook_id text,
  p_application_id text,
  p_webhook_name text,
  p_webhook_url text,
  p_webhook_token text,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz,
  p_scopes text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'discord_oauth_' || p_ledger_id::text;
  v_bundle text;
begin
  if not exists (
    select 1 from public.discord_operation_leases
    where ledger_id = p_ledger_id and owner = p_owner
      and lease_id = p_lease_id and operation_kind = 'connect'
      and expires_at > now()
  ) then
    raise exception 'The Discord connect lease is not active';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'discord'
      and not coalesce(suspended, false)
  ) then
    raise exception 'Owned active Discord ledger entry changed during authorization';
  end if;
  if p_guild_id !~ '^[0-9]{10,25}$'
    or p_channel_id !~ '^[0-9]{10,25}$'
    or p_webhook_id !~ '^[0-9]{10,25}$'
    or p_application_id !~ '^[0-9]{10,25}$' then
    raise exception 'Discord returned invalid destination identifiers';
  end if;
  if char_length(coalesce(p_webhook_name,'')) > 80 then
    raise exception 'Discord webhook name exceeds the storage limit';
  end if;
  if p_webhook_token !~ '^[A-Za-z0-9_.-]{30,255}$' then
    raise exception 'Discord returned an invalid webhook token';
  end if;
  if p_webhook_url <> ('https://discord.com/api/webhooks/' || p_webhook_id || '/' || p_webhook_token) then
    raise exception 'Discord returned an unexpected webhook URL';
  end if;
  if trim(coalesce(p_access_token,'')) = ''
    or trim(coalesce(p_refresh_token,'')) = ''
    or char_length(p_access_token) > 16384
    or char_length(p_refresh_token) > 16384 then
    raise exception 'Discord returned an invalid OAuth token bundle';
  end if;
  if p_token_expires_at is null or p_token_expires_at <= now() then
    raise exception 'Discord OAuth token expiry must be in the future';
  end if;
  if not ('webhook.incoming' = any(coalesce(p_scopes, array[]::text[]))) then
    raise exception 'Discord did not grant webhook.incoming';
  end if;
  if exists (
    select 1 from public.discord_channel_bindings
    where owner = p_owner and channel_id = p_channel_id
      and ledger_id <> p_ledger_id
  ) then
    raise exception 'That Discord channel is already bound to another account record';
  end if;

  v_bundle := jsonb_build_object(
    'webhook_url', p_webhook_url,
    'webhook_token', p_webhook_token,
    'access_token', p_access_token,
    'refresh_token', p_refresh_token,
    'token_type', 'bearer',
    'expires_at', p_token_expires_at,
    'scopes', p_scopes,
    'stored_at', now()
  )::text;

  select vault_secret_id into v_secret_id
  from public.discord_credentials
  where ledger_id = p_ledger_id and owner = p_owner
  for update;
  if v_secret_id is null then
    select id into v_secret_id from vault.secrets where name = v_secret_name;
  end if;
  if v_secret_id is null then
    select vault.create_secret(
      v_bundle, v_secret_name,
      'Discord OAuth webhook bundle for ledger ' || p_ledger_id::text
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id, v_bundle, v_secret_name,
      'Discord OAuth webhook bundle for ledger ' || p_ledger_id::text
    );
  end if;

  insert into public.discord_credentials as credential (
    ledger_id, owner, vault_secret_id, updated_at
  ) values (p_ledger_id, p_owner, v_secret_id, now())
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    vault_secret_id = excluded.vault_secret_id,
    updated_at = excluded.updated_at;

  insert into public.discord_channel_bindings as binding (
    ledger_id, owner, guild_id, channel_id, webhook_id, application_id,
    webhook_name, connected_at, last_verified_at, updated_at
  ) values (
    p_ledger_id, p_owner, p_guild_id, p_channel_id, p_webhook_id,
    p_application_id, left(coalesce(p_webhook_name,''),80), now(), now(), now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    guild_id = excluded.guild_id,
    channel_id = excluded.channel_id,
    webhook_id = excluded.webhook_id,
    application_id = excluded.application_id,
    webhook_name = excluded.webhook_name,
    connected_at = excluded.connected_at,
    last_verified_at = excluded.last_verified_at,
    updated_at = excluded.updated_at;

  insert into public.account_connections as connection (
    ledger_id, owner, provider, provider_subject, granted_scopes,
    connection_state, verification_method, verified_at, connected_at,
    last_checked_at, expires_at, error_code, updated_at
  ) values (
    p_ledger_id, p_owner, 'discord', p_channel_id,
    array['webhook.incoming'], 'connected', 'discord_oauth_webhook',
    now(), now(), now(), p_token_expires_at, '', now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider = excluded.provider,
    provider_subject = excluded.provider_subject,
    granted_scopes = excluded.granted_scopes,
    connection_state = excluded.connection_state,
    verification_method = excluded.verification_method,
    verified_at = excluded.verified_at,
    connected_at = excluded.connected_at,
    last_checked_at = excluded.last_checked_at,
    expires_at = excluded.expires_at,
    error_code = '',
    updated_at = excluded.updated_at;

  -- Remove a dormant pasted-URL secret only after the official connection has
  -- been durably stored. It points to the same ledger but is never reused.
  delete from vault.secrets where name = 'discord_webhook_' || p_ledger_id::text;
  return v_secret_id;
end;
$$;

create or replace function public.discord_get_connection_secret_service(
  p_ledger_id uuid,
  p_owner uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bundle jsonb;
  v_binding public.discord_channel_bindings%rowtype;
  v_legacy text;
  v_match text[];
begin
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'discord'
  ) then
    raise exception 'Owned Discord ledger entry not found';
  end if;

  select binding.* into v_binding
  from public.discord_channel_bindings as binding
  where binding.ledger_id = p_ledger_id and binding.owner = p_owner;

  select secret.decrypted_secret::jsonb into v_bundle
  from public.discord_credentials as credential
  join vault.decrypted_secrets as secret
    on secret.id = credential.vault_secret_id
  where credential.ledger_id = p_ledger_id and credential.owner = p_owner;

  if v_bundle is not null and v_binding.ledger_id is not null then
    return v_bundle || jsonb_build_object(
      'legacy', false,
      'guild_id', v_binding.guild_id,
      'channel_id', v_binding.channel_id,
      'webhook_id', v_binding.webhook_id,
      'application_id', v_binding.application_id,
      'webhook_name', v_binding.webhook_name
    );
  end if;

  -- Migration-019 compatibility: enough information to delete the old remote
  -- webhook, but never enough to publish through the retired path.
  select secret.decrypted_secret into v_legacy
  from vault.decrypted_secrets as secret
  where secret.name = 'discord_webhook_' || p_ledger_id::text;
  v_match := regexp_match(
    coalesce(v_legacy,''),
    '^https://(?:discord\\.com|discordapp\\.com)/api(?:/v[0-9]+)?/webhooks/([0-9]{10,25})/([A-Za-z0-9_.-]{30,255})$'
  );
  if v_match is not null and array_length(v_match,1) = 2 then
    return jsonb_build_object(
      'legacy', true,
      'webhook_url', v_legacy,
      'webhook_id', v_match[1],
      'webhook_token', v_match[2],
      'guild_id', '', 'channel_id', '', 'application_id', '',
      'access_token', '', 'refresh_token', ''
    );
  end if;
  return null;
exception when invalid_text_representation then
  raise exception 'Stored Discord credential bundle is invalid';
end;
$$;

-- Preserve an exact provider-revocation handle when Discord issued a valid
-- webhook/token bundle but verification or immediate cleanup had an ambiguous
-- outcome. This calls the normal Vault writer and marks the connection as a
-- non-publishable cleanup hold in the same database transaction.
create or replace function public.discord_store_oauth_cleanup_hold_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_webhook_id text,
  p_application_id text,
  p_webhook_name text,
  p_webhook_url text,
  p_webhook_token text,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz,
  p_error_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_secret_id uuid;
begin
  if trim(coalesce(p_error_code,'')) = '' then
    raise exception 'Discord cleanup hold error code is required';
  end if;
  v_secret_id := public.discord_store_oauth_connection_service(
    p_ledger_id, p_owner, p_lease_id, p_guild_id, p_channel_id,
    p_webhook_id, p_application_id, p_webhook_name, p_webhook_url,
    p_webhook_token, p_access_token, p_refresh_token, p_token_expires_at,
    array['webhook.incoming']
  );
  update public.discord_channel_bindings set
    last_verified_at = null, updated_at = now()
  where ledger_id = p_ledger_id and owner = p_owner;
  update public.account_connections set
    connection_state = 'error', verification_method = 'discord_oauth_cleanup_hold',
    verified_at = null, error_code = left(p_error_code,120),
    last_checked_at = now(), updated_at = now()
  where ledger_id = p_ledger_id and owner = p_owner and provider = 'discord';
  return v_secret_id;
end;
$$;

create or replace function public.discord_clear_connection_service(
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
  v_remaining integer := 0;
begin
  if not exists (
    select 1 from public.discord_operation_leases
    where ledger_id = p_ledger_id and owner = p_owner
      and lease_id = p_lease_id and operation_kind = 'disconnect'
      and expires_at > now()
  ) then
    raise exception 'The Discord disconnect lease is not active';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = p_owner and provider = 'discord'
  ) then
    raise exception 'Owned Discord ledger entry not found';
  end if;

  delete from public.discord_credentials
  where ledger_id = p_ledger_id and owner = p_owner;
  delete from vault.secrets
  where name = 'discord_webhook_' || p_ledger_id::text;
  delete from public.discord_channel_bindings
  where ledger_id = p_ledger_id and owner = p_owner;
  update public.account_connections set
    provider_subject = '', granted_scopes = '{}',
    connection_state = 'disconnected', verification_method = '',
    verified_at = null, connected_at = null, expires_at = null,
    error_code = '', updated_at = now()
  where ledger_id = p_ledger_id and owner = p_owner and provider = 'discord';

  select count(*)::integer into v_remaining
  from vault.secrets
  where name in (
    'discord_oauth_' || p_ledger_id::text,
    'discord_webhook_' || p_ledger_id::text
  );
  if v_remaining <> 0
    or exists (select 1 from public.discord_credentials where ledger_id = p_ledger_id)
    or exists (select 1 from public.discord_channel_bindings where ledger_id = p_ledger_id) then
    raise exception 'Discord local credential erasure could not be verified';
  end if;
  return true;
end;
$$;

create or replace function public.guard_connected_discord_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user = 'service_role'
    and not exists (
      select 1 from public.discord_credentials where ledger_id = old.id
    )
    and not exists (
      select 1 from public.discord_channel_bindings where ledger_id = old.id
    )
    and not exists (
      select 1 from public.account_connections
      where ledger_id = old.id and owner = old.owner and provider = 'discord'
        and connection_state in ('connected','error')
    )
    and exists (
      select 1 from public.discord_operation_leases
      where ledger_id = old.id and owner = old.owner
        and operation_kind = 'disconnect' and expires_at > now()
    ) then
    return old;
  end if;

  if exists (
    select 1 from public.discord_credentials where ledger_id = old.id
  ) or exists (
    select 1 from public.discord_channel_bindings where ledger_id = old.id
  ) or exists (
    select 1 from public.account_connections
    where ledger_id = old.id and owner = old.owner and provider = 'discord'
      and connection_state in ('connected','error')
  ) or exists (
    select 1 from public.discord_operation_leases
    where ledger_id = old.id and expires_at > now()
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect Discord before deleting this account';
    end if;
    if new.provider is distinct from old.provider then
      raise exception 'Disconnect Discord before changing its provider';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_connected_discord_ledger_change
  on public.account_ledger;
create trigger guard_connected_discord_ledger_change
  before delete or update of provider on public.account_ledger
  for each row execute function public.guard_connected_discord_ledger_change();

create or replace function public.claim_discord_draft_publish_service(
  p_draft_id uuid,
  p_owner uuid,
  p_attempt_id uuid,
  p_lease_id uuid
)
returns table(
  attempt_id uuid,
  draft_id uuid,
  ledger_id uuid,
  persona_id uuid,
  title text,
  body text,
  tags text,
  media_url text,
  content_kind text,
  approval_hash text,
  webhook_id text,
  channel_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.drafts%rowtype;
  v_ledger public.account_ledger%rowtype;
  v_binding public.discord_channel_bindings%rowtype;
  v_hash text;
  v_preview jsonb;
  v_expected_preview_hash text;
begin
  select * into v_draft from public.drafts
  where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Owned draft not found'; end if;
  if v_draft.platform <> 'discord' or v_draft.account_id is null then
    raise exception 'Draft is not assigned to Discord';
  end if;
  if v_draft.persona_id is null then raise exception 'Draft persona is required'; end if;
  if v_draft.approval_state <> 'approved'
    or coalesce(v_draft.approved_content_hash,'') !~ '^[0-9a-f]{64}$' then
    raise exception 'Exact owner approval is required';
  end if;
  v_hash := public.agent_draft_hash(
    v_draft.title, v_draft.body, v_draft.tags, v_draft.media_url,
    v_draft.content_kind, v_draft.persona_id, v_draft.account_id,
    v_draft.platform, v_draft.publish_at
  );
  if v_hash is distinct from v_draft.approved_content_hash then
    raise exception 'Approval no longer matches this exact draft';
  end if;
  if v_draft.publish_state in ('publishing','published','blocked')
    or coalesce(v_draft.provider_post_id,'') <> '' then
    raise exception 'This draft is already publishing, published, or needs reconciliation';
  end if;
  if not exists (
    select 1 from public.agent_owner_settings
    where owner = p_owner and not automation_paused
  ) then
    raise exception 'Owner automation is paused or unavailable';
  end if;

  select * into v_ledger from public.account_ledger
  where id = v_draft.account_id and owner = p_owner and provider = 'discord'
    and not coalesce(suspended,false)
  for share;
  if not found then raise exception 'Discord destination is unavailable'; end if;
  if v_ledger.persona_id is distinct from v_draft.persona_id and not exists (
    select 1 from public.account_persona_links
    where ledger_id = v_ledger.id and owner = p_owner
      and persona_id = v_draft.persona_id
  ) then
    raise exception 'Discord destination is no longer assigned to this persona';
  end if;
  select * into v_binding from public.discord_channel_bindings
  where ledger_id = v_ledger.id and owner = p_owner for share;
  if not found or not exists (
    select 1 from public.discord_credentials
    where ledger_id = v_ledger.id and owner = p_owner
  ) then
    raise exception 'Discord credential binding is unavailable';
  end if;
  -- Migration 069 follows 066 in the same release. JSON extraction plus a
  -- dynamic hash call keeps this forward migration installable before those
  -- columns/function exist, while every runtime claim fails closed until 069
  -- is present.
  v_preview := to_jsonb(v_draft);
  begin
    execute 'select public.agent_draft_preview_hash($1,$2,$3)'
      into v_expected_preview_hash
      using v_draft.approved_content_hash,
        v_preview ->> 'approved_preview_version',
        v_preview ->> 'approved_preview_target_id';
  exception when undefined_function then
    raise exception 'Migration 069 platform-preview gate is required';
  end;
  if (v_preview ->> 'approved_preview_version') is distinct from 'platform-preview-v1'
    or nullif(v_preview ->> 'approved_previewed_at','')::timestamptz is null
    or nullif(v_preview ->> 'approved_previewed_at','')::timestamptz > now()
    or (v_preview ->> 'approved_preview_target_id') is distinct from v_binding.channel_id
    or coalesce(v_preview ->> 'approved_preview_hash','') !~ '^[0-9a-f]{64}$'
    or (v_preview ->> 'approved_preview_hash') is distinct from
      v_expected_preview_hash then
    raise exception 'Review and approve the current exact Discord channel preview';
  end if;
  if not exists (
    select 1 from public.discord_operation_leases
    where ledger_id = v_ledger.id and owner = p_owner
      and lease_id = p_lease_id and operation_kind = 'publish'
      and expires_at > now()
  ) then
    raise exception 'The Discord publish lease is not active';
  end if;
  if not exists (
    select 1 from public.account_connections
    where ledger_id = v_ledger.id and owner = p_owner and provider = 'discord'
      and connection_state = 'connected'
      and verification_method = 'discord_oauth_webhook'
      and provider_subject = v_binding.channel_id
      and 'webhook.incoming' = any(granted_scopes)
  ) then
    raise exception 'Discord write authorization is not connected';
  end if;
  if exists (
    select 1 from public.discord_publish_attempts
    where draft_id = v_draft.id
      and status in ('claimed','provider_accepted','completed','outcome_unknown')
  ) then
    raise exception 'This Discord draft already has an active or durable provider outcome';
  end if;

  insert into public.discord_publish_attempts (
    id, owner, draft_id, ledger_id, approval_hash,
    webhook_id, channel_id, status
  ) values (
    p_attempt_id, p_owner, v_draft.id, v_ledger.id,
    v_draft.approved_content_hash, v_binding.webhook_id,
    v_binding.channel_id, 'claimed'
  );
  update public.drafts set
    publish_state = 'publishing',
    publish_error = 'Discord publish claimed; awaiting a durable provider response.',
    updated_at = now()
  where id = v_draft.id and owner = p_owner;

  return query select
    p_attempt_id, v_draft.id, v_ledger.id, v_draft.persona_id,
    v_draft.title, v_draft.body, v_draft.tags, v_draft.media_url,
    v_draft.content_kind, v_draft.approved_content_hash,
    v_binding.webhook_id, v_binding.channel_id;
end;
$$;

create or replace function public.discord_mark_publish_failed_service(
  p_attempt_id uuid,
  p_owner uuid,
  p_http_status integer,
  p_error_code text,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_draft_id uuid;
begin
  update public.discord_publish_attempts set
    status = 'definitive_failure',
    provider_http_status = p_http_status,
    error_code = left(coalesce(p_error_code,''),120),
    error_message = left(coalesce(p_error_message,''),1000),
    updated_at = now()
  where id = p_attempt_id and owner = p_owner and status = 'claimed'
  returning draft_id into v_draft_id;
  if v_draft_id is null then return false; end if;
  update public.drafts set
    publish_state = 'failed',
    publish_error = left(coalesce(p_error_message,'Discord rejected the post.'),1000),
    updated_at = now()
  where id = v_draft_id and owner = p_owner and publish_state = 'publishing'
    and coalesce(provider_post_id,'') = '';
  return true;
end;
$$;

create or replace function public.discord_mark_publish_uncertain_service(
  p_attempt_id uuid,
  p_owner uuid,
  p_http_status integer,
  p_error_code text,
  p_error_message text,
  p_message_id text default '',
  p_channel_id text default ''
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_draft_id uuid;
begin
  if coalesce(p_message_id,'') <> '' and p_message_id !~ '^[0-9]{10,25}$' then
    raise exception 'Invalid Discord message id';
  end if;
  if coalesce(p_channel_id,'') <> '' and not exists (
    select 1 from public.discord_publish_attempts
    where id = p_attempt_id and owner = p_owner and channel_id = p_channel_id
  ) then
    raise exception 'Discord returned a different channel than the approved destination';
  end if;
  update public.discord_publish_attempts set
    status = 'outcome_unknown',
    provider_http_status = p_http_status,
    error_code = left(coalesce(p_error_code,'provider_outcome_unknown'),120),
    error_message = left(coalesce(p_error_message,''),1000),
    message_id = case when coalesce(p_message_id,'') = '' then message_id else p_message_id end,
    updated_at = now()
  where id = p_attempt_id and owner = p_owner
    and status in ('claimed','provider_accepted')
  returning draft_id into v_draft_id;
  if v_draft_id is null then return false; end if;
  update public.drafts set
    publish_state = 'blocked',
    publish_error = left(coalesce(p_error_message,
      'Discord did not return a durable outcome. Reconcile before retrying.'),1000),
    updated_at = now()
  where id = v_draft_id and owner = p_owner
    and publish_state = 'publishing';
  return true;
end;
$$;

create or replace function public.discord_checkpoint_publish_service(
  p_attempt_id uuid,
  p_owner uuid,
  p_message_id text,
  p_channel_id text,
  p_http_status integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_draft_id uuid;
begin
  if p_message_id !~ '^[0-9]{10,25}$'
    or p_channel_id !~ '^[0-9]{10,25}$' then
    raise exception 'Invalid Discord provider checkpoint';
  end if;
  update public.discord_publish_attempts set
    status = 'provider_accepted', message_id = p_message_id,
    provider_http_status = p_http_status, provider_accepted_at = now(),
    error_code = '', error_message = '', updated_at = now()
  where id = p_attempt_id and owner = p_owner
    and status in ('claimed','outcome_unknown')
    and channel_id = p_channel_id
  returning draft_id into v_draft_id;
  if v_draft_id is null then return false; end if;
  update public.drafts set
    publish_state = 'publishing',
    provider_post_id = p_message_id,
    publish_error = 'Discord accepted the message; local finalization is in progress.',
    updated_at = now()
  where id = v_draft_id and owner = p_owner
    and publish_state in ('publishing','blocked')
    and coalesce(provider_post_id,'') in ('',p_message_id);
  return found;
end;
$$;

create or replace function public.discord_finalize_publish_service(
  p_attempt_id uuid,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft_id uuid;
  v_message_id text;
begin
  select draft_id, message_id into v_draft_id, v_message_id
  from public.discord_publish_attempts
  where id = p_attempt_id and owner = p_owner
    and status = 'provider_accepted'
  for update;
  if not found then return false; end if;
  update public.drafts set
    status = 'posted', publish_state = 'published', posted_at = now(),
    publish_error = '', updated_at = now()
  where id = v_draft_id and owner = p_owner and publish_state = 'publishing'
    and provider_post_id = v_message_id;
  if not found then return false; end if;
  update public.discord_publish_attempts set
    status = 'completed', completed_at = now(), updated_at = now()
  where id = p_attempt_id and owner = p_owner
    and status = 'provider_accepted';
  return found;
end;
$$;

create or replace function public.discord_get_message_reference_service(
  p_draft_id uuid,
  p_owner uuid
)
returns table(
  attempt_id uuid,
  ledger_id uuid,
  webhook_id text,
  channel_id text,
  message_id text,
  attempt_status text
)
language sql
security definer
set search_path = ''
as $$
  select attempt.id, attempt.ledger_id, attempt.webhook_id,
    attempt.channel_id, attempt.message_id, attempt.status
  from public.discord_publish_attempts as attempt
  join public.drafts as draft on draft.id = attempt.draft_id
  where attempt.draft_id = p_draft_id and attempt.owner = p_owner
    and draft.owner = p_owner and attempt.message_id <> ''
    and attempt.status in (
      'provider_accepted','completed','outcome_unknown','provider_deleted'
    )
  order by attempt.claimed_at desc
  limit 1;
$$;

create or replace function public.discord_record_message_verified_service(
  p_attempt_id uuid,
  p_owner uuid,
  p_message_id text,
  p_channel_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft_id uuid;
begin
  select draft_id into v_draft_id
  from public.discord_publish_attempts
  where id = p_attempt_id and owner = p_owner
    and message_id = p_message_id and channel_id = p_channel_id
    and status in ('provider_accepted','completed','outcome_unknown','provider_deleted')
  for update;
  if not found then return false; end if;
  update public.discord_publish_attempts set
    last_verified_at = now(), updated_at = now()
  where id = p_attempt_id and owner = p_owner
    and message_id = p_message_id and channel_id = p_channel_id
    and status in ('provider_accepted','completed','outcome_unknown');
  return found;
end;
$$;

create or replace function public.discord_record_message_deleted_service(
  p_attempt_id uuid,
  p_owner uuid,
  p_message_id text,
  p_channel_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft_id uuid;
  v_previous_status text;
begin
  select draft_id,status into v_draft_id,v_previous_status
  from public.discord_publish_attempts
  where id = p_attempt_id and owner = p_owner
    and message_id = p_message_id and channel_id = p_channel_id
    and status in ('provider_accepted','completed','outcome_unknown','provider_deleted')
  for update;
  if not found then return false; end if;
  update public.discord_publish_attempts set
    status = 'provider_deleted', deleted_at = coalesce(deleted_at,now()),
    last_verified_at = now(), error_code = '', error_message = '',
    updated_at = now()
  where id = p_attempt_id and owner = p_owner;
  if v_previous_status = 'outcome_unknown' then
    update public.drafts set
      publish_state = 'failed', provider_post_id = '',
      publish_error = 'Discord verified that the uncertain message is absent. The exact draft may be reviewed and published again.',
      updated_at = now()
    where id = v_draft_id and owner = p_owner
      and publish_state = 'blocked'
      and coalesce(provider_post_id,'') in ('',p_message_id);
  end if;
  return true;
end;
$$;

-- Account erasure is a verification/cleanup tail, never a provider-revocation
-- substitute. delete-account must first delete each exact remote webhook,
-- revoke its OAuth grant, and clear that ledger under a disconnect lease.
create or replace function public.discord_erase_webhooks_for_owner_service(
  p_owner uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_remaining integer := 0;
begin
  if p_owner is null then raise exception 'Owner is required'; end if;

  select count(*)::integer into v_remaining
  from public.discord_credentials where owner = p_owner;
  if v_remaining <> 0
    or exists (
      select 1 from public.discord_channel_bindings where owner = p_owner
    )
    or exists (
      select 1 from vault.secrets as secret
      where exists (
        select 1 from public.account_ledger as ledger
        where ledger.owner = p_owner and ledger.provider = 'discord'
          and secret.name in (
            'discord_oauth_' || ledger.id::text,
            'discord_webhook_' || ledger.id::text
          )
      )
    )
    or exists (
      select 1 from public.account_connections
      where owner = p_owner and provider = 'discord'
        and connection_state in ('connected','error')
    ) then
    raise exception 'Discord provider revocation must be confirmed before local erasure';
  end if;

  if exists (
    select 1 from public.discord_operation_leases
    where owner = p_owner and expires_at > now()
  ) then
    raise exception 'An active Discord operation still blocks account erasure';
  end if;
  delete from public.discord_operation_leases
  where owner = p_owner and expires_at <= now();
  delete from public.discord_oauth_transactions where owner = p_owner;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Explicitly remove any stale background queue state. Owner-pressed
-- discord-post is the only writer enabled by this migration.
update public.drafts set
  publish_state = 'not_queued', publish_next_attempt_at = null,
  publish_error = case
    when approval_state = 'approved'
      then 'Discord scheduling is off. Review the platform preview and press Publish now.'
    else publish_error
  end,
  updated_at = now()
where platform = 'discord' and publish_state = 'queued';

revoke all on function public.consume_discord_oauth_state(text,uuid,text)
  from public, anon, authenticated;
revoke all on function public.claim_discord_operation_service(uuid,uuid,uuid,text,integer)
  from public, anon, authenticated;
revoke all on function public.release_discord_operation_service(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.delete_discord_vault_secret()
  from public, anon, authenticated;
revoke all on function public.discord_store_oauth_connection_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text[]
) from public, anon, authenticated;
revoke all on function public.discord_get_connection_secret_service(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.discord_store_oauth_cleanup_hold_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text
) from public, anon, authenticated;
revoke all on function public.discord_clear_connection_service(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.guard_connected_discord_ledger_change()
  from public, anon, authenticated;
revoke all on function public.claim_discord_draft_publish_service(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.discord_mark_publish_failed_service(uuid,uuid,integer,text,text)
  from public, anon, authenticated;
revoke all on function public.discord_mark_publish_uncertain_service(uuid,uuid,integer,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.discord_checkpoint_publish_service(uuid,uuid,text,text,integer)
  from public, anon, authenticated;
revoke all on function public.discord_finalize_publish_service(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.discord_get_message_reference_service(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.discord_record_message_verified_service(uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.discord_record_message_deleted_service(uuid,uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.discord_erase_webhooks_for_owner_service(uuid)
  from public, anon, authenticated;

grant execute on function public.consume_discord_oauth_state(text,uuid,text)
  to service_role;
grant execute on function public.claim_discord_operation_service(uuid,uuid,uuid,text,integer)
  to service_role;
grant execute on function public.release_discord_operation_service(uuid,uuid,uuid)
  to service_role;
grant execute on function public.discord_store_oauth_connection_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text[]
) to service_role;
grant execute on function public.discord_get_connection_secret_service(uuid,uuid)
  to service_role;
grant execute on function public.discord_store_oauth_cleanup_hold_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text
) to service_role;
grant execute on function public.discord_clear_connection_service(uuid,uuid,uuid)
  to service_role;
grant execute on function public.claim_discord_draft_publish_service(uuid,uuid,uuid,uuid)
  to service_role;
grant execute on function public.discord_mark_publish_failed_service(uuid,uuid,integer,text,text)
  to service_role;
grant execute on function public.discord_mark_publish_uncertain_service(uuid,uuid,integer,text,text,text,text)
  to service_role;
grant execute on function public.discord_checkpoint_publish_service(uuid,uuid,text,text,integer)
  to service_role;
grant execute on function public.discord_finalize_publish_service(uuid,uuid)
  to service_role;
grant execute on function public.discord_get_message_reference_service(uuid,uuid)
  to service_role;
grant execute on function public.discord_record_message_verified_service(uuid,uuid,text,text)
  to service_role;
grant execute on function public.discord_record_message_deleted_service(uuid,uuid,text,text)
  to service_role;
grant execute on function public.discord_erase_webhooks_for_owner_service(uuid)
  to service_role;

comment on function public.discord_get_connection_secret_service(uuid,uuid) is
  'Service-only exact Discord binding plus decrypted Vault bundle; never callable from a browser.';
comment on function public.discord_store_oauth_cleanup_hold_service(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz,text
) is 'Service-only atomic Vault retention of an exact Discord grant that still requires provider cleanup; never publishable.';
comment on function public.claim_discord_draft_publish_service(uuid,uuid,uuid,uuid) is
  'Service-only atomic owner/global-pause/assignment/approval-hash/destination claim for owner-pressed Discord publishing.';
comment on function public.discord_mark_publish_uncertain_service(uuid,uuid,integer,text,text,text,text) is
  'Service-only fail-closed provider-outcome lock; no automatic retry is allowed.';
comment on function public.discord_erase_webhooks_for_owner_service(uuid) is
  'Service-only verified local erasure after the Edge Function has deleted/revoked every exact Discord provider grant.';

commit;
