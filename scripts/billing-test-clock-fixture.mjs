#!/usr/bin/env node

// Staging-only Stripe test-clock fixture helper.
//
// The real Checkout path creates a Customer itself. Stripe requires a test
// clock to be attached when a Customer is created, so a disposable staging
// account must be prebound to a clock-backed test Customer before opening the
// hosted Checkout. This helper performs only that narrow fixture operation and
// clock advancement. It never prints the account UUID, provider object ids,
// service-role key, or Stripe key.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productionProjectRef = "nwsqyuucwzihruszocge";
const apiVersion = "2026-02-25.clover";

function fail(message) {
  throw new Error(message);
}

function parseArgs(raw) {
  const options = new Map();
  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    if (!current.startsWith("--")) fail(`Unexpected argument: ${current}`);
    const name = current.slice(2);
    const next = raw[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(name, true);
    } else {
      options.set(name, next);
      index += 1;
    }
  }
  return options;
}

function requiredEnvironment() {
  const projectRef = process.env.BILLING_STAGING_PROJECT_REF;
  const supabaseUrl = process.env.BILLING_STAGING_SUPABASE_URL;
  const serviceRoleKey = process.env.BILLING_STAGING_SUPABASE_SERVICE_ROLE_KEY;
  const stripeKey = process.env.STRIPE_TEST_SECRET_KEY;
  if (!/^[a-z]{20}$/.test(projectRef ?? "") || projectRef === productionProjectRef) {
    fail("A separate 20-letter BILLING_STAGING_PROJECT_REF is required");
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    fail("BILLING_STAGING_SUPABASE_URL is invalid");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== `${projectRef}.supabase.co` ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) fail("BILLING_STAGING_SUPABASE_URL does not exactly match staging");
  if (typeof serviceRoleKey !== "string" || serviceRoleKey.length < 32) {
    fail("The staging service-role credential is required");
  }
  if (!/^(?:sk|rk)_test_[A-Za-z0-9_]{16,}$/.test(stripeKey ?? "")) {
    fail("A Stripe test-mode key is required");
  }
  return { projectRef, supabaseUrl: parsedUrl.origin, serviceRoleKey, stripeKey };
}

function safeAlias(raw) {
  if (typeof raw !== "string" || !/^[a-z][a-z0-9-]{2,40}$/.test(raw)) {
    fail("--alias must be a non-identifying lowercase fixture alias");
  }
  return raw;
}

function accountId() {
  const value = process.env.BILLING_TEST_ACCOUNT_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value ?? "")) {
    fail("BILLING_TEST_ACCOUNT_ID must identify the approved disposable staging account");
  }
  return value;
}

function statePath(raw, alias) {
  const path = resolve(root, raw ?? `outputs/billing-test-clock-${alias}.private.json`);
  const insideOutputs = relative(resolve(root, "outputs"), path);
  if (insideOutputs.startsWith("..") || insideOutputs === "" || /^[A-Za-z]:/.test(insideOutputs)) {
    fail("Fixture state must be a file below the ignored outputs directory");
  }
  return path;
}

async function stripeRequest(config, method, path, form, idempotencyKey, label) {
  const headers = {
    Authorization: `Bearer ${config.stripeKey}`,
    "Stripe-Version": apiVersion,
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = form.toString();
  }
  let response;
  try {
    response = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers,
      body,
      redirect: "error",
    });
  } catch {
    fail(`Stripe ${label} request was unavailable`);
  }
  if (!response.ok) fail(`Stripe ${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail(`Stripe ${label} returned invalid JSON`);
  }
}

async function bindCustomer(config, ownerId, customerId) {
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/rest/v1/rpc/billing_bind_customer`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_account_id: ownerId, p_customer_id: customerId }),
      redirect: "error",
    });
  } catch {
    fail("Staging Customer binding request was unavailable");
  }
  if (!response.ok) fail(`Staging Customer binding returned HTTP ${response.status}`);
  let result;
  try {
    result = await response.json();
  } catch {
    fail("Staging Customer binding returned invalid JSON");
  }
  if (result !== true) fail("Staging Customer binding did not confirm success");
}

