// Shared, test-mode-only Stripe billing boundary.
//
// Browser requests supply only an internal plan code. Stripe object ids,
// customer bindings, prices, return URLs, idempotency keys, and credentials are
// resolved or generated on the server. Keep this module free of Deno-specific
// imports so its security-critical parsers can also run in the Node test suite.

export const STRIPE_API_BASE = "https://api.stripe.com";
export const STRIPE_API_VERSION = "2026-02-25.clover";
export const MAX_JSON_REQUEST_BYTES = 4 * 1024;
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
export const MAX_STRIPE_RESPONSE_BYTES = 256 * 1024;
export const STRIPE_TIMEOUT_MS = 15_000;
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

const APP_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
  "https://mypersonas-staging.pages.dev",
  "https://staging.mypersonas.online",
]);
const PLAN_CODE_RE = /^[a-z][a-z0-9_]{1,47}$/;
const PRICE_ID_RE = /^price_[A-Za-z0-9]{8,200}$/;
const PRODUCT_ID_RE = /^prod_[A-Za-z0-9]{8,200}$/;
const CUSTOMER_ID_RE = /^cus_[A-Za-z0-9]{8,200}$/;
const CHECKOUT_ID_RE = /^cs_test_[A-Za-z0-9]{8,240}$/;
const PORTAL_ID_RE = /^bps_[A-Za-z0-9]{8,240}$/;
const PORTAL_CONFIGURATION_ID_RE = /^bpc_[A-Za-z0-9]{8,200}$/;
const SUBSCRIPTION_ID_RE = /^sub_[A-Za-z0-9]{8,240}$/;
const INVOICE_ID_RE = /^in_[A-Za-z0-9]{8,240}$/;
const CHARGE_ID_RE = /^ch_[A-Za-z0-9]{8,240}$/;
const REFUND_ID_RE = /^re_[A-Za-z0-9]{8,240}$/;
const DISPUTE_ID_RE = /^du_[A-Za-z0-9]{8,240}$/;
const PAYMENT_INTENT_ID_RE = /^pi_[A-Za-z0-9]{8,240}$/;
const INVOICE_PAYMENT_ID_RE = /^inpay_[A-Za-z0-9]{8,240}$/;
const EVENT_ID_RE = /^evt_[A-Za-z0-9]{8,240}$/;
const STRIPE_TEST_PRIVATE_KEY_RE = /^(?:sk|rk)_test_[A-Za-z0-9_]{16,480}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{16,255}$/;
const INTERVALS = new Set(["day", "week", "month", "year"]);

export type EnvReader = (name: string) => string | undefined;
export type JsonRecord = Record<string, unknown>;

export type BillingPlan = {
  code: string;
  priceId: string;
  productId: string;
  amount: number;
  currency: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  trialDays: number;
};

export type BillingEmailFingerprintKey = {
  keyId: string;
  secret: string;
};

export type BillingEmailFingerprint = {
  keyId: string;
  digest: string;
};

export type BillingServiceConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  stripeSecretKey: string;
  emailFingerprintKeys: readonly BillingEmailFingerprintKey[];
  appOrigin: string;
  plans: ReadonlyMap<string, BillingPlan>;
};

export type BillingPortalConfig = Omit<BillingServiceConfig, "plans"> & {
  portalConfigurationId: string;
};

export type BillingRefundConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  stripeSecretKey: string;
  appOrigin: string;
  plans: ReadonlyMap<string, BillingPlan>;
};

export type BillingWebhookConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  stripeSecretKey: string;
  webhookSecret: string;
  plans: ReadonlyMap<string, BillingPlan>;
};

export type BillingReconcileConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  stripeSecretKey: string;
  reconcileSecret: string;
  plans: ReadonlyMap<string, BillingPlan>;
};

export type BillingCustomerCleanupConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  stripeSecretKey: string;
};

export type BillingCustomerCleanupCandidate = {
  required: boolean;
  customerId: string | null;
};

export class PublicBillingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PublicBillingError";
    this.status = status;
  }
}

export class BillingConfigurationError extends Error {
  constructor() {
    super("Billing configuration is unavailable");
    this.name = "BillingConfigurationError";
  }
}

export class StripeBoundaryError extends Error {
  readonly retryable: boolean;
  constructor(retryable = true) {
    super("Billing provider request failed");
    this.name = "StripeBoundaryError";
    this.retryable = retryable;
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function configuredValue(env: EnvReader, name: string, max = 16_384): string {
  const raw = env(name) ?? "";
  if (
    !raw || raw !== raw.trim() || raw.length > max ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw new BillingConfigurationError();
  }
  return raw;
}

function supabaseConfig(env: EnvReader) {
  const rawUrl = configuredValue(env, "SUPABASE_URL", 2048);
  const serviceRoleKey = configuredValue(
    env,
    "SUPABASE_SERVICE_ROLE_KEY",
    8192,
  );
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BillingConfigurationError();
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.search ||
    url.hash || (url.pathname !== "/" && url.pathname !== "") ||
    serviceRoleKey.length < 32 || /\s/u.test(serviceRoleKey)
  ) {
    throw new BillingConfigurationError();
  }
  return { supabaseUrl: url.origin, serviceRoleKey };
}

function stripeTestSecret(env: EnvReader): string {
  const secret = configuredValue(env, "STRIPE_TEST_SECRET_KEY", 512);
  if (!STRIPE_TEST_PRIVATE_KEY_RE.test(secret)) {
    throw new BillingConfigurationError();
  }
  return secret;
}

function billingOrigin(env: EnvReader): string {
  const origin = configuredValue(env, "BILLING_APP_ORIGIN", 256);
  if (!APP_ORIGINS.has(origin)) throw new BillingConfigurationError();
  return origin;
}

function fingerprintKeys(
  env: EnvReader,
): readonly BillingEmailFingerprintKey[] {
  const keyId = configuredValue(
    env,
    "BILLING_EMAIL_FINGERPRINT_KEY_ID",
    32,
  );
  const secret = configuredValue(env, "BILLING_EMAIL_FINGERPRINT_SECRET", 512);
  const previousKeyId = env("BILLING_EMAIL_FINGERPRINT_PREVIOUS_KEY_ID") ?? "";
  const previousSecret = env("BILLING_EMAIL_FINGERPRINT_PREVIOUS_SECRET") ?? "";
  if (
    !/^[a-z][a-z0-9_-]{0,31}$/.test(keyId) || secret.length < 32 ||
    /\s/u.test(secret) || (previousKeyId === "") !== (previousSecret === "")
  ) {
    throw new BillingConfigurationError();
  }
  const keys: BillingEmailFingerprintKey[] = [{ keyId, secret }];
  if (previousKeyId) {
    if (
      !/^[a-z][a-z0-9_-]{0,31}$/.test(previousKeyId) ||
      previousSecret.length < 32 || /\s/u.test(previousSecret) ||
      previousKeyId === keyId || previousSecret === secret
    ) {
      throw new BillingConfigurationError();
    }
    keys.push({ keyId: previousKeyId, secret: previousSecret });
  }
  const retiredRaw = env("BILLING_EMAIL_FINGERPRINT_RETIRED_KEYS_JSON") ?? "";
  if (retiredRaw) {
    if (
      retiredRaw !== retiredRaw.trim() || retiredRaw.length > 20_000 ||
      /[\u0000-\u001f\u007f]/u.test(retiredRaw)
    ) throw new BillingConfigurationError();
    let retired: unknown;
    try {
      retired = JSON.parse(retiredRaw);
    } catch {
      throw new BillingConfigurationError();
    }
    if (!Array.isArray(retired) || retired.length < 1 || retired.length > 32) {
      throw new BillingConfigurationError();
    }
    const keyIds = new Set(keys.map((key) => key.keyId));
    const secrets = new Set(keys.map((key) => key.secret));
    for (const value of retired) {
      if (!isRecord(value)) throw new BillingConfigurationError();
      exactKeys(value, ["key_id", "secret"]);
      const retiredKeyId = value.key_id;
      const retiredSecret = value.secret;
      if (
        typeof retiredKeyId !== "string" ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(retiredKeyId) ||
        typeof retiredSecret !== "string" || retiredSecret.length < 32 ||
        retiredSecret.length > 512 || /\s/u.test(retiredSecret) ||
        keyIds.has(retiredKeyId) || secrets.has(retiredSecret)
      ) throw new BillingConfigurationError();
      keyIds.add(retiredKeyId);
      secrets.add(retiredSecret);
      keys.push({ keyId: retiredKeyId, secret: retiredSecret });
    }
  }
  return keys;
}

function exactKeys(record: JsonRecord, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new BillingConfigurationError();
  }
}

export function parseBillingPlans(
  raw: string,
): ReadonlyMap<string, BillingPlan> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BillingConfigurationError();
  }
  if (!isRecord(parsed)) throw new BillingConfigurationError();
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 16) {
    throw new BillingConfigurationError();
  }
  const plans = new Map<string, BillingPlan>();
  const priceIds = new Set<string>();
  for (const [code, value] of entries) {
    if (!PLAN_CODE_RE.test(code) || !isRecord(value)) {
      throw new BillingConfigurationError();
    }
    exactKeys(value, [
      "price_id",
      "product_id",
      "amount",
      "currency",
      "interval",
      "interval_count",
      "trial_days",
    ]);
    const priceId = value.price_id;
    const productId = value.product_id;
    const amount = value.amount;
    const currency = value.currency;
    const interval = value.interval;
    const intervalCount = value.interval_count;
    const trialDays = value.trial_days;
    if (
      typeof priceId !== "string" || !PRICE_ID_RE.test(priceId) ||
      priceIds.has(priceId) ||
      typeof productId !== "string" || !PRODUCT_ID_RE.test(productId) ||
      !Number.isSafeInteger(amount) || Number(amount) < 1 ||
      Number(amount) > 10_000_000 ||
      typeof currency !== "string" || !/^[a-z]{3}$/.test(currency) ||
      typeof interval !== "string" || !INTERVALS.has(interval) ||
      !Number.isSafeInteger(intervalCount) || Number(intervalCount) < 1 ||
      Number(intervalCount) > 12 ||
      !Number.isSafeInteger(trialDays) || Number(trialDays) !== 7
    ) {
      throw new BillingConfigurationError();
    }
    priceIds.add(priceId);
    plans.set(code, {
      code,
      priceId,
      productId,
      amount: Number(amount),
      currency,
      interval: interval as BillingPlan["interval"],
      intervalCount: Number(intervalCount),
      trialDays: Number(trialDays),
    });
  }
  return plans;
}

