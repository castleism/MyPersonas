import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertCanonicalCharge,
  assertCanonicalChargeForDuplicateRefundRecovery,
  assertCanonicalCheckout,
  assertCanonicalDispute,
  assertCanonicalDuplicateRefund,
  assertCanonicalDuplicateRefundList,
  assertCanonicalExpectedRefundedCharge,
  assertCanonicalInvoice,
  assertCanonicalInvoicePaymentList,
  assertCanonicalInvoicePaymentListForRefund,
  assertCanonicalPaymentIntentForRefund,
  assertCanonicalPortalConfiguration,
  assertCanonicalRefund,
  assertCanonicalRefundableCharge,
  assertCanonicalStripeCustomer,
  assertCanonicalSubscription,
  assertCheckoutReservationSession,
  assertCheckoutSession,
  assertDeletedStripeCustomer,
  assertPortalSession,
  assertRefundablePaidInvoice,
  assertServerPlan,
  assertStripeCustomer,
  assertStripePrice,
  assertTerminalCustomerSubscriptions,
  billingCustomerCleanupCandidate,
  billingEmailFingerprint,
  billingEmailFingerprints,
  checkoutForm,
  checkoutPlanCode,
  checkoutPreparation,
  checkoutPreparationAction,
  customerEmailUpdateForm,
  customerForm,
  customerIdempotencyKey,
  duplicateRefundApproval,
  duplicateRefundRequest,
  duplicateRefundServiceCandidate,
  duplicateSubscriptionCancellation,
  fixedBillingUrls,
  loadBillingPortalConfig,
  loadBillingRefundConfig,
  loadBillingServiceConfig,
  loadBillingWebhookConfig,
  parseBillingPlans,
  parseStripeEvent,
  portalForm,
  readJsonObject,
  reconciliationCandidates,
  reconciliationMatches,
  STRIPE_API_VERSION,
  stripeApiJson,
  stripeCustomerEmailSyncRequired,
  verifyStripeSignature,
} from "../supabase/functions/_shared/billing.ts";

const root = new URL("../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");

const accountId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";
const customerId = "cus_TestCustomer123";
const subscriptionId = "sub_TestSubscription123";
const checkoutId = "cs_test_TestCheckout123";
const invoiceId = "in_TestInvoice123";
const eventId = "evt_TestEvent123";
const chargeId = "ch_TestCharge123";
const refundId = "re_TestRefund123";
const disputeId = "du_TestDispute123";
const paymentIntentId = "pi_TestPayment123";
const remediationId = "33333333-3333-4333-8333-333333333333";
const eventCreated = Math.floor(Date.now() / 1000) - 60;
const priceId = "price_TestPrice123";
const productId = "prod_TestProduct123";
const reservationExpiresAt = Math.floor(Date.now() / 1000) + 35 * 60;
const reservationExpiresIso = new Date(reservationExpiresAt * 1000)
  .toISOString();
const stripeTestKey = ["sk", "test", "abcdefghijklmnopqrstuvwxyz1234567890"]
  .join("_");
const stripeRestrictedTestKey = [
  "rk",
  "test",
  "abcdefghijklmnopqrstuvwxyz1234567890",
].join("_");
const stripeLiveKey = ["sk", "live", "abcdefghijklmnopqrstuvwxyz1234567890"]
  .join("_");
const webhookSecret = ["whsec", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
const portalConfigurationId = "bpc_TestPortalConfiguration123";

const planJson = JSON.stringify({
  creator_monthly: {
    price_id: priceId,
    product_id: productId,
    amount: 1900,
    currency: "usd",
    interval: "month",
    interval_count: 1,
    trial_days: 7,
  },
});
const plan = parseBillingPlans(planJson).get("creator_monthly");

function env(overrides = {}) {
  const values = {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY:
      "service_role_abcdefghijklmnopqrstuvwxyz1234567890",
    STRIPE_TEST_SECRET_KEY: stripeTestKey,
    STRIPE_TEST_WEBHOOK_SECRET: webhookSecret,
    STRIPE_TEST_PORTAL_CONFIGURATION_ID: portalConfigurationId,
    STRIPE_TEST_PLANS_JSON: planJson,
    BILLING_EMAIL_FINGERPRINT_SECRET:
      "fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
    BILLING_EMAIL_FINGERPRINT_KEY_ID: "k2026_08",
    BILLING_APP_ORIGIN: "https://mypersonas.online",
    BILLING_RECONCILE_SECRET: "reconcile-secret-abcdefghijklmnopqrstuvwxyz",
    ...overrides,
  };
  return (name) => values[name];
}

function serverPlan() {
  return {
    plan_code: plan.code,
    amount_minor: plan.amount,
    currency: plan.currency,
    recurring_interval: plan.interval,
    interval_count: plan.intervalCount,
    stripe_price_id: plan.priceId,
    livemode: false,
  };
}

function stripePrice() {
  return {
    id: priceId,
    object: "price",
    product: productId,
    livemode: false,
    active: true,
    type: "recurring",
    billing_scheme: "per_unit",
    currency: "usd",
    unit_amount: 1900,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    tiers_mode: null,
    transform_quantity: null,
  };
}

function checkoutObject(amount = 1900) {
  return {
    id: checkoutId,
    object: "checkout.session",
    livemode: false,
    mode: "subscription",
    client_reference_id: accountId,
    customer: customerId,
    subscription: subscriptionId,
    status: "complete",
    payment_status: amount === 0 ? "no_payment_required" : "paid",
    currency: "usd",
    amount_total: amount,
    expires_at: 2_000_000_000,
    url: "https://checkout.stripe.com/c/pay/test",
    metadata: {
      account_id: accountId,
      reservation_id: reservationId,
      plan_code: plan.code,
    },
  };
}

function openCheckoutObject(amount = 1900) {
  return {
    ...checkoutObject(amount),
    subscription: null,
    status: "open",
    payment_status: "unpaid",
    expires_at: reservationExpiresAt,
  };
}

function expiredCheckoutObject(amount = 1900) {
  return {
    ...checkoutObject(amount),
    subscription: null,
    status: "expired",
    payment_status: "unpaid",
  };
}

function customerObject(email = "owner@example.com") {
  return {
    object: "customer",
    id: customerId,
    livemode: false,
    deleted: false,
    email,
    metadata: { account_id: accountId },
  };
}

function subscriptionObject(status = "active") {
  return {
    id: subscriptionId,
    object: "subscription",
    livemode: false,
    customer: customerId,
    status,
    metadata: {
      account_id: accountId,
      reservation_id: reservationId,
      plan_code: plan.code,
    },
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    trial_start: status === "trialing" ? 1_900_000_000 : null,
    trial_end: status === "trialing" ? 1_900_604_800 : null,
    latest_invoice: invoiceId,
    items: {
      object: "list",
      has_more: false,
      total_count: 1,
      data: [{
        id: "si_TestItem123",
        object: "subscription_item",
        quantity: 1,
        current_period_start: 1_900_000_000,
        current_period_end: 1_902_592_000,
        price: stripePrice(),
      }],
    },
  };
}

function invoiceObject() {
  return {
    id: invoiceId,
    object: "invoice",
    livemode: false,
    customer: customerId,
    created: 1_900_000_100,
    status: "paid",
    paid: true,
    amount_paid: 1900,
    amount_due: 1900,
    amount_remaining: 0,
    total: 1900,
    currency: "usd",
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: subscriptionId },
    },
  };
}

