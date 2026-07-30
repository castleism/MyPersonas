-- 019-discord-webhook.sql
-- Official Discord channel-webhook posting for Discord ledger records.
--
-- A channel webhook is Discord's sanctioned way to post into a channel the
-- owner controls. This route never automates a user account, never sees a
-- Discord password, and cannot read messages. The webhook URL is a bearer
-- secret: the browser submits it exactly once through the RPC below, it is
-- stored only in Supabase Vault, and no owner-facing path ever returns it.

-- Store or replace the webhook for an owned Discord ledger record.
create or replace function public.discord_set_webhook(
  p_ledger_id uuid,
  p_webhook_url text
) returns public.account_connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ledger public.account_ledger%rowtype;
  v_url text := trim(coalesce(p_webhook_url, ''));
  v_secret_name text;
  v_connection public.account_connections%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  select * into v_ledger
    from public.account_ledger
    where id = p_ledger_id and owner = v_uid and provider = 'discord';
  if not found then
    raise exception 'Owned Discord ledger record not found';
  end if;
  if v_url !~ '^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]{10,25}/[A-Za-z0-9_.-]{30,255}$' then
    raise exception 'That does not look like a Discord channel webhook URL. Copy it from Server Settings → Integrations → Webhooks.';
  end if;

  v_secret_name := 'discord_webhook_' || v_ledger.id;
  delete from vault.secrets where name = v_secret_name;
  perform vault.create_secret(
    v_url, v_secret_name,
    'Discord channel webhook for account_ledger ' || v_ledger.id
  );

  insert into public.account_connections as ac (
    ledger_id, owner, provider, granted_scopes, connection_state,
    verification_method, connected_at, last_checked_at, error_code, updated_at
  ) values (
    v_ledger.id, v_uid, 'discord', array['webhook.incoming.post'], 'connected',
    'discord_webhook', now(), now(), '', now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider = excluded.provider,
    granted_scopes = excluded.granted_scopes,
    connection_state = 'connected',
    verification_method = excluded.verification_method,
    connected_at = excluded.connected_at,
    last_checked_at = excluded.last_checked_at,
    error_code = '',
    updated_at = excluded.updated_at
  returning * into v_connection;
  return v_connection;
end;
$$;

revoke all on function public.discord_set_webhook(uuid, text) from public, anon, authenticated;
grant execute on function public.discord_set_webhook(uuid, text) to authenticated;
comment on function public.discord_set_webhook(uuid, text) is
  'Stores an owner-submitted Discord channel webhook in Vault and marks the connection connected; the URL is never returned to any browser.';

-- Remove the webhook and mark the connection disconnected.
create or replace function public.discord_clear_webhook(p_ledger_id uuid)
returns public.account_connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_connection public.account_connections%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  if not exists (
    select 1 from public.account_ledger
    where id = p_ledger_id and owner = v_uid and provider = 'discord'
  ) then
    raise exception 'Owned Discord ledger record not found';
  end if;
  delete from vault.secrets where name = 'discord_webhook_' || p_ledger_id;
  update public.account_connections set
    connection_state = 'disconnected',
    granted_scopes = '{}',
    error_code = '',
    updated_at = now()
  where ledger_id = p_ledger_id and owner = v_uid
  returning * into v_connection;
  return v_connection;
end;
$$;

revoke all on function public.discord_clear_webhook(uuid) from public, anon, authenticated;
grant execute on function public.discord_clear_webhook(uuid) to authenticated;
comment on function public.discord_clear_webhook(uuid) is
  'Deletes the Vault-stored Discord webhook and marks the connection disconnected.';

-- Service-only webhook read for the discord-post Edge Function.
create or replace function public.discord_get_webhook_service(p_ledger_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets
    where name = 'discord_webhook_' || p_ledger_id;
  return v_secret;
end;
$$;

revoke all on function public.discord_get_webhook_service(uuid) from public, anon, authenticated;
grant execute on function public.discord_get_webhook_service(uuid) to service_role;
comment on function public.discord_get_webhook_service(uuid) is
  'Service-role-only: returns the decrypted Discord webhook for the posting Edge Function.';