export function loadBillingServiceConfig(env: EnvReader): BillingServiceConfig {
  const base = supabaseConfig(env);
  return {
    ...base,
    stripeSecretKey: stripeTestSecret(env),
    emailFingerprintKeys: fingerprintKeys(env),
    appOrigin: billingOrigin(env),
    plans: parseBillingPlans(
      configuredValue(env, "STRIPE_TEST_PLANS_JSON", 32_768),
    ),
  };
}

export function loadBillingPortalConfig(env: EnvReader): BillingPortalConfig {
  const base = supabaseConfig(env);
  const portalConfigurationId = configuredValue(
    env,
    "STRIPE_TEST_PORTAL_CONFIGURATION_ID",
    256,
  );
  if (!PORTAL_CONFIGURATION_ID_RE.test(portalConfigurationId)) {
    throw new BillingConfigurationError();
  }
  return {
    ...base,
    stripeSecretKey: stripeTestSecret(env),
    emailFingerprintKeys: fingerprintKeys(env),
    appOrigin: billingOrigin(env),
    portalConfigurationId,
  };
}

export function loadBillingRefundConfig(env: EnvReader): BillingRefundConfig {
  return {
    ...supabaseConfig(env),
    stripeSecretKey: stripeTestSecret(env),
    appOrigin: billingOrigin(env),
    plans: parseBillingPlans(
      configuredValue(env, "STRIPE_TEST_PLANS_JSON", 32_768),
    ),
  };
}

export function loadBillingWebhookConfig(env: EnvReader): BillingWebhookConfig {
  const base = supabaseConfig(env);
  const webhookSecret = configuredValue(env, "STRIPE_TEST_WEBHOOK_SECRET", 512);
  if (!/^whsec_[A-Za-z0-9]{16,480}$/.test(webhookSecret)) {
    throw new BillingConfigurationError();
  }
  return {
    ...base,
    stripeSecretKey: stripeTestSecret(env),
    webhookSecret,
    plans: parseBillingPlans(
      configuredValue(env, "STRIPE_TEST_PLANS_JSON", 32_768),
    ),
  };
}

export function loadBillingReconcileConfig(
  env: EnvReader,
): BillingReconcileConfig {
  const base = supabaseConfig(env);
  const reconcileSecret = configuredValue(env, "BILLING_RECONCILE_SECRET", 512);
  if (reconcileSecret.length < 32 || /\s/u.test(reconcileSecret)) {
    throw new BillingConfigurationError();
  }
  return {
    ...base,
    stripeSecretKey: stripeTestSecret(env),
    reconcileSecret,
    plans: parseBillingPlans(
      configuredValue(env, "STRIPE_TEST_PLANS_JSON", 32_768),
    ),
  };
}

export function loadBillingCustomerCleanupConfig(
  env: EnvReader,
): BillingCustomerCleanupConfig {
  return { ...supabaseConfig(env), stripeSecretKey: stripeTestSecret(env) };
}

export function fixedBillingUrls(appOrigin: string) {
  if (!APP_ORIGINS.has(appOrigin)) throw new BillingConfigurationError();
  return {
    checkoutSuccess: `${appOrigin}/?billing=success#/studio`,
    checkoutCancel: `${appOrigin}/?billing=cancel#/studio`,
    portalReturn: `${appOrigin}/#/studio`,
  } as const;
}

export function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  origin = "",
  extraHeaders: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin ? corsHeaders(origin) : {}),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

export function requireBillingOrigin(req: Request, appOrigin: string): string {
  const origin = req.headers.get("Origin") ?? "";
  if (origin !== appOrigin) {
    throw new PublicBillingError(403, "Origin not allowed");
  }
  return origin;
}

export async function readJsonObject(
  req: Request,
  maxBytes = MAX_JSON_REQUEST_BYTES,
  allowEmpty = false,
): Promise<JsonRecord> {
  const contentType = req.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new PublicBillingError(415, "A JSON request is required");
  }
  const declared = req.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new PublicBillingError(400, "Invalid request");
    }
    if (Number(declared) > maxBytes) {
      throw new PublicBillingError(413, "Request body is too large");
    }
  }
  if (!req.body) {
    if (allowEmpty) return {};
    throw new PublicBillingError(400, "A JSON object is required");
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new PublicBillingError(413, "Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PublicBillingError(400, "A JSON object is required");
  }
  if (!text && allowEmpty) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PublicBillingError(400, "A JSON object is required");
  }
  if (!isRecord(parsed)) {
    throw new PublicBillingError(400, "A JSON object is required");
  }
  return parsed;
}

function exactInputKeys(record: JsonRecord, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new PublicBillingError(400, "Request fields are invalid");
  }
}

export function checkoutPlanCode(body: JsonRecord): string {
  exactInputKeys(body, ["planCode"]);
  if (typeof body.planCode !== "string" || !PLAN_CODE_RE.test(body.planCode)) {
    throw new PublicBillingError(400, "Plan code is invalid");
  }
  return body.planCode;
}

export type DuplicateRefundApproval = {
  remediationId: string;
  reason: string;
};

export function duplicateRefundApproval(
  body: JsonRecord,
): DuplicateRefundApproval {
  exactInputKeys(body, ["remediationId", "reason"]);
  const remediationId = body.remediationId;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (
    typeof remediationId !== "string" || !UUID_RE.test(remediationId) ||
    reason.length < 10 || reason.length > 1000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)
  ) {
    throw new PublicBillingError(400, "Refund approval is invalid");
  }
  return { remediationId, reason };
}

export function assertEmptyInput(body: JsonRecord) {
  exactInputKeys(body, []);
}

export type VerifiedBillingUser = {
  id: string;
  email: string;
  token: string;
};

export type BillingAuthClient = {
  auth: {
    getUser: (token: string) => Promise<{
      data: {
        user: null | {
          id?: unknown;
          email?: unknown;
          email_confirmed_at?: unknown;
        };
      };
      error: unknown;
    }>;
  };
};

function normalizeVerifiedEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new PublicBillingError(403, "Verify your email first");
  }
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 || email.length > 320 ||
    /[\s<>\u0000-\u001f\u007f]/u.test(email) ||
    !/^[^@]+@[^@]+\.[^@]+$/u.test(email)
  ) {
    throw new PublicBillingError(403, "Verify your email first");
  }
  return email;
}