function chargeObject(refunds = []) {
  return {
    id: chargeId,
    object: "charge",
    livemode: false,
    customer: customerId,
    payment_intent: paymentIntentId,
    amount: 1900,
    amount_captured: 1900,
    amount_refunded: refunds.some((refund) => refund.status === "succeeded")
      ? 1900
      : 0,
    currency: "usd",
    paid: true,
    captured: true,
    refunded: refunds.some((refund) => refund.status === "succeeded"),
    disputed: false,
    failure_code: null,
    failure_message: null,
    refunds: {
      object: "list",
      url: `/v1/charges/${chargeId}/refunds`,
      has_more: false,
      data: refunds,
    },
  };
}

function refundObject() {
  return {
    id: refundId,
    object: "refund",
    livemode: false,
    charge: chargeId,
    payment_intent: paymentIntentId,
    amount: 1900,
    currency: "usd",
    status: "succeeded",
    reason: null,
    metadata: {},
  };
}

function duplicateRefundObject(status = "succeeded") {
  return {
    ...refundObject(),
    status,
    reason: "duplicate",
    metadata: { mypersonas_remediation_id: remediationId },
  };
}

function paymentIntentObject() {
  return {
    id: paymentIntentId,
    object: "payment_intent",
    livemode: false,
    customer: customerId,
    latest_charge: chargeId,
    amount: 1900,
    amount_received: 1900,
    currency: "usd",
    status: "succeeded",
    canceled_at: null,
    cancellation_reason: null,
  };
}

function disputeObject() {
  return {
    id: disputeId,
    object: "dispute",
    livemode: false,
    charge: chargeId,
    payment_intent: paymentIntentId,
  };
}

function invoicePaymentList() {
  return {
    object: "list",
    url: "/v1/invoice_payments",
    has_more: false,
    data: [{
      id: "inpay_TestPayment123",
      object: "invoice_payment",
      livemode: false,
      invoice: invoiceId,
      payment: { type: "payment_intent", payment_intent: paymentIntentId },
      status: "paid",
      is_default: true,
      amount_paid: 1900,
      amount_requested: 1900,
      currency: "usd",
    }],
  };
}

function eventObject(type, object) {
  return {
    id: eventId,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: eventCreated,
    livemode: false,
    data: { object },
    type,
  };
}

test("plan catalog is an exact server-side allowlist", () => {
  assert.equal(plan.amount, 1900);
  assert.equal(plan.trialDays, 7);
  assert.throws(() =>
    parseBillingPlans(JSON.stringify({
      creator_monthly: {
        ...JSON.parse(planJson).creator_monthly,
        price_id: "price_OtherPrice123",
        extra: true,
      },
    }))
  );
  assert.throws(() =>
    parseBillingPlans(JSON.stringify({
      creator_monthly: {
        ...JSON.parse(planJson).creator_monthly,
        trial_days: 14,
      },
    }))
  );
  assert.throws(() =>
    parseBillingPlans(JSON.stringify({
      creator_monthly: JSON.parse(planJson).creator_monthly,
      duplicate_plan: JSON.parse(planJson).creator_monthly,
    }))
  );
});

test("runtime configuration rejects live or malformed Stripe secrets", () => {
  assert.equal(
    loadBillingServiceConfig(env()).appOrigin,
    "https://mypersonas.online",
  );
  assert.equal(
    loadBillingRefundConfig(env({
      BILLING_APP_ORIGIN: "https://mypersonas-staging.pages.dev",
    })).appOrigin,
    "https://mypersonas-staging.pages.dev",
  );
  assert.equal(
    fixedBillingUrls("https://staging.mypersonas.online").portalReturn,
    "https://staging.mypersonas.online/#/studio",
  );
  assert.equal(
    loadBillingServiceConfig(env({
      STRIPE_TEST_SECRET_KEY: stripeRestrictedTestKey,
    })).stripeSecretKey,
    stripeRestrictedTestKey,
  );
  assert.deepEqual(
    loadBillingServiceConfig(env({
      BILLING_EMAIL_FINGERPRINT_PREVIOUS_KEY_ID: "k2026_07",
      BILLING_EMAIL_FINGERPRINT_PREVIOUS_SECRET:
        "previous-fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
      BILLING_EMAIL_FINGERPRINT_RETIRED_KEYS_JSON: JSON.stringify([
        {
          key_id: "k2026_06",
          secret: "retired-fingerprint-secret-one-abcdefghijklmnopqrstuvwxyz",
        },
        {
          key_id: "k2026_05",
          secret: "retired-fingerprint-secret-two-abcdefghijklmnopqrstuvwxyz",
        },
      ]),
    })).emailFingerprintKeys.map((key) => key.keyId),
    ["k2026_08", "k2026_07", "k2026_06", "k2026_05"],
  );
  assert.throws(() =>
    loadBillingServiceConfig(env({
      STRIPE_TEST_SECRET_KEY: stripeLiveKey,
    }))
  );
  assert.throws(() =>
    loadBillingWebhookConfig(env({
      STRIPE_TEST_WEBHOOK_SECRET: "whsec_short",
    }))
  );
  assert.throws(() =>
    loadBillingServiceConfig(env({
      BILLING_APP_ORIGIN: "https://evil.example",
    }))
  );
  assert.throws(() =>
    loadBillingPortalConfig(env({
      STRIPE_TEST_PORTAL_CONFIGURATION_ID: "",
    }))
  );
  assert.throws(() =>
    loadBillingPortalConfig(env({
      STRIPE_TEST_PORTAL_CONFIGURATION_ID: "bpc_short",
    }))
  );
  assert.throws(() =>
    loadBillingRefundConfig(env({
      BILLING_APP_ORIGIN: "http://localhost:3000",
    }))
  );
  assert.throws(() =>
    loadBillingRefundConfig(env({
      BILLING_APP_ORIGIN: "https://anything.pages.dev",
    }))
  );
  assert.throws(() =>
    loadBillingRefundConfig(env({
      BILLING_APP_ORIGIN: "https://mypersonas-staging.pages.dev?production=1",
    }))
  );
  assert.throws(() =>
    loadBillingServiceConfig(env({
      BILLING_EMAIL_FINGERPRINT_PREVIOUS_KEY_ID: "k2026_07",
    }))
  );
  assert.throws(() =>
    loadBillingServiceConfig(env({
      BILLING_EMAIL_FINGERPRINT_PREVIOUS_KEY_ID: "k2026_08",
      BILLING_EMAIL_FINGERPRINT_PREVIOUS_SECRET:
        "different-fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
    }))
  );
  assert.throws(() =>
    loadBillingServiceConfig(env({
      BILLING_EMAIL_FINGERPRINT_RETIRED_KEYS_JSON: JSON.stringify([{
        key_id: "k2026_08",
        secret: "retired-fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
      }]),
    }))
  );
  assert.throws(() =>
    loadBillingServiceConfig(env({
      BILLING_EMAIL_FINGERPRINT_RETIRED_KEYS_JSON: "not-json",
    }))
  );
});

