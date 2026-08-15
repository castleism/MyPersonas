# Discord dormancy and Vault erasure

Status: **local implementation only; migration 042 is not applied, the updated erasure
functions are not deployed, and no live Vault row was inspected or changed** (2026-08-14).

`discord-post` remains release-disabled before authentication, database access, or a
provider request. This package does not reconnect it and does not grant a write path.

## Local contract

Migration `sql-updates/042-discord-dormancy-erasure.sql`:

1. revokes `discord_set_webhook(uuid,text)` from `public`, `anon`, `authenticated`, and
   `service_role`, preventing API clients from creating or replacing webhook secrets;
2. leaves the authenticated `discord_clear_webhook(uuid)` removal path intact;
3. adds `discord_erase_webhooks_for_owner_service(uuid)` for `service_role` only;
4. derives every deletion target from a current `account_ledger` row with the exact owner
   and `provider='discord'` instead of accepting a Vault ID or free-form secret name;
5. deletes from `vault.secrets` without reading or returning a decrypted value, verifies
   that no matching row remains, marks surviving connection rows disconnected, and returns
   only a row count.

Both `delete-account` and `erase-content` use the shared erasure handler. That handler now
requires the service cleanup RPC to return a valid non-negative integer before owned
storage or generic `account_ledger` deletion begins. A missing migration, RPC error, or
invalid result therefore fails closed while the ledger rows still preserve the exact owner
mapping needed for a safe retry.

Deleting a local bearer secret prevents MyPersonas from using the webhook. It does not
delete the webhook object in Discord. An owner who also wants the Discord-side webhook
removed must delete it in Discord Server Settings → Integrations → Webhooks; MyPersonas
must not claim that provider-side deletion was performed by this migration.

## Pre-apply metadata inventory

Run this only in the privileged SQL editor. It selects IDs, names, timestamps, ledger IDs,
owners, and providers; it never selects a secret value or `vault.decrypted_secrets`.

```sql
select
  secret.id as vault_secret_id,
  secret.name,
  secret.created_at,
  secret.updated_at,
  ledger.id as ledger_id,
  ledger.owner,
  ledger.provider,
  case
    when ledger.id is null then 'orphan_no_matching_ledger'
    when ledger.provider <> 'discord' then 'orphan_wrong_provider'
    else 'owned_discord_ledger'
  end as inventory_state
from vault.secrets as secret
left join public.account_ledger as ledger
  on secret.name = 'discord_webhook_' || ledger.id::text
where left(secret.name, char_length('discord_webhook_')) = 'discord_webhook_'
order by secret.created_at, secret.id;
```

Record counts by `inventory_state` in the private deployment evidence. Do not paste the
output into issues, chat, screenshots, or public logs. A name without a current matching
ledger no longer proves an owner, so migration 042 deliberately does not delete existing
orphans automatically.

## Gated apply order

1. Keep `discord-post` disabled and open a maintenance window for account/content erasure
   and Discord connection management. Confirm no migration numbered 042 or later has been
   applied under a different contract.
2. Run the metadata-only inventory above and retain only its private counts/evidence.
3. Make the complete local suite and Edge type checks green. Review the exact commit; do not
   use the current deploy-all workflow for this isolated release.
4. Apply migration 042 as its included transaction. Do not apply migration 036 as part of
   this work.
5. Deploy the matching `delete-account` and `erase-content` sources under a production
   approval gate. Keep the maintenance window in place until both versions are proven.
6. Run the privilege checks and disposable-owner test below. Close the maintenance window
   only after every expected result is verified.

The maintenance window is required because applying only one side creates a temporary
contract gap: the old erasure function does not call the cleanup RPC, while the new erasure
function intentionally fails if migration 042 is absent.

## Privilege verification

Expected results are `false, false, false, false, true, true` in that order.