function assertClock(raw, expectedId = null) {
  if (
    !raw || raw.object !== "test_helpers.test_clock" ||
    !/^clock_[A-Za-z0-9]{8,}$/.test(raw.id ?? "") ||
    (expectedId !== null && raw.id !== expectedId) ||
    raw.livemode !== false ||
    !["ready", "advancing"].includes(raw.status) ||
    !Number.isSafeInteger(raw.frozen_time)
  ) fail("Stripe returned a noncanonical test clock");
  return raw;
}

function assertCustomer(raw, clockId, ownerId = null) {
  if (
    !raw || raw.object !== "customer" ||
    !/^cus_[A-Za-z0-9]{8,}$/.test(raw.id ?? "") ||
    raw.livemode !== false || raw.deleted === true ||
    raw.test_clock !== clockId ||
    (ownerId !== null && raw.metadata?.account_id !== ownerId)
  ) fail("Stripe returned a noncanonical clock-backed Customer");
  return raw;
}

async function createFixture(config, options) {
  if (!options.has("confirm-staging-test-clock-customer")) {
    fail("create requires --confirm-staging-test-clock-customer");
  }
  const alias = safeAlias(options.get("alias"));
  const ownerId = accountId();
  const path = statePath(options.get("state"), alias);
  const frozenTime = Math.floor(Date.now() / 1000);
  const idempotencyStem = `mypersonas-clock-fixture:${config.projectRef}:${ownerId}:${alias}:v1`;
  const clock = assertClock(await stripeRequest(
    config,
    "POST",
    "/v1/test_helpers/test_clocks",
    new URLSearchParams({ frozen_time: String(frozenTime), name: `MyPersonas ${alias}` }),
    `${idempotencyStem}:clock`,
    "test-clock creation",
  ));
  const customer = assertCustomer(await stripeRequest(
    config,
    "POST",
    "/v1/customers",
    new URLSearchParams({
      test_clock: clock.id,
      "metadata[account_id]": ownerId,
      "metadata[mypersonas_test_fixture]": alias,
    }),
    `${idempotencyStem}:customer`,
    "test Customer creation",
  ), clock.id, ownerId);
  await bindCustomer(config, ownerId, customer.id);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    environment: "billing-staging",
    projectRefSuffix: config.projectRef.slice(-6),
    alias,
    clockId: clock.id,
    customerId: customer.id,
    frozenTime: clock.frozen_time,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return {
    environment: "billing-staging",
    stripeMode: "test",
    alias,
    projectRefSuffix: config.projectRef.slice(-6),
    clockReady: clock.status === "ready",
    customerCreated: true,
    customerBound: true,
    privateStatePath: relative(root, path),
    providerIdsPrinted: false,
    secretsPrinted: false,
  };
}

async function readState(path) {
  let state;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("Could not read valid private fixture state");
  }
  if (
    state.schemaVersion !== 1 || state.environment !== "billing-staging" ||
    !/^[a-z][a-z0-9-]{2,40}$/.test(state.alias ?? "") ||
    !/^clock_[A-Za-z0-9]{8,}$/.test(state.clockId ?? "") ||
    !/^cus_[A-Za-z0-9]{8,}$/.test(state.customerId ?? "") ||
    !Number.isSafeInteger(state.frozenTime)
  ) fail("Private fixture state is invalid");
  return state;
}

async function inspectFixture(config, state) {
  const clock = assertClock(await stripeRequest(
    config,
    "GET",
    `/v1/test_helpers/test_clocks/${encodeURIComponent(state.clockId)}`,
    null,
    null,
    "test-clock inspection",
  ), state.clockId);
  assertCustomer(await stripeRequest(
    config,
    "GET",
    `/v1/customers/${encodeURIComponent(state.customerId)}`,
    null,
    null,
    "test Customer inspection",
  ), state.clockId);
  return {
    environment: "billing-staging",
    stripeMode: "test",
    alias: state.alias,
    projectRefSuffix: config.projectRef.slice(-6),
    clockStatus: clock.status,
    frozenTime: new Date(clock.frozen_time * 1000).toISOString(),
    customerStillClockBound: true,
    providerIdsPrinted: false,
    secretsPrinted: false,
  };
}