test("checkout accepts only the existing frontend internal planCode field", () => {
  assert.equal(
    checkoutPlanCode({ planCode: "creator_monthly" }),
    "creator_monthly",
  );
  assert.throws(() => checkoutPlanCode({ plan_code: "creator_monthly" }));
  assert.throws(() =>
    checkoutPlanCode({ planCode: "creator_monthly", price_id: priceId })
  );
  assert.throws(() => checkoutPlanCode({ planCode: priceId }));
});

test("browser JSON intake cancels an oversized streamed body before parsing", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://mypersonas.online/functions/v1/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  });
  await assert.rejects(readJsonObject(request, 4096));
  assert.equal(cancelled, true);
});

test("return URLs are fixed to the studio route and supported query values", () => {
  assert.deepEqual(fixedBillingUrls("https://mypersonas.online"), {
    checkoutSuccess: "https://mypersonas.online/?billing=success#/studio",
    checkoutCancel: "https://mypersonas.online/?billing=cancel#/studio",
    portalReturn: "https://mypersonas.online/#/studio",
  });
});

test("portal sessions bind the reviewed test configuration and return route", () => {
  const config = loadBillingPortalConfig(env());
  assert.equal(config.portalConfigurationId, portalConfigurationId);
  assert.deepEqual(
    Object.fromEntries(
      portalForm(
        customerId,
        config.appOrigin,
        config.portalConfigurationId,
      ),
    ),
    {
      customer: customerId,
      configuration: portalConfigurationId,
      return_url: "https://mypersonas.online/#/studio",
    },
  );
  assert.throws(() => portalForm(customerId, config.appOrigin, "bpc_short"));

  const canonicalConfiguration = {
    object: "billing_portal.configuration",
    id: portalConfigurationId,
    livemode: false,
    active: true,
    login_page: { enabled: false },
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ["name", "address"],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
      },
      subscription_update: { enabled: false },
    },
  };
  assert.deepEqual(
    assertCanonicalPortalConfiguration(
      canonicalConfiguration,
      portalConfigurationId,
    ),
    { id: portalConfigurationId },
  );

  for (
    const mutate of [
      (copy) => copy.login_page.enabled = true,
      (copy) =>
        copy.features.subscription_cancel.proration_behavior =
          "create_prorations",
      (copy) =>
        copy.features.customer_update.allowed_updates = ["name", "phone"],
      (copy) => copy.features.subscription_pause = { enabled: true },
      (copy) => copy.features.subscription_update.enabled = true,
    ]
  ) {
    const drifted = structuredClone(canonicalConfiguration);
    mutate(drifted);
    assert.throws(
      () => assertCanonicalPortalConfiguration(drifted, portalConfigurationId),
      /Billing provider request failed/,
    );
  }

  const returnUrl = "https://mypersonas.online/#/studio";
  const canonicalSession = {
    object: "billing_portal.session",
    id: "bps_TestSession123",
    livemode: false,
    customer: customerId,
    configuration: portalConfigurationId,
    return_url: returnUrl,
    url: "https://billing.stripe.com/p/session/test_12345678",
  };
  assert.deepEqual(
    assertPortalSession(
      canonicalSession,
      customerId,
      portalConfigurationId,
      returnUrl,
    ),
    { id: canonicalSession.id, url: canonicalSession.url },
  );
  for (
    const mutate of [
      (copy) => copy.customer = "cus_OtherCustomer123",
      (copy) => copy.configuration = "bpc_OtherConfiguration123",
      (copy) => copy.return_url = "https://example.com/",
      (copy) => copy.livemode = true,
    ]
  ) {
    const mismatched = structuredClone(canonicalSession);
    mutate(mismatched);
    assert.throws(
      () =>
        assertPortalSession(
          mismatched,
          customerId,
          portalConfigurationId,
          returnUrl,
        ),
      /Billing provider request failed/,
    );
  }
});

test("email fingerprint is canonical-email-only without Gmail or Unicode rewriting", async () => {
  const secret = "fingerprint-secret-abcdefghijklmnopqrstuvwxyz";
  assert.equal(
    await billingEmailFingerprint(secret, " Owner+trial@Example.com "),
    await billingEmailFingerprint(secret, "owner+trial@example.com"),
  );
  assert.notEqual(
    await billingEmailFingerprint(secret, "owner+trial@example.com"),
    await billingEmailFingerprint(secret, "owner@example.com"),
  );
  assert.notEqual(
    await billingEmailFingerprint(secret, "first.last@example.com"),
    await billingEmailFingerprint(secret, "firstlast@example.com"),
  );
  assert.notEqual(
    await billingEmailFingerprint(secret, "\u00e9@example.com"),
    await billingEmailFingerprint(secret, "e\u0301@example.com"),
  );
});

test("email fingerprint rotation emits the complete ordered retained key ring", async () => {
  const keys = [
    {
      keyId: "k2026_08",
      secret: "current-fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
    },
    {
      keyId: "k2026_07",
      secret: "previous-fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
    },
    {
      keyId: "k2026_06",
      secret: "retired-fingerprint-secret-abcdefghijklmnopqrstuvwxyz",
    },
  ];
  const fingerprints = await billingEmailFingerprints(
    keys,
    " Owner@Example.com ",
  );
  assert.deepEqual(fingerprints.map((value) => value.keyId), [
    "k2026_08",
    "k2026_07",
    "k2026_06",
  ]);
  assert.notEqual(fingerprints[0].digest, fingerprints[1].digest);
  assert.equal(
    fingerprints[0].digest,
    await billingEmailFingerprint(keys[0].secret, "owner@example.com"),
  );
  await assert.rejects(() =>
    billingEmailFingerprints([keys[0], keys[0]], "owner@example.com")
  );
});

