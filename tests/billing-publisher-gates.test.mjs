import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publisherBillingDisposition } from "../supabase/functions/_shared/publisher-entitlement.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath) =>
  readFileSync(path.join(root, relativePath), "utf8");

const postQueue = source("supabase/functions/run-post-queue/index.ts");
const publishQueue = source("supabase/functions/run-publish-queue/index.ts");
const metaPublish = source("supabase/functions/_shared/meta-publish.ts");

test("scheduled Meta publishing fails closed before credentials and provider writes", () => {
  assert.match(postQueue, /from "\.\.\/_shared\/account-entitlement\.ts"/);
  assert.ok(
    (postQueue.match(/accountBillingAccess\(/g) || []).length >= 3,
    "expected initial, credential, and last-moment provider entitlement checks",
  );

  const initialGate = postQueue.search(
    /const initialEntitlement = await accountBillingAccess\(\s*admin,\s*d\.owner,?\s*\)/,
  );
  const automationReads = postQueue.indexOf("const [pause, persona]");
  assert.ok(initialGate > 0 && initialGate < automationReads);

  const credentialGate = postQueue.search(
    /const credentialEntitlement = await accountBillingAccess\(\s*admin,\s*d\.owner,?\s*\)/,
  );
  const credentialRead = postQueue.indexOf(
    "ctx = await resolvePageContext(admin, d.owner, d.facebook_ledger_id)",
  );
  assert.ok(credentialGate > initialGate && credentialGate < credentialRead);

  const facebookCall = postQueue.indexOf("const r = await publishFacebook(");
  const facebookGuard = postQueue.indexOf(
    "() => assertBillingPublishAccess(d.owner)",
    facebookCall,
  );
  assert.ok(facebookCall > credentialRead && facebookGuard > facebookCall);

  const instagramCall = postQueue.indexOf("const r = await publishInstagram(");
  const instagramGuard = postQueue.indexOf(
    "await assertBillingPublishAccess(d.owner)",
    instagramCall,
  );
  assert.ok(instagramCall > facebookCall && instagramGuard > instagramCall);

  assert.match(
    metaPublish,
    /await beforeProviderPost\?\.\(\);\s*const r = await fetch\(/,
    "the supplied check must execute immediately beside each provider POST",
  );
});

test("scheduled Meta backlog is terminal when inactive and retryable only when verification is unavailable", () => {
  assert.match(postQueue, /"billing_membership_inactive"/);
  assert.match(postQueue, /"billing_verification_unavailable"/);
  assert.match(
    postQueue,
    /publisherBillingDisposition\(entitlement, false\) === "defer"[\s\S]*?status: "scheduled"[\s\S]*?publish_claimed_at: null/,
  );
  assert.match(
    postQueue,
    /const failed = await finalizeClaim\(d, "failed", message,[\s\S]*?billingPhase: phase/,
  );
  assert.match(
    postQueue,
    /publisherBillingDisposition\([\s\S]*?e\.entitlement,[\s\S]*?instagramMutationChecks > 0[\s\S]*?billingDisposition === "reconcile"[\s\S]*?reconciliationRequired = true/,
  );
});

test("last-moment billing disposition distinguishes reason and partial provider state at runtime", () => {
  const unavailable = { allowed: false, unavailable: true };
  const inactive = { allowed: false, unavailable: false };

  assert.equal(publisherBillingDisposition(unavailable, false), "defer");
  assert.equal(publisherBillingDisposition(inactive, false), "terminal");
  assert.equal(publisherBillingDisposition(unavailable, true), "reconcile");
  assert.equal(publisherBillingDisposition(inactive, true), "reconcile");
});

test("last-moment Meta failures defer or terminalize only before an unrecorded mutation", () => {
  const facebookCall = postQueue.indexOf("const r = await publishFacebook(");
  const instagramCall = postQueue.indexOf("const r = await publishInstagram(");
  const facebookBranch = postQueue.slice(facebookCall, instagramCall);
  assert.match(
    facebookBranch,
    /e instanceof BillingPublishBlockedError[\s\S]*?haltClaimForBilling\(d, e\.entitlement, "provider"\)[\s\S]*?continue/,
  );

  const instagramBranch = postQueue.slice(instagramCall);
  assert.match(
    instagramBranch,
    /billingDisposition === "reconcile"[\s\S]*?reconciliationRequired = true[\s\S]*?else[\s\S]*?haltClaimForBilling\(d, e\.entitlement, "provider"\)[\s\S]*?continue/,
  );
});

test("native queue checks membership before processing and immediately before its atomic feed mutation", () => {
  assert.match(publishQueue, /from "\.\.\/_shared\/account-entitlement\.ts"/);
  assert.ok(
    (publishQueue.match(/accountBillingAccess\(/g) || []).length >= 2,
    "expected initial and pre-mutation entitlement checks",
  );

  const processStart = publishQueue.indexOf("async function processDraft(");
  const initialGate = publishQueue.indexOf(
    "const initialEntitlement = await accountBillingAccess(admin, draft.owner)",
    processStart,
  );
  const automationReads = publishQueue.indexOf(
    "const [personaResult, settingsResult, bindingResult]",
    processStart,
  );
  assert.ok(initialGate > processStart && initialGate < automationReads);

  const nativeStart = publishQueue.indexOf("async function publishNative(");
  const nativeGate = publishQueue.indexOf(
    "const entitlement = await accountBillingAccess(admin, draft.owner)",
    nativeStart,
  );
  const nativeMutation = publishQueue.indexOf(
    'admin.rpc("publish_native_agent_draft"',
    nativeStart,
  );
  assert.ok(nativeGate > nativeStart && nativeGate < nativeMutation);
});

test("native inactive occurrences require an intentional requeue instead of burst catch-up", () => {
  assert.match(publishQueue, /"billing_membership_inactive"/);
  assert.match(publishQueue, /"billing_verification_unavailable"/);
  assert.match(
    publishQueue,
    /disposition === "defer"[\s\S]*?publish_next_attempt_at: new Date\(Date\.now\(\) \+ RETRY_DELAY_MS\)/,
  );
  assert.match(
    publishQueue,
    /publish_state: "blocked",\s*publish_next_attempt_at: null,\s*publish_error: message/,
  );
});
