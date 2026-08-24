#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(
  root,
  "tests/fixtures/billing-sandbox-lifecycle-matrix.json",
);

const REQUIRED_EVENTS = Object.freeze([
  "charge.dispute.closed",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.refunded",
  "checkout.session.async_payment_failed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "customer.subscription.updated",
  "invoice.finalization_failed",
  "invoice.paid",
  "invoice.payment_action_required",
  "invoice.payment_failed",
  "refund.created",
  "refund.failed",
  "refund.updated",
]);

const PLAN_EXPECTATIONS = Object.freeze({
  account_weekly: Object.freeze({
    amount: 2_000,
    currency: "usd",
    interval: "week",
    intervalCount: 1,
    trialDays: 7,
  }),
  account_monthly: Object.freeze({
    amount: 5_000,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
    trialDays: 7,
  }),
  account_yearly: Object.freeze({
    amount: 33_300,
    currency: "usd",
    interval: "year",
    intervalCount: 1,
    trialDays: 7,
  }),
});

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Could not read valid JSON at ${path}: ${error.message}`);
  }
}

function parseArgs(raw) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (!name) fail("Empty option name");
    if (inline !== undefined) {
      options.set(name, inline);
      continue;
    }
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(name, true);
      continue;
    }
    options.set(name, next);
    index += 1;
  }
  return { positional, options };
}

function option(options, name, fallback = undefined) {
  const value = options.get(name);
  return value === undefined ? fallback : value;
}

function assertAlias(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{2,48}$/.test(value)) {
    fail(`${label} must be a non-identifying lowercase alias`);
  }
  return value;
}

function assertIso(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function stringsIn(value, path = "evidence") {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      stringsIn(entry, `${path}[${index}]`)
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      stringsIn(entry, `${path}.${key}`)
    );
  }
  return [];
}

function assertRedacted(evidence) {
  const forbiddenKeys =
    /(?:^|\.)(?:access_?token|refresh_?token|secret|password|email|phone|stripe_?(?:customer|subscription|invoice|price|product|event|charge|refund|dispute)_?id)$/i;
  const forbiddenValues = [
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "email address"],
    [/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]{8,}\b/, "Stripe API key"],
    [/\bwhsec_[A-Za-z0-9_]{8,}\b/, "webhook secret"],
    [/\b(?:sb_secret|sb_publishable)_[A-Za-z0-9_-]{8,}\b/, "Supabase key"],
    [
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      "JWT",
    ],
    [/\bBearer\s+[A-Za-z0-9._~-]{8,}/i, "bearer credential"],
    [
      /\b(?:cus|sub|price|prod|in|evt|cs|re|du|ch|pi)_[A-Za-z0-9]{8,}\b/,
      "Stripe object identifier",
    ],
    [
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
      "UUID",
    ],
    [/\+\d{8,15}\b/, "phone number"],
  ];
  for (const { path, value } of stringsIn(evidence)) {
    if (forbiddenKeys.test(path)) {
      fail(`${path} uses a forbidden evidence field`);
    }
    for (const [pattern, description] of forbiddenValues) {
      if (pattern.test(value)) {
        fail(`${path} contains a ${description}; redact it`);
      }
    }
  }
}

function matrixIds(matrix) {
  const ids = new Set();
  for (const entry of matrix.cases ?? []) {
    if (!/^[A-Z]{3,5}-\d{3}$/.test(entry.id ?? "")) {
      fail(`Invalid matrix case id: ${String(entry.id)}`);
    }
    if (ids.has(entry.id)) fail(`Duplicate matrix case id: ${entry.id}`);
    ids.add(entry.id);
  }
  if (ids.size < 50) fail("Lifecycle matrix is unexpectedly incomplete");
  return ids;
}

function validateMatrix(matrix) {
  if (matrix.schemaVersion !== 1 || typeof matrix.matrixVersion !== "string") {
    fail("Unsupported lifecycle matrix schema");
  }
  const ids = matrixIds(matrix);
  const areas = new Set();
  for (const entry of matrix.cases) {
    for (const field of ["area", "mode", "title"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length < 3) {
        fail(`${entry.id} has an invalid ${field}`);
      }
    }
    areas.add(entry.area);
    if (!Array.isArray(entry.actors) || entry.actors.length === 0) {
      fail(`${entry.id} has no actors`);
    }
    for (const actor of entry.actors) {
      if (!matrix.requiredActorAliases?.includes(actor)) {
        fail(`${entry.id} has unknown actor ${String(actor)}`);
      }
    }
    if (!Array.isArray(entry.devices) || entry.devices.length === 0) {
      fail(`${entry.id} has no devices`);
    }
    for (const device of entry.devices) {
      if (!matrix.requiredDeviceClasses?.includes(device)) {
        fail(`${entry.id} has unknown device ${String(device)}`);
      }
    }
    for (const key of ["actions", "expected", "evidence"]) {
      if (!Array.isArray(entry[key]) || entry[key].length === 0) {
        fail(`${entry.id} has no ${key}`);
      }
    }
  }
  const requiredAreas = [
    "configuration",
    "plan-lifecycle",
    "payments",
    "webhooks",
    "financial-review",
    "races-and-idempotency",
    "trial-abuse",
    "developer-access",
    "entitlements",
    "mobile-and-session",
    "two-account-privacy",
    "deletion-and-retention",
    "operations",
  ];
  for (const area of requiredAreas) {
    if (!areas.has(area)) fail(`Lifecycle matrix is missing ${area}`);
  }
  return ids;
}

function evidenceTemplate(matrix, options) {
  const now = new Date().toISOString();
  const runId = assertAlias(
    String(option(options, "run-id", `billing-qa-${now.slice(0, 10)}`)),
    "run-id",
  );
  const origin = String(
    option(options, "origin", "https://staging.example.invalid"),
  );
  const projectRefSuffix = String(
    option(options, "project-ref-suffix", "replace"),
  );
  return {
    schemaVersion: 1,
    matrixVersion: matrix.matrixVersion,
    runId,
    environment: {
      targetAlias: "billing-staging",
      appOrigin: origin,
      supabaseProjectRefSuffix: projectRefSuffix,
      stripeMode: "test",
      enforcementEnabled: true,
      checkoutEnabled: true,
    },
    startedAt: now,
    completedAt: null,
    actors: Object.fromEntries(
      matrix.requiredActorAliases.map((alias) => [
        alias,
        {
          alias,
          unrelatedTo: alias === "viewer-b"
            ? ["owner-a", "owner-monthly", "owner-yearly", "deletion-fixture"]
            : [],
          aal2: false,
        },
      ]),
    ),
    devices: {
      desktop: {
        alias: "desktop",
        physical: true,
        os: "replace",
        browser: "replace",
      },
      "ios-mobile": {
        alias: "ios-mobile",
        physical: true,
        os: "replace",
        browser: "Safari",
      },
      "android-mobile": {
        alias: "android-mobile",
        physical: true,
        os: "replace",
        browser: "Chrome",
      },
    },
    cases: Object.fromEntries(
      matrix.cases.map((entry) => [
        entry.id,
        {
          status: "not-run",
          executedAt: null,
          testerAlias: null,
          actorAliases: [],
          deviceClasses: [],
          observation: "",
          artifacts: [],
        },
      ]),
    ),
  };
}

function assertArtifact(artifact, caseId, index) {
  if (!artifact || typeof artifact !== "object") {
    fail(`${caseId} artifact ${index} is invalid`);
  }
  if (
    ![
      "screenshot",
      "network-summary",
      "query-summary",
      "timeline",
      "log-summary",
      "other",
    ].includes(artifact.kind)
  ) {
    fail(`${caseId} artifact ${index} has an invalid kind`);
  }
  if (
    typeof artifact.path !== "string" ||
    artifact.path.length < 3 ||
    isAbsolute(artifact.path) ||
    artifact.path.split(/[\\/]/).includes("..")
  ) {
    fail(
      `${caseId} artifact ${index} path must be relative and traversal-free`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
    fail(`${caseId} artifact ${index} needs a lowercase SHA-256 digest`);
  }
}

function validateEvidence(matrix, evidence, { requireComplete }) {
  validateMatrix(matrix);
  if (
    evidence.schemaVersion !== 1 ||
    evidence.matrixVersion !== matrix.matrixVersion
  ) {
    fail("Evidence schema or matrix version does not match the current matrix");
  }
  assertAlias(evidence.runId, "runId");
  const environment = evidence.environment ?? {};
  if (environment.targetAlias !== "billing-staging") {
    fail("Evidence targetAlias must be billing-staging");
  }
  let origin;
  try {
    origin = new URL(environment.appOrigin);
  } catch {
    fail("Evidence appOrigin must be an absolute staging URL");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    /(?:^|\.)mypersonas\.online$/i.test(origin.hostname)
  ) {
    fail("Evidence appOrigin must be a clean HTTPS non-production origin");
  }
  if (
    !/^[a-z0-9]{6,12}$/.test(environment.supabaseProjectRefSuffix ?? "") ||
    matrix.productionProjectRef.endsWith(environment.supabaseProjectRefSuffix)
  ) {
    fail("Evidence must contain only a non-production Supabase ref suffix");
  }
  if (
    requireComplete &&
    (/^replace$/i.test(environment.supabaseProjectRefSuffix) ||
      /\.invalid$/i.test(origin.hostname))
  ) {
    fail("Evidence staging target still contains placeholder metadata");
  }
  if (environment.stripeMode !== "test") {
    fail("Evidence must be Stripe test mode");
  }
  if (
    environment.enforcementEnabled !== true ||
    environment.checkoutEnabled !== true
  ) {
    fail(
      "The executable sandbox matrix requires both staging billing gates enabled",
    );
  }
  assertIso(evidence.startedAt, "startedAt");
  if (requireComplete) assertIso(evidence.completedAt, "completedAt");

  for (const alias of matrix.requiredActorAliases) {
    const actor = evidence.actors?.[alias];
    if (!actor || actor.alias !== alias) fail(`Missing actor alias ${alias}`);
  }
  const unrelated = evidence.actors?.["viewer-b"]?.unrelatedTo;
  if (
    !Array.isArray(unrelated) ||
    !["owner-a", "owner-monthly", "owner-yearly", "deletion-fixture"].every(
      (alias) => unrelated.includes(alias),
    )
  ) {
    fail("viewer-b must be recorded as unrelated to every disposable owner");
  }
  if (requireComplete) {
    for (const alias of matrix.requiredActorAliases) {
      if (evidence.actors?.[alias]?.aal2 !== true) {
        fail(`${alias} must complete AAL2 testing`);
      }
    }
  }
  for (const deviceClass of matrix.requiredDeviceClasses) {
    const device = evidence.devices?.[deviceClass];
    if (!device || device.alias !== deviceClass) {
      fail(`Missing device ${deviceClass}`);
    }
    if (deviceClass !== "desktop" && device.physical !== true) {
      fail(`${deviceClass} must be a physical device for release evidence`);
    }
    for (const field of ["os", "browser"]) {
      if (
        typeof device[field] !== "string" || device[field].trim().length < 2
      ) {
        fail(`${deviceClass}.${field} is incomplete`);
      }
      if (requireComplete && /^replace$/i.test(device[field].trim())) {
        fail(`${deviceClass}.${field} still contains placeholder text`);
      }
    }
  }

  const knownIds = matrixIds(matrix);
  for (const id of Object.keys(evidence.cases ?? {})) {
    if (!knownIds.has(id)) fail(`Evidence contains unknown case ${id}`);
  }
  const statusCounts = { pass: 0, fail: 0, blocked: 0, "not-run": 0 };
  for (const entry of matrix.cases) {
    const result = evidence.cases?.[entry.id];
    if (!result || !Object.hasOwn(statusCounts, result.status)) {
      fail(`${entry.id} has no valid evidence status`);
    }
    statusCounts[result.status] += 1;
    if (result.status === "not-run") {
      if (requireComplete) fail(`${entry.id} has not been run`);
      continue;
    }
    assertIso(result.executedAt, `${entry.id}.executedAt`);
    assertAlias(result.testerAlias, `${entry.id}.testerAlias`);
    if (
      !Array.isArray(result.actorAliases) || result.actorAliases.length === 0
    ) {
      fail(`${entry.id} must name its tested actor aliases`);
    }
    for (const alias of result.actorAliases) {
      if (!matrix.requiredActorAliases.includes(alias)) {
        fail(`${entry.id} uses unknown actor alias ${alias}`);
      }
    }
    for (const requiredActor of entry.actors) {
      if (!result.actorAliases.includes(requiredActor)) {
        fail(`${entry.id} is missing required actor ${requiredActor}`);
      }
    }
    if (
      !Array.isArray(result.deviceClasses) || result.deviceClasses.length === 0
    ) {
      fail(`${entry.id} must name at least one device class`);
    }
    for (const deviceClass of result.deviceClasses) {
      if (!matrix.requiredDeviceClasses.includes(deviceClass)) {
        fail(`${entry.id} uses unknown device class ${deviceClass}`);
      }
    }
    for (const requiredDevice of entry.devices) {
      if (!result.deviceClasses.includes(requiredDevice)) {
        fail(`${entry.id} is missing required device ${requiredDevice}`);
      }
    }
    if (
      typeof result.observation !== "string" ||
      result.observation.trim().length < 20
    ) {
      fail(`${entry.id} needs a substantive redacted observation`);
    }
    if (!Array.isArray(result.artifacts) || result.artifacts.length === 0) {
      fail(`${entry.id} needs at least one hashed, relative evidence artifact`);
    }
    result.artifacts.forEach((artifact, index) =>
      assertArtifact(artifact, entry.id, index)
    );
    if (requireComplete && result.status !== "pass") {
      fail(`${entry.id} is ${result.status}; release evidence is incomplete`);
    }
  }
  assertRedacted(evidence);
  return statusCounts;
}

function safeProjectRef(value, productionRef) {
  if (typeof value !== "string" || !/^[a-z]{20}$/.test(value)) {
    fail("BILLING_STAGING_PROJECT_REF must be a 20-letter Supabase ref");
  }
  if (value === productionRef) fail("Staging project ref equals production");
  return value;
}

function safeTestKey(value) {
  if (
    typeof value !== "string" ||
    !/^(?:sk|rk)_test_[A-Za-z0-9_]{16,}$/.test(value)
  ) {
    fail("STRIPE_TEST_SECRET_KEY must be a Stripe test-mode key");
  }
  return value;
}

function safePortalConfigurationId(value) {
  if (typeof value !== "string" || !/^bpc_[A-Za-z0-9]{8,}$/.test(value)) {
    fail(
      "STRIPE_TEST_PORTAL_CONFIGURATION_ID must be a Stripe Billing Portal configuration id",
    );
  }
  return value;
}

function parsePlans(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("STRIPE_TEST_PLANS_JSON is not valid JSON");
  }
  const expectedCodes = Object.keys(PLAN_EXPECTATIONS).sort();
  if (Object.keys(parsed).sort().join("|") !== expectedCodes.join("|")) {
    fail("STRIPE_TEST_PLANS_JSON must contain exactly the three account plans");
  }
  const ids = new Set();
  for (const code of expectedCodes) {
    const plan = parsed[code];
    const expected = PLAN_EXPECTATIONS[code];
    if (!plan || typeof plan !== "object") fail(`${code} is invalid`);
    if (!/^price_[A-Za-z0-9]{8,}$/.test(plan.price_id ?? "")) {
      fail(`${code} price_id is invalid`);
    }
    if (!/^prod_[A-Za-z0-9]{8,}$/.test(plan.product_id ?? "")) {
      fail(`${code} product_id is invalid`);
    }
    if (ids.has(plan.price_id)) fail("Plan Price ids must be unique");
    ids.add(plan.price_id);
    for (
      const [field, value] of Object.entries({
        amount: expected.amount,
        currency: expected.currency,
        interval: expected.interval,
        interval_count: expected.intervalCount,
        trial_days: expected.trialDays,
      })
    ) {
      if (plan[field] !== value) {
        fail(`${code}.${field} does not match the approved contract`);
      }
    }
  }
  if (
    new Set(expectedCodes.map((code) => parsed[code].product_id)).size !== 1
  ) {
    fail("All three plan Prices must share one Product");
  }
  return parsed;
}

async function stripeGet(key, path, label) {
  let response;
  try {
    response = await fetch(`https://api.stripe.com${path}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": "2026-02-25.clover",
      },
      redirect: "error",
    });
  } catch {
    fail(`Stripe ${label} request was unavailable`);
  }
  if (!response.ok) {
    fail(`Stripe ${label} request returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    fail(`Stripe ${label} response was not JSON`);
  }
}

async function providerPreflight(matrix) {
  const projectRef = safeProjectRef(
    process.env.BILLING_STAGING_PROJECT_REF,
    matrix.productionProjectRef,
  );
  const key = safeTestKey(process.env.STRIPE_TEST_SECRET_KEY);
  const portalConfigurationId = safePortalConfigurationId(
    process.env.STRIPE_TEST_PORTAL_CONFIGURATION_ID,
  );
  const plans = parsePlans(process.env.STRIPE_TEST_PLANS_JSON ?? "");
  const supabaseUrl = new URL(process.env.BILLING_STAGING_SUPABASE_URL ?? "");
  const appOrigin = new URL(process.env.BILLING_STAGING_APP_ORIGIN ?? "");
  if (
    supabaseUrl.protocol !== "https:" ||
    supabaseUrl.hostname !== `${projectRef}.supabase.co` ||
    supabaseUrl.pathname !== "/" ||
    supabaseUrl.search ||
    supabaseUrl.hash
  ) {
    fail("BILLING_STAGING_SUPABASE_URL does not exactly match the staging ref");
  }
  if (
    appOrigin.protocol !== "https:" ||
    appOrigin.username ||
    appOrigin.password ||
    appOrigin.search ||
    appOrigin.hash ||
    /(?:^|\.)mypersonas\.online$/i.test(appOrigin.hostname)
  ) {
    fail(
      "BILLING_STAGING_APP_ORIGIN must be a clean non-production HTTPS origin",
    );
  }

  const productIds = new Set();
  for (const [code, expected] of Object.entries(PLAN_EXPECTATIONS)) {
    const configured = plans[code];
    const price = await stripeGet(
      key,
      `/v1/prices/${
        encodeURIComponent(configured.price_id)
      }?expand%5B%5D=product`,
      `${code} Price`,
    );
    if (
      price.object !== "price" ||
      price.id !== configured.price_id ||
      price.livemode !== false ||
      price.active !== true ||
      price.type !== "recurring" ||
      price.unit_amount !== expected.amount ||
      price.currency !== expected.currency ||
      price.recurring?.interval !== expected.interval ||
      price.recurring?.interval_count !== expected.intervalCount ||
      price.product?.object !== "product" ||
      price.product?.id !== configured.product_id ||
      price.product?.livemode !== false ||
      price.product?.active !== true
    ) {
      fail(`${code} failed canonical test Price/Product assertions`);
    }
    productIds.add(price.product.id);
  }
  if (productIds.size !== 1) fail("Canonical Prices do not share one Product");

  const portalConfiguration = await stripeGet(
    key,
    `/v1/billing_portal/configurations/${
      encodeURIComponent(portalConfigurationId)
    }`,
    "Billing Portal configuration",
  );
  const portalFeatures = portalConfiguration.features;
  const customerUpdates = portalFeatures?.customer_update?.allowed_updates;
  if (
    portalConfiguration.object !== "billing_portal.configuration" ||
    portalConfiguration.id !== portalConfigurationId ||
    portalConfiguration.livemode !== false ||
    portalConfiguration.active !== true ||
    portalFeatures?.payment_method_update?.enabled !== true ||
    portalFeatures?.invoice_history?.enabled !== true ||
    portalFeatures?.subscription_cancel?.enabled !== true ||
    portalFeatures?.subscription_cancel?.mode !== "at_period_end" ||
    portalFeatures?.subscription_cancel?.proration_behavior !== "none" ||
    (portalFeatures?.subscription_pause !== undefined &&
      portalFeatures?.subscription_pause?.enabled !== false) ||
    portalFeatures?.subscription_update?.enabled !== false ||
    portalFeatures?.customer_update?.enabled !== true ||
    portalConfiguration.login_page?.enabled !== false ||
    !Array.isArray(customerUpdates) ||
    [...customerUpdates].sort().join("|") !== "address|name"
  ) {
    fail(
      "Billing Portal configuration does not match the reviewed cancellation and data-minimization contract",
    );
  }

  const endpoints = await stripeGet(
    key,
    "/v1/webhook_endpoints?limit=100",
    "webhook endpoint inventory",
  );
  if (
    endpoints.object !== "list" || !Array.isArray(endpoints.data) ||
    endpoints.has_more
  ) {
    fail("Webhook endpoint inventory was incomplete");
  }
  const expectedUrl = `${supabaseUrl.origin}/functions/v1/stripe-webhook`;
  const matches = endpoints.data.filter((endpoint) =>
    endpoint.url === expectedUrl
  );
  if (matches.length !== 1) {
    fail("Expected exactly one staging stripe-webhook endpoint");
  }
  const endpoint = matches[0];
  const events = [...(endpoint.enabled_events ?? [])].sort();
  if (
    endpoint.object !== "webhook_endpoint" ||
    endpoint.livemode !== false ||
    endpoint.status !== "enabled" ||
    events.join("|") !== [...REQUIRED_EVENTS].sort().join("|")
  ) {
    fail(
      "Staging webhook endpoint does not exactly match the reviewed event allowlist",
    );
  }

  return {
    environment: "billing-staging",
    stripeMode: "test",
    projectRefSuffix: projectRef.slice(-6),
    pricesVerified: 3,
    productVerified: true,
    portalConfigurationVerified: true,
    webhookVerified: true,
    webhookEventsVerified: REQUIRED_EVENTS.length,
    secretsPrinted: false,
  };
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/billing-sandbox-matrix.mjs list [--area AREA]
  node scripts/billing-sandbox-matrix.mjs init [OUTPUT] --origin URL --project-ref-suffix SUFFIX [--run-id ALIAS]
  node scripts/billing-sandbox-matrix.mjs verify EVIDENCE.json
  node scripts/billing-sandbox-matrix.mjs summary EVIDENCE.json
  node scripts/billing-sandbox-matrix.mjs preflight

preflight reads BILLING_STAGING_PROJECT_REF, BILLING_STAGING_SUPABASE_URL,
BILLING_STAGING_APP_ORIGIN, STRIPE_TEST_SECRET_KEY,
STRIPE_TEST_PORTAL_CONFIGURATION_ID, and STRIPE_TEST_PLANS_JSON.
It prints only booleans, counts, and the last six project-ref characters.
`);
}

