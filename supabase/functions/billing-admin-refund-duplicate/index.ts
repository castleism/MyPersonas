// AAL2 global-administrator approval and execution for a canonically proven
// paid duplicate subscription. The browser supplies only an opaque internal
// remediation UUID and a human reason. Every Stripe identifier and the exact
// tax-inclusive net amount are resolved server-side and refetched before the
// original charge is refunded with a stable idempotency key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import {
  assertCanonicalChargeForDuplicateRefundRecovery,
  assertCanonicalDuplicateRefund,
  assertCanonicalDuplicateRefundList,
  assertCanonicalInvoice,
  assertCanonicalInvoicePaymentListForRefund,
  assertCanonicalPaymentIntentForRefund,
  assertCanonicalRefundableCharge,
  assertCanonicalSubscription,
  assertRefundablePaidInvoice,
  assertServerPlan,
  BillingConfigurationError,
  canonicalPlanCode,
  corsHeaders,
  duplicateRefundApproval,
  duplicateRefundRequest,
  duplicateRefundServiceCandidate,
  jsonResponse,
  loadBillingRefundConfig,
  PublicBillingError,
  readJsonObject,
  requireBillingOrigin,
  requireVerifiedBillingUser,
  stripeApiJson,
  StripeBoundaryError,
} from "../_shared/billing.ts";

class BillingDatabaseError extends Error {}
class ManualRefundReviewError extends Error {}

type RpcClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

async function serverPlan(
  admin: RpcClient,
  config: ReturnType<typeof loadBillingRefundConfig>,
  planCode: string,
) {
  const plan = config.plans.get(planCode);
  if (!plan) throw new StripeBoundaryError(false);
  const result = await admin.rpc("billing_plan_for_service", {
    p_plan_code: plan.code,
  });
  if (result.error) throw new BillingDatabaseError();
  assertServerPlan(result.data, plan);
  return plan;
}

async function recordRefund(
  admin: RpcClient,
  candidate: ReturnType<typeof duplicateRefundServiceCandidate>,
  chargeId: string,
  paymentIntentId: string,
  refund: ReturnType<typeof assertCanonicalDuplicateRefund>,
) {
  const result = await admin.rpc("billing_record_duplicate_refund_result", {
    p_remediation_id: candidate.remediationId,
    p_account_id: candidate.accountId,
    p_customer_id: candidate.customerId,
    p_subscription_id: candidate.subscriptionId,
    p_invoice_id: candidate.invoiceId,
    p_charge_id: chargeId,
    p_payment_intent_id: paymentIntentId,
    p_refund_id: refund.id,
    p_amount: candidate.amount,
    p_currency: candidate.currency,
    p_status: refund.status,
  });
  if (result.error || result.data !== true) throw new BillingDatabaseError();
}

async function markManualReview(
  admin: RpcClient,
  remediationId: string,
  detailCode: string,
) {
  const result = await admin.rpc(
    "billing_mark_duplicate_refund_review_required",
    { p_remediation_id: remediationId, p_detail_code: detailCode },
  );
  if (result.error || result.data !== true) throw new BillingDatabaseError();
}

