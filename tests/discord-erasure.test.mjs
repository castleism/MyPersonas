import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [migration019, migration042, migration066, erasure, runbook] =
  await Promise.all([
    readFile(
      path.join(root, "MyPersonas.Online_v0/sql-updates/019-discord-webhook.sql"),
      "utf8",
    ),
    readFile(
      path.join(root, "MyPersonas.Online_v0/sql-updates/042-discord-dormancy-erasure.sql"),
      "utf8",
    ),
    readFile(
      path.join(root, "MyPersonas.Online_v0/sql-updates/066-discord-oauth-publishing.sql"),
      "utf8",
    ),
    readFile(path.join(root, "supabase/functions/delete-account/index.ts"), "utf8"),
    readFile(path.join(root, "MyPersonas.Online_v0/DISCORD-OAUTH-PUBLISHING.md"), "utf8"),
  ]);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index++) {
    if (source[index] === "(") parameterDepth++;
    if (source[index] === ")" && --parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} has unterminated parameters`);
  const bodyStart = source.indexOf("{", parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has an unterminated body`);
}

function sqlFunctionBlock(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} was not found`);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, `${signature} has an unterminated SQL body`);
  return source.slice(start, end + 4);
}

function assertOrdered(haystack, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${needle}`);
    assert.ok(next > cursor, `${needle} appeared out of order`);
    cursor = next;
  }
}