async function main() {
  const matrix = await readJson(matrixPath);
  validateMatrix(matrix);
  const [command = "list", ...raw] = process.argv.slice(2);
  const { positional, options } = parseArgs(raw);

  if (command === "list") {
    const area = option(options, "area");
    const cases = area
      ? matrix.cases.filter((entry) => entry.area === area)
      : matrix.cases;
    if (cases.length === 0) fail(`No cases found for area ${String(area)}`);
    for (const entry of cases) {
      process.stdout.write(
        `${entry.id}\t${entry.area}\t${entry.mode}\t${entry.title}\n`,
      );
    }
    process.stdout.write(`TOTAL\t${cases.length}\n`);
    return;
  }

  if (command === "init") {
    const defaultName = `billing-sandbox-evidence-${
      new Date().toISOString().slice(0, 10)
    }.json`;
    const output = resolve(root, positional[0] ?? `outputs/${defaultName}`);
    if (relative(root, output).startsWith("..")) {
      fail("Evidence output must stay inside the repository workspace");
    }
    const template = evidenceTemplate(matrix, options);
    validateEvidence(matrix, template, { requireComplete: false });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(template, null, 2)}\n`, {
      flag: "wx",
    });
    process.stdout.write(
      `Created redacted evidence template: ${relative(root, output)}\n`,
    );
    process.stdout.write(`Required cases: ${matrix.cases.length}\n`);
    return;
  }

  if (command === "summary" || command === "verify") {
    if (positional.length !== 1) {
      fail(`${command} requires one evidence JSON path`);
    }
    const evidencePath = resolve(root, positional[0]);
    const evidence = await readJson(evidencePath);
    const counts = validateEvidence(matrix, evidence, {
      requireComplete: command === "verify",
    });
    process.stdout.write(`${
      JSON.stringify(
        {
          matrixVersion: matrix.matrixVersion,
          total: matrix.cases.length,
          ...counts,
          complete: counts.pass === matrix.cases.length,
          redactionValidated: true,
        },
        null,
        2,
      )
    }\n`);
    return;
  }

  if (command === "preflight") {
    process.stdout.write(
      `${JSON.stringify(await providerPreflight(matrix), null, 2)}\n`,
    );
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  printUsage();
  fail(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`Billing sandbox matrix failed: ${error.message}\n`);
  process.exitCode = 1;
});
