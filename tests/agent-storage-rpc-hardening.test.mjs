import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const migrationPath = "MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql";
const [sql, html, legacyAutomation] = await Promise.all([
  read(migrationPath),
  read("MyPersonas.Online_v0/index.html"),
  read("MyPersonas.Online_v0/sql-updates/011-agent-automation.sql"),
]);
const functionBody = (name) => sql.match(
  new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`, "i"),
)?.[0] || "";

test("owner storage mutations use one documented account then sorted-persona lock hierarchy", () => {
  assert.match(sql, /Inherited 011 owner storage hardening/);
  assert.match(functionBody("lock_owner_agent_storage"), /hashtextextended\(p_owner::text,51051101\)/);
  assert.match(functionBody("lock_persona_agent_storage"), /hashtextextended\(p_persona_id::text,51051102\)/);
  assert.match(sql, /revoke all on function public\.lock_owner_agent_storage\(uuid\),[\s\S]*from public,anon,authenticated,service_role/);
  for (const index of [
    "agent_destinations_owner_created_quota_idx",
    "persona_content_plans_owner_created_quota_idx",
    "ai_tasks_owner_created_quota_idx",
    "ai_tasks_owner_persona_quota_idx",
    "drafts_owner_created_quota_idx",
    "drafts_owner_persona_quota_idx",
    "agent_messages_owner_created_quota_idx",
    "agent_messages_owner_persona_quota_idx",
  ]) assert.match(sql, new RegExp(`create index if not exists ${index}`));

  for (const name of [
    "save_agent_destination", "delete_agent_destination",
    "save_persona_content_plan", "delete_persona_content_plan",
    "save_ai_task_definition", "delete_ai_task_definition",
    "save_owner_draft", "append_agent_messages", "delete_agent_message_history",
  ]) {
    const body = functionBody(name);
    assert.ok(body, `${name} exists`);
    const ownerLock = body.indexOf("lock_owner_agent_storage");
    const personaLock = body.indexOf("lock_persona_agent_storage");
    assert.ok(ownerLock >= 0, `${name} takes the owner lock`);
    assert.ok(personaLock < 0 || ownerLock < personaLock, `${name} takes owner lock before persona lock`);
  }
  for (const name of ["save_ai_task_definition", "save_owner_draft"]) {
    assert.match(functionBody(name), /unnest\(array\[v_old_persona_id,p_persona_id\]\)[\s\S]*order by candidate\.persona_id/);
  }
  assert.match(functionBody("append_agent_messages"), /unnest\(v_persona_ids\)[\s\S]*order by candidate\.persona_id/);

  const deletion = functionBody("delete_owned_persona");
  const ownerLock = deletion.indexOf("hashtextextended(auth.uid()::text,51051101)");
  const personaStorageLock = deletion.indexOf("hashtextextended(p_persona_id::text,51051102)");
  const businessLock = deletion.indexOf("hashtextextended(v_business_id::text,52052052)");
  const publicationLock = deletion.indexOf("lock_persona_publication_mutation(p_persona_id)");
  const personaDelete = deletion.indexOf("delete from public.personas persona");
  assert.ok(ownerLock >= 0 && ownerLock < personaStorageLock);
  assert.ok(personaStorageLock < businessLock && businessLock < publicationLock);
  assert.ok(publicationLock < personaDelete);
});

test("destination and schedule changes are AAL2, allowlisted, bounded, and identity-safe", () => {
  const destination = functionBody("save_agent_destination");
  const deleteDestination = functionBody("delete_agent_destination");
  const task = functionBody("save_ai_task_definition");
  const deleteTask = functionBody("delete_ai_task_definition");
  for (const body of [destination, deleteDestination, task, deleteTask]) {
    assert.match(body, /perform public\.require_aal2\(\)/);
  }
  assert.match(destination, /cardinality\(p_allowed_content_types\),0\) not between 1 and 6/);
  assert.match(destination, /p_mode is null or p_mode not in/);
  assert.match(destination, /p_daily_publish_limit is null or p_daily_publish_limit not between/);
  assert.match(destination, /allowed_content_types[\s\S]*'post','reel','article','image','newsletter','promo'/);
  assert.match(destination, /Delete and recreate a destination to change its identity/);
  assert.match(destination, /Automatic publication is paused pending exact page-review support/);
  assert.doesNotMatch(destination, /active claimed L3 binding is required for auto mode/i);
  assert.match(destination, /limit 200[\s\S]*limit 50[\s\S]*interval '24 hours'[\s\S]*limit 50/);
  assert.match(destination, /262144 bytes/);

  assert.match(task, /Task name',256,true/);
  assert.match(task, /Task instructions',4096,false/);
  assert.match(task, /Task time zone',64,true/);
  assert.match(task, /newsplan','original','repost','article','reel','image','newsletter','promo','custom/);
  assert.match(task, /Owner approval is mandatory for every task/);
  assert.match(task, /p_schedule_day is null or p_schedule_day not between 0 and 6/);
  assert.match(task, /p_lead_minutes is null or p_lead_minutes not between 0 and 10080/);
  assert.match(task, /pg_timezone_names/);
  assert.match(task, /Save an enabled matching destination policy first/);
  assert.match(task, /limit 500[\s\S]*interval '24 hours'[\s\S]*limit 100/);
  assert.match(task, /AI task persona limit reached \(100\)/);
  assert.match(task, /2097152 bytes/);
  assert.doesNotMatch(task, /lease_token\s*=|lease_expires_at\s*=|last_status\s*=|last_error\s*=/);
});

test("content plans and owner drafts enforce UTF-8 byte, row, rate, and aggregate caps", () => {
  const validate = functionBody("assert_agent_storage_text");
  const plan = functionBody("save_persona_content_plan");
  const draft = functionBody("save_owner_draft");
  assert.match(validate, /octet_length\(v_value\)>p_max_bytes/);
  assert.match(validate, /unsupported control characters/);
  for (const [field, bytes] of [
    ["Primary goal", 768], ["Success metric", 512], ["Audience focus", 768],
    ["Content pillars", 1024], ["Offers and links", 1536],
    ["Affiliate disclosure", 512], ["Source notes", 1536],
    ["Platform guidance", 1024],
  ]) assert.match(plan, new RegExp(`${field}',${bytes},false`));
  assert.match(plan, /limit 250/);
  assert.match(plan, /interval '24 hours'[\s\S]*limit 50/);
  assert.match(plan, /2097152 bytes/);

  assert.match(draft, /Draft title',1000,false/);
  assert.match(draft, /Draft body',30000,false/);
  assert.match(draft, /Draft tags',4000,false/);
  assert.match(draft, /Draft media URL',2048,false/);
  assert.match(draft, /is_safe_credential_free_https_url/);
  assert.match(draft, /Published, publishing, or staged drafts require reconciliation/);
  assert.match(draft, /limit 5000[\s\S]*interval '24 hours'[\s\S]*limit 200/);
  assert.match(draft, /Draft persona limit reached \(1000\)/);
  assert.match(draft, /67108864 bytes/);
  assert.doesNotMatch(draft, /approval_state\s*=|approved_content_hash\s*=|publish_state\s*=|provider_post_id\s*=/);
  assert.match(legacyAutomation, /create trigger invalidate_changed_draft_approval/);
});

test("browser chat append is exact-key, idempotent, server-timestamped, and bounded", () => {
  const append = functionBody("append_agent_messages");
  const clear = functionBody("delete_agent_message_history");
  assert.match(append, /p_messages is null or pg_catalog\.jsonb_typeof\(p_messages\)<>'array'/);
  assert.match(append, /jsonb_array_length\(p_messages\) not between 1 and 50/);
  assert.match(append, /'persona_id','workspace_id','conversation_key','client_message_id','role','content'/);
  assert.match(append, /Message rows contain unsupported fields/);
  assert.match(append, /duplicate client message id/);
  assert.match(append, /Message content',20000,true/);
  assert.match(append, /role not in \('user','assistant'\)/);
  assert.match(append, /Owned message workspace does not match its persona and conversation/);
  assert.match(append, /already bound to different content/);
  assert.match(append, /limit 20001[\s\S]*limit 2000/);
  assert.match(append, /Agent message persona limit reached \(5000\)/);
  assert.match(append, /Unscoped agent message limit reached \(2000\)/);
  assert.match(append, /Agent message conversation limit reached \(500\)/);
  assert.match(append, /67108864 bytes/);
  assert.match(append, /v_item->>'content',now\(\)/);
  assert.doesNotMatch(append, /v_item->>'created_at'/);
  assert.match(clear, /Choose exactly one workspace or conversation to clear/);
  assert.match(clear, /message\.owner=v_owner/);
});

test("creation churn uses retained counters and service erasure joins the same lock order", () => {
  assert.match(sql, /create table if not exists public\.agent_storage_creation_counters/);
  assert.match(sql, /primary key\(owner,resource\)/);
  assert.match(sql, /lifetime_count bigint not null default 0/);
  assert.match(sql, /persona_content_plan_mutations/);
  assert.match(sql, /revoke all on public\.agent_storage_creation_counters from public,anon,authenticated/);
  const reserve = functionBody("reserve_agent_storage_creations");
  assert.match(reserve, /lock_owner_agent_storage\(p_owner\)/);
  assert.match(reserve, /v_daily\+p_amount>p_daily_limit/);
  assert.match(reserve, /lifetime_count=excluded\.lifetime_count/);
  assert.match(reserve, /action\.action_type='direction\.updated'/);
  assert.match(reserve, /limit 100001/);
  assert.match(reserve, /v_lifetime,0\)\+p_amount>v_plan_lifetime_limit/);
  for (const [name, resource] of [
    ["save_agent_destination", "agent_destinations"],
    ["save_persona_content_plan", "persona_content_plan_mutations"],
    ["save_ai_task_definition", "ai_tasks"],
    ["save_owner_draft", "drafts"],
    ["append_agent_messages", "agent_messages"],
  ]) assert.match(functionBody(name), new RegExp(`reserve_agent_storage_creations\\([\\s\\S]*'${resource}'`));

  for (const name of ["save_agent_binding_controls_service", "delete_agent_bindings_for_account_service"]) {
    const body = functionBody(name);
    const owner = body.indexOf("51051101");
    const persona = body.indexOf("51051102");
    const binding = name === "delete_agent_bindings_for_account_service"
      ? body.indexOf("delete from public.agent_bindings binding")
      : body.indexOf("select * into v_binding from public.agent_bindings binding");
    assert.ok(owner >= 0 && owner < persona, `${name} owner then persona agent lock`);
    assert.ok(persona < binding, `${name} locks before binding rows`);
  }
  assert.match(functionBody("delete_my_agent_data"), /51051101[\s\S]*51051056[\s\S]*51051102[\s\S]*lock_persona_publication_mutation/);
});

test("every audited content-plan mutation is AAL2 and consumes retained daily and lifetime allowance", () => {
  const save = functionBody("save_persona_content_plan");
  const remove = functionBody("delete_persona_content_plan");
  assert.match(save, /perform public\.require_aal2\(\)/);
  assert.match(remove, /perform public\.require_aal2\(\)/);
  assert.match(save, /action\.action_type='direction\.updated'[\s\S]*action\.created_at>=now\(\)-interval '24 hours'[\s\S]*limit 50/);
  const reserve = save.indexOf("reserve_agent_storage_creations");
  const insert = save.indexOf("insert into public.persona_content_plans");
  assert.ok(reserve >= 0 && reserve < insert, "retained allowance is reserved before the audited upsert");
  assert.match(save, /v_owner,'persona_content_plan_mutations',1,50,v_created_day/);
});

test("bulk draft erasure reconciles exact staged posts under AAL2 and sorted locks", () => {
  const erase = functionBody("delete_my_drafts_for_erasure");
  assert.match(erase, /perform public\.require_aal2\(\)/);
  assert.match(erase, /51051101/);
  assert.match(erase, /order by draft\.persona_id[\s\S]*51051102/);
  assert.match(erase, /lock_persona_publication_mutation\(v_persona_id\)/);
  assert.match(erase, /remove_exact_staged_native_post\(v_draft\)/);
  assert.match(erase, /delete from public\.drafts draft where draft\.owner=v_owner/);
  assert.match(sql, /revoke all on function public\.delete_my_drafts_for_erasure\(\)[\s\S]*from public,anon,authenticated,service_role/);
});

test("authenticated table DML is revoked and every owner UI mutation uses a locked RPC", () => {
  assert.match(sql, /revoke insert,update,delete on public\.agent_destinations,[\s\S]*public\.agent_messages[\s\S]*from public,anon,authenticated/);
  assert.match(sql, /revoke insert\([\s\S]*\) on public\.ai_tasks from public,anon,authenticated/);
  assert.match(sql, /revoke update\([\s\S]*\) on public\.drafts from public,anon,authenticated/);
  assert.match(sql, /grant select on public\.agent_destinations,public\.persona_content_plans,[\s\S]*public\.agent_messages to authenticated/);
  for (const rpc of [
    "save_agent_destination", "save_persona_content_plan", "save_ai_task_definition",
    "delete_ai_task_definition", "save_owner_draft", "append_agent_messages",
    "delete_agent_message_history", "delete_my_draft",
  ]) assert.match(html, new RegExp(`rpc\\("${rpc}"`), `${rpc} UI route`);
  assert.doesNotMatch(
    html,
    /\.from\("(?:agent_destinations|persona_content_plans|ai_tasks|drafts|agent_messages)"\)[\s\S]{0,180}?\.(?:insert|update|upsert|delete)\(/,
  );
  assert.match(html, /loadOwnedPages\("agent_destinations"/);
  assert.match(html, /loadOwnedPages\("persona_content_plans"/);
  assert.match(html, /loadOwnedPages\("agent_messages"/);
  assert.match(html, /agent_destinations:destinations\.data\|\|\[\]/);
  assert.match(html, /persona_content_plans:plans\.data\|\|\[\]/);
  assert.match(html, /agent_messages:agentMessages\.data\|\|\[\]/);
  assert.match(functionBody("delete_my_agent_data"), /delete_my_agent_data_legacy_011\(\)/);
  assert.match(html, /Native and external auto-publication remain paused/);
  assert.doesNotMatch(html, /Native auto mode will publish only exact drafts/);
});
