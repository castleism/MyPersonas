-- 021-reddit-oauth.sql
-- Reddit OAuth (identity + submit) for Reddit ledger records.
-- Tokens live only in Supabase Vault through service-role-only RPCs; the
-- browser never sees a token, and the GET callback completes the exchange
-- server-side so the authorization code never returns to a page.

-- Single-use hashed OAuth state records (service-role only; no client access).
create table if not exists public.reddit_oauth_states (
  state_hash text primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);
alter table public.reddit_oauth_states enable row level security;
revoke all on public.reddit_oauth_states from anon, authenticated;
comment on table public.reddit_oauth_states is
  'Single-use hashed Reddit OAuth states; service-role only.';

-- Store tokens after a verified exchange (service role only).
create or replace function public.reddit_store_tokens_service(
  p_ledger_id uuid,
  p_owner uuid,
  p_username text,
  p_access_token text,
  p_refresh_token text,
  p_scopes text[],
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where name in ('reddit_access_'||p_ledger_id,'reddit_refresh_'||p_ledger_id);
  perform vault.create_secret(p_access_token, 'reddit_access_'||p_ledger_id,
    'Reddit access token for account_ledger '||p_ledger_id);
  perform vault.create_secret(p_refresh_token, 'reddit_refresh_'||p_ledger_id,
    'Reddit refresh token for account_ledger '||p_ledger_id);
  insert into public.account_connections as ac (
    ledger_id, owner, provider, provider_subject, granted_scopes,
    connection_state, verification_method, connected_at, last_checked_at,
    expires_at, error_code, updated_at
  ) values (
    p_ledger_id, p_owner, 'reddit', coalesce(p_username,''), coalesce(p_scopes,'{}'),
    'connected', 'reddit_oauth', now(), now(), p_expires_at, '', now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner, provider = excluded.provider,
    provider_subject = excluded.provider_subject,
    granted_scopes = excluded.granted_scopes,
    connection_state = 'connected', verification_method = excluded.verification_method,
    connected_at = excluded.connected_at, last_checked_at = excluded.last_checked_at,
    expires_at = excluded.expires_at, error_code = '', updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.reddit_store_tokens_service(uuid,uuid,text,text,text,text[],timestamptz) from public, anon, authenticated;
grant execute on function public.reddit_store_tokens_service(uuid,uuid,text,text,text,text[],timestamptz) to service_role;

-- Read tokens (service role only).
create or replace function public.reddit_get_tokens_service(p_ledger_id uuid)
returns table(access_token text, refresh_token text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select
    (select decrypted_secret from vault.decrypted_secrets where name = 'reddit_access_'||p_ledger_id),
    (select decrypted_secret from vault.decrypted_secrets where name = 'reddit_refresh_'||p_ledger_id);
end;
$$;
revoke all on function public.reddit_get_tokens_service(uuid) from public, anon, authenticated;
grant execute on function public.reddit_get_tokens_service(uuid) to service_role;

-- Rotate the short-lived access token after a refresh (service role only).
create or replace function public.reddit_update_access_token_service(
  p_ledger_id uuid, p_access_token text, p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where name = 'reddit_access_'||p_ledger_id;
  perform vault.create_secret(p_access_token, 'reddit_access_'||p_ledger_id,
    'Reddit access token for account_ledger '||p_ledger_id);
  update public.account_connections set
    expires_at = p_expires_at, last_checked_at = now(), updated_at = now()
  where ledger_id = p_ledger_id;
end;
$$;
revoke all on function public.reddit_update_access_token_service(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.reddit_update_access_token_service(uuid,text,timestamptz) to service_role;

-- Clear tokens and mark disconnected (service role only).
create or replace function public.reddit_clear_tokens_service(p_ledger_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where name in ('reddit_access_'||p_ledger_id,'reddit_refresh_'||p_ledger_id);
  update public.account_connections set
    connection_state = 'disconnected', granted_scopes = '{}',
    error_code = '', updated_at = now()
  where ledger_id = p_ledger_id;
end;
$$;
revoke all on function public.reddit_clear_tokens_service(uuid) from public, anon, authenticated;
grant execute on function public.reddit_clear_tokens_service(uuid) to service_role;
