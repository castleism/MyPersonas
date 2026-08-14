import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Discord posting is explicitly fail-closed before auth, database, or provider work", async () => {
  const [source, config] = await Promise.all([
    readFile(path.join(repoRoot, "supabase/functions/discord-post/index.ts"), "utf8"),
    readFile(path.join(repoRoot, "supabase/config.toml"), "utf8"),
  ]);
  assert.match(source, /const DISCORD_POST_RELEASE_ENABLED = false/);
  const gate = source.indexOf("if (!DISCORD_POST_RELEASE_ENABLED)");
  assert.ok(gate > 0);
  assert.ok(gate < source.indexOf("const authorization = req.headers"));
  assert.ok(gate < source.indexOf('createClient(SUPABASE_URL, SERVICE_ROLE_KEY'));
  assert.ok(gate < source.indexOf('fetch(`${webhookUrl}?wait=true`'));
  assert.match(source.slice(gate, source.indexOf("const authorization = req.headers")), /status: "disabled"/);
  assert.match(config, /\[functions\.discord-post\]\s*verify_jwt\s*=\s*true/);
});
