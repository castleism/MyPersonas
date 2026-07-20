-- Gmail OAuth: single-use authorization transactions plus Vault-backed refresh tokens.
-- The browser can never read these tables or token RPCs. account_connections keeps
-- only non-secret, server-attested connection metadata.

create extension if not exists supabase_vault with schema vault;

create table if not exists public.gmail_oauth_transactions (
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

-- Safe upgrade for projects that briefly installed an earlier draft of this
-- migration before same-browser completion was added. No live connector could
-- have used those rows because the Edge Function had not yet been deployed.
alter table public.gmail_oauth_transactions
  add column if not exists browser_nonce_hash text;
alter table public.gmail_oauth_transactions
  add column if not exists return_origin text;
delete from public.gmail_oauth_transactions where browser_nonce_hash is null;
delete from public.gmail_oauth_transactions where return_origin is null;
alter table public.gmail_oauth_transactions
  alter column browser_nonce_hash set not null;
alter table public.gmail_oauth_transactions
  alter column return_origin set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.gmail_oauth_transactions'::regclass
      and conname = 'gmail_oauth_transactions_browser_nonce_hash_check'
  ) then
    alter table public.gmail_oauth_transactions
      add constraint gmail_oauth_transactions_browser_nonce_hash_check
      check (browser_nonce_hash ~ '^[0-9a-f]{64}$');
  end if;
end;
$$;

drop index if exists public.gmail_oauth_transactions_owner_ledger_idx;
create unique index gmail_oauth_transactions_owner_ledger_idx
  on public.gmail_oauth_transactions (owner, ledger_id);
create index if not exists gmail_oauth_transactions_expiry_idx
  on public.gmail_oauth_transactions (expires_at);

create table if not exists public.gmail_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

alter table public.gmail_oauth_transactions enable row level security;
alter table public.gmail_credentials enable row level security;

-- No browser policies exist. Only service_role and SECURITY DEFINER helpers may
-- touch OAuth transactions or refresh credentials.
revoke all on public.gmail_oauth_transactions from anon, authenticated;
revoke all on public.gmail_credentials from anon, authenticated;
grant all on public.gmail_oauth_transactions to service_role;
grant all on public.gmail_credentials to service_role;

comment on table public.gmail_oauth_transactions is
  'Service-only, single-use Gmail OAuth state and PKCE verifier records.';
comment on table public.gmail_credentials is
  'Service-only map from a Gmail ledger entry to an encrypted Supabase Vault secret.';

drop function if exists public.consume_gmail_oauth_state(text);

create or replace function public.consume_gmail_oauth_state(
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
  delete from public.gmail_oauth_transactions as tx
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.expires_at > now()
  returning tx.owner, tx.ledger_id, tx.code_verifier;
end;
$$;

drop function if exists public.gmail_store_refresh_token(uuid, uuid, text);

create or replace function public.gmail_store_refresh_token(
  p_ledger_id uuid,
  p_owner uuid,
  p_provider_email text,
  p_refresh_token text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'gmail_refresh_' || p_ledger_id::text;
  v_provider text;
  v_login_email text;
begin
  if trim(coalesce(p_refresh_token, '')) = '' then
    raise exception 'Refresh token is required';
  end if;
  select provider, lower(trim(coalesce(login_email, '')))
    into v_provider, v_login_email
  from public.account_ledger
  where id = p_ledger_id and owner = p_owner
  for update;
  if not found or v_provider <> 'gmail'
    or v_login_email <> lower(trim(coalesce(p_provider_email, ''))) then
    raise exception 'Owned Gmail ledger entry changed during authorization';
  end if;

  select vault_secret_id into v_secret_id
  from public.gmail_credentials
  where ledger_id = p_ledger_id and owner = p_owner
  for update;

  if v_secret_id is null then
    select id into v_secret_id from vault.secrets where name = v_secret_name;
  end if;

  if v_secret_id is null then
    select vault.create_secret(
      p_refresh_token,
      v_secret_name,
      'Gmail OAuth refresh token for ledger ' || p_ledger_id::text
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id,
      p_refresh_token,
      v_secret_name,
      'Gmail OAuth refresh token for ledger ' || p_ledger_id::text
    );
  end if;

  insert into public.gmail_credentials (ledger_id, owner, vault_secret_id, updated_at)
  values (p_ledger_id, p_owner, v_secret_id, now())
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    vault_secret_id = excluded.vault_secret_id,
    updated_at = excluded.updated_at;

  return v_secret_id;
end;
$$;

create or replace function public.gmail_get_refresh_token(p_ledger_id uuid, p_owner uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refresh_token text;
begin
  select secret.decrypted_secret into v_refresh_token
  from public.gmail_credentials as credential
  join vault.decrypted_secrets as secret on secret.id = credential.vault_secret_id
  where credential.ledger_id = p_ledger_id and credential.owner = p_owner;
  return v_refresh_token;
end;
$$;

create or replace function public.delete_gmail_vault_secret()
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

drop trigger if exists gmail_credentials_delete_vault_secret on public.gmail_credentials;
create trigger gmail_credentials_delete_vault_secret
  after delete on public.gmail_credentials
  for each row execute function public.delete_gmail_vault_secret();

-- Never let a direct/stale browser delete destroy the only revocation token.
-- The connector must revoke Google access and remove the Vault credential first.
drop function if exists public.guard_connected_gmail_ledger_delete() cascade;

create or replace function public.guard_connected_gmail_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.gmail_credentials where ledger_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect Gmail before deleting this account';
    end if;
    if new.provider is distinct from old.provider
      or lower(trim(coalesce(new.login_email, ''))) is distinct from lower(trim(coalesce(old.login_email, ''))) then
      raise exception 'Disconnect Gmail before changing its provider or login email';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_connected_gmail_ledger_change on public.account_ledger;
create trigger guard_connected_gmail_ledger_change
  before delete or update of provider, login_email on public.account_ledger
  for each row execute function public.guard_connected_gmail_ledger_change();

create or replace function public.gmail_delete_refresh_token(p_ledger_id uuid, p_owner uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.gmail_credentials
  where ledger_id = p_ledger_id and owner = p_owner;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

revoke all on function public.consume_gmail_oauth_state(text, uuid, text) from public, anon, authenticated;
revoke all on function public.gmail_store_refresh_token(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.gmail_get_refresh_token(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gmail_delete_refresh_token(uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_gmail_vault_secret() from public, anon, authenticated;
revoke all on function public.guard_connected_gmail_ledger_change() from public, anon, authenticated;

grant execute on function public.consume_gmail_oauth_state(text, uuid, text) to service_role;
grant execute on function public.gmail_store_refresh_token(uuid, uuid, text, text) to service_role;
grant execute on function public.gmail_get_refresh_token(uuid, uuid) to service_role;
grant execute on function public.gmail_delete_refresh_token(uuid, uuid) to service_role;

comment on function public.consume_gmail_oauth_state(text, uuid, text) is
  'Service-only atomic consume for Gmail OAuth state bound to its owner and initiating browser tab.';
comment on function public.gmail_store_refresh_token(uuid, uuid, text, text) is
  'Service-only storage of a Gmail refresh token in encrypted Supabase Vault.';
comment on function public.gmail_get_refresh_token(uuid, uuid) is
  'Service-only retrieval of a Gmail refresh token from Supabase Vault.';
comment on function public.gmail_delete_refresh_token(uuid, uuid) is
  'Service-only deletion of a Gmail refresh token and Vault secret.';
