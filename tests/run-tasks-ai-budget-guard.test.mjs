import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const [runTasks, budget, retention, budgetSql] = await Promise.all([
  read("supabase/functions/run-tasks/index.ts"),
  read("supabase/functions/run-tasks/budget.ts"),
  read("MyPersonas.Online_v0/sql-updates/055-agent-action-retention-hardening.sql"),
  read("MyPersonas.Online_v0/sql-updates/057-ai-backend-budget-guard.sql"),
]);

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 10);
  return source.slice(start, next < 0 ? source.length : next);
}

test("scheduled generation claims an explicit automation budget before fetch", () => {
  assert.match(runTasks, /import \{[\s\S]*runWithAutomationBudget,[\s\S]*\} from "\.\/budget\.ts"/);
  assert.match(runTasks, /buildProviderRequest\([\s\S]*conservativeBudgetReservation\([\s\S]*runWithAutomationBudget\(/);
  assert.match(runTasks, /backendId: backend\.id/);
  assert.match(runTasks, /reservedTokens: budgetReservedTokens/);
  assert.match(runTasks, /requestKey: generationAuditId/);
  assert.match(budget, /"claim_ai_backend_budget"[\s\S]*p_mode: "automation"/);
  assert.match(budget, /const claimArgs = \{[\s\S]*p_request_key: options\.requestKey[\s\S]*attempt < 2[\s\S]*"claim_ai_backend_budget", claimArgs/);
  assert.match(budgetSql, /v_mode in\('agent_board','automation'\)[\s\S]*budget_policy_missing/);
  assert.match(budgetSql, /budget_policy_disabled/);
  assert.match(budgetSql, /budget_daily_(?:request|token)_limit/);
});

test("the provider boundary is reachable only inside the claimed wrapper", () => {
  const call = functionBody(runTasks, "callProvider");
  assert.match(call, /markFetchIssued\(\);[\s\S]*fetch\(endpoint\.url/);
  assert.equal(
    [...runTasks.matchAll(/await callProvider\(/g)].length,
    1,
    "one scheduled provider call site expected",
  );
  assert.match(runTasks, /providerCall: async \(markFetchIssued\) => \{[\s\S]*await callProvider\([\s\S]*markFetchIssued/);
  assert.ok(
    runTasks.indexOf("runWithAutomationBudget({") <
      runTasks.indexOf("await callProvider("),
    "budget wrapper must surround the provider call",
  );
});

test("success, known failure, and ambiguous failure finalize exactly once", () => {
  const providerBoundary = functionBody(runTasks, "callProvider");
  assert.match(budget, /let finalizationStarted = false/);
  assert.match(budget, /if \(finalizationStarted\) return false;[\s\S]*finalizationStarted = true/);
  assert.match(budget, /"finalize_ai_backend_budget"/);
  assert.match(budget, /p_provider_usage_reported: actualTokens !== null/);
  assert.match(budget, /fetchIssued[\s\S]*\? safeActualTokens[\s\S]*: 0/);
  assert.match(budget, /fetchIssued[\s\S]*"provider_request_not_started"/);
  assert.match(runTasks, /providerTokenUsage\(payload\)/);
  assert.match(providerBoundary, /true,[\s\S]*"request_failed",[\s\S]*null,[\s\S]*provider_timeout/);
  assert.match(providerBoundary, /transientStatus,[\s\S]*"provider_error",[\s\S]*actualTokens/);
  assert.match(runTasks, /AutomationBudgetFinalizationError/);
  assert.match(runTasks, /budget_finalize_failed/);
});

test("055 exact lifecycle and 057 lease share one collision-free run key", () => {
  assert.match(retention, /'auditActionId',v_action_id,'auditLifecycleVersion',2/);
  assert.match(runTasks, /lifecycleVersion !== 2 \|\| !generationAuditId/);
  assert.match(runTasks, /requestKey: generationAuditId/);
  assert.ok(
    runTasks.indexOf('admin.rpc("reserve_agent_generation"') <
      runTasks.indexOf("runWithAutomationBudget({"),
    "v2 audit reservation must exist before the budget lease",
  );
  assert.match(runTasks, /"ai\.call\.denied"[\s\S]*"denied"/);
  assert.match(runTasks, /"ai\.call\.completed"[\s\S]*"ok"/);
  assert.match(runTasks, /"ai\.call\.failed"[\s\S]*"error"/);
  assert.match(runTasks, /budget_request_key: generationAuditId/);
});

test("budget denial is terminalized without a provider call", () => {
  assert.match(runTasks, /error instanceof AutomationBudgetClaimError/);
  assert.match(runTasks, /provider_fetch_issued: false/);
  assert.match(runTasks, /AI budget enforcement is unavailable; no provider request was sent/);
  assert.match(runTasks, /requires an enabled owner budget policy; no provider request was sent/);
  assert.match(runTasks, /reached an owner-configured automation budget ceiling; no provider request was sent/);
  assert.match(budget, /if \(claimRow\.allowed !== true\)[\s\S]*AutomationBudgetClaimError/);
  assert.match(budget, /if \(!leaseId\)[\s\S]*budget_claim_unavailable/);
});