test("customer cleanup accepts only exact deleted Customer and terminal subscription inventory", () => {
  assert.deepEqual(
    billingCustomerCleanupCandidate({
      required: true,
      stripe_customer_id: customerId,
    }),
    { required: true, customerId },
  );
  assert.deepEqual(
    billingCustomerCleanupCandidate({
      required: false,
      stripe_customer_id: null,
    }),
    { required: false, customerId: null },
  );
  assert.equal(
    assertDeletedStripeCustomer({
      object: "customer",
      id: customerId,
      deleted: true,
    }, customerId).deleted,
    true,
  );
  const terminal = {
    object: "list",
    has_more: false,
    data: [{
      object: "subscription",
      id: subscriptionId,
      customer: customerId,
      status: "canceled",
      metadata: { account_id: accountId },
    }],
  };
  assert.equal(
    assertTerminalCustomerSubscriptions(terminal, customerId, accountId)
      .length,
    1,
  );
  assert.throws(() =>
    assertTerminalCustomerSubscriptions(
      {
        ...terminal,
        data: [{ ...terminal.data[0], status: "active" }],
      },
      customerId,
      accountId,
    )
  );
  assert.throws(() =>
    assertTerminalCustomerSubscriptions(
      { ...terminal, has_more: true },
      customerId,
      accountId,
    )
  );
});

test("duplicate cancellation is immediate, non-prorating, and idempotent", () => {
  const cancellation = duplicateSubscriptionCancellation(subscriptionId);
  assert.equal(cancellation.form.get("invoice_now"), "false");
  assert.equal(cancellation.form.get("prorate"), "false");
  assert.equal(
    cancellation.idempotencyKey,
    `mypersonas-duplicate-cancel:${subscriptionId}`,
  );
});

test("database plan and Stripe Price must exactly match the environment plan", () => {
  assert.equal(assertServerPlan([serverPlan()], plan), plan);
  assert.equal(assertStripePrice(stripePrice(), plan).id, priceId);
  for (
    const mutation of [
      { amount_minor: 1901 },
      { currency: "cad" },
      { recurring_interval: "year" },
      { interval_count: 2 },
      { stripe_price_id: "price_OtherPrice123" },
      { livemode: true },
    ]
  ) {
    assert.throws(() =>
      assertServerPlan([{ ...serverPlan(), ...mutation }], plan)
    );
  }
  for (
    const mutation of [
      { unit_amount: 1901 },
      { currency: "cad" },
      { product: "prod_OtherProduct123" },
      { livemode: true },
      { active: false },
    ]
  ) {
    assert.throws(() =>
      assertStripePrice({ ...stripePrice(), ...mutation }, plan)
    );
  }
  assert.throws(() =>
    assertStripePrice({
      ...stripePrice(),
      recurring: { ...stripePrice().recurring, interval: "year" },
    }, plan)
  );
});

