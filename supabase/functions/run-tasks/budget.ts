export type BudgetRpcError = {
  code?: string;
  message?: string;
};

export type BudgetRpcResult = {
  data: unknown;
  error: BudgetRpcError | null;
};

export type AutomationBudgetRpc = (
  name: "claim_ai_backend_budget" | "finalize_ai_backend_budget",
  args: Record<string, unknown>,
) => Promise<BudgetRpcResult>;

export type BudgetedProviderResult<T> = {
  value: T;
  actualTokens: number | null;
};

type ProviderFailureMetadata = {
  budgetOutcome?: unknown;
  budgetActualTokens?: unknown;
  budgetOutcomeCode?: unknown;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESERVED_TOKENS = 50_000_000;
const MAX_REPORTED_TOKENS = 1_000_000_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeCode(value: unknown, fallback: string) {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (code || fallback).slice(0, 80);
}

function safeActualTokens(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 0 && value <= MAX_REPORTED_TOKENS
    ? value
    : null;
}

export class AutomationBudgetClaimError extends Error {
  code: string;
  retryable: boolean;

  constructor(code: string) {
    super("Scheduled generation budget authorization was denied.");
    this.name = "AutomationBudgetClaimError";
    this.code = safeCode(code, "budget_claim_unavailable");
    this.retryable = this.code === "budget_claim_unavailable";
  }
}

export class AutomationBudgetFinalizationError extends Error {
  providerIssued: boolean;
  originalError: unknown;

  constructor(providerIssued: boolean, originalError: unknown = null) {
    super("Scheduled generation budget accounting could not be finalized.");
    this.name = "AutomationBudgetFinalizationError";
    this.providerIssued = providerIssued;
    this.originalError = originalError;
  }
}

export async function runWithAutomationBudget<T>(options: {
  rpc: AutomationBudgetRpc;
  owner: string;
  backendId: string;
  reservedTokens: number;
  requestKey: string;
  providerCall: (
    markFetchIssued: () => void,
  ) => Promise<BudgetedProviderResult<T>>;
}): Promise<T> {
  if (
    !Number.isSafeInteger(options.reservedTokens) ||
    options.reservedTokens < 1 ||
    options.reservedTokens > MAX_RESERVED_TOKENS ||
    !UUID_RE.test(options.requestKey)
  ) {
    throw new AutomationBudgetClaimError("budget_claim_unavailable");
  }

  const claimArgs = {
    p_owner: options.owner,
    p_backend_id: options.backendId,
    p_mode: "automation",
    p_reserved_tokens: options.reservedTokens,
    p_request_key: options.requestKey,
  };
  let claim: BudgetRpcResult | null = null;
  // A lost claim response is safe to retry with the exact same per-run key:
  // the RPC returns the existing active lease instead of reserving twice.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      claim = await options.rpc("claim_ai_backend_budget", claimArgs);
    } catch {
      claim = null;
    }
    if (claim && !claim.error) break;
  }
  if (!claim || claim.error) {
    throw new AutomationBudgetClaimError("budget_claim_unavailable");
  }
  const rawClaim = Array.isArray(claim.data) ? claim.data[0] : claim.data;
  const claimRow = asRecord(rawClaim);
  if (claim.error || !rawClaim || typeof rawClaim !== "object") {
    throw new AutomationBudgetClaimError("budget_claim_unavailable");
  }
  if (claimRow.allowed !== true) {
    throw new AutomationBudgetClaimError(
      safeCode(claimRow.denial_code, "budget_policy_denied"),
    );
  }
  const leaseId = typeof claimRow.lease_id === "string" &&
      UUID_RE.test(claimRow.lease_id)
    ? claimRow.lease_id
    : null;
  if (!leaseId) {
    // Automation is default-deny and therefore must always receive an exact
    // lease. A legacy/manual-style allowed-without-lease response is malformed.
    throw new AutomationBudgetClaimError("budget_claim_unavailable");
  }

  let finalizationStarted = false;
  const finalizeOnce = async (
    outcome: "completed" | "provider_error" | "request_failed",
    actualTokens: number | null,
    outcomeCode: string,
  ) => {
    if (finalizationStarted) return false;
    finalizationStarted = true;
    try {
      const finalized = await options.rpc("finalize_ai_backend_budget", {
        p_lease_id: leaseId,
        p_outcome: outcome,
        p_actual_tokens: actualTokens,
        p_provider_usage_reported: actualTokens !== null,
        p_outcome_code: safeCode(outcomeCode, "provider_request_failed"),
      });
      return !finalized.error && finalized.data === true;
    } catch {
      return false;
    }
  };

  let fetchIssued = false;
  let providerResult: BudgetedProviderResult<T>;
  try {
    providerResult = await options.providerCall(() => {
      fetchIssued = true;
    });
  } catch (error) {
    const metadata = asRecord(error) as ProviderFailureMetadata;
    const actualTokens = fetchIssued
      ? safeActualTokens(metadata.budgetActualTokens)
      : 0;
    const requestedOutcome = metadata.budgetOutcome === "provider_error"
      ? "provider_error"
      : "request_failed";
    const finalized = await finalizeOnce(
      fetchIssued ? requestedOutcome : "request_failed",
      actualTokens,
      fetchIssued
        ? safeCode(metadata.budgetOutcomeCode, "provider_request_failed")
        : "provider_request_not_started",
    );
    if (!finalized) {
      throw new AutomationBudgetFinalizationError(fetchIssued, error);
    }
    throw error;
  }

  const finalized = await finalizeOnce(
    "completed",
    safeActualTokens(providerResult.actualTokens),
    "provider_completed",
  );
  if (!finalized) {
    throw new AutomationBudgetFinalizationError(fetchIssued);
  }
  return providerResult.value;
}
