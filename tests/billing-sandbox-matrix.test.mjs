import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(root, "tests/fixtures/billing-sandbox-lifecycle-matrix.json");
const runnerPath = resolve(root, "scripts/billing-sandbox-matrix.mjs");
const clockFixturePath = resolve(root, "scripts/billing-test-clock-fixture.mjs");
const sharedBillingPath = resolve(root, "supabase/functions/_shared/billing.ts");
const supabaseConfigPath = resolve(root, "supabase/config.toml");

async function matrix() {
  return JSON.parse(await readFile(matrixPath, "utf8"));
}

async function run(args, env = {}) {
  try {
    const result = await execFileAsync(process.execPath, [runnerPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number(error.code) || 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

function completedEvidence(source, matrixValue) {
  const finishedAt = "2026-08-23T12:30:00.000Z";
  source.completedAt = finishedAt;
  source.environment.appOrigin = "https://billing-staging.example.test";
  source.environment.supabaseProjectRefSuffix = "stg123";
  for (const actor of matrixValue.requiredActorAliases) {
    source.actors[actor].aal2 = true;
  }
  for (const device of Object.values(source.devices)) {
    device.os = device.alias === "ios-mobile" ? "iOS test device" :
      device.alias === "android-mobile" ? "Android test device" : "Windows test device";
    device.browser = device.alias === "ios-mobile" ? "Safari" :
      device.alias === "android-mobile" ? "Chrome" : "Edge";
  }
  for (const [id, result] of Object.entries(source.cases)) {
    const matrixCase = matrixValue.cases.find((entry) => entry.id === id);
    Object.assign(result, {
      status: "pass",
      executedAt: finishedAt,
      testerAlias: "release-tester",
      actorAliases: [...matrixCase.actors],
      deviceClasses: [...matrixCase.devices],
      observation: `${id} produced the expected redacted staging result without cross-account exposure.`,
      artifacts: [{
        kind: "query-summary",
        path: `outputs/evidence/${id.toLowerCase()}.json`,
        sha256: "a".repeat(64),
      }],
    });
  }
  return source;
}

test("matrix inventories every required billing, race, operations, and privacy area", async () => {
  const value = await matrix();
  assert.equal(value.schemaVersion, 1);
  assert.ok(value.cases.length >= 60);
  assert.equal(new Set(value.cases.map((entry) => entry.id)).size, value.cases.length);
  const supabaseConfig = await readFile(supabaseConfigPath, "utf8");
  assert.match(supabaseConfig, new RegExp(`^project_id = "${value.productionProjectRef}"`, "m"));
  const areas = new Set(value.cases.map((entry) => entry.area));
  for (const required of [
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
  ]) assert.ok(areas.has(required), required);
  const searchable = JSON.stringify(value);
  for (const phrase of [
    "weekly trial, conversion, and renewal",
    "monthly trial, conversion, and renewal",
    "yearly trial, conversion, and renewal",
    "3DS or SCA",
    "past-due suspension",
    "Modified payload with reused event ID",
    "Old and out-of-order",
    "full refund",
    "partial refund",
    "Dispute creation, update, and closure",
    "Unknown Customer",
    "Completed but initially unreconciled Checkout",
    "Duplicate renewable subscription remediation",
    "Consumed-trial rebinding",
    "Checkout versus account deletion",
    "kill switch during provider_pending",
    "Same account cannot receive a second trial",
    "Deleted and recreated account with same verified email",
    "Renewable subscription blocks developer grant",
    "No stale work burst after recovery",
    "Account switching and stale response isolation",
    "AAL2 enrollment, step-up, interruption, and recovery",
    "Opaque media and private preview isolation",
    "Billed Customer deletion and retention workflow",
    "Versioned trial-fingerprint key rotation",
  ]) assert.match(searchable, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

test("provider preflight webhook allowlist stays equal to the application parser", async () => {
  const [runner, shared] = await Promise.all([
    readFile(runnerPath, "utf8"),
    readFile(sharedBillingPath, "utf8"),
  ]);
  const runnerBlock = runner.match(/const REQUIRED_EVENTS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(runnerBlock);
  const sharedBlock = shared.slice(
    shared.indexOf("const CHECKOUT_EVENT_TYPES"),
    shared.indexOf("export type StripeEventEnvelope"),
  );
  const values = (text) => [...text.matchAll(/"([a-z]+(?:\.[a-z_]+)+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(values(runnerBlock), values(sharedBlock));
});

test("runner lists all cases and creates an incomplete fail-closed evidence template", async () => {
  const value = await matrix();
  const listed = await run(["list", "--area", "two-account-privacy"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /PRIV-001/);
  assert.match(listed.stdout, /TOTAL\s+5/);

  const output = `outputs/billing-matrix-test-${process.pid}-${Date.now()}.json`;
  try {
    const initialized = await run([
      "init",
      output,
      "--origin",
      "https://billing-staging.example.test",
      "--project-ref-suffix",
      "stg123",
      "--run-id",
      "automated-test-run",
    ]);
    assert.equal(initialized.code, 0, initialized.stderr);
    const summary = await run(["summary", output]);
    assert.equal(summary.code, 0, summary.stderr);
    assert.match(summary.stdout, new RegExp(`"total": ${value.cases.length}`));
    assert.match(summary.stdout, new RegExp(`"not-run": ${value.cases.length}`));
    const verified = await run(["verify", output]);
    assert.notEqual(verified.code, 0);
    assert.match(verified.stderr, /completedAt|has not been run/);
  } finally {
    await rm(resolve(root, output), { force: true });
  }
});

test("complete redacted evidence passes while PII and provider identifiers fail", async () => {
  const temp = await mkdtemp(resolve(tmpdir(), "mypersonas-billing-matrix-"));
  try {
    const templatePath = resolve(temp, "template.json");
    const initOutput = `outputs/billing-matrix-template-${process.pid}-${Date.now()}.json`;
    const initialized = await run([
      "init",
      initOutput,
      "--origin",
      "https://billing-staging.example.test",
      "--project-ref-suffix",
      "stg123",
      "--run-id",
      "complete-test-run",
    ]);
    assert.equal(initialized.code, 0, initialized.stderr);
    const template = JSON.parse(await readFile(resolve(root, initOutput), "utf8"));
    await rm(resolve(root, initOutput), { force: true });

    const complete = completedEvidence(template, await matrix());
    await writeFile(templatePath, JSON.stringify(complete));
    const verified = await run([templatePath]);
    assert.notEqual(verified.code, 0, "an evidence path without the verify command must not be accepted");
    const passed = await run(["verify", templatePath]);
    assert.equal(passed.code, 0, passed.stderr);
    assert.match(passed.stdout, /"complete": true/);

    const missingMobile = structuredClone(complete);
    missingMobile.cases["MOB-001"].deviceClasses = ["desktop", "ios-mobile"];
    await writeFile(templatePath, JSON.stringify(missingMobile));
    const mobileRejected = await run(["verify", templatePath]);
    assert.notEqual(mobileRejected.code, 0);
    assert.match(mobileRejected.stderr, /MOB-001 is missing required device android-mobile/);

    const missingActor = structuredClone(complete);
    missingActor.cases["PRIV-001"].actorAliases = ["owner-a"];
    await writeFile(templatePath, JSON.stringify(missingActor));
    const actorRejected = await run(["verify", templatePath]);
    assert.notEqual(actorRejected.code, 0);
    assert.match(actorRejected.stderr, /PRIV-001 is missing required actor viewer-b/);

    complete.cases["CFG-001"].observation = "Leaked owner@example.com and cus_123456789 in evidence output.";
    await writeFile(templatePath, JSON.stringify(complete));
    const rejected = await run(["verify", templatePath]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /email address|Stripe object identifier/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("preflight rejects production and live-mode configuration before network access", async () => {
  const production = await matrix();
  const base = {
    BILLING_STAGING_PROJECT_REF: production.productionProjectRef,
    BILLING_STAGING_SUPABASE_URL: `https://${production.productionProjectRef}.supabase.co`,
    BILLING_STAGING_APP_ORIGIN: "https://billing-staging.example.test",
    STRIPE_TEST_SECRET_KEY: ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_"),
    STRIPE_TEST_PLANS_JSON: "{}",
  };
  const wrongProject = await run(["preflight"], base);
  assert.notEqual(wrongProject.code, 0);
  assert.match(wrongProject.stderr, /equals production/);
  assert.doesNotMatch(wrongProject.stderr, /sk_test_/);

  const liveKey = await run(["preflight"], {
    ...base,
    BILLING_STAGING_PROJECT_REF: "abcdefghijklmnopqrst",
    BILLING_STAGING_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    STRIPE_TEST_SECRET_KEY: ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
  });
  assert.notEqual(liveKey.code, 0);
  assert.match(liveKey.stderr, /test-mode key/);
  assert.doesNotMatch(liveKey.stderr, /sk_live_/);
});

test("test-clock helper is staging-only, test-mode-only, explicit, and redacted", async () => {
  const source = await readFile(clockFixturePath, "utf8");
  assert.match(source, /projectRef === productionProjectRef/);
  assert.match(source, /\^\(\?:sk\|rk\)_test_/);
  assert.match(source, /--confirm-staging-test-clock-customer/);
  assert.match(source, /--confirm-advance-test-clock/);
  assert.match(source, /outputs\/billing-test-clock-/);
  assert.match(source, /metadata\[account_id\]/);
  assert.match(source, /billing_bind_customer/);
  assert.match(source, /providerIdsPrinted: false/);
  assert.match(source, /secretsPrinted: false/);
  assert.doesNotMatch(source, /console\.(?:log|error|warn|debug)/);

  const production = (await matrix()).productionProjectRef;
  const result = await execFileAsync(process.execPath, [
    clockFixturePath,
    "create",
    "--alias",
    "weekly-fixture",
    "--confirm-staging-test-clock-customer",
  ], {
    cwd: root,
    env: {
      ...process.env,
      BILLING_STAGING_PROJECT_REF: production,
      BILLING_STAGING_SUPABASE_URL: `https://${production}.supabase.co`,
      BILLING_STAGING_SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40),
      STRIPE_TEST_SECRET_KEY: ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_"),
      BILLING_TEST_ACCOUNT_ID: "11111111-1111-4111-8111-111111111111",
    },
    windowsHide: true,
  }).then(
    () => ({ code: 0, stderr: "" }),
    (error) => ({ code: Number(error.code) || 1, stderr: String(error.stderr ?? "") }),
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /separate .*BILLING_STAGING/i);
  assert.doesNotMatch(result.stderr, /sk_test_|11111111|nwsqyuucwzihruszocge/);
});
