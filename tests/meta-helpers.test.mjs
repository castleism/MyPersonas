import { test } from "node:test";
import assert from "node:assert/strict";
import {
  instagramAssetFromLinked,
  normalizeLoginEmail,
  normalizeScopes,
  parseBindings,
  safeExpiry,
  validLedgerId,
  validProviderId,
} from "./lib/meta-helpers.mjs";

const UUID = "1e8b9288-a938-4c98-8988-8e0cc9835123"; // valid v4-ish
const UUID2 = "512dfc83-3ee3-4d67-ab2a-48d108e8f75a";

test("validProviderId accepts numeric provider ids, rejects the rest", () => {
  assert.equal(validProviderId("17841400478504523"), true);
  assert.equal(validProviderId(17841400478504523), true);
  assert.equal(validProviderId(""), false);
  assert.equal(validProviderId("abc"), false);
  assert.equal(validProviderId("123abc"), false);
  assert.equal(validProviderId(null), false);
});

test("validLedgerId accepts uuids, rejects junk", () => {
  assert.equal(validLedgerId(UUID), true);
  assert.equal(validLedgerId(UUID2), true);
  assert.equal(validLedgerId("not-a-uuid"), false);
  assert.equal(validLedgerId(""), false);
});

test("normalizeScopes dedups, trims, sorts, drops invalid", () => {
  assert.deepEqual(
    normalizeScopes("pages_show_list, instagram_basic pages_show_list"),
    ["instagram_basic", "pages_show_list"],
  );
  assert.deepEqual(normalizeScopes(["a", "a", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeScopes(""), []);
  assert.deepEqual(normalizeScopes(null), []);
  // spaces/invalid chars dropped
  assert.deepEqual(normalizeScopes(["good_one", "bad scope!"]), ["good_one"]);
});

test("safeExpiry: absolute preferred, relative fallback, sane window", () => {
  const now = 1_000_000_000_000; // fixed
  const inTwoHours = Math.floor((now + 2 * 3600 * 1000) / 1000);
  assert.equal(
    safeExpiry(inTwoHours, undefined, now),
    new Date(inTwoHours * 1000).toISOString(),
  );
  // too-soon absolute rejected, falls back to relative
  assert.equal(
    safeExpiry(Math.floor((now + 10_000) / 1000), 3600, now),
    new Date(now + 3600 * 1000).toISOString(),
  );
  // both invalid -> ""
  assert.equal(safeExpiry("nope", 5, now), "");
  assert.equal(safeExpiry(undefined, undefined, now), "");
  // relative beyond 400d rejected
  assert.equal(safeExpiry(undefined, 401 * 24 * 3600, now), "");
});

test("instagramAssetFromLinked keeps IG whenever a valid id exists", () => {
  // full detail
  assert.deepEqual(
    instagramAssetFromLinked({
      id: "17841400478504523",
      username: "chriscodyak",
      name: "Chris",
      account_type: "BUSINESS",
    }),
    {
      id: "17841400478504523",
      username: "chriscodyak",
      name: "Chris",
      account_type: "BUSINESS",
    },
  );
  // id-only (the whole point of the fix: still offered for pairing)
  assert.deepEqual(instagramAssetFromLinked({ id: "17841400478504523" }), {
    id: "17841400478504523",
    username: "",
    name: "",
    account_type: "",
  });
  // no/invalid id -> null
  assert.equal(instagramAssetFromLinked(null), null);
  assert.equal(instagramAssetFromLinked({ id: "abc" }), null);
  assert.equal(instagramAssetFromLinked({}), null);
});

test("parseBindings accepts valid, rejects dupes/invalid", () => {
  const ok = parseBindings([
    { pageId: "111", facebookLedgerId: UUID },
    { pageId: "222", facebookLedgerId: UUID2, instagramLedgerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
  ]);
  assert.equal(ok.length, 2);
  assert.equal(ok[1].instagramLedgerId, "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  // duplicate page id
  assert.equal(
    parseBindings([
      { pageId: "111", facebookLedgerId: UUID },
      { pageId: "111", facebookLedgerId: UUID2 },
    ]),
    null,
  );
  // duplicate ledger id
  assert.equal(
    parseBindings([
      { pageId: "111", facebookLedgerId: UUID },
      { pageId: "222", facebookLedgerId: UUID },
    ]),
    null,
  );
  // fb ledger reused as ig ledger in same row
  assert.equal(
    parseBindings([{ pageId: "111", facebookLedgerId: UUID, instagramLedgerId: UUID }]),
    null,
  );
  // empty / oversized
  assert.equal(parseBindings([]), null);
  assert.equal(parseBindings("nope"), null);
});

test("normalizeLoginEmail lowercases, trims, validates", () => {
  assert.equal(normalizeLoginEmail("  Girl.Gamer.WP@Gmail.com "), "girl.gamer.wp@gmail.com");
  assert.equal(normalizeLoginEmail("plain@example.org"), "plain@example.org");
  assert.equal(normalizeLoginEmail("no-at-sign"), "");
  assert.equal(normalizeLoginEmail("two@@at.com"), "");
  assert.equal(normalizeLoginEmail("no@domain"), "");
  assert.equal(normalizeLoginEmail(""), "");
  assert.equal(normalizeLoginEmail(null), "");
});
