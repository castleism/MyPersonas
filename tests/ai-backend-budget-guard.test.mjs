import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const [sql, proxy, runner, erasure] = await Promise.all([
  read("MyPersonas.Online_v0/sql-updates/057-ai-backend-budget-guard.sql"),
  read("supabase/functions/ai-proxy/index.ts"),
  read("supabase/functions/agent-board-run/index.ts"),
  read("supabase/functions/delete-account/index.ts"),
]);
const functionBody = (name) => sql.match(
  new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`, "i"),
)?.[0] || "";

test("automated modes default deny and enabled policies require explicit ceilings", () => {
  const claim = functionBody("claim_ai_backend_budget");
  assert.match(claim, /v_mode in\('agent_board','automation'\)[\s\S]*budget_policy_missing/);
  assert.match(sql, /not enabled or \([\s\S]*daily_request_limit>0[\s\S]*monthly_request_limit>=daily_request_limit[\s\S]*daily_token_limit>0[\s\S]*monthly_token_limit>=daily_token_limit/);
  assert.match(sql, /daily_request_limit between 0 and 1000000/);
  assert.match(sql, /monthly_token_limit between 0 and 30000000000000/);
  assert.match(claim, /budget_daily_request_limit/);
  assert.match(claim, /budget_monthly_request_limit/);
  assert.match(claim, /budget_daily_token_limit/);
  assert.match(claim, /budget_monthly_token_limit/);
});

test("manual modes preserve the existing default until an explicit policy exists", () => {
  const claim = functionBody("claim_ai_backend_budget");
  assert.match(claim, /absent manual policy preserves the existing[\s\S]*return query select true,null::uuid,null::text,null::timestamptz/i);
  assert.match(claim, /if not v_policy\.enabled then[\s\S]*budget_policy_disabled/);
});

test("policy UI is owner AAL2-only and budget tables have no direct DML surface", () => {
  assert.match(functionBody("save_ai_backend_budget_policy"), /perform public\.require_aal2\(\)/);
  assert.match(functionBody("my_ai_backend_budget_policies"), /perform public\.require_aal2\(\)/);
  assert.match(sql, /revoke all on public\.ai_backend_budget_policies,[\s\S]*public\.ai_backend_budget_usage,[\s\S]*public\.ai_backend_budget_leases[\s\S]*from public,anon,authenticated,service_role/);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|all) on public\.ai_backend_budget_/i);
});

test("service claim is atomic, concurrent, expiring, and durable across deletion attempts", () => {
  const claim = functionBody("claim_ai_backend_budget");
  const guard = functionBody("guard_ai_backend_budget_delete");
  assert.match(claim, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(claim, /perform public\.lock_ai_backend_budget\(p_owner,p_backend_id\)/);
  assert.match(claim, /status='expired',finalized_at=now\(\),outcome_code='lease_expired'/);
  assert.match(claim, /lease\.owner=p_owner and lease\.backend_id=p_backend_id[\s\S]*lease\.mode=v_mode and lease\.status='active'/);
  assert.match(claim, /v_active>=v_policy\.max_concurrent_leases/);
  assert.match(claim, /insert into public\.ai_backend_budget_usage[\s\S]*on conflict\(owner,backend_id,mode,window_kind,window_start\) do nothing/);
  assert.match(claim, /request_count=usage\.request_count\+1,[\s\S]*reserved_tokens=usage\.reserved_tokens\+p_reserved_tokens/);
  assert.match(guard, /window_kind='month'[\s\S]*AI backend has current budget usage and cannot be deleted/);
  assert.match(sql, /create trigger guard_ai_backend_budget_delete/);
});

test("finalization is service-only, exactly once, and keeps unknown usage reserved", () => {
  const finalize = functionBody("finalize_ai_backend_budget");
  assert.match(finalize, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(finalize, /v_lease\.status<>'active' then return false/);
  assert.match(finalize, /if p_provider_usage_reported then[\s\S]*reserved_tokens=usage\.reserved_tokens-v_lease\.reserved_tokens[\s\S]*actual_tokens=usage\.actual_tokens\+p_actual_tokens/);
  assert.match(finalize, /if v_rows<>2 then[\s\S]*Budget usage reservation is unavailable/);
  assert.match(finalize, /where id=p_lease_id and status='active'/);
});

test("retention and account erasure are bounded service-only operations", () => {
  const purge = functionBody("purge_ai_backend_budget_retention");
  const erase = functionBody("delete_ai_backend_budget_data_for_account_service");
  assert.match(purge, /least\(greatest\(coalesce\(p_limit,1000\),1\),5000\)/);
  assert.match(purge, /interval '90 days'/);
  assert.match(purge, /interval '62 days'/);
  assert.match(purge, /interval '400 days'/);
  assert.match(erase, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(erase, /order by backend_id[\s\S]*51051161/);
  assert.match(erasure, /delete_ai_backend_budget_data_for_account_service/);
  assert.ok(
    erasure.indexOf("delete_ai_backend_budget_data_for_account_service") <
      erasure.indexOf('admin.from("ai_backends").delete()'),
  );
});

test("proxy and board runner use the database guard without a spoofable header", () => {
  assert.match(proxy, /modeValue !== "agent_board"/);
  assert.match(proxy, /mode !== "agent_board" \|\| !constantTimeEqual\(jwt, SERVICE_ROLE_KEY\)/);
  assert.match(proxy, /allowedKeys = new Set\(\["action", "mode", "runId", "capability"\]\)/);
  assert.match(proxy, /consume_agent_board_run_capability_service/);
  assert.match(proxy, /serverSystemPrompt = approvedInput\.systemPrompt/);
  assert.match(proxy, /p_credential_revision: approvedInput\?\.credentialRevision/);
  assert.match(proxy, /admin\.rpc\("claim_ai_backend_budget"/);
  assert.match(proxy, /p_owner: owner,[\s\S]*p_backend_id: backendRow\.id,[\s\S]*p_mode: mode/);
  assert.match(proxy, /admin\.rpc\("finalize_ai_backend_budget"/);
  assert.match(proxy, /providerTokenUsage\(providerPayload\)/);
  assert.match(proxy, /budgetFinalizationStarted/);
  assert.match(proxy, /"cancelled",\s*0,\s*"agent_board_provider_start_unavailable"/);
  assert.match(proxy, /let providerStartRecorded = false;[\s\S]*let fetchIssued = false;/);
  assert.match(proxy, /providerStartRecorded = true;[\s\S]*fetchIssued = true;[\s\S]*fetch\(endpoint\.url/);
  assert.match(proxy, /preFetchFailure \? 0 : null/);
  assert.match(proxy, /if \(providerTimeout !== undefined\) clearTimeout\(providerTimeout\)/);
  assert.doesNotMatch(proxy, /x-mypersonas-ai-mode/i);
  assert.match(runner, /Authorization: `Bearer \$\{SERVICE_ROLE_KEY\}`/);
  assert.match(runner, /mode: "agent_board"/);
  assert.doesNotMatch(runner, /mode: "owner_chat"/);
});

test("capability explanation is server-prompted, context-free, and charged as owner chat", () => {
  assert.doesNotMatch(proxy, /\| "capability_explain"/);
  assert.match(proxy, /purpose === "capability_explain"/);
  assert.match(proxy, /mode !== "owner_chat" \|\| requestedPersonaId \|\| attachedSummaries\.length/);
  assert.match(proxy, /sanitized\.messages\.length !== 1 \|\| sanitized\.messages\[0\]\?\.role !== "user"/);
  assert.match(proxy, /allowedKeys = new Set\(\[[\s\S]*"purpose"[\s\S]*"messages"[\s\S]*"max_tokens"/);
  assert.match(proxy, /serverSystemPrompt = capabilityExplainSystemPrompt\(\)/);
  assert.match(proxy, /The application-supplied statuses in the user message are authoritative/);
  assert.ok(
    proxy.indexOf('purpose === "capability_explain"') <
      proxy.indexOf("serverSystemPrompt = await ownerHqSystemPrompt(owner)"),
  );
  assert.match(proxy, /p_mode: mode/);
});