export async function requireVerifiedBillingUser(
  req: Request,
  authClient: BillingAuthClient,
): Promise<VerifiedBillingUser> {
  const authorization = req.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(\S{20,8192})$/i);
  if (!match) throw new PublicBillingError(401, "Sign in first");
  const token = match[1];
  const result = await authClient.auth.getUser(token);
  const user = result.data?.user;
  if (
    result.error || !user || typeof user.id !== "string" ||
    !UUID_RE.test(user.id)
  ) {
    throw new PublicBillingError(401, "Sign in again");
  }
  if (typeof user.email_confirmed_at !== "string" || !user.email_confirmed_at) {
    throw new PublicBillingError(403, "Verify your email first");
  }
  return { id: user.id, email: normalizeVerifiedEmail(user.email), token };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function hmacSha256Hex(
  secret: string,
  bytes: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    exactArrayBuffer(bytes),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function billingEmailFingerprint(
  secret: string,
  verifiedEmail: string,
): Promise<string> {
  const normalized = normalizeVerifiedEmail(verifiedEmail);
  return await hmacSha256Hex(
    secret,
    new TextEncoder().encode(`mypersonas:billing-email:v1:${normalized}`),
  );
}

export async function billingEmailFingerprints(
  keys: readonly BillingEmailFingerprintKey[],
  verifiedEmail: string,
): Promise<readonly BillingEmailFingerprint[]> {
  if (keys.length < 1 || keys.length > 34) {
    throw new BillingConfigurationError();
  }
  const seen = new Set<string>();
  const seenSecrets = new Set<string>();
  const fingerprints: BillingEmailFingerprint[] = [];
  for (const key of keys) {
    if (
      !/^[a-z][a-z0-9_-]{0,31}$/.test(key.keyId) ||
      key.secret.length < 32 || key.secret.length > 512 ||
      /\s/u.test(key.secret) || seen.has(key.keyId) ||
      seenSecrets.has(key.secret)
    ) {
      throw new BillingConfigurationError();
    }
    seen.add(key.keyId);
    seenSecrets.add(key.secret);
    fingerprints.push({
      keyId: key.keyId,
      digest: await billingEmailFingerprint(key.secret, verifiedEmail),
    });
  }
  if (
    fingerprints.length === 2 &&
    fingerprints[0].digest === fingerprints[1].digest
  ) {
    throw new BillingConfigurationError();
  }
  return fingerprints;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
}

export async function timingSafeEqualText(
  left: string,
  right: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function verifyStripeSignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  webhookSecret: string,
  nowMilliseconds = Date.now(),
  toleranceSeconds = STRIPE_SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  if (
    !signatureHeader || signatureHeader.length > 2048 ||
    !/^whsec_[A-Za-z0-9]{16,480}$/.test(webhookSecret) ||
    !Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 1 ||
    toleranceSeconds > 600
  ) return false;
  let timestamp: number | null = null;
  const signatures: Uint8Array[] = [];
  for (const rawPart of signatureHeader.split(",")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (name === "t") {
      if (!/^\d{1,12}$/.test(value)) return false;
      const candidate = Number(value);
      if (
        !Number.isSafeInteger(candidate) ||
        (timestamp !== null && timestamp !== candidate)
      ) {
        return false;
      }
      timestamp = candidate;
    } else if (name === "v1") {
      const candidate = hexToBytes(value);
      if (candidate) signatures.push(candidate);
    }
  }
  if (timestamp === null || signatures.length < 1 || signatures.length > 8) {
    return false;
  }
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  signed.set(prefix, 0);
  signed.set(rawBody, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const signature of signatures) {
    if (
      await crypto.subtle.verify(
        "HMAC",
        key,
        exactArrayBuffer(signature),
        exactArrayBuffer(signed),
      )
    ) return true;
  }
  return false;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("Content-Length");
  if (
    declared && /^\d+$/.test(declared) &&
    Number(declared) > MAX_STRIPE_RESPONSE_BYTES
  ) {
    throw new StripeBoundaryError(false);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STRIPE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new StripeBoundaryError(false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StripeBoundaryError(false);
  }
}

export type StripeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function stripeApiJson(
  secretKey: string,
  path: string,
  options: {
    method?: "GET" | "POST" | "DELETE";
    form?: URLSearchParams;
    idempotencyKey?: string;
    fetchImpl?: StripeFetch;
  } = {},
): Promise<JsonRecord> {
  if (!STRIPE_TEST_PRIVATE_KEY_RE.test(secretKey)) {
    throw new BillingConfigurationError();
  }
  if (!/^\/v1\/[A-Za-z0-9_?=&%./-]{1,500}$/.test(path)) {
    throw new BillingConfigurationError();
  }
  const method = options.method ?? "GET";
  if (method === "POST" && !options.form) throw new BillingConfigurationError();
  if (method === "GET" && options.form) throw new BillingConfigurationError();
  if (
    options.idempotencyKey && !IDEMPOTENCY_KEY_RE.test(options.idempotencyKey)
  ) {
    throw new BillingConfigurationError();
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await (options.fetchImpl ?? fetch)(`${STRIPE_API_BASE}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${secretKey}`,
        "Stripe-Version": STRIPE_API_VERSION,
        ...(method !== "GET"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body: options.form,
      signal: controller.signal,
    });
    // Keep the same deadline active while consuming the response body. Fetch
    // resolving headers alone must not let a stalled provider response hold an
    // Edge worker indefinitely.
    text = await boundedResponseText(response);
  } catch (error) {
    if (error instanceof StripeBoundaryError) throw error;
    throw new StripeBoundaryError(true);
  } finally {
    clearTimeout(timeout);
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(contentType) || !text) {
    throw new StripeBoundaryError(
      response.status >= 500 || response.status === 429,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StripeBoundaryError(false);
  }
  if (!isRecord(parsed) || !response.ok) {
    throw new StripeBoundaryError(
      response.status >= 500 || response.status === 429,
    );
  }
  return parsed;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

export function assertServerPlan(
  raw: unknown,
  expected: BillingPlan,
): BillingPlan {
  const row = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (!isRecord(row)) throw new StripeBoundaryError(false);
  if (
    row.plan_code !== expected.code ||
    row.stripe_price_id !== expected.priceId ||
    integer(row.amount_minor) !== expected.amount ||
    row.currency !== expected.currency ||
    row.recurring_interval !== expected.interval ||
    integer(row.interval_count) !== expected.intervalCount ||
    row.livemode !== false
  ) {
    throw new StripeBoundaryError(false);
  }
  return expected;
}

export function assertStripePrice(
  raw: unknown,
  expected: BillingPlan,
): JsonRecord {
  if (!isRecord(raw) || !isRecord(raw.recurring)) {
    throw new StripeBoundaryError(false);
  }
  if (
    raw.object !== "price" || raw.id !== expected.priceId ||
    raw.product !== expected.productId ||
    raw.livemode !== false || raw.active !== true || raw.type !== "recurring" ||
    raw.billing_scheme !== "per_unit" || raw.currency !== expected.currency ||
    integer(raw.unit_amount) !== expected.amount ||
    raw.recurring.interval !== expected.interval ||
    integer(raw.recurring.interval_count) !== expected.intervalCount ||
    (raw.recurring.usage_type !== undefined &&
      raw.recurring.usage_type !== "licensed") ||
    (raw.tiers_mode !== undefined && raw.tiers_mode !== null) ||
    (raw.transform_quantity !== undefined && raw.transform_quantity !== null)
  ) {
    throw new StripeBoundaryError(false);
  }
  return raw;
}

export function assertStripeCustomerBinding(raw: unknown, expectedId: string) {
  if (!CUSTOMER_ID_RE.test(expectedId) || !isRecord(raw)) {
    throw new StripeBoundaryError(false);
  }
  let email = "";
  try {
    if (raw.email !== null && raw.email !== undefined) {
      email = normalizeVerifiedEmail(raw.email);
    }
  } catch {
    throw new StripeBoundaryError(false);
  }
  if (
    raw.object !== "customer" || raw.id !== expectedId ||
    raw.livemode !== false ||
    raw.deleted === true
  ) {
    throw new StripeBoundaryError(false);
  }
  return { customer: raw, email };
}

export function stripeCustomerEmailSyncRequired(
  raw: unknown,
  expectedId: string,
  verifiedEmail: string,
) {
  return assertStripeCustomerBinding(raw, expectedId).email !==
    normalizeVerifiedEmail(verifiedEmail);
}

export function customerEmailUpdateForm(verifiedEmail: string) {
  return new URLSearchParams({ email: normalizeVerifiedEmail(verifiedEmail) });
}

export function assertStripeCustomer(
  raw: unknown,
  expectedId: string,
  verifiedEmail: string,
) {
  const binding = assertStripeCustomerBinding(raw, expectedId);
  if (binding.email !== normalizeVerifiedEmail(verifiedEmail)) {
    throw new StripeBoundaryError(false);
  }
  return binding.customer;
}

export function assertCanonicalStripeCustomerBinding(
  raw: unknown,
  expectedId: string | null,
  accountId: string,
) {
  if (
    !UUID_RE.test(accountId) || !isRecord(raw) ||
    typeof raw.id !== "string" || !CUSTOMER_ID_RE.test(raw.id) ||
    (expectedId !== null && raw.id !== expectedId) || !isRecord(raw.metadata) ||
    raw.metadata.account_id !== accountId
  ) {
    throw new StripeBoundaryError(false);
  }
  return assertStripeCustomerBinding(raw, raw.id);
}

export function assertCanonicalStripeCustomer(
  raw: unknown,
  expectedId: string | null,
  verifiedEmail: string,
  accountId: string,
) {
  const binding = assertCanonicalStripeCustomerBinding(
    raw,
    expectedId,
    accountId,
  );
  if (binding.email !== normalizeVerifiedEmail(verifiedEmail)) {
    throw new StripeBoundaryError(false);
  }
  return binding.customer;
}

export function billingCustomerCleanupCandidate(
  raw: unknown,
): BillingCustomerCleanupCandidate {
  if (!isRecord(raw) || typeof raw.required !== "boolean") {
    throw new StripeBoundaryError(false);
  }
  const customerId = raw.stripe_customer_id;
  if (
    (raw.required &&
      (typeof customerId !== "string" || !CUSTOMER_ID_RE.test(customerId))) ||
    (!raw.required && customerId !== null)
  ) {
    throw new StripeBoundaryError(false);
  }
  return {
    required: raw.required,
    customerId: typeof customerId === "string" ? customerId : null,
  };
}

export function assertTerminalCustomerSubscriptions(
  raw: unknown,
  customerId: string,
  accountId: string,
) {
  if (
    !CUSTOMER_ID_RE.test(customerId) || !UUID_RE.test(accountId) ||
    !isRecord(raw) || raw.object !== "list" || raw.has_more !== false ||
    !Array.isArray(raw.data) || raw.data.length > 100
  ) {
    throw new StripeBoundaryError(false);
  }
  for (const subscription of raw.data) {
    if (
      !isRecord(subscription) || subscription.object !== "subscription" ||
      typeof subscription.id !== "string" ||
      !SUBSCRIPTION_ID_RE.test(subscription.id) ||
      idFromExpandable(subscription.customer, CUSTOMER_ID_RE) !== customerId ||
      !isRecord(subscription.metadata) ||
      subscription.metadata.account_id !== accountId ||
      !["canceled", "incomplete_expired"].includes(String(subscription.status))
    ) {
      throw new StripeBoundaryError(false);
    }
  }
  return raw.data;
}

export function assertDeletedStripeCustomer(
  raw: unknown,
  expectedId: string,
) {
  if (
    !CUSTOMER_ID_RE.test(expectedId) || !isRecord(raw) ||
    raw.object !== "customer" || raw.id !== expectedId || raw.deleted !== true
  ) {
    throw new StripeBoundaryError(false);
  }
  return raw;
}

export type CheckoutPreparation = {
  reservationId: string;
  trialEligible: boolean;
  customerId: string | null;
  reservationStatus: "reserved" | "provider_pending" | "session_created";
  sessionId: string | null;
  leaseAcquired: boolean;
  expiresAt: number;
};

export function checkoutPreparation(
  raw: unknown,
  expectedPlan: BillingPlan,
): CheckoutPreparation {
  if (!isRecord(raw)) throw new StripeBoundaryError(false);
  assertServerPlan(raw, expectedPlan);
  const reservationId = raw.reservation_id;
  const trialEligible = raw.trial_eligible;
  const customerId = raw.stripe_customer_id;
  const reservationStatus = raw.reservation_status;
  const sessionId = raw.stripe_checkout_session_id;
  const leaseAcquired = raw.lease_acquired;
  const parsedExpiresAt = typeof raw.reservation_expires_at === "string"
    ? Date.parse(raw.reservation_expires_at)
    : Number.NaN;
  const now = Date.now();
  if (
    typeof reservationId !== "string" || !UUID_RE.test(reservationId) ||
    typeof trialEligible !== "boolean" ||
    !(customerId === null ||
      (typeof customerId === "string" && CUSTOMER_ID_RE.test(customerId))) ||
    !["reserved", "provider_pending", "session_created"].includes(
      String(reservationStatus),
    ) ||
    !(sessionId === null ||
      (typeof sessionId === "string" && CHECKOUT_ID_RE.test(sessionId))) ||
    typeof leaseAcquired !== "boolean" ||
    !Number.isSafeInteger(parsedExpiresAt) ||
    parsedExpiresAt % 1000 !== 0 || parsedExpiresAt <= now + 60_000 ||
    parsedExpiresAt > now + 25 * 60 * 60 * 1000 ||
    (["reserved", "provider_pending"].includes(String(reservationStatus)) &&
      sessionId !== null) ||
    (reservationStatus === "session_created" &&
      (sessionId === null || customerId === null || leaseAcquired)) ||
    (reservationStatus === "session_created" && leaseAcquired)
  ) {
    throw new StripeBoundaryError(false);
  }
  return {
    reservationId,
    trialEligible,
    customerId,
    reservationStatus:
      reservationStatus as CheckoutPreparation["reservationStatus"],
    sessionId: sessionId as string | null,
    leaseAcquired,
    expiresAt: parsedExpiresAt / 1000,
  };
}

export function checkoutPreparationAction(
  preparation: CheckoutPreparation,
): "create" | "reuse" | "busy" {
  if (preparation.reservationStatus === "session_created") return "reuse";
  return preparation.leaseAcquired ? "create" : "busy";
}

export function customerIdempotencyKey(accountId: string): string {
  if (!UUID_RE.test(accountId)) throw new BillingConfigurationError();
  return `mypersonas-customer:${accountId}`;
}

export function customerForm(accountId: string): URLSearchParams {
  if (!UUID_RE.test(accountId)) throw new BillingConfigurationError();
  const form = new URLSearchParams();
  form.set("metadata[account_id]", accountId);
  return form;
}

export function duplicateSubscriptionCancellation(
  subscriptionId: string,
) {
  if (!SUBSCRIPTION_ID_RE.test(subscriptionId)) {
    throw new BillingConfigurationError();
  }
  return {
    form: new URLSearchParams({ invoice_now: "false", prorate: "false" }),
    idempotencyKey: `mypersonas-duplicate-cancel:${subscriptionId}`,
  } as const;
}

const DUPLICATE_REFUND_STATES = new Set([
  "refund_pending",
  "provider_refund_pending",
  "provider_refunded",
]);

export type DuplicateRefundServiceCandidate = {
  remediationId: string;
  accountId: string;
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  state: string;
  amount: number;
  currency: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  refundId: string | null;
  refundStatus: string | null;
};

export function duplicateRefundServiceCandidate(
  raw: unknown,
): DuplicateRefundServiceCandidate {
  if (!isRecord(raw)) throw new BillingConfigurationError();
  exactKeys(raw, [
    "remediation_id",
    "account_id",
    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_invoice_id",
    "state",
    "refund_amount",
    "refund_currency",
    "stripe_charge_id",
    "stripe_payment_intent_id",
    "stripe_refund_id",
    "refund_status",
  ]);
  const remediationId = raw.remediation_id;
  const accountId = raw.account_id;
  const customerId = raw.stripe_customer_id;
  const subscriptionId = raw.stripe_subscription_id;
  const invoiceId = raw.stripe_invoice_id;
  const state = raw.state;
  const amount = integer(raw.refund_amount);
  const currency = raw.refund_currency;
  const chargeId = raw.stripe_charge_id;
  const paymentIntentId = raw.stripe_payment_intent_id;
  const refundId = raw.stripe_refund_id;
  const refundStatus = raw.refund_status;
  if (
    typeof remediationId !== "string" || !UUID_RE.test(remediationId) ||
    typeof accountId !== "string" || !UUID_RE.test(accountId) ||
    typeof customerId !== "string" || !CUSTOMER_ID_RE.test(customerId) ||
    typeof subscriptionId !== "string" ||
    !SUBSCRIPTION_ID_RE.test(subscriptionId) ||
    typeof invoiceId !== "string" || !INVOICE_ID_RE.test(invoiceId) ||
    typeof state !== "string" || !DUPLICATE_REFUND_STATES.has(state) ||
    amount === null || amount < 1 || amount > 1_000_000_000 ||
    typeof currency !== "string" || !/^[a-z]{3}$/.test(currency) ||
    (chargeId !== null &&
      (typeof chargeId !== "string" || !CHARGE_ID_RE.test(chargeId))) ||
    (paymentIntentId !== null &&
      (typeof paymentIntentId !== "string" ||
        !PAYMENT_INTENT_ID_RE.test(paymentIntentId))) ||
    (chargeId === null) !== (paymentIntentId === null) ||
    (refundId !== null &&
      (typeof refundId !== "string" || !REFUND_ID_RE.test(refundId))) ||
    (refundStatus !== null &&
      (typeof refundStatus !== "string" ||
        !["pending", "requires_action", "succeeded"].includes(refundStatus))) ||
    (state === "refund_pending" &&
      (refundId !== null || refundStatus !== null)) ||
    (state === "provider_refund_pending" &&
      (!refundId || !["pending", "requires_action"].includes(
        String(refundStatus),
      ))) ||
    (state === "provider_refunded" &&
      (!refundId || refundStatus !== "succeeded"))
  ) throw new BillingConfigurationError();
  return {
    remediationId,
    accountId,
    customerId,
    subscriptionId,
    invoiceId,
    state,
    amount,
    currency,
    chargeId: chargeId as string | null,
    paymentIntentId: paymentIntentId as string | null,
    refundId: refundId as string | null,
    refundStatus: refundStatus as string | null,
  };
}

export function duplicateRefundRequest(
  remediationId: string,
  chargeId: string,
  amount: number,
) {
  if (
    !UUID_RE.test(remediationId) || !CHARGE_ID_RE.test(chargeId) ||
    !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000
  ) throw new BillingConfigurationError();
  const form = new URLSearchParams();
  form.set("charge", chargeId);
  form.set("amount", String(amount));
  form.set("reason", "duplicate");
  form.set("metadata[mypersonas_remediation_id]", remediationId);
  return {
    form,
    idempotencyKey: `mypersonas-duplicate-refund:${remediationId}`,
  } as const;
}

export function checkoutIdempotencyKey(reservationId: string): string {
  if (!UUID_RE.test(reservationId)) throw new BillingConfigurationError();
  return `mypersonas-checkout:${reservationId}`;
}

export function checkoutForm(
  accountId: string,
  customerId: string,
  preparation: CheckoutPreparation,
  plan: BillingPlan,
  appOrigin: string,
  expiresAtSeconds: number,
): URLSearchParams {
  if (
    !UUID_RE.test(accountId) || !CUSTOMER_ID_RE.test(customerId) ||
    !Number.isSafeInteger(expiresAtSeconds)
  ) {
    throw new BillingConfigurationError();
  }
  const urls = fixedBillingUrls(appOrigin);
  const form = new URLSearchParams();
  form.set("mode", "subscription");
  form.set("ui_mode", "hosted");
  form.set("payment_method_collection", "always");
  form.set("payment_method_types[0]", "card");
  form.set("consent_collection[terms_of_service]", "required");
  form.set("success_url", urls.checkoutSuccess);
  form.set("cancel_url", urls.checkoutCancel);
  form.set("client_reference_id", accountId);
  form.set("line_items[0][price]", plan.priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("expires_at", String(expiresAtSeconds));
  form.set("metadata[account_id]", accountId);
  form.set("metadata[reservation_id]", preparation.reservationId);
  form.set("metadata[plan_code]", plan.code);
  form.set("subscription_data[metadata][account_id]", accountId);
  form.set(
    "subscription_data[metadata][reservation_id]",
    preparation.reservationId,
  );
  form.set("subscription_data[metadata][plan_code]", plan.code);
  form.set("customer", customerId);
  if (preparation.trialEligible && plan.trialDays > 0) {
    form.set("subscription_data[trial_period_days]", String(plan.trialDays));
  }
  return form;
}

export type CheckoutSession = {
  id: string;
  url: string;
  customerId: string;
  expiresAt: number;
};

export type CheckoutReservationSession = {
  id: string;
  status: "open" | "expired";
  url: string | null;
  customerId: string;
  expiresAt: number;
};

function exactStripeUrl(value: unknown, hostname: string): string {
  if (typeof value !== "string" || value.length > 4096) {
    throw new StripeBoundaryError(false);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new StripeBoundaryError(false);
  }
  if (
    url.protocol !== "https:" || url.hostname !== hostname || url.port ||
    url.username || url.password
  ) throw new StripeBoundaryError(false);
  return url.toString();
}

export function assertCheckoutReservationSession(
  raw: unknown,
  accountId: string,
  reservationId: string,
  expectedCustomerId: string,
  plan: BillingPlan,
  expiresAtSeconds: number,
  trialEligible: boolean,
): CheckoutReservationSession {
  if (!isRecord(raw)) throw new StripeBoundaryError(false);
  const binding = metadataBinding(raw, true);
  const id = raw.id;
  const customer = raw.customer;
  const status = raw.status === "open" || raw.status === "expired"
    ? raw.status
    : null;
  const url = status === "open"
    ? exactStripeUrl(raw.url, "checkout.stripe.com")
    : raw.url === null
    ? null
    : exactStripeUrl(raw.url, "checkout.stripe.com");
  if (
    typeof id !== "string" || !CHECKOUT_ID_RE.test(id) ||
    raw.object !== "checkout.session" || raw.livemode !== false ||
    raw.mode !== "subscription" || !status || raw.subscription !== null ||
    raw.client_reference_id !== accountId ||
    binding.accountId !== accountId ||
    binding.reservationId !== reservationId ||
    binding.planCode !== plan.code || customer !== expectedCustomerId ||
    raw.currency !== plan.currency ||
    !(integer(raw.amount_total) === plan.amount ||
      (trialEligible && plan.trialDays === 7 &&
        integer(raw.amount_total) === 0)) ||
    integer(raw.expires_at) !== expiresAtSeconds ||
    typeof customer !== "string" || !CUSTOMER_ID_RE.test(customer)
  ) throw new StripeBoundaryError(false);
  return {
    id,
    status,
    url,
    customerId: customer,
    expiresAt: expiresAtSeconds,
  };
}

export function assertCheckoutSession(
  raw: unknown,
  accountId: string,
  reservationId: string,
  expectedCustomerId: string,
  plan: BillingPlan,
  expiresAtSeconds: number,
  trialEligible: boolean,
): CheckoutSession {
  const session = assertCheckoutReservationSession(
    raw,
    accountId,
    reservationId,
    expectedCustomerId,
    plan,
    expiresAtSeconds,
    trialEligible,
  );
  if (session.status !== "open" || !session.url) {
    throw new StripeBoundaryError(false);
  }
  return {
    id: session.id,
    url: session.url,
    customerId: session.customerId,
    expiresAt: session.expiresAt,
  };
}

export function customerId(raw: unknown): string {
  if (typeof raw !== "string" || !CUSTOMER_ID_RE.test(raw)) {
    throw new PublicBillingError(
      409,
      "Complete checkout before opening billing settings",
    );
  }
  return raw;
}

export function portalForm(
  customer: string,
  appOrigin: string,
  portalConfigurationId: string,
): URLSearchParams {
  if (
    !CUSTOMER_ID_RE.test(customer) ||
    !PORTAL_CONFIGURATION_ID_RE.test(portalConfigurationId)
  ) throw new BillingConfigurationError();
  const form = new URLSearchParams();
  form.set("customer", customer);
  form.set("configuration", portalConfigurationId);
  form.set("return_url", fixedBillingUrls(appOrigin).portalReturn);
  return form;
}

export function assertCanonicalPortalConfiguration(
  raw: unknown,
  expectedConfigurationId: string,
): { id: string } {
  if (
    !isRecord(raw) ||
    !PORTAL_CONFIGURATION_ID_RE.test(expectedConfigurationId) ||
    raw.object !== "billing_portal.configuration" ||
    raw.id !== expectedConfigurationId || raw.livemode !== false ||
    raw.active !== true || !isRecord(raw.features) ||
    !isRecord(raw.login_page)
  ) throw new StripeBoundaryError(false);
  const features = raw.features;
  const customerUpdate = features.customer_update;
  const invoiceHistory = features.invoice_history;
  const paymentMethodUpdate = features.payment_method_update;
  const subscriptionCancel = features.subscription_cancel;
  const subscriptionPause = features.subscription_pause;
  const subscriptionUpdate = features.subscription_update;
  if (
    !isRecord(customerUpdate) || customerUpdate.enabled !== true ||
    !Array.isArray(customerUpdate.allowed_updates) ||
    customerUpdate.allowed_updates.length !== 2 ||
    [...customerUpdate.allowed_updates].sort().join("|") !== "address|name" ||
    !isRecord(invoiceHistory) || invoiceHistory.enabled !== true ||
    !isRecord(paymentMethodUpdate) || paymentMethodUpdate.enabled !== true ||
    !isRecord(subscriptionCancel) || subscriptionCancel.enabled !== true ||
    subscriptionCancel.mode !== "at_period_end" ||
    subscriptionCancel.proration_behavior !== "none" ||
    (subscriptionPause !== undefined &&
      (!isRecord(subscriptionPause) || subscriptionPause.enabled !== false)) ||
    !isRecord(subscriptionUpdate) || subscriptionUpdate.enabled !== false ||
    raw.login_page.enabled !== false
  ) throw new StripeBoundaryError(false);
  return { id: expectedConfigurationId };
}

export function assertPortalSession(
  raw: unknown,
  expectedCustomerId: string,
  expectedConfigurationId: string,
  expectedReturnUrl: string,
): { id: string; url: string } {
  let canonicalReturnUrl = "";
  try {
    canonicalReturnUrl = fixedBillingUrls(
      new URL(expectedReturnUrl).origin,
    ).portalReturn;
  } catch {
    throw new StripeBoundaryError(false);
  }
  if (
    !isRecord(raw) || typeof raw.id !== "string" ||
    !PORTAL_ID_RE.test(raw.id) ||
    !CUSTOMER_ID_RE.test(expectedCustomerId) ||
    !PORTAL_CONFIGURATION_ID_RE.test(expectedConfigurationId) ||
    canonicalReturnUrl !== expectedReturnUrl ||
    raw.object !== "billing_portal.session" || raw.livemode !== false ||
    raw.customer !== expectedCustomerId ||
    raw.configuration !== expectedConfigurationId ||
    raw.return_url !== expectedReturnUrl
  ) {
    throw new StripeBoundaryError(false);
  }
  return { id: raw.id, url: exactStripeUrl(raw.url, "billing.stripe.com") };
}

function idFromExpandable(value: unknown, pattern: RegExp): string | null {
  if (typeof value === "string" && pattern.test(value)) return value;
  if (
    isRecord(value) && typeof value.id === "string" && pattern.test(value.id)
  ) {
    return value.id;
  }
  return null;
}

function nullableTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = integer(value);
  if (result === null || result < 1 || result > 253_402_300_799) {
    throw new StripeBoundaryError(false);
  }
  return result;
}

export function stripeTimestampIso(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 253_402_300_799) {
    throw new StripeBoundaryError(false);
  }
  return new Date(value * 1000).toISOString();
}

function metadataBinding(raw: unknown, reservationRequired: boolean) {
  if (!isRecord(raw) || !isRecord(raw.metadata)) {
    throw new StripeBoundaryError(false);
  }
  const accountId = raw.metadata.account_id;
  const planCode = raw.metadata.plan_code;
  const reservationId = raw.metadata.reservation_id;
  if (
    typeof accountId !== "string" || !UUID_RE.test(accountId) ||
    typeof planCode !== "string" || !PLAN_CODE_RE.test(planCode) ||
    (reservationRequired &&
      (typeof reservationId !== "string" || !UUID_RE.test(reservationId))) ||
    (!reservationRequired && reservationId !== undefined &&
      (typeof reservationId !== "string" || !UUID_RE.test(reservationId)))
  ) throw new StripeBoundaryError(false);
  return {
    accountId,
    planCode,
    reservationId: typeof reservationId === "string" ? reservationId : null,
  };
}

export function canonicalPlanCode(raw: unknown): string {
  return metadataBinding(raw, false).planCode;
}

export type CanonicalCheckout = {
  accountId: string;
  reservationId: string;
  planCode: string;
  customerId: string;
  subscriptionId: string | null;
  sessionId: string;
  status: "open" | "complete" | "expired";
};

export function assertCanonicalCheckout(
  raw: unknown,
  expectedSessionId: string,
  plan: BillingPlan,
  trialVerified = false,
): CanonicalCheckout {
  if (!isRecord(raw) || !CHECKOUT_ID_RE.test(expectedSessionId)) {
    throw new StripeBoundaryError(false);
  }
  const binding = metadataBinding(raw, true);
  const customer = idFromExpandable(raw.customer, CUSTOMER_ID_RE);
  const subscription = idFromExpandable(raw.subscription, SUBSCRIPTION_ID_RE);
  const statuses = new Set(["open", "complete", "expired"]);
  const status = typeof raw.status === "string" && statuses.has(raw.status)
    ? raw.status as CanonicalCheckout["status"]
    : null;
  if (
    raw.object !== "checkout.session" || raw.id !== expectedSessionId ||
    raw.livemode !== false ||
    raw.mode !== "subscription" ||
    binding.accountId !== raw.client_reference_id ||
    binding.planCode !== plan.code || !customer || !status ||
    (status === "expired" ? raw.subscription !== null : !subscription) ||
    !["paid", "unpaid", "no_payment_required"].includes(
      String(raw.payment_status),
    ) ||
    raw.currency !== plan.currency ||
    !(integer(raw.amount_total) === plan.amount ||
      (trialVerified && plan.trialDays === 7 &&
        integer(raw.amount_total) === 0))
  ) throw new StripeBoundaryError(false);
  return {
    accountId: binding.accountId,
    reservationId: binding.reservationId!,
    planCode: binding.planCode,
    customerId: customer,
    subscriptionId: subscription,
    sessionId: expectedSessionId,
    status,
  };
}

const SUBSCRIPTION_STATUSES = new Set([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);

export type CanonicalSubscription = {
  accountId: string;
  planCode: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  status: string;
  trialStart: number | null;
  trialEnd: number | null;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  canceledAt: number | null;
  latestInvoiceId: string | null;
};

export function assertCanonicalSubscription(
  raw: unknown,
  expectedSubscriptionId: string,
  plan: BillingPlan,
  expectedAccountId?: string,
  expectedCustomerId?: string,
): CanonicalSubscription {
  if (!isRecord(raw) || !SUBSCRIPTION_ID_RE.test(expectedSubscriptionId)) {
    throw new StripeBoundaryError(false);
  }
  const binding = metadataBinding(raw, false);
  const customer = idFromExpandable(raw.customer, CUSTOMER_ID_RE);
  if (
    !isRecord(raw.items) || !Array.isArray(raw.items.data) ||
    raw.items.data.length !== 1
  ) {
    throw new StripeBoundaryError(false);
  }
  const item = raw.items.data[0];
  if (
    !isRecord(item) || !isRecord(item.price) || !isRecord(item.price.recurring)
  ) {
    throw new StripeBoundaryError(false);
  }
  const periodStart = nullableTimestamp(item.current_period_start);
  const periodEnd = nullableTimestamp(item.current_period_end);
  const trialStart = nullableTimestamp(raw.trial_start);
  const trialEnd = nullableTimestamp(raw.trial_end);
  const latestInvoiceId = raw.latest_invoice === null
    ? null
    : idFromExpandable(raw.latest_invoice, INVOICE_ID_RE);
  if (
    raw.object !== "subscription" || raw.id !== expectedSubscriptionId ||
    raw.livemode !== false ||
    !customer || binding.planCode !== plan.code ||
    (expectedAccountId !== undefined &&
      binding.accountId !== expectedAccountId) ||
    (expectedCustomerId !== undefined && customer !== expectedCustomerId) ||
    typeof raw.status !== "string" || !SUBSCRIPTION_STATUSES.has(raw.status) ||
    raw.cancel_at_period_end !== true && raw.cancel_at_period_end !== false ||
    periodStart === null || periodEnd === null || periodEnd <= periodStart ||
    (trialStart === null) !== (trialEnd === null) ||
    (trialStart !== null && trialEnd !== null &&
      trialEnd - trialStart !== plan.trialDays * 86_400) ||
    raw.items.has_more !== false ||
    (raw.items.total_count !== undefined &&
      integer(raw.items.total_count) !== 1) ||
    item.quantity !== 1 || item.price.id !== plan.priceId ||
    item.price.product !== plan.productId ||
    item.price.object !== "price" || item.price.livemode !== false ||
    item.price.type !== "recurring" ||
    item.price.billing_scheme !== "per_unit" ||
    item.price.currency !== plan.currency ||
    integer(item.price.unit_amount) !== plan.amount ||
    item.price.recurring.interval !== plan.interval ||
    integer(item.price.recurring.interval_count) !== plan.intervalCount ||
    (item.price.recurring.usage_type !== undefined &&
      item.price.recurring.usage_type !== "licensed") ||
    (raw.latest_invoice !== null && !latestInvoiceId)
  ) throw new StripeBoundaryError(false);
  return {
    accountId: binding.accountId,
    planCode: binding.planCode,
    customerId: customer,
    subscriptionId: expectedSubscriptionId,
    priceId: plan.priceId,
    status: raw.status,
    trialStart,
    trialEnd,
    periodStart,
    periodEnd,
    cancelAtPeriodEnd: raw.cancel_at_period_end,
    cancelAt: nullableTimestamp(raw.cancel_at),
    canceledAt: nullableTimestamp(raw.canceled_at),
    latestInvoiceId,
  };
}

const INVOICE_STATUSES = new Set([
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
]);

export type CanonicalInvoice = {
  id: string;
  status: string;
  paid: boolean;
  created: number;
  amountPaid: number;
  amountDue: number;
  amountRemaining: number;
  total: number;
  currency: string;
};

export function assertCanonicalInvoice(
  raw: unknown,
  expectedInvoiceId: string,
  subscriptionId: string,
  customerId: string,
): CanonicalInvoice {
  if (!isRecord(raw) || !INVOICE_ID_RE.test(expectedInvoiceId)) {
    throw new StripeBoundaryError(false);
  }
  const parent = raw.parent;
  const subscriptionFromParent =
    isRecord(parent) && isRecord(parent.subscription_details)
      ? idFromExpandable(
        parent.subscription_details.subscription,
        SUBSCRIPTION_ID_RE,
      )
      : null;
  const created = nullableTimestamp(raw.created);
  const amountPaid = integer(raw.amount_paid);
  const amountDue = integer(raw.amount_due);
  const amountRemaining = integer(raw.amount_remaining);
  const total = integer(raw.total);
  if (
    raw.object !== "invoice" || raw.id !== expectedInvoiceId ||
    raw.livemode !== false ||
    idFromExpandable(raw.customer, CUSTOMER_ID_RE) !== customerId ||
    subscriptionFromParent !== subscriptionId || created === null ||
    typeof raw.status !== "string" || !INVOICE_STATUSES.has(raw.status) ||
    typeof raw.paid !== "boolean" || raw.paid !== (raw.status === "paid") ||
    amountPaid === null || amountPaid < 0 || amountPaid > 1_000_000_000 ||
    amountDue === null || amountDue < 0 || amountDue > 1_000_000_000 ||
    amountRemaining === null || amountRemaining < 0 ||
    amountRemaining > 1_000_000_000 || total === null || total < 0 ||
    total > 1_000_000_000 || typeof raw.currency !== "string" ||
    !/^[a-z]{3}$/.test(raw.currency) ||
    (raw.status === "paid" && amountRemaining !== 0)
  ) throw new StripeBoundaryError(false);
  return {
    id: expectedInvoiceId,
    status: raw.status,
    paid: raw.status === "paid",
    created,
    amountPaid,
    amountDue,
    amountRemaining,
    total,
    currency: raw.currency,
  };
}

export function assertRefundablePaidInvoice(
  invoice: CanonicalInvoice,
  expectedAmount: number,
  expectedCurrency: string,
) {
  if (
    !Number.isSafeInteger(expectedAmount) || expectedAmount < 1 ||
    expectedAmount > 1_000_000_000 || !/^[a-z]{3}$/.test(expectedCurrency) ||
    !invoice.paid || invoice.status !== "paid" ||
    invoice.amountPaid !== expectedAmount ||
    invoice.amountDue !== expectedAmount ||
    invoice.total !== expectedAmount || invoice.amountRemaining !== 0 ||
    invoice.currency !== expectedCurrency
  ) throw new StripeBoundaryError(false);
  return invoice;
}

export function canonicalInvoiceReferences(
  raw: unknown,
  expectedInvoiceId: string,
) {
  if (!isRecord(raw) || !INVOICE_ID_RE.test(expectedInvoiceId)) {
    throw new StripeBoundaryError(false);
  }
  const parent = raw.parent;
  const subscriptionId =
    isRecord(parent) && isRecord(parent.subscription_details)
      ? idFromExpandable(
        parent.subscription_details.subscription,
        SUBSCRIPTION_ID_RE,
      )
      : null;
  const customerId = idFromExpandable(raw.customer, CUSTOMER_ID_RE);
  if (
    raw.object !== "invoice" || raw.id !== expectedInvoiceId ||
    raw.livemode !== false ||
    !subscriptionId || !customerId
  ) throw new StripeBoundaryError(false);
  return { subscriptionId, customerId };
}

export type CanonicalCharge = {
  id: string;
  customerId: string;
  paymentIntentId: string;
};

export function assertCanonicalCharge(
  raw: unknown,
  expectedChargeId: string,
  expectedPaymentIntentId?: string | null,
): CanonicalCharge {
  if (!isRecord(raw) || !CHARGE_ID_RE.test(expectedChargeId)) {
    throw new StripeBoundaryError(false);
  }
  const customerId = idFromExpandable(raw.customer, CUSTOMER_ID_RE);
  const paymentIntentId = idFromExpandable(
    raw.payment_intent,
    PAYMENT_INTENT_ID_RE,
  );
  if (
    raw.object !== "charge" || raw.id !== expectedChargeId ||
    raw.livemode !== false || !customerId || !paymentIntentId ||
    (expectedPaymentIntentId !== undefined &&
      paymentIntentId !== expectedPaymentIntentId)
  ) throw new StripeBoundaryError(false);
  return { id: expectedChargeId, customerId, paymentIntentId };
}

export type CanonicalRefund = {
  id: string;
  chargeId: string;
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  reason: "duplicate" | "fraudulent" | "requested_by_customer" | null;
  remediationId: string | null;
};

export function assertCanonicalRefund(
  raw: unknown,
  expectedRefundId: string,
): CanonicalRefund {
  if (!isRecord(raw) || !REFUND_ID_RE.test(expectedRefundId)) {
    throw new StripeBoundaryError(false);
  }
  const chargeId = idFromExpandable(raw.charge, CHARGE_ID_RE);
  const paymentIntentId = raw.payment_intent === null
    ? null
    : idFromExpandable(raw.payment_intent, PAYMENT_INTENT_ID_RE);
  const amount = integer(raw.amount);
  const statuses = new Set([
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "canceled",
  ]);
  const reasons = new Set(["duplicate", "fraudulent", "requested_by_customer"]);
  const metadata = raw.metadata;
  const remediationValue = isRecord(metadata)
    ? metadata.mypersonas_remediation_id
    : undefined;
  const remediationId = remediationValue === undefined
    ? null
    : remediationValue;
  if (
    raw.object !== "refund" || raw.id !== expectedRefundId ||
    raw.livemode !== false || !chargeId ||
    (raw.payment_intent !== null && !paymentIntentId) || amount === null ||
    amount < 1 || amount > 1_000_000_000 ||
    typeof raw.currency !== "string" || !/^[a-z]{3}$/.test(raw.currency) ||
    typeof raw.status !== "string" || !statuses.has(raw.status) ||
    (raw.reason !== null &&
      (typeof raw.reason !== "string" || !reasons.has(raw.reason))) ||
    !isRecord(metadata) ||
    (remediationId !== null &&
      (typeof remediationId !== "string" || !UUID_RE.test(remediationId)))
  ) throw new StripeBoundaryError(false);
  return {
    id: expectedRefundId,
    chargeId,
    paymentIntentId,
    amount,
    currency: raw.currency,
    status: raw.status as CanonicalRefund["status"],
    reason: raw.reason as CanonicalRefund["reason"],
    remediationId: remediationId as string | null,
  };
}

export type CanonicalDispute = {
  id: string;
  chargeId: string;
  paymentIntentId: string | null;
};

export function assertCanonicalDispute(
  raw: unknown,
  expectedDisputeId: string,
): CanonicalDispute {
  if (!isRecord(raw) || !DISPUTE_ID_RE.test(expectedDisputeId)) {
    throw new StripeBoundaryError(false);
  }
  const chargeId = idFromExpandable(raw.charge, CHARGE_ID_RE);
  const paymentIntentId = raw.payment_intent === null
    ? null
    : idFromExpandable(raw.payment_intent, PAYMENT_INTENT_ID_RE);
  if (
    raw.object !== "dispute" || raw.id !== expectedDisputeId ||
    raw.livemode !== false || !chargeId ||
    (raw.payment_intent !== null && !paymentIntentId)
  ) throw new StripeBoundaryError(false);
  return { id: expectedDisputeId, chargeId, paymentIntentId };
}

export type CanonicalInvoicePayment = {
  id: string;
  invoiceId: string;
};

export function assertCanonicalInvoicePaymentList(
  raw: unknown,
  expectedPaymentIntentId: string,
): CanonicalInvoicePayment {
  if (!isRecord(raw) || !PAYMENT_INTENT_ID_RE.test(expectedPaymentIntentId)) {
    throw new StripeBoundaryError(false);
  }
  if (
    raw.object !== "list" || raw.has_more !== false ||
    raw.url !== "/v1/invoice_payments" || !Array.isArray(raw.data) ||
    raw.data.length !== 1
  ) throw new StripeBoundaryError(false);
  const row = raw.data[0];
  if (!isRecord(row) || !isRecord(row.payment)) {
    throw new StripeBoundaryError(false);
  }
  const invoiceId = idFromExpandable(row.invoice, INVOICE_ID_RE);
  const paymentIntentId = idFromExpandable(
    row.payment.payment_intent,
    PAYMENT_INTENT_ID_RE,
  );
  if (
    row.object !== "invoice_payment" || typeof row.id !== "string" ||
    !INVOICE_PAYMENT_ID_RE.test(row.id) || row.livemode !== false ||
    row.payment.type !== "payment_intent" ||
    paymentIntentId !== expectedPaymentIntentId || !invoiceId ||
    !["open", "paid", "canceled"].includes(String(row.status))
  ) throw new StripeBoundaryError(false);
  return { id: row.id, invoiceId };
}

export type CanonicalRefundInvoicePayment = {
  id: string;
  invoiceId: string;
  paymentIntentId: string;
  amountPaid: number;
  currency: string;
};

export function assertCanonicalInvoicePaymentListForRefund(
  raw: unknown,
  expectedInvoiceId: string,
  expectedAmount: number,
  expectedCurrency: string,
): CanonicalRefundInvoicePayment {
  if (
    !INVOICE_ID_RE.test(expectedInvoiceId) ||
    !Number.isSafeInteger(expectedAmount) || expectedAmount < 1 ||
    expectedAmount > 1_000_000_000 || !/^[a-z]{3}$/.test(expectedCurrency) ||
    !isRecord(raw) || raw.object !== "list" ||
    raw.url !== "/v1/invoice_payments" || raw.has_more !== false ||
    !Array.isArray(raw.data) || raw.data.length !== 1
  ) throw new StripeBoundaryError(false);
  const row = raw.data[0];
  if (!isRecord(row) || !isRecord(row.payment)) {
    throw new StripeBoundaryError(false);
  }
  const invoiceId = idFromExpandable(row.invoice, INVOICE_ID_RE);
  const paymentIntentId = idFromExpandable(
    row.payment.payment_intent,
    PAYMENT_INTENT_ID_RE,
  );
  const amountPaid = integer(row.amount_paid);
  const amountRequested = integer(row.amount_requested);
  if (
    row.object !== "invoice_payment" || typeof row.id !== "string" ||
    !INVOICE_PAYMENT_ID_RE.test(row.id) || row.livemode !== false ||
    invoiceId !== expectedInvoiceId || row.payment.type !== "payment_intent" ||
    !paymentIntentId || row.status !== "paid" || row.is_default !== true ||
    amountPaid !== expectedAmount || amountRequested !== expectedAmount ||
    row.currency !== expectedCurrency
  ) throw new StripeBoundaryError(false);
  return {
    id: row.id,
    invoiceId,
    paymentIntentId,
    amountPaid,
    currency: expectedCurrency,
  };
}

export type CanonicalPaymentIntent = {
  id: string;
  customerId: string;
  chargeId: string;
  amount: number;
  currency: string;
};

export function assertCanonicalPaymentIntentForRefund(
  raw: unknown,
  expectedPaymentIntentId: string,
  expectedCustomerId: string,
  expectedAmount: number,
  expectedCurrency: string,
): CanonicalPaymentIntent {
  if (
    !isRecord(raw) || !PAYMENT_INTENT_ID_RE.test(expectedPaymentIntentId) ||
    !CUSTOMER_ID_RE.test(expectedCustomerId) ||
    !Number.isSafeInteger(expectedAmount) || expectedAmount < 1 ||
    expectedAmount > 1_000_000_000 || !/^[a-z]{3}$/.test(expectedCurrency)
  ) throw new StripeBoundaryError(false);
  const customerId = idFromExpandable(raw.customer, CUSTOMER_ID_RE);
  const chargeId = idFromExpandable(raw.latest_charge, CHARGE_ID_RE);
  if (
    raw.object !== "payment_intent" || raw.id !== expectedPaymentIntentId ||
    raw.livemode !== false || customerId !== expectedCustomerId || !chargeId ||
    integer(raw.amount) !== expectedAmount ||
    integer(raw.amount_received) !== expectedAmount ||
    raw.currency !== expectedCurrency || raw.status !== "succeeded" ||
    raw.canceled_at !== null || raw.cancellation_reason !== null
  ) throw new StripeBoundaryError(false);
  return {
    id: expectedPaymentIntentId,
    customerId,
    chargeId,
    amount: expectedAmount,
    currency: expectedCurrency,
  };
}

function chargeRefundList(raw: JsonRecord, expectedChargeId: string) {
  const refunds = raw.refunds;
  if (
    !isRecord(refunds) || refunds.object !== "list" ||
    refunds.has_more !== false || !Array.isArray(refunds.data) ||
    refunds.url !== `/v1/charges/${expectedChargeId}/refunds`
  ) throw new StripeBoundaryError(false);
  return refunds.data;
}

export function assertCanonicalRefundableCharge(
  raw: unknown,
  expectedChargeId: string,
  expectedPaymentIntentId: string,
  expectedCustomerId: string,
  expectedAmount: number,
  expectedCurrency: string,
) {
  const charge = assertCanonicalCharge(
    raw,
    expectedChargeId,
    expectedPaymentIntentId,
  );
  if (!isRecord(raw)) throw new StripeBoundaryError(false);
  if (
    charge.customerId !== expectedCustomerId ||
    integer(raw.amount) !== expectedAmount ||
    integer(raw.amount_captured) !== expectedAmount ||
    integer(raw.amount_refunded) !== 0 || raw.currency !== expectedCurrency ||
    raw.paid !== true || raw.captured !== true || raw.refunded !== false ||
    raw.disputed !== false || raw.failure_code !== null ||
    raw.failure_message !== null ||
    chargeRefundList(raw, expectedChargeId).length !== 0
  ) throw new StripeBoundaryError(false);
  return { ...charge, amount: expectedAmount, currency: expectedCurrency };
}

export function assertCanonicalDuplicateRefund(
  raw: unknown,
  expectedRemediationId: string,
  expectedChargeId: string,
  expectedPaymentIntentId: string,
  expectedAmount: number,
  expectedCurrency: string,
): CanonicalRefund {
  if (!isRecord(raw) || typeof raw.id !== "string") {
    throw new StripeBoundaryError(false);
  }
  const refund = assertCanonicalRefund(raw, raw.id);
  if (
    !UUID_RE.test(expectedRemediationId) ||
    refund.remediationId !== expectedRemediationId ||
    refund.chargeId !== expectedChargeId ||
    refund.paymentIntentId !== expectedPaymentIntentId ||
    refund.amount !== expectedAmount || refund.currency !== expectedCurrency ||
    refund.reason !== "duplicate"
  ) throw new StripeBoundaryError(false);
  return refund;
}

export function assertCanonicalDuplicateRefundList(
  raw: unknown,
  expectedRemediationId: string,
  expectedChargeId: string,
  expectedPaymentIntentId: string,
  expectedAmount: number,
  expectedCurrency: string,
): CanonicalRefund | null {
  if (
    !isRecord(raw) || raw.object !== "list" || raw.url !== "/v1/refunds" ||
    raw.has_more !== false || !Array.isArray(raw.data) || raw.data.length > 1
  ) throw new StripeBoundaryError(false);
  if (raw.data.length === 0) return null;
  return assertCanonicalDuplicateRefund(
    raw.data[0],
    expectedRemediationId,
    expectedChargeId,
    expectedPaymentIntentId,
    expectedAmount,
    expectedCurrency,
  );
}

export function assertCanonicalChargeForDuplicateRefundRecovery(
  raw: unknown,
  expectedCustomerId: string,
  expectedAmount: number,
  expectedCurrency: string,
  refund: CanonicalRefund,
) {
  const charge = assertCanonicalCharge(
    raw,
    refund.chargeId,
    refund.paymentIntentId,
  );
  if (!isRecord(raw)) throw new StripeBoundaryError(false);
  const refunds = chargeRefundList(raw, charge.id);
  const amountRefunded = integer(raw.amount_refunded);
  const completed = refund.status === "succeeded";
  if (
    charge.customerId !== expectedCustomerId ||
    integer(raw.amount) !== expectedAmount ||
    integer(raw.amount_captured) !== expectedAmount ||
    raw.currency !== expectedCurrency || raw.paid !== true ||
    raw.captured !== true || raw.disputed !== false ||
    raw.failure_code !== null || raw.failure_message !== null ||
    refunds.length !== 1 || !isRecord(refunds[0]) ||
    refunds[0].id !== refund.id ||
    (completed &&
      (amountRefunded !== expectedAmount || raw.refunded !== true)) ||
    (!completed && (amountRefunded !== 0 || raw.refunded !== false))
  ) throw new StripeBoundaryError(false);
  assertCanonicalDuplicateRefund(
    refunds[0],
    refund.remediationId ?? "",
    refund.chargeId,
    refund.paymentIntentId ?? "",
    expectedAmount,
    expectedCurrency,
  );
  return { ...charge, amount: expectedAmount, currency: expectedCurrency };
}

export function assertCanonicalExpectedRefundedCharge(
  raw: unknown,
  expectedChargeId: string,
): { charge: CanonicalCharge; refund: CanonicalRefund } {
  const charge = assertCanonicalCharge(raw, expectedChargeId);
  if (!isRecord(raw)) throw new StripeBoundaryError(false);
  const amount = integer(raw.amount);
  const captured = integer(raw.amount_captured);
  const refunded = integer(raw.amount_refunded);
  const refunds = chargeRefundList(raw, expectedChargeId);
  if (
    amount === null || amount < 1 || amount > 1_000_000_000 ||
    captured !== amount || refunded !== amount ||
    typeof raw.currency !== "string" || !/^[a-z]{3}$/.test(raw.currency) ||
    raw.paid !== true || raw.captured !== true || raw.refunded !== true ||
    raw.disputed !== false || refunds.length !== 1
  ) throw new StripeBoundaryError(false);
  const refundRaw = refunds[0];
  if (!isRecord(refundRaw) || typeof refundRaw.id !== "string") {
    throw new StripeBoundaryError(false);
  }
  const refund = assertCanonicalRefund(refundRaw, refundRaw.id);
  if (
    refund.chargeId !== charge.id ||
    refund.paymentIntentId !== charge.paymentIntentId ||
    refund.amount !== amount || refund.currency !== raw.currency ||
    refund.status !== "succeeded" || refund.reason !== "duplicate" ||
    refund.remediationId === null
  ) throw new StripeBoundaryError(false);
  return { charge, refund };
}

const CHECKOUT_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);
const SUBSCRIPTION_EVENT_TYPES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.trial_will_end",
]);
const INVOICE_EVENT_TYPES = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
]);
const REVIEW_REQUIRED_EVENT_TYPES = new Set([
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "refund.created",
  "refund.updated",
  "refund.failed",
]);

