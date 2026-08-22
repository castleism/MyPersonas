import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseWorkroomUrl, partitionName, safeInitialUrl } = require(path.join(root, "apps/workroom-bridge/provider-policy.cjs"));

const account = "11111111-1111-4111-8111-111111111111";
const persona = "22222222-2222-4222-8222-222222222222";

test("workroom protocol accepts an allowlisted provider URL without credentials", () => {
  const input = `aliaspaces-workroom://open?provider=instagram&account_id=${account}&persona_id=${persona}&url=${encodeURIComponent("https://www.instagram.com/accounts/edit/")}`;
  assert.deepEqual(parseWorkroomUrl(input), {
    ok: true,
    provider: "instagram",
    accountId: account,
    personaId: persona,
    initialUrl: "https://www.instagram.com/accounts/edit/",
  });
});

test("workroom protocol rejects identity, host, credential, and scheme confusion", () => {
  const base = `aliaspaces-workroom://open?provider=instagram&account_id=${account}&persona_id=${persona}&url=`;
  for (const url of [
    "http://www.instagram.com/",
    "https://user:pass@www.instagram.com/",
    "https://instagram.com.evil.example/",
    "https://www.instagram.com:8443/",
    "javascript:alert(1)",
  ]) assert.equal(parseWorkroomUrl(base + encodeURIComponent(url)).ok, false);
  assert.equal(parseWorkroomUrl(base.replace(account, "not-a-uuid") + encodeURIComponent("https://www.instagram.com/")).ok, false);
  assert.equal(safeInitialUrl("unknown", "https://example.com/"), "");
});

test("partitions are deterministic per installation/account and isolated across accounts", () => {
  const installation = "33333333-3333-4333-8333-333333333333";
  const a = partitionName(installation, account);
  const b = partitionName(installation, account);
  const c = partitionName(installation, persona);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^persist:aliaspaces-account-[0-9a-f]{40}$/);
  assert.doesNotMatch(a, new RegExp(account, "i"));
});
