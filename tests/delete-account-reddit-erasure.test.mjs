import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  path.join(repoRoot, "supabase/functions/delete-account/index.ts"),
  "utf8",
);

function functionBlock(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index++) {
    if (source[index] === "(") parameterDepth++;
    if (source[index] === ")") {
      parameterDepth--;
      if (parameterDepth === 0) {
        parametersEnd = index;
        break;
      }
    }
  }
  assert.notEqual(parametersEnd, -1, `${name} has unterminated parameters`);
  const bodyStart = source.indexOf("{", parametersEnd);
  assert.notEqual(bodyStart, -1, `${name} has no body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has an unterminated body`);
}

function assertOrdered(haystack, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker: ${needle}`);
    assert.ok(next > cursor, `${needle} appeared out of order`);
    cursor = next;
  }
}

test("Reddit provider revocation uses the required fail-closed request", () => {
  const block = functionBlock("revokeRedditRefreshToken");
  assert.match(block, /https:\/\/www\.reddit\.com\/api\/v1\/revoke_token/);
  assert.match(block, /method: "POST"/);
  assert.match(block, /"Authorization": `Basic \$\{btoa\(`/);
  assert.match(block, /"Content-Type": "application\/x-www-form-urlencoded"/);
  assert.match(block, /"User-Agent": REDDIT_USER_AGENT/);
  assert.match(block, /token: refreshToken/);
  assert.match(block, /token_type_hint: "refresh_token"/);
  assert.match(block, /redirect: "error"/);
  assert.match(block, /AbortSignal\.timeout\(15_000\)/);
  assert.match(block, /return response\.ok/);
  assert.match(block, /catch \{\s*return false;/s);
});

test("all Reddit revocations precede local token cleanup and ledgers remain for dependency-ordered erasure", () => {
  const inventory = functionBlock("listRedditLedgers");
  assert.match(inventory, /\.eq\("owner", uid\)\.eq\("provider", "reddit"\)/);
  assert.match(inventory, /\.range\(from, from \+ 499\)/);

  const block = functionBlock("revokeReddit");
  assertOrdered(block, [
    "listRedditLedgers(admin, uid)",
    'admin.rpc("reddit_get_tokens_service"',
    "hasStoredRedditToken",
    "revokeRedditRefreshToken(",
    '"reddit_clear_tokens_service"',
    'admin.from("reddit_oauth_states").delete()',
  ]);
  assert.doesNotMatch(block, /admin\.from\("account_ledger"\)\.delete/);
  assert.match(block, /plan\.refreshToken &&\s*!await revokeRedditRefreshToken/s);
  assert.match(block, /hasStoredToken: Boolean\(accessToken \|\| refreshToken\)/);
  assert.match(
    block,
    /Reddit did not confirm revocation; no local Reddit token or ledger record was deleted/,
  );
  assert.doesNotMatch(block, /acknowledg|manual/i);
});

test("Reddit state cleanup is ordered before the generic ledger delete", () => {
  const block = functionBlock("eraseOwnedRows");
  assertOrdered(block, [
    'admin.from("reddit_oauth_states").delete().eq("owner", uid)',
    'admin.rpc("delete_account_ledger_for_account_service"',
  ]);

  const erasure = source.slice(source.indexOf("const eraseClaimedOwner"));
  assertOrdered(erasure, [
    '"X revocation"',
    "revokeTwitter(",
    '"Reddit revocation"',
    "revokeReddit(admin, uid)",
    '"Meta revocation"',
    "revokeMeta(",
  ]);
});

test("owned storage removal is exact, recursive, verified, and precedes row erasure", () => {
  const block = functionBlock("eraseOwnedStorage");
  assert.match(block, /\{ bucket: "media", prefix: normalizedOwner \}/);
  assert.match(block, /\{ bucket: "persona-media", prefix: normalizedOwner \}/);
  assert.match(block, /\{ bucket: "persona-docs", prefix: normalizedOwner \}/);
  assert.match(block, /bucket: "post-approved-media",\s*prefix: `owners\/\$\{normalizedOwner\}`/s);
  assert.match(block, /admin\.storage\.listBuckets\(\)/);
  assert.match(block, /existingBuckets\.has\(target\.bucket\)/);

  const recursive = functionBlock("listStorageFiles");
  assert.match(recursive, /listStorageFiles\(admin, bucket, path, visited\)/);
  assert.match(recursive, /limit: 1000/);
  const erasePrefix = functionBlock("eraseStoragePrefix");
  assert.match(erasePrefix, /pass < 3/);
  assert.match(erasePrefix, /start \+= 500/);
  assert.match(erasePrefix, /storage removal could not be verified/);

  const erasure = source.slice(source.indexOf("const eraseClaimedOwner"));
  assertOrdered(erasure, [
    '"owned storage erasure"',
    "eraseOwnedStorage(admin, uid)",
    '"owned-row erasure"',
    "eraseOwnedRows(admin, uid, personaIds)",
  ]);
});

test("Reddit never becomes a manual erasure acknowledgement", () => {
  const capabilityStart = source.indexOf("externalRevocationAcknowledgements:");
  const capabilityEnd = source.indexOf("]", capabilityStart);
  const capabilities = source.slice(capabilityStart, capabilityEnd + 1);
  assert.doesNotMatch(capabilities, /reddit/i);

  const acknowledgementStart = source.indexOf(
    "const acknowledgedExternalRevocations",
  );
  const acknowledgementEnd = source.indexOf("try {", acknowledgementStart);
  const acknowledgements = source.slice(
    acknowledgementStart,
    acknowledgementEnd,
  );
  assert.doesNotMatch(acknowledgements, /reddit/i);
});
