// Service-only, read-only Stripe reconciliation probe.
//
// This endpoint deliberately does not synthesize webhook events or mutate
// billing state. It retrieves bounded database candidates, verifies their exact
// test-mode Stripe bindings, and compares the complete stored scalar snapshot
// to the current canonical Stripe subscription and invoice. It records only a
// bounded operational result/alert and never mutates money or entitlement state.
// A later SQL contract can add an explicit, idempotent repair RPC.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  assertCanonicalInvoice,
  assertCanonicalSubscription,
  assertServerPlan,
  BillingConfigurationError,
  canonicalPlanCode,
  jsonResponse,
  loadBillingReconcileConfig,
  reconciliationCandidates,
  reconciliationMatches,
  reconciliationPath,
  stripeApiJson,
  StripeBoundaryError,
  timingSafeEqualText,
} from "../_shared/billing.ts";

const RECONCILIATION_LIMIT = 5;

class BillingDatabaseError extends Error {}

async function recordReconciliation(
  admin: {
    rpc: (
      name: string,
      args?: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  candidate: ReturnType<typeof reconciliationCandidates>[number],
  result: "current" | "drifted" | "unavailable",
  detailCode: string,
) {
  const recorded = await admin.rpc("billing_record_reconciliation_result", {
    p_account_id: candidate.accountId,
    p_subscription_id: candidate.subscriptionId,
    p_result: result,
    p_detail_code: detailCode,
  });
  if (recorded.error || recorded.data !== true) {
    throw new BillingDatabaseError();
  }
}

Deno.serve(async (req: Request) => {
  let config;
  try {
    config = loadBillingReconcileConfig((name) => Deno.env.get(name));
  } catch {
    return jsonResponse(503, {
      error: "Reconciliation is temporarily unavailable",
    });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" }, "", { "Allow": "POST" });
  }
  const suppliedSecret = req.headers.get("X-Billing-Reconcile-Secret") ?? "";
  if (
    suppliedSecret.length > 512 ||
    !await timingSafeEqualText(suppliedSecret, config.reconcileSecret)
  ) {
    return jsonResponse(401, { error: "Authentication required" });
  }
  const declared = req.headers.get("Content-Length");
  if (
    declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== 0)
  ) {
    return jsonResponse(400, { error: "Request body is not allowed" });
  }
  if (req.body) {
    const reader = req.body.getReader();
    const first = await reader.read();
    if (!first.done) {
      await reader.cancel();
      return jsonResponse(400, { error: "Request body is not allowed" });
    }
  }

  try {
    const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const candidateResult = await admin.rpc(
      "billing_reconciliation_candidates",
      {
        p_limit: RECONCILIATION_LIMIT,
      },
    );
    if (candidateResult.error) throw new BillingDatabaseError();
    const candidates = reconciliationCandidates(
      candidateResult.data,
      RECONCILIATION_LIMIT,
    );
    let current = 0;
    let drifted = 0;
    let unavailable = 0;

    for (const candidate of candidates) {
      try {
        const subscriptionRaw = await stripeApiJson(
          config.stripeSecretKey,
          reconciliationPath(candidate),
        );
        if (canonicalPlanCode(subscriptionRaw) !== candidate.planCode) {
          throw new StripeBoundaryError(false);
        }
        const plan = config.plans.get(candidate.planCode);
        if (!plan || plan.priceId !== candidate.priceId) {
          throw new StripeBoundaryError(false);
        }
        const databasePlan = await admin.rpc("billing_plan_for_service", {
          p_plan_code: plan.code,
        });
        if (databasePlan.error) throw new BillingDatabaseError();
        assertServerPlan(databasePlan.data, plan);
        const subscription = assertCanonicalSubscription(
          subscriptionRaw,
          candidate.subscriptionId,
          plan,
          candidate.accountId,
          candidate.customerId,
        );
        let invoice = null;
        if (subscription.latestInvoiceId) {
          const invoiceRaw = await stripeApiJson(
            config.stripeSecretKey,
            `/v1/invoices/${encodeURIComponent(subscription.latestInvoiceId)}`,
          );
          invoice = assertCanonicalInvoice(
            invoiceRaw,
            subscription.latestInvoiceId,
            subscription.subscriptionId,
            subscription.customerId,
          );
        }
        if (reconciliationMatches(candidate, subscription, invoice)) {
          await recordReconciliation(
            admin,
            candidate,
            "current",
            "canonical_snapshot_match",
          );
          current += 1;
        } else {
          await recordReconciliation(
            admin,
            candidate,
            "drifted",
            "canonical_snapshot_mismatch",
          );
          drifted += 1;
        }
      } catch (error) {
        if (error instanceof BillingDatabaseError) throw error;
        if (error instanceof StripeBoundaryError && error.retryable) {
          await recordReconciliation(
            admin,
            candidate,
            "unavailable",
            "stripe_temporarily_unavailable",
          );
          unavailable += 1;
        } else {
          await recordReconciliation(
            admin,
            candidate,
            "drifted",
            "canonical_verification_failed",
          );
          drifted += 1;
        }
      }
    }

    return jsonResponse(unavailable ? 503 : 200, {
      checked: candidates.length,
      current,
      drifted,
      unavailable,
      mutated: false,
    });
  } catch (error) {
    if (error instanceof BillingConfigurationError) {
      return jsonResponse(503, {
        error: "Reconciliation is temporarily unavailable",
      });
    }
    return jsonResponse(503, {
      error: "Reconciliation is temporarily unavailable",
    });
  }
});
