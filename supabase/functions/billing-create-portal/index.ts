// Authenticated, test-mode-only Stripe Customer Portal entrypoint.
// The account-to-customer binding is resolved by a service RPC and reverified
// against the caller's confirmed authentication email before a portal URL is
// created. No Stripe id is accepted from or returned to the browser.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import {
  assertCanonicalPortalConfiguration,
  assertCanonicalStripeCustomer,
  assertEmptyInput,
  assertPortalSession,
  BillingConfigurationError,
  billingEmailFingerprints,
  corsHeaders,
  customerEmailUpdateForm,
  customerId,
  fixedBillingUrls,
  jsonResponse,
  loadBillingPortalConfig,
  portalForm,
  PublicBillingError,
  readJsonObject,
  requireBillingOrigin,
  requireVerifiedBillingUser,
  stripeApiJson,
  StripeBoundaryError,
  stripeCustomerEmailSyncRequired,
} from "../_shared/billing.ts";

class BillingDatabaseError extends Error {}

Deno.serve(async (req: Request) => {
  let config;
  try {
    config = loadBillingPortalConfig((name) => Deno.env.get(name));
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
    assertEmptyInput(await readJsonObject(req, undefined, true));

    const resolved = await admin.rpc("billing_get_customer_for_portal", {
      p_account_id: user.id,
    });
    if (resolved.error) throw new BillingDatabaseError();
    const stripeCustomerId = customerId(resolved.data);
    const emailFingerprint = (await billingEmailFingerprints(
      config.emailFingerprintKeys,
      user.email,
    ))[0].digest;
    let stripeCustomer = await stripeApiJson(
      config.stripeSecretKey,
      `/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
    );
    if (
      stripeCustomerEmailSyncRequired(
        stripeCustomer,
        stripeCustomerId,
        user.email,
      )
    ) {
      stripeCustomer = await stripeApiJson(
        config.stripeSecretKey,
        `/v1/customers/${encodeURIComponent(stripeCustomerId)}`,
        {
          method: "POST",
          form: customerEmailUpdateForm(user.email),
          idempotencyKey:
            `mypersonas-customer-email:${user.id}:${emailFingerprint}`,
        },
      );
    }
    assertCanonicalStripeCustomer(
      stripeCustomer,
      stripeCustomerId,
      user.email,
      user.id,
    );

    const form = portalForm(
      stripeCustomerId,
      config.appOrigin,
      config.portalConfigurationId,
    );
    const returnUrl = fixedBillingUrls(config.appOrigin).portalReturn;
    const portalConfigurationPath = `/v1/billing_portal/configurations/${
      encodeURIComponent(config.portalConfigurationId)
    }`;
    const verifyPortalConfiguration = async () => {
      const raw = await stripeApiJson(
        config.stripeSecretKey,
        portalConfigurationPath,
      );
      assertCanonicalPortalConfiguration(raw, config.portalConfigurationId);
    };
    // Stripe permits mutation of an existing bpc_ configuration. Validate it
    // immediately before and after session creation so Dashboard drift cannot
    // silently weaken the reviewed AAL2-only cancellation boundary.
    await verifyPortalConfiguration();
    const idempotencyKey = `mypersonas-portal:${crypto.randomUUID()}`;
    let portalRaw;
    try {
      portalRaw = await stripeApiJson(
        config.stripeSecretKey,
        "/v1/billing_portal/sessions",
        { method: "POST", form, idempotencyKey },
      );
    } catch (error) {
      if (!(error instanceof StripeBoundaryError) || !error.retryable) {
        throw error;
      }
      portalRaw = await stripeApiJson(
        config.stripeSecretKey,
        "/v1/billing_portal/sessions",
        { method: "POST", form, idempotencyKey },
      );
    }
    const portal = assertPortalSession(
      portalRaw,
      stripeCustomerId,
      config.portalConfigurationId,
      returnUrl,
    );
    await verifyPortalConfiguration();
    return jsonResponse(200, { url: portal.url }, origin);
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
