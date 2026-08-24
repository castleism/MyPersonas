import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AutomationBudgetFinalizationError,
  conservativeAutomationBudgetReservation,
  reportedProviderTokens,
  runWithAutomationBudget,
} from "../supabase/functions/run-tasks/budget.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const OWNER = "05710000-0000-4000-8000-000000000001";
const BACKEND = "05710000-0000-4000-8000-000000000002";
const REQUEST = "05710000-0000-4000-8000-000000000003";
const LEASE = "05710000-0000-4000-8000-000000000004";

function budgetOptions(rpc, providerCall) {
  return {
    rpc,
    owner: OWNER,
    backendId: BACKEND,
    reservedTokens: 2_000,
    requestKey: REQUEST,
    providerCall,
  };
}

test("shared automation budget records exact, uncertain, and cancelled outcomes", async () => {
  for (const scenario of [
    {
      error: Object.assign(new Error("membership changed"), {
        budgetOutcome: "cancelled",
        budgetActualTokens: 0,
        budgetOutcomeCode: "billing_required",
      }),
      issued: false,
      expected: ["cancelled", 0, true, "billing_required"],
    },
    {
      error: Object.assign(new Error("network response lost"), {
        budgetOutcome: "request_failed",
        budgetActualTokens: null,
        budgetOutcomeCode: "provider_timeout",
      }),
      issued: true,
      expected: ["request_failed", null, false, "provider_timeout"],
    },
    {
      error: Object.assign(new Error("HTTP 429"), {
        budgetOutcome: "provider_error",
        budgetActualTokens: 17,
        budgetOutcomeCode: "provider_http_error",
      }),
      issued: true,
      expected: ["provider_error", 17, true, "provider_http_error"],
    },
  ]) {
    const finalizations = [];
    const rpc = async (name, args) => {
      if (name === "claim_ai_backend_budget") {
        return { data: [{ allowed: true, lease_id: LEASE }], error: null };
      }
      finalizations.push(args);
      return { data: true, error: null };
    };
    await assert.rejects(
      runWithAutomationBudget(budgetOptions(rpc, async (markIssued) => {
        if (scenario.issued) markIssued();
        throw scenario.error;
      })),
      (error) => error === scenario.error,
    );
    assert.equal(finalizations.length, 1);
    assert.deepEqual([
      finalizations[0].p_outcome,
      finalizations[0].p_actual_tokens,
      finalizations[0].p_provider_usage_reported,
      finalizations[0].p_outcome_code,
    ], scenario.expected);
  }
});

test("provider output is withheld when exact budget finalization fails", async () => {
  let finalizations = 0;
  const rpc = async (name) => {
    if (name === "claim_ai_backend_budget") {
      return { data: [{ allowed: true, lease_id: LEASE }], error: null };
    }
    finalizations += 1;
    return { data: false, error: null };
  };
  await assert.rejects(
    runWithAutomationBudget(budgetOptions(rpc, async (markIssued) => {
      markIssued();
      return { value: "must not escape", actualTokens: 9 };
    })),
    (error) => error instanceof AutomationBudgetFinalizationError &&
      error.providerIssued,
  );
  assert.equal(finalizations, 1);
});

test("shared reservation and provider-usage parsing are conservative", () => {
  const body = JSON.stringify({ messages: [{ content: "snowman ☃" }] });
  assert.ok(
    conservativeAutomationBudgetReservation(body, 500) >= 500 + body.length,
  );
  assert.equal(reportedProviderTokens({ usage: { total_tokens: 31 } }), 31);
  assert.equal(reportedProviderTokens({
    usage: { input_tokens: 11, output_tokens: 7 },
  }), 18);
  assert.equal(reportedProviderTokens({ usage: { input_tokens: 11 } }), null);
});

