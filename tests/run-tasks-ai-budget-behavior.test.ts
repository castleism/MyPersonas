import {
  AutomationBudgetClaimError,
  AutomationBudgetFinalizationError,
  type AutomationBudgetRpc,
  runWithAutomationBudget,
} from "../supabase/functions/run-tasks/budget.ts";

const OWNER = "05710000-0000-4000-8000-000000000001";
const BACKEND = "05710000-0000-4000-8000-000000000002";
const REQUEST = "05710000-0000-4000-8000-000000000003";
const LEASE = "05710000-0000-4000-8000-000000000004";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function expectReject(
  operation: () => Promise<unknown>,
  check: (error: unknown) => void,
) {
  try {
    await operation();
  } catch (error) {
    check(error);
    return;
  }
  throw new Error("Expected operation to reject");
}

function options(
  rpc: AutomationBudgetRpc,
  providerCall: Parameters<
    typeof runWithAutomationBudget<string>
  >[0]["providerCall"],
) {
  return {
    rpc,
    owner: OWNER,
    backendId: BACKEND,
    reservedTokens: 2_000,
    requestKey: REQUEST,
    providerCall,
  };
}

Deno.test("missing, disabled, and exhausted automation policies never call the provider", async () => {
  for (
    const denialCode of [
      "budget_policy_missing",
      "budget_policy_disabled",
      "budget_daily_token_limit",
    ]
  ) {
    let providerCalls = 0;
    let finalizeCalls = 0;
    const rpc: AutomationBudgetRpc = async (name) => {
      if (name === "finalize_ai_backend_budget") finalizeCalls += 1;
      return {
        data: [{ allowed: false, lease_id: null, denial_code: denialCode }],
        error: null,
      };
    };
    await expectReject(
      () =>
        runWithAutomationBudget(options(rpc, async () => {
          providerCalls += 1;
          return { value: "unsafe", actualTokens: 1 };
        })),
      (error) => {
        assert(
          error instanceof AutomationBudgetClaimError,
          "denial must be a budget claim error",
        );
        assertEquals(error.code, denialCode, "denial code must be preserved");
      },
    );
    assertEquals(providerCalls, 0, `${denialCode} must not call provider`);
    assertEquals(finalizeCalls, 0, `${denialCode} has no lease to finalize`);
  }
});

Deno.test("an ambiguous claim response retries the same run key without double reservation", async () => {
  const claims: Record<string, unknown>[] = [];
  let providerCalls = 0;
  let finalizeCalls = 0;
  const rpc: AutomationBudgetRpc = async (name, args) => {
    if (name === "claim_ai_backend_budget") {
      claims.push(args);
      if (claims.length === 1) throw new Error("response lost");
      return { data: [{ allowed: true, lease_id: LEASE }], error: null };
    }
    finalizeCalls += 1;
    return { data: true, error: null };
  };
  const result = await runWithAutomationBudget(options(rpc, async (issued) => {
    providerCalls += 1;
    issued();
    return { value: "recovered", actualTokens: 9 };
  }));
  assertEquals(result, "recovered", "retry must recover the exact lease");
  assertEquals(claims.length, 2, "one bounded claim retry expected");
  assertEquals(
    claims[0].p_request_key,
    claims[1].p_request_key,
    "claim retry must reuse the per-run request key",
  );
  assertEquals(
    providerCalls,
    1,
    "claim retry must not duplicate the provider call",
  );
  assertEquals(finalizeCalls, 1, "recovered lease must finalize exactly once");
});

Deno.test("known success finalizes the exact lease once with reported usage", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: AutomationBudgetRpc = async (name, args) => {
    calls.push({ name, args });
    return name === "claim_ai_backend_budget"
      ? { data: [{ allowed: true, lease_id: LEASE }], error: null }
      : { data: true, error: null };
  };
  const result = await runWithAutomationBudget(options(rpc, async (issued) => {
    issued();
    return { value: "draft", actualTokens: 37 };
  }));
  assertEquals(result, "draft", "successful result must be returned");
  assertEquals(calls.length, 2, "claim and one finalization expected");
  assertEquals(calls[0].args.p_mode, "automation", "mode must be automation");
  assertEquals(
    calls[0].args.p_request_key,
    REQUEST,
    "request key must be stable",
  );
  assertEquals(calls[1], {
    name: "finalize_ai_backend_budget",
    args: {
      p_lease_id: LEASE,
      p_outcome: "completed",
      p_actual_tokens: 37,
      p_provider_usage_reported: true,
      p_outcome_code: "provider_completed",
    },
  }, "success finalization must be exact");
});

