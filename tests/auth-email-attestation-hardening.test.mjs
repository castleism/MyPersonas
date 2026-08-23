import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrationPath = new URL(
  "../MyPersonas.Online_v0/sql-updates/056-auth-email-attestation-hardening.sql",
  import.meta.url,
);
const sql = await readFile(migrationPath, "utf8");

function extractFunction(name) {
  const match = sql.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
      "i",
    ),
  );
  assert.ok(match, `${name} function should exist`);
  return match[0];
}

test("auth email changes revoke only stale email-match attestations", () => {
  const fn = extractFunction("invalidate_stale_aliaspaces_email_attestations");
  assert.match(fn, /security definer[\s\S]*set search_path = ''/i);
  assert.match(fn, /hashtextextended\(new\.id::text,51051059\)/i);
  assert.match(
    fn,
    /from public\.account_ledger[\s\S]*order by ledger\.id[\s\S]*for update of ledger/i,
  );
  assert.match(
    fn,
    /from public\.account_connections[\s\S]*order by connection\.ledger_id[\s\S]*for update of connection/i,
  );
  assert.match(fn, /verification_method='aliaspaces_confirmed_email'/i);
  assert.match(fn, /connection_state='verified'/i);
  assert.doesNotMatch(fn, /connection_state='connected'/i);
  assert.match(fn, /set connection_state='disconnected'/i);
  assert.match(fn, /provider_email=''/i);
  assert.match(fn, /verified_at=null/i);
});

test("trigger is non-callable and watches both authentication email fields", () => {
  assert.match(
    sql,
    /revoke all on function public\.invalidate_stale_aliaspaces_email_attestations\(\)[\s\S]*from public,anon,authenticated,service_role/i,
  );
  assert.match(
    sql,
    /after update of email,email_confirmed_at on auth\.users[\s\S]*execute function public\.invalidate_stale_aliaspaces_email_attestations\(\)/i,
  );
});

test("legacy backfill shares owner and row lock ordering", () => {
  const backfill = sql.match(/do \$backfill\$[\s\S]*?\$backfill\$;/i)?.[0] || "";
  assert.ok(backfill, "backfill block should exist");
  assert.match(backfill, /hashtextextended\(v_owner::text,51051059\)/i);
  assert.match(
    backfill,
    /from public\.account_ledger[\s\S]*order by ledger\.id[\s\S]*for update of ledger/i,
  );
  assert.match(
    backfill,
    /from public\.account_connections[\s\S]*order by connection\.ledger_id[\s\S]*for update of connection/i,
  );
  assert.match(backfill, /verification_method='aliaspaces_confirmed_email'/i);
  assert.match(backfill, /connection_state='verified'/i);
});
