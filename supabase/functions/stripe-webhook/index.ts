// Public Stripe webhook receiver. Gateway JWT verification must remain off.
//
// The signature is verified over the exact raw bytes before JSON parsing. A
// valid supported event is durably recorded first, then current test-mode
// Stripe objects are retrieved and reduced to bounded scalars for idempotent
// database application. Raw provider payloads and secrets are never logged or
// returned.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  assertCanonicalCharge,
  assertCanonicalCheckout,
  assertCanonicalDispute,
  assertCanonicalExpectedRefundedCharge,
  assertCanonicalInvoice,
  assertCanonicalInvoicePaymentList,
  assertCanonicalRefund,
  assertCanonicalSubscription,
  assertServerPlan,
  BillingConfigurationError,
  canonicalInvoiceReferences,
  canonicalPlanCode,
  duplicateSubscriptionCancellation,
  jsonResponse,
  loadBillingWebhookConfig,
  MAX_WEBHOOK_BYTES,
  parseStripeEvent,
  PublicBillingError,
  sha256Hex,
  stripeApiJson,
  StripeBoundaryError,
  stripeTimestampIso,
  verifyStripeSignature,
} from "../_shared/billing.ts";

class BillingDatabaseError extends Error {}

type ServiceRpcClient = {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

async function rawWebhookBody(req: Request): Promise<Uint8Array> {
  const contentType = req.headers.get("Content-Type") ?? "";
  const contentEncoding = (req.headers.get("Content-Encoding") ?? "identity")
    .trim().toLowerCase();
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
    contentEncoding !== "identity"
  ) {
    throw new PublicBillingError(415, "Invalid webhook payload");
  }
  const declared = req.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new PublicBillingError(400, "Invalid webhook payload");
    }
    if (Number(declared) > MAX_WEBHOOK_BYTES) {
      throw new PublicBillingError(413, "Webhook payload is too large");
    }
  }
  if (!req.body) throw new PublicBillingError(400, "Invalid webhook payload");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_BYTES) {
      await reader.cancel();
      throw new PublicBillingError(413, "Webhook payload is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength < 2) {
    throw new PublicBillingError(
      400,
      "Invalid webhook payload",
    );
  }
  return bytes;
}

function decodedUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublicBillingError(400, "Invalid webhook payload");
  }
}

async function serverPlan(
  admin: ServiceRpcClient,
  plans: ReturnType<typeof loadBillingWebhookConfig>["plans"],
  planCode: string,
) {
  const plan = plans.get(planCode);
  if (!plan) throw new StripeBoundaryError(false);
  const result = await admin.rpc("billing_plan_for_service", {
    p_plan_code: plan.code,
  });
  if (result.error) throw new BillingDatabaseError();
  assertServerPlan(result.data, plan);
  return plan;
}

async function canonicalInvoice(
  secretKey: string,
  latestInvoiceId: string | null,
  subscriptionId: string,
  customerId: string,
) {
  if (!latestInvoiceId) return null;
  const raw = await stripeApiJson(
    secretKey,
    `/v1/invoices/${encodeURIComponent(latestInvoiceId)}`,
  );
  return assertCanonicalInvoice(
    raw,
    latestInvoiceId,
    subscriptionId,
    customerId,
  );
}

async function applySubscriptionSnapshot(
  admin: ServiceRpcClient,
  eventId: string,
  subscription: ReturnType<typeof assertCanonicalSubscription>,
  invoice: Awaited<ReturnType<typeof canonicalInvoice>>,
) {
  const applied = await admin.rpc("billing_apply_subscription_event", {
    p_event_id: eventId,
    p_account_id: subscription.accountId,
    p_customer_id: subscription.customerId,
    p_subscription_id: subscription.subscriptionId,
    p_price_id: subscription.priceId,
    p_plan_code: subscription.planCode,
    p_status: subscription.status,
    p_trial_start: stripeTimestampIso(subscription.trialStart),
    p_trial_end: stripeTimestampIso(subscription.trialEnd),
    p_period_start: stripeTimestampIso(subscription.periodStart),
    p_period_end: stripeTimestampIso(subscription.periodEnd),
    p_cancel_at_period_end: subscription.cancelAtPeriodEnd,
    p_cancel_at: stripeTimestampIso(subscription.cancelAt),
    p_canceled_at: stripeTimestampIso(subscription.canceledAt),
    p_invoice_id: invoice?.id ?? null,
    p_invoice_status: invoice?.status ?? null,
    p_invoice_paid: invoice?.paid ?? false,
  });
  if (applied.error || applied.data !== true) throw new BillingDatabaseError();
}

