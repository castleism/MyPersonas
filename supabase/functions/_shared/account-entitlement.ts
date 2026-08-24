// Server-side account entitlement check shared by AI/provider boundaries.
// The database is authoritative. Any verification failure is fail-closed and
// distinct from a verified inactive membership so callers can return 503 vs 402.

export type BillingRpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: null | { message?: string } }>;
};

export type AccountEntitlementResult =
  | { allowed: true; unavailable: false }
  | { allowed: false; unavailable: false }
  | { allowed: false; unavailable: true };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function accountBillingAccess(
  client: BillingRpcClient,
  accountId: string,
): Promise<AccountEntitlementResult> {
  if (!UUID_RE.test(accountId)) return { allowed: false, unavailable: true };
  try {
    const result = await client.rpc("account_has_billing_access", {
      p_account_id: accountId,
    });
    if (result.error || typeof result.data !== "boolean") {
      return { allowed: false, unavailable: true };
    }
    return result.data
      ? { allowed: true, unavailable: false }
      : { allowed: false, unavailable: false };
  } catch {
    return { allowed: false, unavailable: true };
  }
}

export function billingAccessHttpStatus(
  result: AccountEntitlementResult,
): 402 | 503 {
  return result.unavailable ? 503 : 402;
}
export function billingAccessMessage(result: AccountEntitlementResult): string {
  return result.unavailable
    ? "Membership verification is unavailable; no provider request was sent"
    : "An active MyPersonas membership or developer grant is required";
}