Deno.serve(async (req: Request) => {
  let config;
  try {
    config = loadBillingRefundConfig((name) => Deno.env.get(name));
  } catch {
    return jsonResponse(503, { error: "Billing is temporarily unavailable" });
  }

  const requestOrigin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") {
    return requestOrigin === config.appOrigin
      ? new Response(null, {
        status: 204,
        headers: corsHeaders(config.appOrigin),
      })
      : jsonResponse(403, { error: "Origin not allowed" });
  }
  if (req.method !== "POST") {
    return jsonResponse(
      405,
      { error: "POST only" },
      requestOrigin === config.appOrigin ? config.appOrigin : "",
      { "Allow": "POST, OPTIONS" },
    );
  }

  let origin = "";
  let admin: RpcClient | null = null;
  let remediationId = "";
  try {
    origin = requireBillingOrigin(req, config.appOrigin);
    const service = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    admin = service;
    const assurance = await requireAal2(req, service);
    if (!assurance.ok) {
      throw new PublicBillingError(assurance.status, assurance.error);
    }
    const user = await requireVerifiedBillingUser(req, service);
    if (user.id !== assurance.user.id) {
      throw new PublicBillingError(401, "Sign in again");
    }
    const approval = duplicateRefundApproval(await readJsonObject(req));
    remediationId = approval.remediationId;

    // This client still uses the project key for routing, but PostgREST receives
    // the caller's validated AAL2 JWT. The approval RPC therefore evaluates
    // auth.uid(), aal and global-administrator membership as the human actor.
    const actor = createClient(config.supabaseUrl, config.serviceRoleKey, {
      global: { headers: { Authorization: `Bearer ${assurance.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const approved = await actor.rpc("billing_admin_approve_duplicate_refund", {
      p_remediation_id: approval.remediationId,
      p_reason: approval.reason,
    });
    if (approved.error || typeof approved.data !== "string") {
      throw new BillingDatabaseError();
    }

    const candidateResult = await service.rpc(
      "billing_duplicate_refund_candidate_for_service",
      { p_remediation_id: approval.remediationId },
    );
    if (candidateResult.error) throw new BillingDatabaseError();
    const candidate = duplicateRefundServiceCandidate(candidateResult.data);
    if (candidate.state === "provider_refunded") {
      return jsonResponse(200, {
        state: "refunded",
        amount: candidate.amount,
        currency: candidate.currency,
      }, origin);
    }

    const subscriptionRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/subscriptions/${encodeURIComponent(candidate.subscriptionId)}`,
    );
    const plan = await serverPlan(
      service,
      config,
      canonicalPlanCode(subscriptionRaw),
    );
    const subscription = assertCanonicalSubscription(
      subscriptionRaw,
      candidate.subscriptionId,
      plan,
      candidate.accountId,
      candidate.customerId,
    );
    if (
      subscription.status !== "canceled" || subscription.canceledAt === null ||
      subscription.latestInvoiceId !== candidate.invoiceId
    ) throw new StripeBoundaryError(false);

    const invoiceRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/invoices/${encodeURIComponent(candidate.invoiceId)}`,
    );
    const invoice = assertCanonicalInvoice(
      invoiceRaw,
      candidate.invoiceId,
      candidate.subscriptionId,
      candidate.customerId,
    );
    assertRefundablePaidInvoice(
      invoice,
      candidate.amount,
      candidate.currency,
    );

    const paymentQuery = new URLSearchParams({
      invoice: candidate.invoiceId,
      status: "paid",
      limit: "2",
    });
    const paymentsRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/invoice_payments?${paymentQuery.toString()}`,
    );
    const payment = assertCanonicalInvoicePaymentListForRefund(
      paymentsRaw,
      candidate.invoiceId,
      candidate.amount,
      candidate.currency,
    );
    const paymentIntentRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/payment_intents/${encodeURIComponent(payment.paymentIntentId)}`,
    );
    const paymentIntent = assertCanonicalPaymentIntentForRefund(
      paymentIntentRaw,
      payment.paymentIntentId,
      candidate.customerId,
      candidate.amount,
      candidate.currency,
    );
    if (
      candidate.chargeId !== null &&
      (candidate.chargeId !== paymentIntent.chargeId ||
        candidate.paymentIntentId !== paymentIntent.id)
    ) throw new StripeBoundaryError(false);

    const bound = await service.rpc("billing_bind_duplicate_refund_charge", {
      p_remediation_id: candidate.remediationId,
      p_account_id: candidate.accountId,
      p_customer_id: candidate.customerId,
      p_subscription_id: candidate.subscriptionId,
      p_invoice_id: candidate.invoiceId,
      p_charge_id: paymentIntent.chargeId,
      p_payment_intent_id: paymentIntent.id,
      p_amount: candidate.amount,
      p_currency: candidate.currency,
    });
    if (bound.error || bound.data !== true) throw new BillingDatabaseError();

    const refundQuery = new URLSearchParams({
      charge: paymentIntent.chargeId,
      limit: "2",
    });
    const refundPath = `/v1/refunds?${refundQuery.toString()}`;
    let refundsRaw = await stripeApiJson(config.stripeSecretKey, refundPath);
    let refund = assertCanonicalDuplicateRefundList(
      refundsRaw,
      candidate.remediationId,
      paymentIntent.chargeId,
      paymentIntent.id,
      candidate.amount,
      candidate.currency,
    );
    if (
      candidate.refundId !== null &&
      (refund?.id !== candidate.refundId ||
        refund.status !== candidate.refundStatus)
    ) throw new StripeBoundaryError(false);

    let chargeRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/charges/${encodeURIComponent(paymentIntent.chargeId)}`,
    );
    if (refund) {
      assertCanonicalChargeForDuplicateRefundRecovery(
        chargeRaw,
        candidate.customerId,
        candidate.amount,
        candidate.currency,
        refund,
      );
    } else {
      assertCanonicalRefundableCharge(
        chargeRaw,
        paymentIntent.chargeId,
        paymentIntent.id,
        candidate.customerId,
        candidate.amount,
        candidate.currency,
      );
      const request = duplicateRefundRequest(
        candidate.remediationId,
        paymentIntent.chargeId,
        candidate.amount,
      );
      try {
        const refundRaw = await stripeApiJson(
          config.stripeSecretKey,
          "/v1/refunds",
          { method: "POST", ...request },
        );
        refund = assertCanonicalDuplicateRefund(
          refundRaw,
          candidate.remediationId,
          paymentIntent.chargeId,
          paymentIntent.id,
          candidate.amount,
          candidate.currency,
        );
      } catch (error) {
        if (!(error instanceof StripeBoundaryError) || !error.retryable) {
          throw error;
        }
        // A timed-out POST can still have succeeded. Recover by the canonical
        // charge plus opaque metadata instead of issuing a second logical refund.
        refundsRaw = await stripeApiJson(config.stripeSecretKey, refundPath);
        refund = assertCanonicalDuplicateRefundList(
          refundsRaw,
          candidate.remediationId,
          paymentIntent.chargeId,
          paymentIntent.id,
          candidate.amount,
          candidate.currency,
        );
        if (!refund) throw error;
        chargeRaw = await stripeApiJson(
          config.stripeSecretKey,
          `/v1/charges/${encodeURIComponent(paymentIntent.chargeId)}`,
        );
        assertCanonicalChargeForDuplicateRefundRecovery(
          chargeRaw,
          candidate.customerId,
          candidate.amount,
          candidate.currency,
          refund,
        );
      }
    }
    if (!refund) throw new StripeBoundaryError(true);
    await recordRefund(
      service,
      candidate,
      paymentIntent.chargeId,
      paymentIntent.id,
      refund,
    );
    if (refund.status === "failed" || refund.status === "canceled") {
      throw new ManualRefundReviewError();
    }
    return jsonResponse(refund.status === "succeeded" ? 200 : 202, {
      state: refund.status === "succeeded" ? "refunded" : "provider_pending",
      amount: candidate.amount,
      currency: candidate.currency,
    }, origin);
  } catch (error) {
    if (
      remediationId && admin && error instanceof StripeBoundaryError &&
      !error.retryable
    ) {
      try {
        await markManualReview(
          admin,
          remediationId,
          "canonical_provider_evidence_mismatch",
        );
      } catch {
        return jsonResponse(503, {
          error: "Billing is temporarily unavailable",
        }, origin);
      }
      return jsonResponse(409, {
        error: "Refund requires manual review",
      }, origin);
    }
    if (error instanceof ManualRefundReviewError) {
      return jsonResponse(409, {
        error: "Refund requires manual review",
      }, origin);
    }
    if (error instanceof PublicBillingError) {
      return jsonResponse(error.status, { error: error.message }, origin);
    }
    if (error instanceof StripeBoundaryError) {
      return jsonResponse(503, {
        error: "Billing provider is temporarily unavailable",
      }, origin);
    }
    if (error instanceof BillingConfigurationError) {
      return jsonResponse(503, {
        error: "Billing is temporarily unavailable",
      }, origin);
    }
    return jsonResponse(503, {
      error: "Billing is temporarily unavailable",
    }, origin);
  }
});