const RENEWABLE_SUBSCRIPTION_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);

async function canonicalSubscriptionWithDuplicateRemediation(
  admin: ServiceRpcClient,
  config: ReturnType<typeof loadBillingWebhookConfig>,
  eventId: string,
  subscription: ReturnType<typeof assertCanonicalSubscription>,
  plan: Parameters<typeof assertCanonicalSubscription>[2],
) {
  const candidate = await admin.rpc(
    "billing_duplicate_subscription_candidate",
    {
      p_event_id: eventId,
      p_account_id: subscription.accountId,
      p_customer_id: subscription.customerId,
      p_subscription_id: subscription.subscriptionId,
      p_subscription_status: subscription.status,
    },
  );
  if (candidate.error || typeof candidate.data !== "boolean") {
    throw new BillingDatabaseError();
  }
  if (!candidate.data) {
    return {
      subscription,
      invoice: await canonicalInvoice(
        config.stripeSecretKey,
        subscription.latestInvoiceId,
        subscription.subscriptionId,
        subscription.customerId,
      ),
    };
  }
  let canceled = subscription;
  if (RENEWABLE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    const cancellation = duplicateSubscriptionCancellation(
      subscription.subscriptionId,
    );
    let canceledRaw;
    try {
      canceledRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/subscriptions/${encodeURIComponent(subscription.subscriptionId)}`,
        { method: "DELETE", ...cancellation },
      );
    } catch (error) {
      if (!(error instanceof StripeBoundaryError) || !error.retryable) {
        throw error;
      }
      canceledRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/subscriptions/${encodeURIComponent(subscription.subscriptionId)}`,
        { method: "DELETE", ...cancellation },
      );
    }
    canceled = assertCanonicalSubscription(
      canceledRaw,
      subscription.subscriptionId,
      plan,
      subscription.accountId,
      subscription.customerId,
    );
  }
  if (canceled.status !== "canceled" || canceled.canceledAt === null) {
    throw new StripeBoundaryError(false);
  }
  const invoice = await canonicalInvoice(
    config.stripeSecretKey,
    canceled.latestInvoiceId,
    canceled.subscriptionId,
    canceled.customerId,
  );
  const recorded = await admin.rpc(
    "billing_record_duplicate_subscription_remediation",
    {
      p_event_id: eventId,
      p_account_id: canceled.accountId,
      p_customer_id: canceled.customerId,
      p_subscription_id: canceled.subscriptionId,
      p_invoice_id: invoice?.id ?? null,
      p_invoice_paid: invoice?.paid ?? false,
      p_invoice_amount: invoice?.paid ? invoice.amountPaid : null,
      p_invoice_currency: invoice?.paid ? invoice.currency : null,
      p_provider_canceled_at: stripeTimestampIso(canceled.canceledAt),
    },
  );
  if (recorded.error || recorded.data !== true) {
    throw new BillingDatabaseError();
  }
  return { subscription: canceled, invoice };
}

async function canonicalFinancialCharge(
  config: ReturnType<typeof loadBillingWebhookConfig>,
  eventType: string,
  objectId: string,
) {
  let providerObjectType: "charge" | "refund" | "dispute";
  let chargeId: string;
  let expectedPaymentIntentId: string | null | undefined;
  let expectedRefund: ReturnType<typeof assertCanonicalRefund> | null = null;
  if (eventType === "charge.refunded") {
    providerObjectType = "charge";
    chargeId = objectId;
  } else if (eventType.startsWith("charge.dispute.")) {
    providerObjectType = "dispute";
    const disputeRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/disputes/${encodeURIComponent(objectId)}`,
    );
    const dispute = assertCanonicalDispute(disputeRaw, objectId);
    chargeId = dispute.chargeId;
    expectedPaymentIntentId = dispute.paymentIntentId;
  } else {
    providerObjectType = "refund";
    const refundRaw = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/refunds/${encodeURIComponent(objectId)}`,
    );
    const refund = assertCanonicalRefund(refundRaw, objectId);
    expectedRefund = refund;
    chargeId = refund.chargeId;
    expectedPaymentIntentId = refund.paymentIntentId;
  }
  const chargeRaw = await stripeApiJson(
    config.stripeSecretKey,
    `/v1/charges/${encodeURIComponent(chargeId)}`,
  );
  const charge = assertCanonicalCharge(
    chargeRaw,
    chargeId,
    expectedPaymentIntentId ?? undefined,
  );
  if (eventType === "charge.refunded") {
    try {
      expectedRefund = assertCanonicalExpectedRefundedCharge(
        chargeRaw,
        chargeId,
      ).refund;
    } catch {
      // A charge.refunded event that is not the one exact, full MyPersonas
      // duplicate refund remains subject to the generic financial hold below.
      expectedRefund = null;
    }
  }
  return {
    charge,
    expectedRefund,
    providerObjectType,
    providerObjectId: objectId,
  };
}

