// Fail-closed billing barrier for mailbox provider work. The entitlement check
// is intentionally performed inside the same helper invocation as the remote
// operation so callers cannot accidentally resolve credentials and check
// membership in separate, race-prone phases.
import {
  accountBillingAccess,
  type AccountEntitlementResult,
  type BillingRpcClient,
} from "./account-entitlement.ts";

export type MailboxProviderBoundaryResult<T> =
  | { allowed: true; unavailable: false; value: T }
  | Extract<AccountEntitlementResult, { allowed: false }>;

export async function runMailboxProviderBoundary<T>(
  client: BillingRpcClient,
  accountId: string,
  membershipRequired: boolean,
  providerOperation: () => Promise<T>,
): Promise<MailboxProviderBoundaryResult<T>> {
  if (membershipRequired) {
    const entitlement = await accountBillingAccess(client, accountId);
    if (!entitlement.allowed) return entitlement;
  }
  return {
    allowed: true,
    unavailable: false,
    value: await providerOperation(),
  };
}
