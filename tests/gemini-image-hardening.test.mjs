import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodedBase64ByteLength,
  GEMINI_IMAGE_MODEL,
  GEMINI_NATIVE_BASE_URL,
  geminiGenerateContentUrl,
  isGoogleImageProvider,
  MAX_BASE_IMAGE_BASE64_CHARS,
  MAX_BASE_IMAGE_BYTES,
  MAX_GEMINI_IMAGE_REQUEST_BYTES,
  parseGeminiBaseImage,
  pinnedGeminiImageModel,
} from "../supabase/functions/_shared/gemini-image.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const [source, helperSource, config] = await Promise.all([
  readFile(
    path.join(repoRoot, "supabase/functions/gemini-image/index.ts"),
    "utf8",
  ),
  readFile(
    path.join(repoRoot, "supabase/functions/_shared/gemini-image.ts"),
    "utf8",
  ),
  readFile(path.join(repoRoot, "supabase/config.toml"), "utf8"),
]);

test("Gemini image traffic is pinned to the native Google endpoint and model", () => {
  assert.equal(
    GEMINI_NATIVE_BASE_URL,
    "https://generativelanguage.googleapis.com/v1beta",
  );
  assert.equal(GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image");
  assert.equal(
    geminiGenerateContentUrl(),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
  );
  assert.equal(
    pinnedGeminiImageModel("gemini-3.1-flash-image"),
    GEMINI_IMAGE_MODEL,
  );
  assert.throws(
    () => pinnedGeminiImageModel("gemini-2.5-flash-image"),
    /Only gemini-3\.1-flash-image is supported/,
  );
  assert.throws(() => pinnedGeminiImageModel({ model: GEMINI_IMAGE_MODEL }));

  assert.match(source, /"x-goog-api-key": key/);
  assert.match(source, /redirect: "error"/);
  assert.doesNotMatch(
    source,
    /[?&]key=|encodeURIComponent\(key\)|URLSearchParams\([^)]*key/,
  );
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/);
});

test("only owned Google provider records can supply the credential", () => {
  assert.equal(isGoogleImageProvider("google"), true);
  assert.equal(isGoogleImageProvider(" GOOGLE_LEGACY "), true);
  assert.equal(isGoogleImageProvider("openrouter"), false);
  assert.equal(isGoogleImageProvider({ provider: "google" }), false);

  assert.match(source, /\.select\("id,provider"\)/);
  assert.doesNotMatch(source, /\.select\("[^"]*(?:base_url|api_key|model)/);
  assert.doesNotMatch(source, /backend\.(?:base_url|api_key|model)/);
  assert.match(source, /\.eq\("owner", owner\)\.eq\("id", backendId\)/);
  assert.match(source, /\.in\("provider", GOOGLE_PROVIDERS\)/);
  assert.match(source, /ai_backend_get_key/);
  assert.match(
    source,
    /body\.provider !== undefined && !isGoogleImageProvider/,
  );
  assert.match(source, /model = pinnedGeminiImageModel\(body\.model\)/);
});

test("request and decoded base-image sizes are bounded before payload use", () => {
  assert.equal(MAX_GEMINI_IMAGE_REQUEST_BYTES, 12 * 1024 * 1024);
  assert.equal(MAX_BASE_IMAGE_BYTES, 8 * 1024 * 1024);
  assert.equal(
    MAX_BASE_IMAGE_BASE64_CHARS,
    Math.ceil(MAX_BASE_IMAGE_BYTES / 3) * 4,
  );
  assert.equal(decodedBase64ByteLength("YQ==", 1), 1);
  assert.equal(decodedBase64ByteLength("YWI=", 2), 2);
  assert.throws(() => decodedBase64ByteLength("YWI=", 1), /decoded-byte limit/);
  assert.throws(
    () => decodedBase64ByteLength("not base64"),
    /canonical base64/,
  );

  assert.deepEqual(parseGeminiBaseImage("data:image/png;base64,YQ=="), {
    mimeType: "image/png",
    data: "YQ==",
    decodedBytes: 1,
  });
  assert.throws(
    () => parseGeminiBaseImage("data:image/svg+xml;base64,YQ=="),
    /JPEG, PNG, or WebP/,
  );

  const encodedLimit = helperSource.indexOf(
    "encodedLength > MAX_BASE_IMAGE_BASE64_CHARS",
  );
  const payloadSlice = helperSource.indexOf("value.slice(dataStart)");
  const decodedLimit = helperSource.indexOf(
    "decodedBase64ByteLength(data, MAX_BASE_IMAGE_BYTES)",
  );
  assert.ok(encodedLimit > 0 && encodedLimit < payloadSlice);
  assert.ok(payloadSlice < decodedLimit);
  assert.doesNotMatch(helperSource, /\batob\(|Buffer\.from/);

  assert.match(source, /source\.body\.getReader\(\)/);
  assert.match(source, /total > maxBytes/);
  assert.match(source, /MAX_GEMINI_IMAGE_REQUEST_BYTES/);
  assert.doesNotMatch(source, /await req\.json\(\)/);
});

test("validated AAL2 precedes request, backend, Vault, and provider work", () => {
  const guard = source.indexOf("await requireAal2(req, admin)");
  assert.ok(guard > 0);
  for (
    const marker of [
      "await readBoundedText(",
      "await ownerGoogleBackend(",
      "await ownerBackendKey(",
      "await fetch(geminiGenerateContentUrl(model)",
    ]
  ) {
    assert.ok(guard < source.indexOf(marker), `${marker} must follow AAL2`);
  }
  assert.match(config, /\[functions\.gemini-image\]\s*\r?\nverify_jwt = true/);
});