async function canonicalFinancialOwnership(
  admin: ServiceRpcClient,
  config: ReturnType<typeof loadBillingWebhookConfig>,
  financialCharge: Awaited<ReturnType<typeof canonicalFinancialCharge>>,
) {
  const { charge, providerObjectType, providerObjectId } = financialCharge;
  const invoicePaymentQuery = new URLSearchParams({
    "payment[type]": "payment_intent",
    "payment[payment_intent]": charge.paymentIntentId,
    limit: "2",
  });
  const invoicePaymentsRaw = await stripeApiJson(
    config.stripeSecretKey,
    `/v1/invoice_payments?${invoicePaymentQuery.toString()}`,
  );
  const invoiceId = assertCanonicalInvoicePaymentList(
    invoicePaymentsRaw,
    charge.paymentIntentId,
  ).invoiceId;
  const invoiceRaw = await stripeApiJson(
    config.stripeSecretKey,
    `/v1/invoices/${encodeURIComponent(invoiceId)}`,
  );
  const references = canonicalInvoiceReferences(invoiceRaw, invoiceId);
  if (references.customerId !== charge.customerId) {
    throw new StripeBoundaryError(false);
  }
  const subscriptionRaw = await stripeApiJson(
    config.stripeSecretKey,
    `/v1/subscriptions/${encodeURIComponent(references.subscriptionId)}`,
  );
  const plan = await serverPlan(
    admin,
    config.plans,
    canonicalPlanCode(subscriptionRaw),
  );
  const subscription = assertCanonicalSubscription(
    subscriptionRaw,
    references.subscriptionId,
    plan,
    undefined,
    references.customerId,
  );
  assertCanonicalInvoice(
    invoiceRaw,
    invoiceId,
    subscription.subscriptionId,
    subscription.customerId,
  );
  return {
    accountId: subscription.accountId,
    customerId: subscription.customerId,
    subscriptionId: subscription.subscriptionId,
    invoiceId,
    providerObjectType,
    providerObjectId,
  };
}

