import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL(
  "../MyPersonas.Online_v0/sql-updates/055-agent-action-retention-hardening.sql",
  import.meta.url,
), "utf8");
const deletion = await readFile(new URL(
  "../supabase/functions/delete-account/index.ts",
  import.meta.url,
), "utf8");
const html = await readFile(new URL(
  "../MyPersonas.Online_v0/index.html",
  import.meta.url,
), "utf8");
const postApproval = await readFile(new URL(
  "../supabase/functions/approve-post-draft/index.ts",
  import.meta.url,
), "utf8");
const nativePublish = await readFile(new URL(
  "../supabase/functions/post-bridge/index.ts",
  import.meta.url,
), "utf8");
const redditPublish = await readFile(new URL(
  "../supabase/functions/reddit-post/index.ts",
  import.meta.url,
), "utf8");
const aiProxy = await readFile(new URL(
  "../supabase/functions/ai-proxy/index.ts",
  import.meta.url,
), "utf8");
const runTasks = await readFile(new URL(
  "../supabase/functions/run-tasks/index.ts",
  import.meta.url,
), "utf8");
const runPublishQueue = await readFile(new URL(
  "../supabase/functions/run-publish-queue/index.ts",
  import.meta.url,
), "utf8");

function functionBody(name) {
  const start = migration.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const end = migration.indexOf("$$;", start);
  assert.notEqual(end, -1, `${name} terminates`);
  return migration.slice(start, end + 3);
}

test("055 is additive, transactional, and keeps recent evidence fail-closed", () => {
  assert.match(migration, /^-- 055-agent-action-retention-hardening\.sql/m);
  assert.match(migration, /\nbegin;[\s\S]*\ncommit;\s*$/);
  assert.doesNotMatch(migration, /delete from public\.agent_actions[\s\S]*?where[\s\S]*?(?:created_at|limit)[\s\S]*?;/i);
  assert.match(migration, /Recent evidence is never pruned implicitly/);
});

test("one retained owner receipt bounds every insert and update", () => {
  assert.match(migration, /create table if not exists public\.agent_action_storage_usage/);
  assert.match(migration, /lifetime_mutations bigint not null default 0/);
  assert.match(migration, /stored_rows integer not null default 0/);
  assert.match(migration, /stored_bytes bigint not null default 0/);
  assert.match(migration, /pending_terminal_mutations integer not null default 0/);
  assert.match(migration, /pending_terminal_bytes bigint not null default 0/);
  assert.match(migration, /limit 100001/);
  const reserve = functionBody("reserve_agent_action_mutation");
  assert.match(reserve, /where usage\.owner=p_owner for update/);
  assert.match(reserve, /p_terminal_kind[\s\S]*'reserve'[\s\S]*'consume'/);
  assert.match(reserve, /when p_terminal_kind='reserve' then 2/);
  assert.match(reserve, /when p_terminal_kind='consume' then 0/);
  assert.match(reserve, /v_owner_today>500/);
  assert.match(reserve, /v_system_today>10000/);
  assert.match(reserve, /lifetime_mutations\+v_mutation_cost>1000000/);
  assert.match(reserve, /v_rows>100000/);
  assert.match(reserve, /v_effective_bytes>67108864/);
  assert.match(reserve, /v_rows>90000 or v_effective_bytes>58720256/);
  assert.match(reserve, /p_terminal_kind<>'consume'/);
  assert.match(migration, /before insert or update on public\.agent_actions[\s\S]*guard_agent_action_storage/);
  assert.match(migration, /after delete on public\.agent_actions[\s\S]*reconcile_agent_action_storage_delete/);
});