async function advanceFixture(config, options, path, state) {
  if (!options.has("confirm-advance-test-clock")) {
    fail("advance requires --confirm-advance-test-clock");
  }
  const targetText = options.get("to") ?? process.env.BILLING_TEST_CLOCK_TARGET_TIME;
  const targetMs = Date.parse(targetText ?? "");
  if (!Number.isFinite(targetMs) || targetMs % 1000 !== 0) {
    fail("--to must be an ISO-8601 time at whole-second precision");
  }
  const target = targetMs / 1000;
  if (target <= state.frozenTime) fail("The target must be after the current frozen time");
  assertClock(await stripeRequest(
    config,
    "POST",
    `/v1/test_helpers/test_clocks/${encodeURIComponent(state.clockId)}/advance`,
    new URLSearchParams({ frozen_time: String(target) }),
    null,
    "test-clock advance",
  ), state.clockId);

  let clock;
  const deadline = Date.now() + 45_000;
  do {
    clock = assertClock(await stripeRequest(
      config,
      "GET",
      `/v1/test_helpers/test_clocks/${encodeURIComponent(state.clockId)}`,
      null,
      null,
      "test-clock readiness",
    ), state.clockId);
    if (clock.status === "ready") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  } while (Date.now() < deadline);
  if (clock.status !== "ready" || clock.frozen_time !== target) {
    fail("Test clock did not reach the requested ready state within 45 seconds");
  }
  state.frozenTime = clock.frozen_time;
  state.lastAdvancedAt = new Date().toISOString();
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return {
    environment: "billing-staging",
    stripeMode: "test",
    alias: state.alias,
    projectRefSuffix: config.projectRef.slice(-6),
    clockStatus: "ready",
    frozenTime: new Date(clock.frozen_time * 1000).toISOString(),
    providerIdsPrinted: false,
    secretsPrinted: false,
  };
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/billing-test-clock-fixture.mjs create --alias ALIAS [--state outputs/FILE] --confirm-staging-test-clock-customer
  node scripts/billing-test-clock-fixture.mjs inspect --alias ALIAS [--state outputs/FILE]
  node scripts/billing-test-clock-fixture.mjs advance --alias ALIAS [--state outputs/FILE] --to ISO_TIME --confirm-advance-test-clock

Required protected environment variables:
  BILLING_STAGING_PROJECT_REF
  BILLING_STAGING_SUPABASE_URL
  BILLING_STAGING_SUPABASE_SERVICE_ROLE_KEY
  STRIPE_TEST_SECRET_KEY
  BILLING_TEST_ACCOUNT_ID (create only; disposable staging account)

The private state file stays below ignored outputs/ and must never be attached
to release evidence. Use the account deletion/retention workflow for cleanup.
`);
}

async function main() {
  const [command = "help", ...raw] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const options = parseArgs(raw);
  const config = requiredEnvironment();
  if (command === "create") {
    process.stdout.write(`${JSON.stringify(await createFixture(config, options), null, 2)}\n`);
    return;
  }
  const alias = safeAlias(options.get("alias"));
  const path = statePath(options.get("state"), alias);
  const state = await readState(path);
  if (state.alias !== alias || state.projectRefSuffix !== config.projectRef.slice(-6)) {
    fail("Private fixture state does not match the requested staging target");
  }
  if (command === "inspect") {
    process.stdout.write(`${JSON.stringify(await inspectFixture(config, state), null, 2)}\n`);
    return;
  }
  if (command === "advance") {
    process.stdout.write(`${JSON.stringify(await advanceFixture(config, options, path, state), null, 2)}\n`);
    return;
  }
  usage();
  fail(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`Billing test-clock fixture failed: ${error.message}\n`);
  process.exitCode = 1;
});
