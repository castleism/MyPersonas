// Authenticated, test-mode-only Checkout Session creation.
// The browser supplies one internal plan code and receives one short-lived URL.
// It never supplies or receives Stripe object ids, prices, customer ids, API
// credentials, idempotency keys, or redirect URLs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import {
  assertCanonicalStripeCustomer,
  assertCanonicalStripeCustomerBinding,
  assertCheckoutReservationSession,
  assertCheckoutSession,
  assertServerPlan,
  assertStripeCustomer,
  assertStripePrice,
  BillingConfigurationError,
  billingEmailFingerprints,
  checkoutForm,
  checkoutIdempotencyKey,
  checkoutPlanCode,
  checkoutPreparation,
  checkoutPreparationAction,
  corsHeaders,
  customerEmailUpdateForm,
  customerForm,
  customerIdempotencyKey,
  jsonResponse,
  loadBillingServiceConfig,
  PublicBillingError,
  readJsonObject,
  requireBillingOrigin,
  requireVerifiedBillingUser,
  stripeApiJson,
  StripeBoundaryError,
  stripeCustomerEmailSyncRequired,
} from "../_shared/billing.ts";

const CHECKOUT_LIFETIME_SECONDS = 35 * 60;

class BillingDatabaseError extends Error {}

async function stripePostWithOneRetry(
  secretKey: string,
  path: string,
  form: URLSearchParams,
  idempotencyKey: string,
) {
  try {
    return await stripeApiJson(secretKey, path, {
      method: "POST",
      form,
      idempotencyKey,
    });
  } catch (error) {
    if (!(error instanceof StripeBoundaryError) || !error.retryable) {
      throw error;
    }
    return await stripeApiJson(secretKey, path, {
      method: "POST",
      form,
      idempotencyKey,
    });
  }
}

