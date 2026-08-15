import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [migration019, migration042, erasureSource, runbook] = await Promise.all([
  readFile(
    path.join(
      repoRoot,
      "MyPersonas.Online_v0/sql-updates/019-discord-webhook.sql",
    ),
    "utf8",
  ),
  readFile(
    path.join(
      repoRoot,
      "MyPersonas.Online_v0/sql-updates/042-discord-dormancy-erasure.sql",
    ),
    "utf8",
  ),
  readFile(
    path.join(repoRoot, "supabase/functions/delete-account/index.ts"),
    "utf8",
  ),
  readFile(
    path.join(repoRoot, "MyPersonas.Online_v0/DISCORD-DORMANCY-ERASURE.md"),
    "utf8",
  ),
]);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index++) {
    if (source[index] === "(") parameterDepth++;
    if (source[index] === ")") {
      parameterDepth--;
      if (parameterDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} has unterminated parameters`);
  const bodyStart = source.indexOf("{", parametersEnd);
  assert.notEqual(bodyStart, -1, `${name} has no body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
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

test("migration 042 atomically disables new Discord webhook secrets", () => {
  assert.match(migration042, /\bbegin;[\s\S]*\bcommit;\s*$/i);
  assert.match(
    migration042,
    /revoke all on function public\.discord_set_webhook\(uuid, text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.doesNotMatch(
    migration042,
    /grant\s+execute\s+on\s+function\s+public\.discord_set_webhook/i,
  );
  assert.match(migration042, /DORMANT: no API role may create or replace/i);

  // Dormancy removes creation/replacement but preserves owner-initiated removal.
  assert.match(
    migration019,
    /grant execute on function public\.discord_clear_webhook\(uuid\) to authenticated;/i,
  );
  assert.doesNotMatch(
    migration042,
    /revoke all on function public\.discord_clear_webhook/i,
  );
});

test("Discord erasure is service-only, owner-derived, and verifies Vault absence", () => {
  const block = sqlFunctionBlock(
    migration042,
    "create or replace function public.discord_erase_webhooks_for_owner_service(",
  );
  assert.match(block, /p_owner uuid[\s\S]*returns integer/i);
  assert.match(block, /security definer\s+set search_path = ''/i);
  assert.match(block, /delete from vault\.secrets as secret/i);
  assert.match(block, /from public\.account_ledger as ledger/i);
  assert.match(block, /ledger\.owner = p_owner/i);
  assert.match(block, /ledger\.provider = 'discord'/i);
  assert.match(
    block,
    /secret\.name = 'discord_webhook_' \|\| ledger\.id::text/i,
  );
  assertOrdered(block, [
    "delete from vault.secrets",
    "get diagnostics v_deleted = row_count",
    "select count(*)::integer",
    "if v_remaining <> 0",
    "return v_deleted",
  ]);
  assert.match(block, /connection_state = 'disconnected'/i);
  assert.doesNotMatch(block, /decrypted_secret|decrypted_secrets/i);

  assert.match(
    migration042,
    /revoke all on function public\.discord_erase_webhooks_for_owner_service\(uuid\)\s+from public, anon, authenticated;/i,
  );
  assert.match(
    migration042,
    /grant execute on function public\.discord_erase_webhooks_for_owner_service\(uuid\)\s+to service_role;/i,
  );
});

test("account erasure fails closed on Discord cleanup before generic row deletion", () => {
  const cleanup = functionBlock(erasureSource, "eraseDiscordWebhooks");
  assert.match(
    cleanup,
    /admin\.rpc\(\s*"discord_erase_webhooks_for_owner_service",\s*\{ p_owner: uid \}/s,
  );
  assert.match(cleanup, /error \|\| typeof data !== "number"/);
  assert.match(cleanup, /!Number\.isSafeInteger\(data\)/);
  assert.match(cleanup, /data < 0/);
  assert.match(cleanup, /generic account-ledger cleanup was not started/);

  const eraseClaimedOwner = erasureSource.slice(
    erasureSource.indexOf("const eraseClaimedOwner"),
  );
  assertOrdered(eraseClaimedOwner, [
    '"Meta revocation"',
    "revokeMeta(",
    '"Discord webhook erasure"',
    "eraseDiscordWebhooks(admin, uid)",
    '"owned storage erasure"',
    "eraseOwnedStorage(admin, uid)",
    '"owned-row erasure"',
    "eraseOwnedRows(admin, uid, personaIds)",
  ]);

  const ownedRows = functionBlock(erasureSource, "eraseOwnedRows");
  assert.match(
    ownedRows,
    /admin\.from\("account_ledger"\)\.delete\(\)\.eq\("owner", uid\)/,
  );
});

test("runbook inventories and removes only reviewed orphan metadata IDs", () => {
  assert.match(runbook, /local implementation only/i);
  assert.match(runbook, /migration 042 is not applied/i);
  assert.match(runbook, /orphan_no_matching_ledger/);
  assert.match(runbook, /orphan_wrong_provider/);
  assert.match(runbook, /reviewed_discord_orphans/);
  assert.match(runbook, /secret\.id = reviewed\.secret_id/);
  assert.match(runbook, /Use `rollback;` instead of `commit;` on any mismatch/);
  assert.doesNotMatch(runbook, /select\s+[^;]*decrypted_secret/is);
});