test("started calls reserve their terminal mutation and byte footprint up front", () => {
  const guard = functionBody("guard_agent_action_storage");
  assert.match(migration, /action_type='ai\.call\.started'[\s\S]*outcome='started'[\s\S]*pending_terminal_mutations/);
  assert.match(migration, /greatest\(0::bigint,65536-[\s\S]*agent_action_storage_bytes/);
  assert.match(guard, /v_terminal_kind:='reserve'/);
  assert.match(guard, /v_terminal_reservation_bytes:=greatest\(0::bigint,65536-v_new_bytes\)/);
  assert.match(guard, /v_terminal_kind:='consume'/);
  assert.match(guard, /v_terminal_reservation_bytes:=greatest\(0::bigint,65536-v_old_bytes\)/);
  assert.match(migration, /action_type='ai\.call\.legacy_started'/);
  assert.match(migration, /outcome='legacy_unreserved'/);
  assert.match(migration, /possible_inflight_at_upgrade/);
  assert.match(migration, /created_at>=now\(\)-interval '15 minutes'[\s\S]*not exists\([\s\S]*ai\.call\.completed[\s\S]*ai\.call\.failed/);
  assert.match(migration, /auditLifecycleVersion',''\) not in \('1','2'\)/);
});

test("audit fields and bytes are strict and immutable", () => {
  const guard = functionBody("guard_agent_action_storage");
  assert.match(migration, /drop constraint if exists agent_actions_binding_id_fkey/);
  assert.match(migration, /historical binding identifier/i);
  assert.match(guard, /new\.binding_id is not null[\s\S]*binding\.owner=new\.owner[\s\S]*binding\.persona_id=new\.persona_id/);
  assert.match(guard, /action_type[\s\S]*not between 1 and 96/);
  assert.match(guard, /entity_type[\s\S]*octet_length[\s\S]*>64/);
  assert.match(guard, /outcome[\s\S]*not between 1 and 128/);
  assert.match(guard, /jsonb_typeof\(new\.detail\)<>'object'/);
  assert.match(guard, /49152 UTF-8 bytes/);
  assert.match(guard, /new\.created_at:=now\(\)/);
  assert.match(guard, /Agent action identity and creation time are immutable/);
  assert.match(guard, /old\.action_type<>'ai\.call\.started'[\s\S]*old\.outcome<>'started'/);
  assert.match(guard, /new\.action_type='ai\.call\.completed' and new\.outcome='ok'/);
  assert.match(guard, /new\.action_type='ai\.call\.failed' and new\.outcome='error'/);
  assert.match(guard, /new\.action_type='ai\.call\.denied' and new\.outcome='denied'/);
  assert.match(guard, /new\.action_type='ai\.call\.abandoned' and new\.outcome='unknown'/);
  assert.match(guard, /immutable after its one terminal transition/);
  assert.match(guard, /v_new_bytes>65536/);
  assert.match(guard, /reserve_agent_action_mutation/);
});

test("owner approval, rejection, publication, and controls require AAL2", () => {
  const guard = functionBody("guard_agent_action_storage");
  assert.match(guard, /v_role='authenticated'/);
  assert.match(guard, /new\.action_type like 'draft\.%'/);
  assert.match(guard, /new\.action_type like 'publish\.%'/);
  assert.match(guard, /new\.action_type like 'fan_chat\.owner_%'/);
  for (const action of [
    "binding.updated", "owner_controls.updated", "destination.created",
    "destination.updated", "destination.deleted", "direction.updated",
    "post_draft.scheduled", "post_draft.unscheduled", "post_draft.deleted",
    "publish_external_reddit",
  ]) assert.match(guard, new RegExp(action.replace(".", "\\.")));
  assert.match(guard, /perform public\.require_aal2\(\)/);
  assert.match(postApproval, /import \{ requireAal2 \} from "\.\.\/_shared\/aal2\.ts"/);
  assert.match(postApproval, /const guard = await requireAal2\(req, admin\)/);
  assert.match(postApproval, /if \(!guard\.ok\)[\s\S]*guard\.status/);
  assert.doesNotMatch(postApproval, /async function caller\(/);
  for (const edge of [nativePublish, redditPublish]) {
    assert.match(edge, /import \{ requireAal2 \} from "\.\.\/_shared\/aal2\.ts"/);
    assert.match(edge, /const guard = await requireAal2\(req, (?:admin|userClient)\)/);
    assert.match(edge, /if \(!guard\.ok\)[\s\S]*guard\.status/);
  }
  assert.doesNotMatch(nativePublish, /async function caller\(/);
});

test("service DML is narrow except for the exact old-worker terminal bridge", () => {
  assert.match(migration, /revoke all on public\.agent_actions[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration, /grant select on public\.agent_actions to authenticated/);
  assert.match(migration, /grant select on public\.agent_actions to service_role/);
  assert.match(migration, /grant insert\(owner,persona_id,binding_id,action_type,entity_type,entity_id,[\s\S]*outcome,detail\) on public\.agent_actions to service_role/);
  assert.doesNotMatch(migration, /grant\s+(?:select,)?\s*(?:update|delete)[\s\S]*on public\.agent_actions to service_role/i);
  assert.match(migration, /revoke all on public\.agent_action_storage_usage[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration, /grant select on public\.agent_action_storage_usage to authenticated/);

  const insertService = functionBody("insert_agent_action_service");
  const finishService = functionBody("finish_agent_action_service");
  for (const boundary of [insertService, finishService]) {
    assert.match(boundary, /Service role required/);
    assert.match(boundary, /51051101/);
    assert.match(boundary, /51051102/);
  }
  assert.match(insertService, /insert into public\.agent_actions/);
  assert.match(insertService, /set_config\('app\.agent_action_narrow_writer','1',true\)/);
  assert.match(finishService, /update public\.agent_actions/);
  assert.match(migration, /grant execute on function public\.insert_agent_action_service\([\s\S]*public\.finish_agent_action_service\([\s\S]*to service_role/);

  for (const edge of [aiProxy, nativePublish, redditPublish, runTasks, runPublishQueue]) {
    assert.match(edge, /\.rpc\("insert_agent_action_service"/);
    assert.doesNotMatch(edge, /\.from\("agent_actions"\)\s*\.\s*(?:insert|update|upsert|delete)\(/);
  }
  assert.match(aiProxy, /\.rpc\("finish_agent_action_service"/);
  assert.match(runTasks, /\.rpc\("finish_agent_action_service"/);
});

test("scheduled generation uses one exact versioned lifecycle across rolling deploys", () => {
  const reserveGeneration = functionBody("reserve_agent_generation");
  const guard = functionBody("guard_agent_action_storage");
  assert.match(reserveGeneration, /v_action_id uuid:=pg_catalog\.gen_random_uuid\(\)/);
  assert.match(reserveGeneration, /id,owner,persona_id,binding_id,action_type/);
  assert.match(reserveGeneration, /'auditLifecycleVersion',2/);
  assert.match(reserveGeneration, /'auditActionId',v_action_id/);
  assert.match(reserveGeneration, /superseded_stale_generation_attempt/);
  assert.match(guard, /new\.entity_type='ai_task'[\s\S]*new\.entity_id is not null/);
  assert.match(guard, /action\.entity_id=new\.entity_id[\s\S]*auditLifecycleVersion',''\) in \('1','2'\)/);
  assert.match(guard, /not exists\([\s\S]*legacyTerminalBridge[\s\S]*legacyTerminalBridgeAt/);
  assert.match(guard, /update public\.agent_actions action set[\s\S]*return null/);
  assert.match(guard, /51051101[\s\S]*51051102[\s\S]*Direct service insert requires an exact open versioned task terminal/);
  assert.match(reserveGeneration, /set_config\('app\.agent_action_narrow_writer','1',true\)[\s\S]*insert into public\.agent_actions/);
  assert.match(runTasks, /auditActionId\?: string/);
  assert.match(runTasks, /lifecycleVersion !== 2 \|\| !generationAuditId/);
  assert.match(runTasks, /no provider request was sent\. Apply migration 055 before this worker/);
  assert.match(runTasks, /finishGenerationAudit\([\s\S]*"ai\.call\.completed"/);
  assert.match(runTasks, /finishGenerationAudit\([\s\S]*"ai\.call\.failed"/);
});

test("stale exact starts reconcile to retained unknown-outcome evidence", () => {
  const reconcile = functionBody("reconcile_stale_agent_action_starts_service");
  const insertService = functionBody("insert_agent_action_service");
  assert.match(reconcile, /Service role required/);
  assert.match(reconcile, /p_before>now\(\)-interval '5 minutes'/);
  assert.match(reconcile, /p_limit not between 1 and 100/);
  assert.match(reconcile, /51051101[\s\S]*51051102/);
  assert.match(reconcile, /action_type='ai\.call\.abandoned',outcome='unknown'/);
  assert.match(reconcile, /provider_outcome','unknown'/);
  assert.match(insertService, /created_at<now\(\)-interval '15 minutes'/);
  assert.match(runTasks, /reconcile_stale_agent_action_starts_service/);
});

test("legacy over-limit receipts remain sticky until exact row absence", () => {
  const reconcile = functionBody("reconcile_agent_action_storage_delete");
  const reserve = functionBody("reserve_agent_action_mutation");
  assert.match(migration, /limit 100001/);
  assert.match(migration, /totals\.stored_rows>100000/);
  assert.match(reserve, /v_pending_mutations<0 or v_pending_bytes<0[\s\S]*v_usage\.over_limit[\s\S]*p_terminal_kind<>'consume'/);
  assert.match(reserve, /v_rows>100000 and p_terminal_kind<>'consume'/);
  assert.match(reserve, /v_effective_bytes>67108864 and p_terminal_kind<>'consume'/);
  assert.match(reconcile, /over_limit=usage\.over_limit/);
  assert.match(reconcile, /v_remaining=0[\s\S]*not exists\(select 1 from public\.agent_actions action[\s\S]*action\.owner=old\.owner/);
  assert.match(reconcile, /pending_terminal_mutations=0[\s\S]*pending_terminal_bytes=0[\s\S]*over_limit=false/);
});

test("owner and service erasure cannot be blocked by a full audit log", () => {
  const ownerErase = functionBody("delete_my_agent_data");
  const serviceErase = functionBody("delete_agent_action_data_for_account_service");
  assert.match(ownerErase, /perform public\.require_aal2\(\)/);
  assert.match(ownerErase, /51051101[\s\S]*51051056[\s\S]*51051102[\s\S]*51051103/);
  assert.match(ownerErase, /set_config\('app\.agent_action_erasure','1',true\)/);
  assert.match(ownerErase, /delete_my_agent_data_legacy_011/);
  assert.match(ownerErase, /delete from public\.agent_action_storage_usage/);
  assert.match(serviceErase, /Service role required/);
  assert.match(serviceErase, /51051101[\s\S]*51051102[\s\S]*51051103/);
  assert.match(serviceErase, /delete from public\.agent_destinations[\s\S]*delete from public\.agent_actions[\s\S]*delete from public\.agent_action_storage_usage/);
  assert.match(deletion, /admin\.rpc\("delete_agent_action_data_for_account_service"/);
  assert.doesNotMatch(deletion, /admin\.from\("agent_actions"\)\.delete\(\)\.eq\("owner", uid\)/);
});

test("retained usage receipt is owner-exported but never restored", () => {
  const exportLoader = html.match(/async function loadGovernanceExportSections[\s\S]*?\r?\n}\r?\nasync function loadFanSessionRows/)?.[0] || "";
  const xlsx = html.match(/async function downloadDataXlsx\(\)[\s\S]*?\nfunction restoreFromFile/)?.[0] || "";
  const restore = html.match(/async function restoreImport\(data\)[\s\S]*?\n}\nfunction/)?.[0] || "";
  assert.match(exportLoader, /\["agent_action_storage_usage","\*","updated_at"\]/);
  assert.match(xlsx, /add\("Agent Audit Usage",g\.agent_action_storage_usage\)/);
  assert.doesNotMatch(restore, /agent_action_storage_usage/);
});
