import type { AccountEntitlementResult } from "./account-entitlement.ts";

export type DeniedBillingAccess = Extract<
  AccountEntitlementResult,
  { allowed: false }
>;

export type PublisherBillingDisposition =
  | "defer"
  | "terminal"
  | "reconcile";

// A billing stop is retryable only when verification is unavailable and no
// provider mutation lacks a durable result. Verified inactivity is terminal
// for the scheduled occurrence, while any unrecorded provider mutation must be
// reconciled before another attempt regardless of the billing reason.
export function publisherBillingDisposition(
  entitlement: DeniedBillingAccess,
  hasUnrecordedProviderMutation: boolean,
): PublisherBillingDisposition {
  if (hasUnrecordedProviderMutation) return "reconcile";
  return entitlement.unavailable ? "defer" : "terminal";
}
