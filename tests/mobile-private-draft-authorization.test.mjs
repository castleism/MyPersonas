import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const sql = await read("MyPersonas.Online_v0/sql-updates/077-mobile-private-draft-workflow.sql");
const functionBody = (name) => sql.match(
  new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`, "i"),
)?.[0] || "";

test("077 keeps publishing disabled and reuses owner research locks", () => {
  assert.match(sql, /^-- 077-mobile-private-draft-workflow\.sql/);
  assert.match(sql, /check \(publishing_enabled = false\)/);
  assert.match(sql, /creation_source in \('brief','mobile_private'\)/);
  const create = functionBody("create_owner_mobile_private_draft");
  assert.ok(create, "create_owner_mobile_private_draft exists");
  assert.match(create, /auth\.uid\(\)/);
  assert.match(create, /Owned persona not found/);
  assert.match(create, /lock_owner_research_content/);
  assert.match(create, /assert_owner_content_variants/);
  assert.match(create, /assert_owner_mobile_draft_bindings/);
  assert.match(create, /publishing_enabled/);
  assert.match(create, /'mobile_private'/);
  assert.match(create, /'owner_review'/);
  assert.doesNotMatch(create, /provider_id,\s*provider_url\s*\)\s*values\s*\([^)]*'https?:/i);
  assert.doesNotMatch(create, /http_post|net\.http|pg_net|oauth|grant write/i);
  assert.match(sql, /grant execute on function public\.create_owner_mobile_private_draft[\s\S]*to authenticated/);
  assert.match(sql, /revoke all on function public\.create_owner_mobile_private_draft[\s\S]*from public, anon, service_role/);
});

test("077 exact binding rejects foreign, suspended, and ambiguous ledger rows", () => {
  const body = functionBody("assert_owner_mobile_draft_bindings");
  assert.ok(body);
  assert.match(body, /Exact provider\/account binding is required for every channel/);
  assert.match(body, /ledger\.owner = p_owner/);
  assert.match(body, /ledger\.persona_id = p_persona_id/);
  assert.match(body, /not ledger\.suspended/);
  assert.match(body, /Exact one assigned account is required/);
  assert.match(body, /Account provider does not match channel/);
  assert.match(body, /array\['x','twitter'\]/);
});

test("077 does not replace the canonical approval preview gate", async () => {
  const preview = await read("MyPersonas.Online_v0/sql-updates/073-content-package-preview-gate.sql");
  assert.match(preview, /create or replace function public\.content_package_preview_snapshot/);
  assert.match(preview, /planning records only|never call a|never auto-post|cannot call a provider/i);
  assert.doesNotMatch(sql, /create or replace function public\.content_package_preview_snapshot/);
  assert.doesNotMatch(sql, /create or replace function public\.approve_content_package/);
});