Deno.test("known pre-fetch failure releases the reservation with zero usage", async () => {
  const finalizations: Record<string, unknown>[] = [];
  const rpc: AutomationBudgetRpc = async (name, args) => {
    if (name === "claim_ai_backend_budget") {
      return { data: [{ allowed: true, lease_id: LEASE }], error: null };
    }
    finalizations.push(args);
    return { data: true, error: null };
  };
  const original = new Error("request construction stopped");
  await expectReject(
    () =>
      runWithAutomationBudget(options(rpc, async () => {
        throw original;
      })),
    (error) =>
      assert(error === original, "original pre-fetch error must survive"),
  );
  assertEquals(finalizations, [{
    p_lease_id: LEASE,
    p_outcome: "request_failed",
    p_actual_tokens: 0,
    p_provider_usage_reported: true,
    p_outcome_code: "provider_request_not_started",
  }], "pre-fetch failure must finalize once with known zero usage");
});

Deno.test("possibly issued fetch keeps ambiguous usage reserved", async () => {
  const finalizations: Record<string, unknown>[] = [];
  const rpc: AutomationBudgetRpc = async (name, args) => {
    if (name === "claim_ai_backend_budget") {
      return { data: [{ allowed: true, lease_id: LEASE }], error: null };
    }
    finalizations.push(args);
    return { data: true, error: null };
  };
  const original = Object.assign(new Error("timeout"), {
    budgetOutcome: "request_failed",
    budgetActualTokens: null,
    budgetOutcomeCode: "provider_timeout",
  });
  await expectReject(
    () =>
      runWithAutomationBudget(options(rpc, async (issued) => {
        issued();
        throw original;
      })),
    (error) =>
      assert(error === original, "original ambiguous error must survive"),
  );
  assertEquals(finalizations, [{
    p_lease_id: LEASE,
    p_outcome: "request_failed",
    p_actual_tokens: null,
    p_provider_usage_reported: false,
    p_outcome_code: "provider_timeout",
  }], "possibly issued fetch must retain unknown reservation");
});

Deno.test("known provider error finalizes once with reported usage", async () => {
  const finalizations: Record<string, unknown>[] = [];
  const rpc: AutomationBudgetRpc = async (name, args) => {
    if (name === "claim_ai_backend_budget") {
      return { data: [{ allowed: true, lease_id: LEASE }], error: null };
    }
    finalizations.push(args);
    return { data: true, error: null };
  };
  const original = Object.assign(new Error("HTTP 429"), {
    budgetOutcome: "provider_error",
    budgetActualTokens: 11,
    budgetOutcomeCode: "provider_http_error",
  });
  await expectReject(
    () =>
      runWithAutomationBudget(options(rpc, async (issued) => {
        issued();
        throw original;
      })),
    (error) =>
      assert(error === original, "original provider error must survive"),
  );
  assertEquals(finalizations, [{
    p_lease_id: LEASE,
    p_outcome: "provider_error",
    p_actual_tokens: 11,
    p_provider_usage_reported: true,
    p_outcome_code: "provider_http_error",
  }], "known provider error must replace reservation with actual usage");
});

Deno.test("failed finalization is surfaced and never attempted twice", async () => {
  let finalizeCalls = 0;
  const rpc: AutomationBudgetRpc = async (name) => {
    if (name === "claim_ai_backend_budget") {
      return { data: [{ allowed: true, lease_id: LEASE }], error: null };
    }
    finalizeCalls += 1;
    return { data: false, error: null };
  };
  await expectReject(
    () =>
      runWithAutomationBudget(options(rpc, async (issued) => {
        issued();
        return { value: "withheld", actualTokens: 5 };
      })),
    (error) =>
      assert(
        error instanceof AutomationBudgetFinalizationError &&
          error.providerIssued,
        "failed finalization must be explicit",
      ),
  );
  assertEquals(finalizeCalls, 1, "budget lease must never be finalized twice");
});
