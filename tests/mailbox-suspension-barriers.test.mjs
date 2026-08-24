import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runMailboxProviderBoundary } from "../supabase/functions/_shared/mailbox-provider-boundary.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(
  path.join(root, "supabase/functions/run-mailbox-jobs/index.ts"),
  "utf8",
);
const owner = "00000000-0000-4000-8000-000000000001";

test("mailbox provider boundary blocks inactive or unverifiable accounts before provider work", async () => {
  for (
    const rpcResult of [
      { data: false, error: null },
      { data: null, error: { message: "database unavailable" } },
    ]
  ) {
    let providerCalls = 0;
    const result = await runMailboxProviderBoundary(
      { rpc: async () => rpcResult },
      owner,
      true,
      async () => {
        providerCalls++;
        return "must-not-run";
      },
    );
    assert.equal(result.allowed, false);
    assert.equal(providerCalls, 0);
  }
});

test("mailbox provider boundary rechecks every AI batch and stops after mid-run suspension", async () => {
  const outcomes = [true, true, false];
  let checks = 0;
  let providerCalls = 0;
  const client = {
    rpc: async () => ({ data: outcomes[checks++], error: null }),
  };

  const first = await runMailboxProviderBoundary(
    client,
    owner,
    true,
    async () => ++providerCalls,
  );
  const second = await runMailboxProviderBoundary(
    client,
    owner,
    true,
    async () => ++providerCalls,
  );
  const suspended = await runMailboxProviderBoundary(
    client,
    owner,
    true,
    async () => ++providerCalls,
  );

  assert.deepEqual([first.allowed, second.allowed, suspended.allowed], [
    true,
    true,
    false,
  ]);
  assert.equal(checks, 3);
  assert.equal(providerCalls, 2);
});

test("rule-only mailbox provider work does not consume a paid-AI entitlement check", async () => {
  let checks = 0;
  let providerCalls = 0;
  const result = await runMailboxProviderBoundary(
    {
      rpc: async () => {
        checks++;
        return { data: false, error: null };
      },
    },
    owner,
    false,
    async () => ++providerCalls,
  );
  assert.equal(result.allowed, true);
  assert.equal(result.value, 1);
  assert.equal(checks, 0);
  assert.equal(providerCalls, 1);
});

test("AI scans place fresh entitlement barriers before token refresh, list, and every metadata batch", () => {
  const scan = source.slice(
    source.indexOf("async function processOneScan"),
    source.indexOf("async function completeScan"),
  );
  const initial = scan.indexOf(
    "const initialEntitlement = await accountBillingAccess(admin, run.owner)",
  );
  const context = scan.indexOf("const context = await ownedMailboxContext");
  assert.ok(
    initial >= 0 && context > initial,
    "the initial gate must precede mailbox context resolution",
  );

  const tokenBoundary = scan.indexOf(
    "const tokenBoundary = await runMailboxProviderBoundary",
  );
  const tokenRefresh = scan.indexOf("gmailAccessToken(context)", tokenBoundary);
  const listBoundary = scan.indexOf(
    "const listingBoundary = await runMailboxProviderBoundary",
    tokenRefresh,
  );
  const listRequest = scan.indexOf(
    "/gmail/v1/users/me/messages?",
    listBoundary,
  );
  const metadataLoop = scan.indexOf(
    "for (let index = 0; index < candidates.length; index += 5)",
  );
  const metadataBoundary = scan.indexOf(
    "const metadataBoundary = await runMailboxProviderBoundary",
    metadataLoop,
  );
  const metadataRequest = scan.indexOf(
    "gmailMetadata(accessToken, id)",
    metadataBoundary,
  );
  assert.ok(tokenBoundary > context && tokenRefresh > tokenBoundary);
  assert.ok(listBoundary > tokenRefresh && listRequest > listBoundary);
  assert.ok(
    metadataBoundary > metadataLoop && metadataRequest > metadataBoundary,
  );
  assert.match(
    scan.slice(tokenBoundary, metadataRequest),
    /snapshot\.classifierMode === "ai"[\s\S]*snapshot\.classifierMode === "ai"[\s\S]*snapshot\.classifierMode === "ai"/,
  );

  const persistenceGate = scan.indexOf(
    "const persistenceEntitlement = await accountBillingAccess",
    metadataRequest,
  );
  const persistence = scan.indexOf("persistScannedMessage(", persistenceGate);
  assert.ok(
    persistenceGate > metadataRequest && persistence > persistenceGate,
    "provider-read results must still be withheld after a suspension",
  );
});