test("research, fan chat, and mailbox reserve before provider fetch and recheck membership", async () => {
  const [research, fan, mailbox, mailboxWorker, agentBoard] = await Promise.all([
    read("supabase/functions/research-brief-run/index.ts"),
    read("supabase/functions/fan-chat/index.ts"),
    read("supabase/functions/_shared/mailbox.ts"),
    read("supabase/functions/run-mailbox-jobs/index.ts"),
    read("supabase/functions/agent-board-run/index.ts"),
  ]);
  for (const [source, name] of [
    [research, "research"],
    [fan, "fan chat"],
    [mailbox, "mailbox"],
  ]) {
    assert.match(source, /runWithAutomationBudget\(/, `${name} has no budget claim`);
    assert.match(source, /conservativeAutomationBudgetReservation\(/,
      `${name} has no conservative reservation`);
    assert.match(source, /reportedProviderTokens\(/,
      `${name} does not reconcile reported provider usage`);
  }

  const researchRun = research.slice(research.indexOf(
    "const responseText = await runWithAutomationBudget",
  ));
  assert.ok(
    researchRun.indexOf("accountBillingAccess(admin, owner)") <
      researchRun.indexOf("providerText(providerRequest, markFetchIssued)"),
  );
  assert.ok(
    researchRun.indexOf("const persistenceEntitlement") <
      researchRun.indexOf('admin.rpc("save_research_brief"'),
    "research output must be withheld when membership changes",
  );

  const fanRun = fan.slice(fan.indexOf("reply = await runWithAutomationBudget"));
  assert.ok(
    fanRun.indexOf("accountBillingAccess(") <
      fanRun.indexOf("callBackend(providerRequest, markFetchIssued)"),
  );
  const status = fan.slice(
    fan.indexOf('if (action === "status")'),
    fan.indexOf("const sessionId =", fan.indexOf('if (action === "status")')),
  );
  assert.match(status, /loadEligibility\(personaId, false\)/,
    "public status checks must not resolve a provider credential");
  const fanPersistence = fan.indexOf("const persistenceEntitlement", fan.indexOf(
    "reply = await runWithAutomationBudget",
  ));
  assert.ok(
    fanPersistence >= 0 && fanPersistence < fan.indexOf(
      "const outputSafetyCategories",
      fanPersistence,
    ),
    "fan-chat output must be withheld before reply persistence",
  );

  const classify = mailbox.slice(mailbox.indexOf(
    "export async function mailboxAiClassify",
  ));
  assert.ok(
    classify.indexOf("runWithAutomationBudget({") <
      classify.indexOf("accountBillingAccess(admin, owner)",
        classify.indexOf("runWithAutomationBudget({")) &&
      classify.indexOf("accountBillingAccess(admin, owner)",
        classify.indexOf("runWithAutomationBudget({")) <
      classify.indexOf("markFetchIssued()"),
  );
  assert.match(mailboxWorker, /MailboxAiBudgetFatalError[\s\S]*failScan\(/,
    "mailbox budget reconciliation failures must stop findings persistence");

  const boardPersistence = agentBoard.indexOf(
    "const persistenceEntitlement",
    agentBoard.indexOf("if (!proxyResponse.ok)"),
  );
  assert.ok(
    boardPersistence >= 0 && boardPersistence < agentBoard.indexOf(
      "const resultText",
      boardPersistence,
    ),
    "Agent Board must withhold a provider result when membership changes",
  );
});

test("Agent Board rechecks membership after provider-start recording and before fetch", async () => {
  const proxy = await read("supabase/functions/ai-proxy/index.ts");
  const marker = proxy.indexOf('"mark_agent_board_provider_started_service"');
  const postMarker = proxy.indexOf("const postMarkerEntitlement", marker);
  const fetchIssued = proxy.indexOf("fetchIssued = true", postMarker);
  const providerFetch = proxy.indexOf("const providerResponse = await fetch", postMarker);
  assert.ok(marker >= 0 && postMarker > marker && fetchIssued > postMarker);
  assert.ok(providerFetch > fetchIssued);
  const barrier = proxy.slice(postMarker, fetchIssued);
  assert.match(barrier, /finalizeBudgetOnce\("cancelled", 0, code\)/);
  assert.match(barrier, /provider_fetch_issued: false/);
});