Deno.serve(async (req: Request) => {
  let config;
  try {
    config = loadBillingServiceConfig((name) => Deno.env.get(name));
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
  try {
    origin = requireBillingOrigin(req, config.appOrigin);
    const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const assurance = await requireAal2(req, admin);
    if (!assurance.ok) {
      throw new PublicBillingError(assurance.status, assurance.error);
    }
    const user = await requireVerifiedBillingUser(req, admin);
    if (user.id !== assurance.user.id) {
      throw new PublicBillingError(401, "Sign in again");
    }
    const body = await readJsonObject(req);
    const planCode = checkoutPlanCode(body);
    const plan = config.plans.get(planCode);
    if (!plan) throw new PublicBillingError(404, "Plan is unavailable");

    // The database is the service authorization boundary. Do not contact the
    // processor for a plan that is not currently active in that boundary.
    const databasePlan = await admin.rpc("billing_plan_for_service", {
      p_plan_code: plan.code,
    });
    if (databasePlan.error) throw new BillingDatabaseError();
    assertServerPlan(databasePlan.data, plan);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = nowSeconds + CHECKOUT_LIFETIME_SECONDS;
    const requestKey = crypto.randomUUID();
    const emailFingerprints = await billingEmailFingerprints(
      config.emailFingerprintKeys,
      user.email,
    );
    const currentEmailFingerprint = emailFingerprints[0];
    const previousEmailFingerprint = emailFingerprints[1] ?? null;
    const prepared = await admin.rpc("billing_prepare_checkout", {
      p_account_id: user.id,
      p_email_fingerprint: currentEmailFingerprint.digest,
      p_email_fingerprint_key_id: currentEmailFingerprint.keyId,
      p_previous_email_fingerprint: previousEmailFingerprint?.digest ?? null,
      p_previous_email_fingerprint_key_id: previousEmailFingerprint?.keyId ??
        null,
      p_retired_email_fingerprints: emailFingerprints.slice(2).map((value) => ({
        digest: value.digest,
        key_id: value.keyId,
      })),
      p_plan_code: plan.code,
      p_request_key: requestKey,
      p_expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
    });
    if (prepared.error) throw new BillingDatabaseError();
    const preparation = checkoutPreparation(prepared.data, plan);
    const action = checkoutPreparationAction(preparation);
    if (action === "busy") {
      throw new PublicBillingError(409, "Checkout is already being prepared");
    }

    const allowed = await admin.rpc("billing_assert_checkout_allowed", {
      p_account_id: user.id,
      p_reservation_id: preparation.reservationId,
      p_lease_token: requestKey,
    });
    if (allowed.error || allowed.data !== true) {
      throw new BillingDatabaseError();
    }

    const providerPrice = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/prices/${encodeURIComponent(plan.priceId)}`,
    );
    assertStripePrice(providerPrice, plan);

    let stripeCustomerId = preparation.customerId;
    if (preparation.customerId) {
      let customer = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/customers/${encodeURIComponent(preparation.customerId)}`,
      );
      if (
        stripeCustomerEmailSyncRequired(
          customer,
          preparation.customerId,
          user.email,
        )
      ) {
        customer = await stripePostWithOneRetry(
          config.stripeSecretKey,
          `/v1/customers/${encodeURIComponent(preparation.customerId)}`,
          customerEmailUpdateForm(user.email),
          `mypersonas-customer-email:${user.id}:${currentEmailFingerprint.digest}`,
        );
      }
      assertStripeCustomer(customer, preparation.customerId, user.email);
      assertCanonicalStripeCustomer(
        customer,
        preparation.customerId,
        user.email,
        user.id,
      );
    } else {
      if (action !== "create") throw new StripeBoundaryError(false);
      let customer = await stripePostWithOneRetry(
        config.stripeSecretKey,
        "/v1/customers",
        customerForm(user.id),
        customerIdempotencyKey(user.id),
      );
      const createdBinding = assertCanonicalStripeCustomerBinding(
        customer,
        null,
        user.id,
      );
      if (
        stripeCustomerEmailSyncRequired(
          customer,
          String(createdBinding.customer.id),
          user.email,
        )
      ) {
        customer = await stripePostWithOneRetry(
          config.stripeSecretKey,
          `/v1/customers/${
            encodeURIComponent(String(createdBinding.customer.id))
          }`,
          customerEmailUpdateForm(user.email),
          `mypersonas-customer-email:${user.id}:${currentEmailFingerprint.digest}`,
        );
      }
      const canonicalCustomer = assertCanonicalStripeCustomer(
        customer,
        null,
        user.email,
        user.id,
      );
      stripeCustomerId = String(canonicalCustomer.id);
    }
    if (!stripeCustomerId) throw new StripeBoundaryError(false);

    if (action === "reuse") {
      if (!preparation.sessionId) throw new StripeBoundaryError(false);
      const sessionRaw = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/checkout/sessions/${encodeURIComponent(preparation.sessionId)}`,
      );
      const reservationSession = assertCheckoutReservationSession(
        sessionRaw,
        user.id,
        preparation.reservationId,
        stripeCustomerId,
        plan,
        preparation.expiresAt,
        preparation.trialEligible,
      );
      if (reservationSession.id !== preparation.sessionId) {
        throw new StripeBoundaryError(false);
      }
      if (reservationSession.status === "expired") {
        const expired = await admin.rpc("billing_expire_checkout_reservation", {
          p_account_id: user.id,
          p_reservation_id: preparation.reservationId,
          p_session_id: reservationSession.id,
        });
        if (expired.error || expired.data !== true) {
          throw new BillingDatabaseError();
        }
        throw new PublicBillingError(409, "Checkout expired; try again");
      }
      const stillAllowed = await admin.rpc("billing_assert_checkout_allowed", {
        p_account_id: user.id,
        p_reservation_id: preparation.reservationId,
        p_lease_token: requestKey,
      });
      if (stillAllowed.error || stillAllowed.data !== true) {
        throw new BillingDatabaseError();
      }
      if (!reservationSession.url) throw new StripeBoundaryError(false);
      return jsonResponse(200, { url: reservationSession.url }, origin);
    }

    const boundCustomer = await admin.rpc("billing_bind_customer", {
      p_account_id: user.id,
      p_customer_id: stripeCustomerId,
    });
    if (boundCustomer.error || boundCustomer.data !== true) {
      throw new BillingDatabaseError();
    }
    const sessionForm = checkoutForm(
      user.id,
      stripeCustomerId,
      preparation,
      plan,
      config.appOrigin,
      preparation.expiresAt,
    );
    const idempotencyKey = checkoutIdempotencyKey(preparation.reservationId);
    const sessionRaw = await stripePostWithOneRetry(
      config.stripeSecretKey,
      "/v1/checkout/sessions",
      sessionForm,
      idempotencyKey,
    );
    const reservationSession = assertCheckoutReservationSession(
      sessionRaw,
      user.id,
      preparation.reservationId,
      stripeCustomerId,
      plan,
      preparation.expiresAt,
      preparation.trialEligible,
    );
    if (reservationSession.status === "expired") {
      const expired = await admin.rpc("billing_expire_checkout_reservation", {
        p_account_id: user.id,
        p_reservation_id: preparation.reservationId,
        p_session_id: reservationSession.id,
      });
      if (expired.error || expired.data !== true) {
        throw new BillingDatabaseError();
      }
      throw new PublicBillingError(409, "Checkout expired; try again");
    }
    const session = assertCheckoutSession(
      sessionRaw,
      user.id,
      preparation.reservationId,
      stripeCustomerId,
      plan,
      preparation.expiresAt,
      preparation.trialEligible,
    );
    const stillAllowed = await admin.rpc("billing_assert_checkout_allowed", {
      p_account_id: user.id,
      p_reservation_id: preparation.reservationId,
      p_lease_token: requestKey,
    });
    if (stillAllowed.error || stillAllowed.data !== true) {
      throw new BillingDatabaseError();
    }
    const attachArgs = {
      p_account_id: user.id,
      p_reservation_id: preparation.reservationId,
      p_session_id: session.id,
      p_lease_token: requestKey,
    };
    let attached = await admin.rpc(
      "billing_attach_checkout_session",
      attachArgs,
    );
    if (attached.error) {
      // The exact attach is idempotent. One retry recovers a lost database
      // response without creating another Customer or Checkout Session.
      attached = await admin.rpc("billing_attach_checkout_session", attachArgs);
    }
    if (attached.error || attached.data !== true) {
      throw new BillingDatabaseError();
    }

    return jsonResponse(200, { url: session.url }, origin);
  } catch (error) {
    if (error instanceof PublicBillingError) {
      return jsonResponse(error.status, { error: error.message }, origin);
    }
    if (error instanceof StripeBoundaryError) {
      return jsonResponse(
        error.retryable ? 503 : 502,
        { error: "Billing provider is temporarily unavailable" },
        origin,
      );
    }
    if (error instanceof BillingConfigurationError) {
      return jsonResponse(
        503,
        { error: "Billing is temporarily unavailable" },
        origin,
      );
    }
    return jsonResponse(
      503,
      { error: "Billing is temporarily unavailable" },
      origin,
    );
  }
});
