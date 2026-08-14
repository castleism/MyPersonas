import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = await readFile(path.join(repoRoot, "MyPersonas.Online_v0/index.html"), "utf8");
const migration = await readFile(
  path.join(repoRoot, "MyPersonas.Online_v0/sql-updates/037-friend-request-realtime.sql"),
  "utf8"
);

test("friend Realtime is scoped to owned persona ids in bounded filters", () => {
  assert.match(frontend, /function setupFriendRealtime\(uid,generation=authLoadGeneration\)/);
  assert.match(frontend, /for\(let start=0;start<ids\.length;start\+=100\)/);
  assert.match(frontend, /filter:`target=in\.\(\$\{values\}\)`/);
  assert.match(frontend, /filter:`follower=in\.\(\$\{values\}\)`/);
  assert.match(frontend, /for\(const event of \["INSERT","UPDATE"\]\)/);
  assert.doesNotMatch(frontend, /table:"follows",filter:[^\n]+event:"\*"/);
});

test("friend Realtime tears down on account changes and rejects stale callbacks", () => {
  assert.match(frontend, /function resetPrivateUiState\(\)\{teardownFriendRealtime\(\)/);
  assert.match(frontend, /session\?\.user\?\.id!==uid\|\|generation!==authLoadGeneration/);
  assert.match(frontend, /sb\.removeChannel\(channel\)/);
  assert.match(frontend, /window\.addEventListener\("focus"/);
});

test("friend refresh updates the badge without reloading private account state", () => {
  const refresh = frontend.slice(
    frontend.indexOf("async function refreshFriendRequests"),
    frontend.indexOf("function scheduleFriendRequestRefresh")
  );
  assert.match(refresh, /pendingIn=rows;updateBadge\(\)/);
  assert.doesNotMatch(refresh, /loadMine\(/);
  assert.match(refresh, /start<targets\.length;start\+=100/);
});

test("migration 037 idempotently enables only the follows table", () => {
  assert.match(migration, /pg_catalog\.pg_publication_tables/);
  assert.match(migration, /pubname = 'supabase_realtime'/);
  assert.match(migration, /alter publication supabase_realtime add table public\.follows/);
  assert.match(migration, /follows_target_status_created_idx/);
  assert.match(migration, /follows_follower_status_created_idx/);
  assert.equal((migration.match(/add table/g) || []).length, 1);
});
