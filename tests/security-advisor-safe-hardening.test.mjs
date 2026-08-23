import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasePath = path.join(root, "MyPersonas.Online_v0/sql-updates/061-security-advisor-safe-hardening.sql");
const migrationPath = path.join(root, "supabase/migrations/20260823030000_security_advisor_safe_hardening.sql");
const [releaseSql, migrationSql] = await Promise.all([
  readFile(releasePath, "utf8"),
  readFile(migrationPath, "utf8"),
]);
const normalize = value => value.replaceAll("\r\n", "\n");

test("migration 061 has an exact release mirror and remains transactional", () => {
  assert.equal(normalize(migrationSql), normalize(releaseSql));
  assert.match(migrationSql, /^begin;$/m);
  assert.match(migrationSql, /^commit;\s*$/m);
  assert.match(migrationSql, /Forward-only, provider-independent fixes/);
});

test("both mutable trigger paths are pinned without assuming live-only drift", () => {
  assert.match(migrationSql, /alter function public\.touch_updated_at\(\)[\s\S]{0,80}set search_path = pg_catalog/);
  assert.match(migrationSql, /to_regprocedure\('public\.tg_touch_updated_at\(\)'\)/);
  assert.match(migrationSql, /execute 'alter function public\.tg_touch_updated_at\(\) set search_path = pg_catalog'/);
  assert.match(migrationSql, /revoke all on function public\.touch_updated_at\(\)[\s\S]{0,80}from public, anon, authenticated/);
});

test("trigger implementations and owner research RPCs lose anonymous execution", () => {
  const triggerFunctions = [
    "auto_create_research_settings",
    "cleanup_deleted_fan_chat_notification",
    "invalidate_content_package_approval",
    "notify_content_package_review",
    "notify_new_research_brief",
    "notify_owner_fan_message",
  ];
  for (const fn of triggerFunctions) {
    assert.match(migrationSql, new RegExp(`revoke all on function public\\.${fn}\\(\\)[\\s\\S]{0,80}from public, anon, authenticated`), fn);
  }
  for (const signature of ["owner_research_brief_queue\\(date,text\\)", "get_research_digest\\(uuid,integer\\)"]) {
    assert.match(migrationSql, new RegExp(`revoke all on function public\\.${signature}[\\s\\S]{0,80}from public, anon, authenticated`));
    assert.match(migrationSql, new RegExp(`grant execute on function public\\.${signature}[\\s\\S]{0,60}to authenticated`));
  }
});

test("RLS predicates and reviewed public projections remain intentionally anonymous", () => {
  for (const fn of ["owns_persona", "persona_visible"]) {
    assert.match(migrationSql, new RegExp(`grant execute on function public\\.${fn}\\(uuid\\)[\\s\\S]{0,60}to anon, authenticated`));
  }
  const projections = [
    "business_page_by_slug", "discover_personas", "get_public_persona_revenue_rails",
    "persona_by_handle", "persona_family_by_handle", "persona_page_layout",
    "persona_relation_cards", "public_persona_friend_policy",
  ];
  for (const fn of projections) assert.match(migrationSql, new RegExp(`--   ${fn}\\(`), fn);
  assert.match(migrationSql, /That warning is accepted; their projection contracts are intentional/);
});

test("future postgres-owned public functions require an explicit browser-role grant", () => {
  assert.match(migrationSql, /alter default privileges for role postgres in schema public[\s\S]{0,100}revoke execute on functions from public, anon, authenticated/);
  assert.match(migrationSql, /alter default privileges for role postgres in schema public[\s\S]{0,100}grant execute on functions to service_role/);
  assert.doesNotMatch(migrationSql, /alter default privileges for role supabase_admin/i);
});

test("the waitlist remains write-only and accepts only the exact landing-page payload", () => {
  assert.match(migrationSql, /constraint noo_waitlist_input_contract check/);
  assert.match(migrationSql, /email = pg_catalog\.lower\(pg_catalog\.btrim\(email\)\)/);
  assert.match(migrationSql, /pg_catalog\.char_length\(email\) between 3 and 254/);
  assert.match(migrationSql, /source = 'nooyouniverse\.com'/);
  assert.match(migrationSql, /create policy noo_waitlist_anon_insert[\s\S]*?for insert[\s\S]*?to anon[\s\S]*?with check \([\s\S]*?source = 'nooyouniverse\.com'/);
  assert.doesNotMatch(migrationSql, /with check \(true\)/i);
  assert.match(migrationSql, /revoke all privileges on table public\.noo_waitlist[\s\S]{0,80}from public, anon, authenticated/);
  assert.match(migrationSql, /grant insert \(email,source\) on public\.noo_waitlist to anon/);
  assert.doesNotMatch(migrationSql, /grant (?:select|update|delete|truncate|trigger|references)[^;]*noo_waitlist[^;]*to anon/i);
});

test("provider-managed non-relocatable pg_net is classified but not mutated", () => {
  assert.match(migrationSql, /pg_net 0\.20\.3 is provider-installed in public and extrelocatable=false/);
  assert.doesNotMatch(migrationSql, /(?:alter|drop|create) extension\s+(?:if exists\s+)?pg_net/i);
});
