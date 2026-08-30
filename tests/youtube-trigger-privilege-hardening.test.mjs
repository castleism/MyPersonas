import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const canonical = await readFile(
  new URL("../MyPersonas.Online_v0/sql-updates/076-youtube-trigger-privilege-hardening.sql", import.meta.url),
  "utf8",
);
const mirror = await readFile(
  new URL("../supabase/migrations/20260830190000_youtube_trigger_privilege_hardening.sql", import.meta.url),
  "utf8",
);

test("migration 076 mirrors are byte-identical and transactional", () => {
  assert.equal(mirror, canonical);
  assert.match(canonical, /^-- 076-youtube-trigger-privilege-hardening\.sql/);
  assert.match(canonical, /\bbegin;[\s\S]*\bcommit;/i);
});

test("all YouTube trigger helpers reject browser and service RPC execution", () => {
  for (const name of [
    "delete_youtube_credential_vault_secret",
    "delete_youtube_upload_session_vault_secret",
    "invalidate_youtube_approval_on_draft_change",
  ]) {
    assert.match(
      canonical,
      new RegExp(`revoke all on function public\\.${name}\\(\\)\\s+from public, anon, authenticated, service_role;`, "i"),
    );
  }
});