```sql
select
  has_function_privilege('anon',
    'public.discord_set_webhook(uuid,text)', 'execute') as anon_can_set,
  has_function_privilege('authenticated',
    'public.discord_set_webhook(uuid,text)', 'execute') as authenticated_can_set,
  has_function_privilege('service_role',
    'public.discord_set_webhook(uuid,text)', 'execute') as service_can_set,
  has_function_privilege('authenticated',
    'public.discord_erase_webhooks_for_owner_service(uuid)', 'execute')
      as authenticated_can_erase_owner,
  has_function_privilege('authenticated',
    'public.discord_clear_webhook(uuid)', 'execute') as authenticated_can_clear,
  has_function_privilege('service_role',
    'public.discord_erase_webhooks_for_owner_service(uuid)', 'execute')
      as service_can_erase_owner;
```

Also call the dormant `discord-post` endpoint with a disposable signed-in session and verify
the response is still `status:"disabled"` before any connection, draft, or provider work.

## Disposable-owner erasure verification

Use three disposable owners and record their Discord ledger UUIDs before the test. Owners
A and C must each have an existing pre-migration webhook secret; owner B is the untouched
sentinel.

1. Run content erasure for owner A through the signed-in product flow.
2. Confirm owner A's exact metadata row is absent and owner B's remains present:

   ```sql
   select id, name, created_at, updated_at
   from vault.secrets
   where name in (
     'discord_webhook_<OWNER_A_LEDGER_UUID>',
     'discord_webhook_<OWNER_B_LEDGER_UUID>',
     'discord_webhook_<OWNER_C_LEDGER_UUID>'
   )
   order by name;
   ```

3. Confirm owner A has no remaining Discord ledger or connected-state row, owners B and C
   are unchanged, and no Vault values appeared in logs.
4. Run full account deletion for owner C. Verify that auth account is removed only after
   owner C's exact secret absence is proven and owner B remains unchanged.
5. Force an RPC failure in a non-production test project and verify the handler reports that
   Discord erasure could not be verified while leaving the owner's ledger rows intact.

## Existing-orphan review and exact cleanup

Orphans need a separate, owner-approved cleanup decision because their original owner
mapping is already gone. Never use a prefix-wide delete. After reviewing the inventory,
place only the exact approved Vault metadata IDs into a temporary table and re-check each
candidate immediately before deletion:

```sql
begin;

create temporary table reviewed_discord_orphans (
  secret_id uuid primary key
) on commit drop;

-- Add only metadata IDs that were explicitly reviewed and approved.
insert into reviewed_discord_orphans (secret_id) values
  ('<REVIEWED_VAULT_SECRET_UUID>');

select secret.id, secret.name, secret.created_at, secret.updated_at
from vault.secrets as secret
join reviewed_discord_orphans as reviewed on reviewed.secret_id = secret.id
where left(secret.name, char_length('discord_webhook_')) = 'discord_webhook_'
  and not exists (
    select 1
    from public.account_ledger as ledger
    where ledger.provider = 'discord'
      and secret.name = 'discord_webhook_' || ledger.id::text
  )
order by secret.id;

delete from vault.secrets as secret
using reviewed_discord_orphans as reviewed
where secret.id = reviewed.secret_id
  and left(secret.name, char_length('discord_webhook_')) = 'discord_webhook_'
  and not exists (
    select 1
    from public.account_ledger as ledger
    where ledger.provider = 'discord'
      and secret.name = 'discord_webhook_' || ledger.id::text
  )
returning secret.id, secret.name;

select count(*) as reviewed_rows_still_present
from vault.secrets as secret
join reviewed_discord_orphans as reviewed on reviewed.secret_id = secret.id;

-- Commit only if the reviewed deletion set and zero-row verification are exact.
commit;
```

Use `rollback;` instead of `commit;` on any mismatch. Webhook values must never be selected,
copied, logged, or used as verification evidence.

## Re-enablement rule

Do not roll migration 042 back by re-granting the old setter. A future Discord rebuild needs
a new forward migration, explicit owner reconnection, least-privilege provider design,
provider-side deletion behavior, AAL2 enforcement for secret changes, rate limits, audit
events, idempotency, and end-to-end tests before any set/read/post permission is restored.