export type StripeEventEnvelope = {
  id: string;
  type: string;
  created: number;
  apiVersion: string;
  livemode: false;
  object: JsonRecord;
  group:
    | "checkout"
    | "subscription"
    | "invoice"
    | "review_required"
    | "ignored";
  objectId: string;
};

export function parseStripeEvent(rawText: string): StripeEventEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new PublicBillingError(400, "Invalid webhook payload");
  }
  if (!isRecord(raw) || !isRecord(raw.data) || !isRecord(raw.data.object)) {
    throw new PublicBillingError(400, "Invalid webhook payload");
  }
  if (
    raw.object !== "event" || typeof raw.id !== "string" ||
    !EVENT_ID_RE.test(raw.id) ||
    typeof raw.type !== "string" || raw.type.length > 160 ||
    !Number.isSafeInteger(raw.created) || Number(raw.created) < 1 ||
    Number(raw.created) > Math.floor(Date.now() / 1000) + 300 ||
    raw.livemode !== false || raw.api_version !== STRIPE_API_VERSION ||
    (raw.account !== undefined && raw.account !== null) ||
    (raw.context !== undefined && raw.context !== null)
  ) {
    throw new PublicBillingError(400, "Invalid webhook payload");
  }
  const object = raw.data.object;
  let group: StripeEventEnvelope["group"] = "ignored";
  let objectId = "";
  if (CHECKOUT_EVENT_TYPES.has(raw.type)) {
    if (
      object.object !== "checkout.session" || typeof object.id !== "string" ||
      !CHECKOUT_ID_RE.test(object.id) || object.livemode !== false
    ) throw new PublicBillingError(400, "Invalid webhook payload");
    group = "checkout";
    objectId = object.id;
  } else if (SUBSCRIPTION_EVENT_TYPES.has(raw.type)) {
    if (
      object.object !== "subscription" || typeof object.id !== "string" ||
      !SUBSCRIPTION_ID_RE.test(object.id) || object.livemode !== false
    ) throw new PublicBillingError(400, "Invalid webhook payload");
    group = "subscription";
    objectId = object.id;
  } else if (INVOICE_EVENT_TYPES.has(raw.type)) {
    if (
      object.object !== "invoice" || typeof object.id !== "string" ||
      !INVOICE_ID_RE.test(object.id) || object.livemode !== false
    ) throw new PublicBillingError(400, "Invalid webhook payload");
    group = "invoice";
    objectId = object.id;
  } else if (REVIEW_REQUIRED_EVENT_TYPES.has(raw.type)) {
    group = "review_required";
    const expectedObject = raw.type === "charge.refunded"
      ? ["charge", CHARGE_ID_RE]
      : raw.type.startsWith("charge.dispute.")
      ? ["dispute", DISPUTE_ID_RE]
      : ["refund", REFUND_ID_RE];
    if (
      object.object !== expectedObject[0] || typeof object.id !== "string" ||
      !(expectedObject[1] as RegExp).test(object.id) ||
      object.livemode !== false
    ) throw new PublicBillingError(400, "Invalid webhook payload");
    objectId = object.id;
  } else {
    const candidate = object.id;
    objectId = typeof candidate === "string" && candidate.length <= 255
      ? candidate
      : "ignored";
  }
  return {
    id: raw.id,
    type: raw.type,
    created: Number(raw.created),
    apiVersion: raw.api_version as string,
    livemode: false,
    object,
    group,
    objectId,
  };
}