test("Stripe requests pin test credentials, API version, form encoding, and idempotency", async () => {
  let captured;
  const result = await stripeApiJson(
    stripeTestKey,
    "/v1/checkout/sessions",
    {
      method: "POST",
      form: new URLSearchParams({ mode: "subscription" }),
      idempotencyKey:
        "mypersonas-checkout:22222222-2222-4222-8222-222222222222",
      fetchImpl: async (input, init) => {
        captured = { input: String(input), init };
        return new Response(JSON.stringify({ object: "test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
  assert.equal(result.object, "test");
  assert.equal(captured.input, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(captured.init.headers["Stripe-Version"], STRIPE_API_VERSION);
  assert.equal(
    captured.init.headers.Authorization,
    `Bearer ${stripeTestKey}`,
  );
  assert.equal(
    captured.init.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    captured.init.headers["Idempotency-Key"],
    "mypersonas-checkout:22222222-2222-4222-8222-222222222222",
  );
  assert.equal(String(captured.init.body), "mode=subscription");
});

test("Stripe boundary supports idempotent DELETE with bounded form parameters", async () => {
  let captured;
  const cancellation = duplicateSubscriptionCancellation(subscriptionId);
  await stripeApiJson(
    stripeTestKey,
    `/v1/subscriptions/${subscriptionId}`,
    {
      method: "DELETE",
      ...cancellation,
      fetchImpl: async (input, init) => {
        captured = { input: String(input), init };
        return new Response(JSON.stringify({ object: "subscription" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
  assert.equal(captured.init.method, "DELETE");
  assert.equal(String(captured.init.body), "invoice_now=false&prorate=false");
  assert.equal(
    captured.init.headers["Idempotency-Key"],
    cancellation.idempotencyKey,
  );
});

test("flat checkout reservation contract is exact and customer ids stay server-side", () => {
  const preparation = checkoutPreparation({
    reservation_id: reservationId,
    trial_eligible: true,
    stripe_customer_id: customerId,
    reservation_status: "reserved",
    stripe_checkout_session_id: null,
    lease_acquired: true,
    reservation_expires_at: reservationExpiresIso,
    ...serverPlan(),
  }, plan);
  assert.deepEqual(preparation, {
    reservationId,
    trialEligible: true,
    customerId,
    reservationStatus: "reserved",
    sessionId: null,
    leaseAcquired: true,
    expiresAt: reservationExpiresAt,
  });
  assert.throws(() =>
    checkoutPreparation({
      reservation_id: reservationId,
      trial_eligible: true,
      stripe_customer_id: "cus_bad",
      reservation_status: "reserved",
      stripe_checkout_session_id: null,
      lease_acquired: true,
      reservation_expires_at: reservationExpiresIso,
      ...serverPlan(),
    }, plan)
  );
});

test("concurrent Checkout callers and a lost attach select one safe action", () => {
  const base = {
    reservation_id: reservationId,
    trial_eligible: true,
    stripe_customer_id: customerId,
    stripe_checkout_session_id: null,
    reservation_status: "reserved",
    reservation_expires_at: reservationExpiresIso,
    ...serverPlan(),
  };
  const leaseOwner = checkoutPreparation(
    { ...base, lease_acquired: true },
    plan,
  );
  const concurrentCaller = checkoutPreparation({
    ...base,
    lease_acquired: false,
  }, plan);
  assert.deepEqual(
    [leaseOwner, concurrentCaller].map(checkoutPreparationAction),
    ["create", "busy"],
  );
  const afterLostAttachResponse = checkoutPreparation({
    ...base,
    reservation_status: "session_created",
    stripe_checkout_session_id: checkoutId,
    lease_acquired: false,
  }, plan);
  assert.equal(checkoutPreparationAction(afterLostAttachResponse), "reuse");
  const providerPendingRecovery = checkoutPreparation({
    ...base,
    reservation_status: "provider_pending",
    lease_acquired: true,
  }, plan);
  assert.equal(checkoutPreparationAction(providerPendingRecovery), "create");
  assert.equal(
    checkoutPreparationAction(checkoutPreparation({
      ...base,
      reservation_status: "provider_pending",
      lease_acquired: false,
    }, plan)),
    "busy",
  );
  assert.throws(() =>
    checkoutPreparation({
      ...base,
      reservation_status: "session_created",
      stripe_checkout_session_id: checkoutId,
      lease_acquired: true,
    }, plan)
  );
});

test("checkout form fixes payment, consent, price, metadata, and redirects server-side", () => {
  const prepared = {
    reservationId,
    trialEligible: true,
    customerId,
    reservationStatus: "reserved",
    sessionId: null,
    leaseAcquired: true,
    expiresAt: reservationExpiresAt,
  };
  const form = checkoutForm(
    accountId,
    customerId,
    prepared,
    plan,
    "https://mypersonas.online",
    reservationExpiresAt,
  );
  assert.equal(form.get("line_items[0][price]"), priceId);
  assert.equal(form.get("payment_method_collection"), "always");
  assert.equal(form.get("payment_method_types[0]"), "card");
  assert.equal(form.get("consent_collection[terms_of_service]"), "required");
  assert.equal(form.get("subscription_data[trial_period_days]"), "7");
  assert.equal(form.get("customer"), customerId);
  assert.equal(form.get("customer_email"), null);
  assert.equal(form.get("automatic_tax[enabled]"), null);
  assert.equal(
    form.get("success_url"),
    "https://mypersonas.online/?billing=success#/studio",
  );
  assert.equal(
    form.get("cancel_url"),
    "https://mypersonas.online/?billing=cancel#/studio",
  );

  const existing = checkoutForm(
    accountId,
    customerId,
    { ...prepared, trialEligible: false },
    plan,
    "https://mypersonas.online",
    reservationExpiresAt,
  );
  assert.equal(existing.get("customer"), customerId);
  assert.equal(existing.get("customer_email"), null);
  assert.equal(existing.get("subscription_data[trial_period_days]"), null);
});

test("canonical Customer creation is account-bound and stably idempotent", () => {
  assert.equal(
    customerIdempotencyKey(accountId),
    `mypersonas-customer:${accountId}`,
  );
  const form = customerForm(accountId);
  assert.equal(form.get("email"), null);
  assert.equal(form.get("metadata[account_id]"), accountId);
  assert.equal(
    assertCanonicalStripeCustomer(
      customerObject(),
      null,
      "owner@example.com",
      accountId,
    ).id,
    customerId,
  );
  assert.throws(() =>
    assertCanonicalStripeCustomer(
      { ...customerObject(), metadata: { account_id: reservationId } },
      customerId,
      "owner@example.com",
      accountId,
    )
  );
});

test("an immutable account binding can safely recover after a verified email change", () => {
  const oldCustomer = customerObject("old@example.com");
  assert.equal(
    stripeCustomerEmailSyncRequired(oldCustomer, customerId, "new@example.com"),
    true,
  );
  assert.equal(
    customerEmailUpdateForm(" New@Example.com ").get("email"),
    "new@example.com",
  );
  assert.throws(() =>
    assertStripeCustomer(oldCustomer, customerId, "new@example.com")
  );
  const updated = { ...oldCustomer, email: "new@example.com" };
  assert.equal(
    stripeCustomerEmailSyncRequired(updated, customerId, "new@example.com"),
    false,
  );
  assert.equal(
    assertStripeCustomer(updated, customerId, "new@example.com").id,
    customerId,
  );
  assert.throws(() =>
    stripeCustomerEmailSyncRequired(
      { ...oldCustomer, id: "cus_Other123" },
      customerId,
      "new@example.com",
    )
  );
});

test("zero-value Checkout is accepted only for a server-verified trial", () => {
  assert.equal(
    assertCheckoutSession(
      openCheckoutObject(1900),
      accountId,
      reservationId,
      customerId,
      plan,
      reservationExpiresAt,
      false,
    ).id,
    checkoutId,
  );
  assert.equal(
    assertCheckoutSession(
      openCheckoutObject(0),
      accountId,
      reservationId,
      customerId,
      plan,
      reservationExpiresAt,
      true,
    ).id,
    checkoutId,
  );
  assert.throws(() =>
    assertCheckoutSession(
      openCheckoutObject(0),
      accountId,
      reservationId,
      customerId,
      plan,
      reservationExpiresAt,
      false,
    )
  );
  assert.throws(() =>
    assertCheckoutSession(
      checkoutObject(1900),
      accountId,
      reservationId,
      customerId,
      plan,
      2_000_000_000,
      false,
    )
  );
  assert.throws(() =>
    assertCanonicalCheckout(checkoutObject(0), checkoutId, plan, false)
  );
  assert.equal(
    assertCanonicalCheckout(checkoutObject(0), checkoutId, plan, true)
      .sessionId,
    checkoutId,
  );
  assert.equal(
    assertCanonicalCheckout(expiredCheckoutObject(0), checkoutId, plan, true)
      .subscriptionId,
    null,
  );
  assert.equal(
    assertCheckoutReservationSession(
      { ...openCheckoutObject(0), status: "expired" },
      accountId,
      reservationId,
      customerId,
      plan,
      reservationExpiresAt,
      true,
    ).status,
    "expired",
  );
});

test("canonical subscription and invoice reduce to owner-bound scalar state", () => {
  const subscription = assertCanonicalSubscription(
    subscriptionObject(),
    subscriptionId,
    plan,
    accountId,
    customerId,
  );
  assert.equal(subscription.priceId, priceId);
  assert.equal(subscription.periodEnd, 1_902_592_000);
  assert.equal(subscription.latestInvoiceId, invoiceId);
  const canceledWithTrial = assertCanonicalSubscription(
    {
      ...subscriptionObject("canceled"),
      trial_start: 1_900_000_000,
      trial_end: 1_900_604_800,
    },
    subscriptionId,
    plan,
    accountId,
    customerId,
  );
  assert.equal(canceledWithTrial.status, "canceled");
  assert.equal(canceledWithTrial.trialStart, 1_900_000_000);
  assert.equal(canceledWithTrial.trialEnd, 1_900_604_800);
  assert.throws(() =>
    assertCanonicalSubscription(
      { ...subscriptionObject("canceled"), trial_start: 1_900_000_000 },
      subscriptionId,
      plan,
      accountId,
      customerId,
    )
  );
  assert.throws(() =>
    assertCanonicalSubscription(
      {
        ...subscriptionObject("canceled"),
        trial_start: 1_900_000_000,
        trial_end: 1_900_604_799,
      },
      subscriptionId,
      plan,
      accountId,
      customerId,
    )
  );
  assert.deepEqual(
    assertCanonicalInvoice(
      invoiceObject(),
      invoiceId,
      subscriptionId,
      customerId,
    ),
    {
      id: invoiceId,
      status: "paid",
      paid: true,
      created: 1_900_000_100,
      amountPaid: 1900,
      amountDue: 1900,
      amountRemaining: 0,
      total: 1900,
      currency: "usd",
    },
  );
  assert.throws(() =>
    assertCanonicalSubscription(
      { ...subscriptionObject(), customer: "cus_OtherCustomer123" },
      subscriptionId,
      plan,
      accountId,
      customerId,
    )
  );
  assert.throws(() =>
    assertCanonicalInvoice(
      { ...invoiceObject(), customer: "cus_OtherCustomer123" },
      invoiceId,
      subscriptionId,
      customerId,
    )
  );
});

test("refund and dispute ownership is derived only from refetched canonical objects", () => {
  assert.deepEqual(assertCanonicalCharge(chargeObject(), chargeId), {
    id: chargeId,
    customerId,
    paymentIntentId,
  });
  assert.deepEqual(assertCanonicalRefund(refundObject(), refundId), {
    id: refundId,
    chargeId,
    paymentIntentId,
    amount: 1900,
    currency: "usd",
    status: "succeeded",
    reason: null,
    remediationId: null,
  });
  assert.deepEqual(assertCanonicalDispute(disputeObject(), disputeId), {
    id: disputeId,
    chargeId,
    paymentIntentId,
  });
  assert.deepEqual(
    assertCanonicalInvoicePaymentList(invoicePaymentList(), paymentIntentId),
    { id: "inpay_TestPayment123", invoiceId },
  );
  assert.throws(() =>
    assertCanonicalCharge(
      { ...chargeObject(), customer: "cus_bad" },
      chargeId,
    )
  );
  assert.throws(() =>
    assertCanonicalRefund({ ...refundObject(), charge: "ch_bad" }, refundId)
  );
  assert.throws(() =>
    assertCanonicalDispute({ ...disputeObject(), livemode: true }, disputeId)
  );
  assert.throws(() =>
    assertCanonicalInvoicePaymentList({
      ...invoicePaymentList(),
      data: [
        ...invoicePaymentList().data,
        { ...invoicePaymentList().data[0], id: "inpay_OtherPayment123" },
      ],
    }, paymentIntentId)
  );
});

test("duplicate refund approval is exact, durable, and canonically recoverable", () => {
  assert.deepEqual(
    duplicateRefundApproval({
      remediationId,
      reason: "Confirmed accidental duplicate membership charge.",
    }),
    {
      remediationId,
      reason: "Confirmed accidental duplicate membership charge.",
    },
  );
  assert.throws(() =>
    duplicateRefundApproval({
      remediationId,
      reason: "too short",
      amount: 1900,
    })
  );
  const request = duplicateRefundRequest(remediationId, chargeId, 1900);
  assert.equal(
    request.idempotencyKey,
    `mypersonas-duplicate-refund:${remediationId}`,
  );
  assert.deepEqual([...request.form.entries()], [
    ["charge", chargeId],
    ["amount", "1900"],
    ["reason", "duplicate"],
    ["metadata[mypersonas_remediation_id]", remediationId],
  ]);
  const candidate = duplicateRefundServiceCandidate({
    remediation_id: remediationId,
    account_id: accountId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_invoice_id: invoiceId,
    state: "refund_pending",
    refund_amount: 1900,
    refund_currency: "usd",
    stripe_charge_id: null,
    stripe_payment_intent_id: null,
    stripe_refund_id: null,
    refund_status: null,
  });
  assert.equal(candidate.amount, 1900);
  assert.equal(candidate.chargeId, null);
  assert.throws(() =>
    duplicateRefundServiceCandidate({
      remediation_id: remediationId,
      account_id: accountId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      stripe_invoice_id: invoiceId,
      state: "refund_pending",
      refund_amount: 1900,
      refund_currency: "usd",
      stripe_charge_id: chargeId,
      stripe_payment_intent_id: null,
      stripe_refund_id: null,
      refund_status: null,
    })
  );

  const invoice = assertCanonicalInvoice(
    invoiceObject(),
    invoiceId,
    subscriptionId,
    customerId,
  );
  assert.equal(assertRefundablePaidInvoice(invoice, 1900, "usd"), invoice);
  assert.throws(() => assertRefundablePaidInvoice(invoice, 1800, "usd"));
  const payment = assertCanonicalInvoicePaymentListForRefund(
    invoicePaymentList(),
    invoiceId,
    1900,
    "usd",
  );
  assert.equal(payment.paymentIntentId, paymentIntentId);
  assert.throws(() =>
    assertCanonicalInvoicePaymentListForRefund(
      {
        ...invoicePaymentList(),
        data: [
          ...invoicePaymentList().data,
          {
            ...invoicePaymentList().data[0],
            id: "inpay_OtherPayment123",
          },
        ],
      },
      invoiceId,
      1900,
      "usd",
    )
  );
  const paymentIntent = assertCanonicalPaymentIntentForRefund(
    paymentIntentObject(),
    paymentIntentId,
    customerId,
    1900,
    "usd",
  );
  assert.equal(paymentIntent.chargeId, chargeId);
  assertCanonicalRefundableCharge(
    chargeObject(),
    chargeId,
    paymentIntentId,
    customerId,
    1900,
    "usd",
  );
  assert.throws(() =>
    assertCanonicalRefundableCharge(
      { ...chargeObject(), disputed: true },
      chargeId,
      paymentIntentId,
      customerId,
      1900,
      "usd",
    )
  );

  const refund = assertCanonicalDuplicateRefund(
    duplicateRefundObject(),
    remediationId,
    chargeId,
    paymentIntentId,
    1900,
    "usd",
  );
  assert.equal(refund.remediationId, remediationId);
  assert.equal(
    assertCanonicalDuplicateRefundList(
      {
        object: "list",
        url: "/v1/refunds",
        has_more: false,
        data: [duplicateRefundObject()],
      },
      remediationId,
      chargeId,
      paymentIntentId,
      1900,
      "usd",
    )?.id,
    refundId,
  );
  assertCanonicalChargeForDuplicateRefundRecovery(
    chargeObject([duplicateRefundObject()]),
    customerId,
    1900,
    "usd",
    refund,
  );
  assert.deepEqual(
    assertCanonicalExpectedRefundedCharge(
      chargeObject([duplicateRefundObject()]),
      chargeId,
    ).refund,
    refund,
  );
  assert.throws(() =>
    assertCanonicalDuplicateRefund(
      { ...duplicateRefundObject(), amount: 1899 },
      remediationId,
      chargeId,
      paymentIntentId,
      1900,
      "usd",
    )
  );
});

test("Stripe signature verification uses exact raw bytes and a five-minute window", async () => {
  const secret = webhookSecret;
  const raw = new TextEncoder().encode('{\n  "id": "evt_TestEvent123"\n}');
  const timestamp = 1_900_000_000;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, signed))
    .toString("hex");
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(
    await verifyStripeSignature(raw, header, secret, timestamp * 1000),
    true,
  );
  assert.equal(
    await verifyStripeSignature(
      new TextEncoder().encode("{}"),
      header,
      secret,
      timestamp * 1000,
    ),
    false,
  );
  assert.equal(
    await verifyStripeSignature(raw, header, secret, (timestamp + 301) * 1000),
    false,
  );
});

test("webhook event classification covers checkout, subscription, renewal invoices, and review gates", () => {
  assert.equal(
    parseStripeEvent(
      JSON.stringify(
        eventObject("checkout.session.completed", checkoutObject()),
      ),
    ).group,
    "checkout",
  );
  assert.equal(
    parseStripeEvent(JSON.stringify(eventObject(
      "checkout.session.expired",
      expiredCheckoutObject(),
    ))).group,
    "checkout",
  );
  assert.equal(
    parseStripeEvent(JSON.stringify(eventObject(
      "customer.subscription.updated",
      subscriptionObject(),
    ))).group,
    "subscription",
  );
  for (
    const type of [
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.payment_action_required",
      "invoice.finalization_failed",
    ]
  ) {
    assert.equal(
      parseStripeEvent(JSON.stringify(eventObject(type, invoiceObject())))
        .group,
      "invoice",
    );
  }
  assert.equal(
    parseStripeEvent(
      JSON.stringify(eventObject("charge.refunded", chargeObject())),
    )
      .group,
    "review_required",
  );
  assert.equal(
    parseStripeEvent(
      JSON.stringify(eventObject("refund.created", refundObject())),
    )
      .objectId,
    refundId,
  );
  assert.equal(
    parseStripeEvent(JSON.stringify(eventObject(
      "charge.dispute.updated",
      disputeObject(),
    ))).objectId,
    disputeId,
  );
  assert.throws(() =>
    parseStripeEvent(
      JSON.stringify(eventObject("refund.created", chargeObject())),
    )
  );
  assert.equal(
    parseStripeEvent(JSON.stringify(eventObject("customer.created", {
      id: customerId,
      object: "customer",
      livemode: false,
    }))).group,
    "ignored",
  );
  assert.throws(() =>
    parseStripeEvent(JSON.stringify({
      ...eventObject("customer.subscription.updated", subscriptionObject()),
      livemode: true,
    }))
  );
  assert.throws(() =>
    parseStripeEvent(JSON.stringify({
      ...eventObject("customer.subscription.updated", subscriptionObject()),
      api_version: "2025-06-30.basil",
    }))
  );
});

test("reconciliation compares the full database snapshot to canonical Stripe state", () => {
  const subscription = assertCanonicalSubscription(
    subscriptionObject(),
    subscriptionId,
    plan,
    accountId,
    customerId,
  );
  const invoice = assertCanonicalInvoice(
    invoiceObject(),
    invoiceId,
    subscriptionId,
    customerId,
  );
  const rows = reconciliationCandidates([{
    account_id: accountId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: priceId,
    plan_code: plan.code,
    subscription_status: "active",
    trial_start: null,
    trial_end: null,
    current_period_start: new Date(1_900_000_000 * 1000).toISOString(),
    current_period_end: new Date(1_902_592_000 * 1000).toISOString(),
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    latest_invoice_id: invoiceId,
    latest_invoice_status: "paid",
    latest_invoice_paid: true,
    livemode: false,
    last_event_created_at: "2026-01-17T17:46:40.000Z",
  }], 5);
  assert.equal(rows[0].accountId, accountId);
  assert.equal(rows[0].customerId, customerId);
  assert.equal(rows[0].subscriptionId, subscriptionId);
  assert.equal(reconciliationMatches(rows[0], subscription, invoice), true);
  assert.equal(
    reconciliationMatches(
      { ...rows[0], status: "past_due" },
      subscription,
      invoice,
    ),
    false,
  );
  assert.equal(
    reconciliationMatches(
      { ...rows[0], invoicePaid: false },
      subscription,
      invoice,
    ),
    false,
  );
  assert.throws(() =>
    reconciliationCandidates([{
      ...{
        account_id: accountId,
        stripe_subscription_id: subscriptionId,
        stripe_price_id: priceId,
        plan_code: plan.code,
        subscription_status: "active",
        trial_start: null,
        trial_end: null,
        current_period_start: new Date(1_900_000_000 * 1000).toISOString(),
        current_period_end: new Date(1_902_592_000 * 1000).toISOString(),
        cancel_at_period_end: false,
        cancel_at: null,
        canceled_at: null,
        latest_invoice_id: invoiceId,
        latest_invoice_status: "paid",
        latest_invoice_paid: true,
        livemode: false,
        last_event_created_at: "2026-01-17T17:46:40.000Z",
      },
      stripe_customer_id: "cus_bad",
    }], 5)
  );
});

test("Edge sources preserve the service-only RPC and redaction boundaries", () => {
  const checkout = source(
    "supabase/functions/billing-create-checkout/index.ts",
  );
  const shared = source("supabase/functions/_shared/billing.ts");
  const portal = source("supabase/functions/billing-create-portal/index.ts");
  const refundAdmin = source(
    "supabase/functions/billing-admin-refund-duplicate/index.ts",
  );
  const webhook = source("supabase/functions/stripe-webhook/index.ts");
  const reconcile = source("supabase/functions/billing-reconcile/index.ts");
  const config = source("supabase/config.toml");
  const frontend = source("MyPersonas.Online_v0/billing.js");

  assert.match(
    frontend,
    /functions\.invoke\("billing-create-checkout",\{body:\{planCode\}\}\)/,
  );
  assert.match(checkout, /billing_plan_for_service/);
  assert.match(
    checkout,
    /import \{ requireAal2 \} from "\.\.\/_shared\/aal2\.ts"/,
  );
  assert.match(checkout, /const assurance = await requireAal2\(req, admin\)/);
  assert.match(
    portal,
    /import \{ requireAal2 \} from "\.\.\/_shared\/aal2\.ts"/,
  );
  assert.match(portal, /const assurance = await requireAal2\(req, admin\)/);
  assert.match(checkout, /billing_prepare_checkout/);
  assert.match(checkout, /billing_bind_customer/);
  assert.match(checkout, /billing_attach_checkout_session/);
  assert.match(checkout, /billing_expire_checkout_reservation/);
  assert.equal(
    (checkout.match(/billing_assert_checkout_allowed/g) ?? []).length,
    3,
    "Checkout must gate before provider work and again before URL return or attach",
  );
  assert.match(checkout, /p_lease_token:\s*requestKey/);
  assert.match(shared, /reservation_status/);
  assert.match(shared, /stripe_checkout_session_id/);
  assert.match(shared, /lease_acquired/);
  assert.match(shared, /provider_pending/);
  assert.match(shared, /mypersonas-customer:\$\{accountId\}/);
  assert.doesNotMatch(shared, /form\.set\("customer_email"/);
  const busyGate = checkout.indexOf('action === "busy"');
  const firstCheckoutGuard = checkout.indexOf(
    'admin.rpc("billing_assert_checkout_allowed"',
  );
  const providerPriceRead = checkout.indexOf("/v1/prices/");
  const customerCreate = checkout.indexOf('"/v1/customers"');
  const customerBind = checkout.indexOf('admin.rpc("billing_bind_customer"');
  const sessionCreate = checkout.indexOf('"/v1/checkout/sessions"');
  assert.ok(
    busyGate >= 0 && firstCheckoutGuard > busyGate &&
      providerPriceRead > firstCheckoutGuard &&
      customerCreate > providerPriceRead && customerBind > customerCreate &&
      sessionCreate > customerBind,
    "the sole lease owner must bind the canonical Customer before creating Checkout",
  );
  assert.equal(
    (checkout.match(
      /admin\.rpc\(\s*"billing_attach_checkout_session"/g,
    ) ?? []).length,
    2,
    "the exact idempotent attach must retry once after a lost database response",
  );
  assert.match(
    checkout,
    /action === "reuse"[\s\S]{0,800}\/v1\/checkout\/sessions\/\$\{/,
  );
  assert.doesNotMatch(
    checkout,
    /body\.(?:price|priceId|customer|success|cancel|session)/,
  );
  assert.match(checkout, /\{ url: session\.url \}/);
  assert.match(portal, /billing_get_customer_for_portal/);
  assert.match(portal, /assertCanonicalStripeCustomer/);
  assert.equal(
    (portal.match(/await verifyPortalConfiguration\(\)/g) ?? []).length,
    2,
    "Portal configuration drift must be rejected before and after session creation",
  );
  assert.match(
    portal,
    /assertPortalSession\([\s\S]{0,300}stripeCustomerId[\s\S]{0,300}config\.portalConfigurationId[\s\S]{0,300}returnUrl/,
  );
  assert.match(
    portal,
    /mypersonas-customer-email:\$\{user\.id\}:\$\{emailFingerprint\}/,
  );
  assert.match(portal, /\{ url: portal\.url \}/);
  assert.doesNotMatch(portal, /body\.(?:customer|customerId|returnUrl)/);
  assert.match(
    refundAdmin,
    /const assurance = await requireAal2\(req, service\)/,
  );
  assert.match(refundAdmin, /billing_admin_approve_duplicate_refund/);
  assert.match(refundAdmin, /Authorization: `Bearer \$\{assurance\.token\}`/);
  assert.match(refundAdmin, /billing_duplicate_refund_candidate_for_service/);
  assert.match(refundAdmin, /billing_bind_duplicate_refund_charge/);
  assert.match(refundAdmin, /billing_record_duplicate_refund_result/);
  assert.match(refundAdmin, /assertRefundablePaidInvoice/);
  assert.match(refundAdmin, /assertCanonicalInvoicePaymentListForRefund/);
  assert.match(refundAdmin, /assertCanonicalPaymentIntentForRefund/);
  assert.match(refundAdmin, /duplicateRefundRequest/);
  assert.match(shared, /metadata\[mypersonas_remediation_id\]/);
  assert.doesNotMatch(
    refundAdmin,
    /body\.(?:amount|charge|customer|invoice|refund|subscription)/,
  );

  const rawRead = webhook.indexOf("req.body.getReader()");
  const signatureCheck = webhook.search(
    /if\s*\(\s*!await verifyStripeSignature/,
  );
  const payloadParse = webhook.indexOf(
    "parseStripeEvent(decodedUtf8(rawBody))",
  );
  assert.ok(
    rawRead >= 0 && signatureCheck > rawRead && payloadParse > signatureCheck,
  );
  assert.match(webhook, /billing_record_webhook_event/);
  assert.match(webhook, /billing_apply_checkout_event/);
  assert.match(webhook, /p_reservation_id:\s*checkout\.reservationId/);
  assert.match(
    webhook,
    /canonicalTrialStart = stripeTimestampIso\(subscription\.trialStart\)/,
  );
  assert.match(
    webhook,
    /canonicalTrialEnd = stripeTimestampIso\(subscription\.trialEnd\)/,
  );
  assert.match(webhook, /p_trial_start:\s*canonicalTrialStart/);
  assert.match(webhook, /p_trial_end:\s*canonicalTrialEnd/);
  assert.doesNotMatch(
    webhook,
    /p_trial_(?:start|end):\s*(?:event|checkout)\b/,
  );
  assert.match(webhook, /billing_apply_subscription_event/);
  assert.match(webhook, /billing_apply_financial_hold_event/);
  assert.match(webhook, /billing_apply_expected_duplicate_refund_event/);
  assert.equal(
    (webhook.match(/applied\.error \|\| applied\.data !== true/g) ?? []).length,
    2,
    "Checkout and subscription apply paths must fail closed unless SQL confirms application",
  );
  assert.match(
    webhook,
    /if \(recorded\.data === false\)[\s\S]{0,800}billing_webhook_event_disposition/,
  );
  assert.match(
    webhook,
    /disposition\.data === "terminal"[\s\S]{0,200}received: true/,
  );
  assert.match(webhook, /disposition\.data === "terminal"[\s\S]{0,300}503/);
  assert.match(webhook, /billing_mark_webhook_review_required/);
  assert.match(webhook, /financial_event_linkage_unproven/);
  assert.match(webhook, /\/v1\/refunds\//);
  assert.match(webhook, /\/v1\/disputes\//);
  assert.match(webhook, /\/v1\/charges\//);
  assert.match(webhook, /\/v1\/invoice_payments\?/);
  assert.match(webhook, /"payment\[type\]": "payment_intent"/);
  assert.match(webhook, /limit: "2"/);
  assert.match(webhook, /\/v1\/invoices\//);
  assert.match(webhook, /\/v1\/subscriptions\//);
  assert.match(webhook, /billing_mark_webhook_failed/);
  assert.match(webhook, /reader\.cancel\(\)/);
  assert.doesNotMatch(webhook, /p_(?:payload|raw_payload|event):/);
  assert.doesNotMatch(webhook, /console\.(?:log|error|warn|debug)/);
  assert.doesNotMatch(
    checkout + portal + refundAdmin + webhook + reconcile,
    /sk_(?:test|live)_[A-Za-z0-9]{16,}/,
  );
  assert.doesNotMatch(
    checkout + portal + refundAdmin + webhook + reconcile,
    /whsec_[A-Za-z0-9]{16,}/,
  );

  assert.match(reconcile, /billing_reconciliation_candidates/);
  assert.match(reconcile, /billing_record_reconciliation_result/);
  assert.match(reconcile, /reconciliationMatches/);
  assert.match(reconcile, /current/);
  assert.match(reconcile, /drifted/);
  assert.match(reconcile, /mutated:\s*false/);
  assert.doesNotMatch(
    reconcile,
    /billing_apply_(?:checkout|subscription)_event/,
  );
  assert.match(
    config,
    /\[functions\.billing-create-checkout\]\s*\nverify_jwt = true/,
  );
  assert.match(
    config,
    /\[functions\.billing-create-portal\]\s*\nverify_jwt = true/,
  );
  assert.match(
    config,
    /\[functions\.billing-admin-refund-duplicate\]\s*\nverify_jwt = true/,
  );
  assert.match(config, /\[functions\.stripe-webhook\]\s*\nverify_jwt = false/);
  assert.match(
    config,
    /\[functions\.billing-reconcile\]\s*\nverify_jwt = false/,
  );
});