test("legacy pasted-webhook mutation remains retired", () => {
  assert.match(migration042, /revoke all on function public\.discord_set_webhook/);
  assert.match(
    migration019,
    /grant execute on function public\.discord_clear_webhook\(uuid\) to authenticated/,
  );
  assert.match(
    migration066,
    /revoke all on function public\.discord_clear_webhook\(uuid\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration066,
    /revoke all on function public\.discord_get_webhook_service\(uuid\)[\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration066,
    /grant execute on function public\.discord_(?:set|clear|get)_webhook/i,
  );
});

test("account erasure inventories only owner Discord ledgers", () => {
  const inventory = functionBlock(erasure, "listDiscordLedgers");
  assert.match(inventory, /from\("account_ledger"\)\.select\("id"\)/);
  assert.match(inventory, /\.eq\("owner", uid\)\.eq\("provider", "discord"\)/);
  assert.match(inventory, /\.range\(from, from \+ 499\)/);
});

test("even service-role ledger deletion stays blocked by unresolved Discord state", () => {
  const guard = sqlFunctionBlock(
    migration066,
    "create or replace function public.guard_connected_discord_ledger_change()",
  );
  assert.match(guard, /current_user = 'service_role'/);
  assert.match(guard, /connection_state in \('connected','error'\)/);
  assert.match(guard, /Disconnect Discord before deleting this account/);
});

test("account erasure deletes the exact provider webhook and revokes OAuth before local Vault cleanup", () => {
  const cleanup = functionBlock(erasure, "eraseDiscordWebhooks");
  assert.match(cleanup, /claim_discord_operation_service/);
  assert.match(cleanup, /p_operation_kind:\s*"disconnect"/);
  assert.match(cleanup, /discord_get_connection_secret_service/);
  assert.match(cleanup, /exactDiscordWebhookIdentity/);
  assert.match(cleanup, /DISCORD_CLIENT_ID/);
  assert.match(cleanup, /DISCORD_CLIENT_SECRET/);
  assertOrdered(cleanup, [
    "deleteExactDiscordWebhook(webhookId, webhookToken)",
    "revokeDiscordGrant(",
    '"discord_clear_connection_service"',
    '"discord_erase_webhooks_for_owner_service"',
  ]);
  assert.match(cleanup, /provider deletion is ambiguous|did not confirm deletion/i);
  assert.match(cleanup, /local access was retained/);
  assert.match(cleanup, /release_discord_operation_service/);
});

test("only definitive Discord provider responses permit local erasure", () => {
  const providerDelete = functionBlock(erasure, "deleteExactDiscordWebhook");
  const providerRevoke = functionBlock(erasure, "revokeDiscordGrant");
  assert.match(providerDelete, /response\.status === 204 \|\| response\.status === 404/);
  assert.match(providerDelete, /catch\s*\{[\s\S]*return false/);
  assert.match(providerRevoke, /oauth2\/token\/revoke/);
  assert.match(providerRevoke, /token_type_hint/);
  assert.match(providerRevoke, /return response\.ok/);
  assert.match(providerRevoke, /catch\s*\{[\s\S]*return false/);
});

test("missing or malformed revocation handles fail closed", () => {
  const identity = functionBlock(erasure, "exactDiscordWebhookIdentity");
  const cleanup = functionBlock(erasure, "eraseDiscordWebhooks");
  assert.match(identity, /parsed\.protocol !== "https:"/);
  assert.match(identity, /discord\.com/);
  assert.match(identity, /discordapp\.com/);
  assert.match(identity, /match!\[1\] === webhookId/);
  assert.match(identity, /match!\[2\] === webhookToken/);
  assert.match(cleanup, /\["connected", "error"\]\.includes/);
  assert.match(cleanup, /exact revocation handle is unavailable/i);
  assert.match(cleanup, /stored Discord webhook identity is invalid/i);
  assert.match(cleanup, /no provider or local access was erased/i);
});

test("the final SQL erasure RPC verifies remote-first cleanup instead of deleting secrets itself", () => {
  const tail = sqlFunctionBlock(
    migration066,
    "create or replace function public.discord_erase_webhooks_for_owner_service(",
  );
  assert.match(tail, /security definer\s+set search_path = ''/i);
  assert.match(tail, /from public\.discord_credentials where owner = p_owner/);
  assert.match(tail, /from public\.discord_channel_bindings where owner = p_owner/);
  assert.match(tail, /from vault\.secrets as secret/);
  assert.match(tail, /connection_state in \('connected','error'\)/);
  assert.match(tail, /provider revocation must be confirmed before local erasure/i);
  assert.doesNotMatch(tail, /delete from public\.discord_credentials/);
  assert.doesNotMatch(tail, /delete from public\.discord_channel_bindings/);
  assert.doesNotMatch(tail, /delete from vault\.secrets/);
  assert.match(tail, /delete from public\.discord_oauth_transactions where owner = p_owner/);
  assert.match(
    migration066,
    /revoke all on function public\.discord_erase_webhooks_for_owner_service\(uuid\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration066,
    /grant execute on function public\.discord_erase_webhooks_for_owner_service\(uuid\)[\s\S]*to service_role/,
  );
});

test("Discord provider cleanup precedes all generic account and storage erasure", () => {
  const eraseClaimedOwner = erasure.slice(erasure.indexOf("const eraseClaimedOwner"));
  assertOrdered(eraseClaimedOwner, [
    '"Discord webhook erasure"',
    "eraseDiscordWebhooks(admin, uid)",
    '"owned storage erasure"',
    "eraseOwnedStorage(admin, uid)",
    '"owned-row erasure"',
    "eraseOwnedRows(admin, uid, personaIds)",
  ]);
  const ownedRows = functionBlock(erasure, "eraseOwnedRows");
  assert.match(
    ownedRows,
    /admin\.rpc\("delete_account_ledger_for_account_service", \{ p_owner: uid \}\)/,
  );
});

test("the release runbook documents remote-first disconnect and ambiguity", () => {
  assert.match(runbook, /delete the remote webhook first/i);
  assert.match(runbook, /revoke the OAuth grant second/i);
  assert.match(runbook, /erase the Vault bundle/i);
  assert.match(runbook, /ambiguous response stops local erasure/i);
  assert.match(runbook, /Authorized Apps/i);
  assert.match(runbook, /Server.*Integrations/is);
});