export type ReconciliationCandidate = {
  accountId: string;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  planCode: string;
  status: string;
  trialStart: number | null;
  trialEnd: number | null;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  cancelAt: number | null;
  canceledAt: number | null;
  invoiceId: string | null;
  invoiceStatus: string;
  invoicePaid: boolean;
  livemode: false;
  lastEventCreatedAt: number;
};

function reconciliationTimestamp(
  value: unknown,
  nullable: boolean,
): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || value.length < 20 || value.length > 64) {
    throw new StripeBoundaryError(false);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) || milliseconds < 1_000 ||
    milliseconds > 253_402_300_799_000 || milliseconds % 1000 !== 0
  ) throw new StripeBoundaryError(false);
  return milliseconds / 1000;
}

export function reconciliationCandidates(
  raw: unknown,
  limit: number,
): ReconciliationCandidate[] {
  if (!Array.isArray(raw) || raw.length > limit) {
    throw new StripeBoundaryError(false);
  }
  return raw.map((value) => {
    if (!isRecord(value)) throw new StripeBoundaryError(false);
    const trialStart = reconciliationTimestamp(value.trial_start, true);
    const trialEnd = reconciliationTimestamp(value.trial_end, true);
    const periodStart = reconciliationTimestamp(
      value.current_period_start,
      false,
    );
    const periodEnd = reconciliationTimestamp(value.current_period_end, false);
    const cancelAt = reconciliationTimestamp(value.cancel_at, true);
    const canceledAt = reconciliationTimestamp(value.canceled_at, true);
    const lastEventCreatedAt = reconciliationTimestamp(
      value.last_event_created_at,
      false,
    );
    const invoiceId = value.latest_invoice_id;
    const invoiceStatus = value.latest_invoice_status;
    if (
      typeof value.account_id !== "string" || !UUID_RE.test(value.account_id) ||
      typeof value.stripe_customer_id !== "string" ||
      !CUSTOMER_ID_RE.test(value.stripe_customer_id) ||
      typeof value.stripe_subscription_id !== "string" ||
      !SUBSCRIPTION_ID_RE.test(value.stripe_subscription_id) ||
      typeof value.stripe_price_id !== "string" ||
      !PRICE_ID_RE.test(value.stripe_price_id) ||
      typeof value.plan_code !== "string" ||
      !PLAN_CODE_RE.test(value.plan_code) ||
      typeof value.subscription_status !== "string" ||
      !SUBSCRIPTION_STATUSES.has(value.subscription_status) ||
      periodStart === null || periodEnd === null || periodEnd <= periodStart ||
      typeof value.cancel_at_period_end !== "boolean" ||
      !(invoiceId === null ||
        (typeof invoiceId === "string" && INVOICE_ID_RE.test(invoiceId))) ||
      typeof invoiceStatus !== "string" ||
      !(invoiceStatus === "" || INVOICE_STATUSES.has(invoiceStatus)) ||
      typeof value.latest_invoice_paid !== "boolean" ||
      (invoiceId === null &&
        (invoiceStatus !== "" || value.latest_invoice_paid)) ||
      value.livemode !== false || lastEventCreatedAt === null ||
      lastEventCreatedAt > Math.floor(Date.now() / 1000) + 300
    ) throw new StripeBoundaryError(false);
    return {
      accountId: value.account_id,
      customerId: value.stripe_customer_id,
      subscriptionId: value.stripe_subscription_id,
      priceId: value.stripe_price_id,
      planCode: value.plan_code,
      status: value.subscription_status,
      trialStart,
      trialEnd,
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: value.cancel_at_period_end,
      cancelAt,
      canceledAt,
      invoiceId: invoiceId as string | null,
      invoiceStatus,
      invoicePaid: value.latest_invoice_paid,
      livemode: false,
      lastEventCreatedAt,
    };
  });
}

