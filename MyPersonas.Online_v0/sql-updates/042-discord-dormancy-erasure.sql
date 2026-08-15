-- 042-discord-dormancy-erasure.sql
-- Keep the Discord connector fail-closed while its safety rebuild is dormant,
-- and give account erasure an owner-scoped, service-only Vault cleanup path.
--
-- This migration intentionally does not delete pre-existing orphan secrets:
-- once the matching account_ledger row is gone, the ledger-derived Vault name
-- no longer proves an owner. Inventory and review those rows with
-- DISCORD-DORMANCY-ERASURE.md instead of performing a prefix-wide deletion.

begin;

-- Migration 019 allowed signed-in owners to create or replace webhook bearer
-- secrets. No API role may do that while the connector is dormant. The
-- authenticated clear RPC remains available so an owner can still remove an
-- existing secret.
revoke all on function public.discord_set_webhook(uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.discord_set_webhook(uuid, text) is
  'DORMANT: no API role may create or replace Discord webhook secrets. Re-enable only through a reviewed forward migration after the connector safety rebuild.';

-- Delete only webhook secrets whose ledger rows still prove both the owner and
-- Discord provider. The routine never reads or returns a Vault secret value.
create or replace function public.discord_erase_webhooks_for_owner_service(
  p_owner uuid
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_remaining integer := 0;
begin
  if p_owner is null then
    raise exception 'Owner is required';
  end if;

  delete from vault.secrets as secret
  where exists (
    select 1
    from public.account_ledger as ledger
    where ledger.owner = p_owner
      and ledger.provider = 'discord'
      and secret.name = 'discord_webhook_' || ledger.id::text
  );
  get diagnostics v_deleted = row_count;

  select count(*)::integer
  into v_remaining
  from vault.secrets as secret
  where exists (
    select 1
    from public.account_ledger as ledger
    where ledger.owner = p_owner
      and ledger.provider = 'discord'
      and secret.name = 'discord_webhook_' || ledger.id::text
  );

  if v_remaining <> 0 then
    raise exception 'Discord webhook erasure could not be verified';
  end if;

  -- If a later erasure phase fails, do not leave the surviving local row
  -- claiming that a now-erased webhook is connected.
  update public.account_connections as connection
  set connection_state = 'disconnected',
      granted_scopes = '{}',
      error_code = '',
      updated_at = now()
  where connection.owner = p_owner
    and connection.provider = 'discord'
    and exists (
      select 1
      from public.account_ledger as ledger
      where ledger.id = connection.ledger_id
        and ledger.owner = p_owner
        and ledger.provider = 'discord'
    );

  return v_deleted;
end;
$$;

revoke all on function public.discord_erase_webhooks_for_owner_service(uuid)
  from public, anon, authenticated;
grant execute on function public.discord_erase_webhooks_for_owner_service(uuid)
  to service_role;

comment on function public.discord_erase_webhooks_for_owner_service(uuid) is
  'Service-role-only: deletes and verifies absence of Discord webhook Vault rows derived from the supplied owner''s current Discord ledger records; returns only the deleted row count.';

commit;
