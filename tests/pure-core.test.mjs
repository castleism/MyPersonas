// Tests the REAL shared connector module (supabase/functions/_shared/connector/
// pure.ts) directly, using Node's type-stripping so there is no mirrored copy to
// drift. Run via: node --experimental-strip-types --test tests/pure-core.test.mjs
// (wired into `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instagramAssetFromLinked,
  normalizeEmail,
  normalizeScopes,
  parseBindings,
  safeExpiry,
  validLedgerId,
  validProviderId,
} from "../supabase/functions/_shared/connector/pure.ts";

const UUID = "1e8b9288-a938-4c98-8988-8e0cc9835123";
const UUID2 = "512dfc83-3ee3-4d67-ab2a-48d108e8f75a";
const UUID3 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("pure.ts validProviderId", () => {
  assert.equal(validProviderId("17841400478504523"), true);
  assert.equal(validProviderId("abc"), false);
  assert.equal(validProviderId(""), false);
});

test("pure.ts validLedgerId", () => {
  assert.equal(validLedgerId(UUID), true);
  assert.equal(validLedgerId("nope"), false);
});

test("pure.ts normalizeScopes", () => {
  assert.deepEqual(normalizeScopes("b, a a"), ["a", "b"]);
  assert.deepEqual(normalizeScopes(["x", "x"]), ["x"]);
});

test("pure.ts safeExpiry", () => {
  const now = 1_000_000_000_000;
  const abs = Math.floor((now + 7200_000) / 1000);
  assert.equal(safeExpiry(abs, undefined, now), new Date(abs * 1000).toISOString());
  assert.equal(safeExpiry("x", 3600, now), new Date(now + 3600_000).toISOString());
  assert.equal(safeExpiry("x", "x", now), "");
});

test("pure.ts instagramAssetFromLinked keeps id-only IG", () => {
  assert.deepEqual(instagramAssetFromLinked({ id: "123" }), {
    id: "123",
    username: "",
    name: "",
    account_type: "",
  });
  assert.equal(instagramAssetFromLinked({ id: "x" }), null);
  assert.equal(instagramAssetFromLinked(null), null);
});

test("pure.ts parseBindings", () => {
  assert.equal(
    parseBindings([{ pageId: "1", facebookLedgerId: UUID, instagramLedgerId: UUID3 }])
      .length,
    1,
  );
  assert.equal(
    parseBindings([
      { pageId: "1", facebookLedgerId: UUID },
      { pageId: "1", facebookLedgerId: UUID2 },
    ]),
    null,
  );
});

test("pure.ts normalizeEmail", () => {
  assert.equal(normalizeEmail("  A@B.Com "), "a@b.com");
  assert.equal(normalizeEmail("bad"), "");
});