export function reconciliationPath(candidate: ReconciliationCandidate): string {
  return `/v1/subscriptions/${encodeURIComponent(candidate.subscriptionId)}`;
}

export function assertReconciliationObject(
  raw: unknown,
  candidate: ReconciliationCandidate,
): JsonRecord {
  if (
    !isRecord(raw) || raw.livemode !== false ||
    raw.id !== candidate.subscriptionId
  ) {
    throw new StripeBoundaryError(false);
  }
  if (raw.object !== "subscription") throw new StripeBoundaryError(false);
  return raw;
}

export function reconciliationMatches(
  candidate: ReconciliationCandidate,
  subscription: CanonicalSubscription,
  invoice: CanonicalInvoice | null,
): boolean {
  return candidate.accountId === subscription.accountId &&
    candidate.customerId === subscription.customerId &&
    candidate.subscriptionId === subscription.subscriptionId &&
    candidate.priceId === subscription.priceId &&
    candidate.planCode === subscription.planCode &&
    candidate.status === subscription.status &&
    candidate.trialStart === subscription.trialStart &&
    candidate.trialEnd === subscription.trialEnd &&
    candidate.periodStart === subscription.periodStart &&
    candidate.periodEnd === subscription.periodEnd &&
    candidate.cancelAtPeriodEnd === subscription.cancelAtPeriodEnd &&
    candidate.cancelAt === subscription.cancelAt &&
    candidate.canceledAt === subscription.canceledAt &&
    candidate.invoiceId === (invoice?.id ?? null) &&
    candidate.invoiceStatus === (invoice?.status ?? "") &&
    candidate.invoicePaid === (invoice?.paid ?? false) &&
    candidate.livemode === false;
}