Deno.serve(async (req: Request) => {
  let config;
  try {
    config = loadBillingWebhookConfig((name) => Deno.env.get(name));
  } catch {
    return jsonResponse(503, { error: "Webhook is temporarily unavailable" });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" }, "", { "Allow": "POST" });
  }

  let durableEventId = "";
  let durableFinancialReviewEvent = false;
  let admin: ServiceRpcClient | null = null;
  try {
    const rawBody = await rawWebhookBody(req);
    const signature = req.headers.get("Stripe-Signature") ?? "";
    if (
      !await verifyStripeSignature(rawBody, signature, config.webhookSecret)
    ) {
      throw new PublicBillingError(400, "Invalid webhook signature");
    }
    const event = parseStripeEvent(decodedUtf8(rawBody));
    if (event.group === "ignored") return jsonResponse(200, { received: true });

    admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as ServiceRpcClient;
    const payloadHash = await sha256Hex(rawBody);
    const recorded = await admin.rpc("billing_record_webhook_event", {
      p_event_id: event.id,
      p_event_type: event.type,
      p_object_id: event.objectId,
      p_event_created_at: stripeTimestampIso(event.created),
      p_payload_sha256: payloadHash,
      p_livemode: false,
    });
    if (recorded.error || typeof recorded.data !== "boolean") {
      throw new BillingDatabaseError();
    }
    durableEventId = event.id;
    durableFinancialReviewEvent = event.group === "review_required";
    if (recorded.data === false) {
      const disposition = await admin.rpc("billing_webhook_event_disposition", {
        p_event_id: event.id,
        p_payload_sha256: payloadHash,
      });
      // Never mutate an event claimed by another worker. A terminal duplicate
      // is safe to acknowledge; active or unverifiable work remains retryable
      // so a crashed owning worker cannot strand a webhook indefinitely.
      durableEventId = "";
      if (
        disposition.error ||
        !["terminal", "active"].includes(String(disposition.data))
      ) {
        throw new BillingDatabaseError();
      }
      return disposition.data === "terminal"
        ? jsonResponse(200, { received: true })
        : jsonResponse(503, { error: "Webhook processing is in progress" });
    }

    if (event.group === "review_required") {
      const financialCharge = await canonicalFinancialCharge(
        config,
        event.type,
        event.objectId,
      );
      let ownership: Awaited<ReturnType<typeof canonicalFinancialOwnership>>;
      try {
        ownership = await canonicalFinancialOwnership(
          admin,
          config,
          financialCharge,
        );
      } catch (error) {
        if (!(error instanceof StripeBoundaryError) || error.retryable) {
          throw error;
        }
        const held = await admin.rpc(
          "billing_apply_customer_financial_hold_event",
          {
            p_event_id: event.id,
            p_customer_id: financialCharge.charge.customerId,
            p_provider_object_type: financialCharge.providerObjectType,
            p_provider_object_id: financialCharge.providerObjectId,
          },
        );
        if (held.error || held.data !== true) throw new BillingDatabaseError();
        return jsonResponse(200, { received: true });
      }
      const expectedRefund = financialCharge.expectedRefund;
      if (
        expectedRefund?.remediationId &&
        expectedRefund.reason === "duplicate"
      ) {
        const expected = await admin.rpc(
          "billing_apply_expected_duplicate_refund_event",
          {
            p_event_id: event.id,
            p_remediation_id: expectedRefund.remediationId,
            p_account_id: ownership.accountId,
            p_customer_id: ownership.customerId,
            p_subscription_id: ownership.subscriptionId,
            p_invoice_id: ownership.invoiceId,
            p_charge_id: financialCharge.charge.id,
            p_payment_intent_id: financialCharge.charge.paymentIntentId,
            p_refund_id: expectedRefund.id,
            p_amount: expectedRefund.amount,
            p_currency: expectedRefund.currency,
            p_status: expectedRefund.status,
            p_reason: expectedRefund.reason,
          },
        );
        if (expected.error) throw new BillingDatabaseError();
        if (expected.data === true) {
          return jsonResponse(200, { received: true });
        }
      }
      const flagged = await admin.rpc("billing_apply_financial_hold_event", {
        p_event_id: event.id,
        p_account_id: ownership.accountId,
        p_customer_id: ownership.customerId,
        p_subscription_id: ownership.subscriptionId,
        p_invoice_id: ownership.invoiceId,
        p_provider_object_type: ownership.providerObjectType,
        p_provider_object_id: ownership.providerObjectId,
      });
      if (flagged.error || flagged.data !== true) {
        throw new BillingDatabaseError();
      }
      // The event and critical operations alert are now durable and terminal.
      // Acknowledge Stripe only after that atomic handoff succeeds.
      return jsonResponse(200, { received: true });
    }

    if (event.group === "checkout") {
      let canonicalTrialStart: string | null = null;
      let canonicalTrialEnd: string | null = null;
      const sessionRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/checkout/sessions/${encodeURIComponent(event.objectId)}`,
      );
      const plan = await serverPlan(
        admin,
        config.plans,
        canonicalPlanCode(sessionRaw),
      );
      let checkout = assertCanonicalCheckout(
        sessionRaw,
        event.objectId,
        plan,
        true,
      );
      if (checkout.status === "expired") {
        if (
          event.type !== "checkout.session.expired" ||
          checkout.subscriptionId !== null
        ) {
          throw new StripeBoundaryError(false);
        }
      } else {
        if (
          checkout.status !== "complete" || !checkout.subscriptionId ||
          event.type === "checkout.session.expired"
        ) {
          throw new StripeBoundaryError(false);
        }
        const subscriptionRaw = await stripeApiJson(
          config.stripeSecretKey,
          `/v1/subscriptions/${encodeURIComponent(checkout.subscriptionId)}`,
        );
        const subscription = assertCanonicalSubscription(
          subscriptionRaw,
          checkout.subscriptionId,
          plan,
          checkout.accountId,
          checkout.customerId,
        );
        canonicalTrialStart = stripeTimestampIso(subscription.trialStart);
        canonicalTrialEnd = stripeTimestampIso(subscription.trialEnd);
        checkout = assertCanonicalCheckout(
          sessionRaw,
          event.objectId,
          plan,
          subscription.trialStart !== null && subscription.trialEnd !== null,
        );
        await canonicalInvoice(
          config.stripeSecretKey,
          subscription.latestInvoiceId,
          subscription.subscriptionId,
          subscription.customerId,
        );
      }
      const applied = await admin.rpc("billing_apply_checkout_event", {
        p_event_id: event.id,
        p_account_id: checkout.accountId,
        p_customer_id: checkout.customerId,
        p_subscription_id: checkout.subscriptionId,
        p_reservation_id: checkout.reservationId,
        p_session_id: checkout.sessionId,
        p_checkout_status: checkout.status,
        p_trial_start: canonicalTrialStart,
        p_trial_end: canonicalTrialEnd,
      });
      if (applied.error || applied.data !== true) {
        throw new BillingDatabaseError();
      }
    } else if (event.group === "subscription") {
      const subscriptionRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/subscriptions/${encodeURIComponent(event.objectId)}`,
      );
      const plan = await serverPlan(
        admin,
        config.plans,
        canonicalPlanCode(subscriptionRaw),
      );
      const subscription = assertCanonicalSubscription(
        subscriptionRaw,
        event.objectId,
        plan,
      );
      const canonical = await canonicalSubscriptionWithDuplicateRemediation(
        admin,
        config,
        event.id,
        subscription,
        plan,
      );
      await applySubscriptionSnapshot(
        admin,
        event.id,
        canonical.subscription,
        canonical.invoice,
      );
    } else {
      const eventInvoiceRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/invoices/${encodeURIComponent(event.objectId)}`,
      );
      const invoiceReferences = canonicalInvoiceReferences(
        eventInvoiceRaw,
        event.objectId,
      );
      const subscriptionRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/subscriptions/${
          encodeURIComponent(invoiceReferences.subscriptionId)
        }`,
      );
      const plan = await serverPlan(
        admin,
        config.plans,
        canonicalPlanCode(subscriptionRaw),
      );
      const subscription = assertCanonicalSubscription(
        subscriptionRaw,
        invoiceReferences.subscriptionId,
        plan,
        undefined,
        invoiceReferences.customerId,
      );
      if (!subscription.latestInvoiceId) throw new StripeBoundaryError(false);
      const canonical = await canonicalSubscriptionWithDuplicateRemediation(
        admin,
        config,
        event.id,
        subscription,
        plan,
      );
      await applySubscriptionSnapshot(
        admin,
        event.id,
        canonical.subscription,
        canonical.invoice,
      );
    }
    return jsonResponse(200, { received: true });
  } catch (error) {
    if (durableEventId && admin) {
      try {
        if (
          durableFinancialReviewEvent && error instanceof StripeBoundaryError &&
          !error.retryable
        ) {
          const flagged = await admin.rpc(
            "billing_mark_webhook_review_required",
            {
              p_event_id: durableEventId,
              p_reason: "financial_event_linkage_unproven",
            },
          );
          if (!flagged.error && flagged.data === true) {
            durableEventId = "";
            return jsonResponse(200, { received: true });
          }
        }
        await admin.rpc("billing_mark_webhook_failed", {
          p_event_id: durableEventId,
          p_error: error instanceof StripeBoundaryError
            ? "canonical_provider_verification_failed"
            : "event_application_failed",
        });
      } catch {
        // Stripe receives a retryable response below; never log identifiers or errors.
      }
    }
    if (error instanceof PublicBillingError) {
      return jsonResponse(error.status, { error: error.message });
    }
    if (error instanceof BillingConfigurationError) {
      return jsonResponse(503, { error: "Webhook is temporarily unavailable" });
    }
    return jsonResponse(503, { error: "Webhook is temporarily unavailable" });
  }
});
