import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const [sql, ownerApp] = await Promise.all([
  read("MyPersonas.Online_v0/sql-updates/054-owner-research-content-hardening.sql"),
  read("MyPersonas.Online_v0/owner-app.js"),
]);
const functionBody = (name) => sql.match(
  new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`, "i"),
)?.[0] || "";

test("054 removes all 044/045 browser DML while preserving owner reads", () => {
  for (const table of [
    "persona_research_settings", "persona_research_briefs", "persona_research_topics",
    "persona_topic_post_plans", "research_brief_annotations", "persona_content_packages",
    "persona_content_variants", "owner_notifications", "persona_activity_events",
  ]) assert.match(sql, new RegExp(`public\\.${table}`));
  assert.match(sql, /revoke insert,update,delete on public\.persona_research_settings,[\s\S]*public\.persona_activity_events[\s\S]*from authenticated/);
  for (const policy of [
    "owner write research settings", "owner write briefs", "owner write topics", "owner write plans",
    "owner all research annotations", "owner all content packages", "owner all content variants",
    "owner all notifications", "owner all activity events",
  ]) assert.match(sql, new RegExp(`drop policy if exists \\"${policy}\\"`));
  assert.match(sql, /create policy "owner read research annotations"/);
  assert.match(sql, /create policy "owner read activity events"/);
});

test("creation quotas are serialized, durable, and cover rows, bytes, daily churn, and lifetime churn", () => {
  assert.match(sql, /create table if not exists public\.owner_research_content_usage/);
  assert.match(sql, /window_day date not null/);
  for (const kind of ["briefs", "topics", "plans", "annotations", "packages", "owner_activity"]) {
    assert.match(sql, new RegExp(`when '${kind}' then v_daily_limit`));
  }
  assert.match(functionBody("lock_owner_research_content"), /hashtextextended\(p_owner::text,51051056\)/);
  const reserve = functionBody("reserve_owner_research_content_creation");
  assert.match(reserve, /lock_owner_research_content\(p_owner\)/);
  assert.match(reserve, /v_today\+p_amount>v_daily_limit/);
  assert.match(reserve, /v_lifetime\+p_amount>v_lifetime_limit/);
  assert.match(sql, /Research brief storage limit reached \(2000\)/);
  assert.match(sql, /Research topic storage limit reached \(20000\)/);
  assert.match(sql, /Topic plan storage limit reached \(5000\)/);
  assert.match(sql, /Annotation storage limit reached \(5000\)/);
  assert.match(sql, /Content package storage limit reached \(1000\)/);
  assert.match(sql, /Research brief byte limit reached \(157286400 bytes\)/);
  assert.match(sql, /Annotation byte limit reached \(20971520 bytes\)/);
  assert.match(sql, /Content package byte limit reached \(52428800 bytes\)/);
  assert.match(sql, /Activity event byte limit reached \(67108864 bytes\)/);
});

test("owner RPCs enforce local drafting and immutable approval/provenance boundaries", () => {
  for (const name of [
    "save_owner_research_settings", "set_owner_research_brief_status",
    "save_owner_research_annotation", "delete_owner_research_annotation",
    "create_owner_content_package", "save_owner_content_package_draft",
    "mark_owner_notifications_read", "record_owner_local_activity",
  ]) {
    const body = functionBody(name);
    assert.ok(body, `${name} exists`);
    assert.match(body, /lock_owner_research_content/);
  }
  assert.match(functionBody("save_owner_research_annotation"), /is_safe_credential_free_https_url/);
  assert.match(functionBody("create_owner_content_package"), /assert_owner_content_variants/);
  const savePackage = functionBody("save_owner_content_package_draft");
  assert.match(savePackage, /Posted or archived content must remain immutable/);
  const packageLock = savePackage.indexOf("for update;");
  const protectedDowngrade = savePackage.search(/if v_package\.status in \('approved','scheduled'\) then\s+perform public\.require_aal2\(\)/);
  assert.ok(packageLock >= 0 && protectedDowngrade > packageLock, "approved/scheduled downgrade requires AAL2 after the exact row lock");
  assert.match(functionBody("assert_owner_content_variants"), /unsupported or protected fields/);
  assert.match(functionBody("assert_owner_content_variants"), /'facebook','instagram','website','x'/);
  assert.match(functionBody("set_owner_research_brief_status"), /Archived briefs cannot be reopened/);
  assert.match(functionBody("approve_research_topic"), /Topic cannot be approved in its current state/);
  assert.match(functionBody("reject_research_topic"), /status='cancelled'/);

  for (const name of [
    "approve_content_package", "schedule_content_package", "unschedule_content_package",
    "mark_owner_content_variant_manually_posted",
  ]) assert.match(functionBody(name), /perform public\.require_aal2\(\)/);

  const manual = functionBody("mark_owner_content_variant_manually_posted");
  assert.match(manual, /source,summary[\s\S]*'owner'/);
  assert.doesNotMatch(manual, /provider_id\s*=|provider_url\s*=/);
  const provider = functionBody("record_content_variant_provider_receipt_service");
  assert.match(provider, /auth\.role\(\),'?'\)?<>?'service_role'|Service role required/);
  assert.match(provider, /provider_id=p_provider_id,provider_url=p_provider_url/);
  assert.match(provider, /'provider_receipt'/);
  assert.match(sql, /grant execute on function public\.save_research_brief[\s\S]*public\.record_content_variant_provider_receipt_service\(uuid,text,text\)[\s\S]*to service_role/);
  const authenticatedGrant = sql.match(/grant execute on function public\.save_owner_research_settings[\s\S]*?to authenticated;/)?.[0] || "";
  assert.doesNotMatch(authenticatedGrant, /record_content_variant_provider_receipt_service/);
});

test("owner app uses the locked RPC surface and performs no direct 044/045 mutations", () => {
  const mutable = "persona_research_settings|persona_research_briefs|persona_research_topics|persona_topic_post_plans|research_brief_annotations|persona_content_packages|persona_content_variants|owner_notifications|persona_activity_events";
  assert.doesNotMatch(ownerApp, new RegExp(`sb\\.from\\(\\"(?:${mutable})\\"\\)\\.(?:insert|upsert|update|delete)`));
  for (const rpc of [
    "record_owner_local_activity", "save_owner_research_annotation",
    "delete_owner_research_annotation", "set_owner_research_brief_status",
    "create_owner_content_package", "save_owner_content_package_draft",
    "mark_owner_content_variant_manually_posted", "mark_owner_notifications_read",
    "save_owner_research_settings",
  ]) assert.match(ownerApp, new RegExp(`sb\\.rpc\\(\\"${rpc}\\"`));
  assert.match(ownerApp, /not a provider receipt/);
  assert.match(ownerApp, /no provider receipt was claimed/);
});
