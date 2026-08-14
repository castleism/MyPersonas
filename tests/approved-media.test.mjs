import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_MEDIA_BUCKET,
  approvedMediaPath,
  approvedMediaUrl,
  detectImageMime,
  readBoundedBytes,
  sha256Hex,
  stageApprovedMedia,
  validatedRemoteImageUrl,
  validateApprovedMediaRecord,
  verifyApprovedMedia,
} from "../supabase/functions/_shared/approved-media.ts";

const OWNER = "1e8b9288-a938-4c98-8988-8e0cc9835123";
const SUPABASE_URL = "https://nwsqyuucwzihruszocge.supabase.co";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class MemoryStorage {
  objects = new Map();

  from(bucket) {
    assert.equal(bucket, APPROVED_MEDIA_BUCKET);
    return {
      upload: async (path, bytes, options) => {
        if (this.objects.has(path)) return { error: { message: "already exists" } };
        this.objects.set(path, new Blob([bytes], { type: options.contentType }));
        return { error: null };
      },
      download: async (path) => ({
        data: this.objects.get(path) || null,
        error: this.objects.has(path) ? null : { message: "missing" },
      }),
    };
  }
}

test("image MIME is detected from bytes, not a filename or header", () => {
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(
    detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0x00])),
    "image/jpeg",
  );
  assert.equal(
    detectImageMime(new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ])),
    "image/webp",
  );
  assert.throws(() => detectImageMime(new TextEncoder().encode("<svg/>")));
});

test("remote source URL validation blocks local/private and ambiguous hosts", () => {
  assert.equal(
    validatedRemoteImageUrl("https://cdn.example.com/image.png#fragment").toString(),
    "https://cdn.example.com/image.png",
  );
  for (const value of [
    "http://cdn.example.com/image.png",
    "https://localhost/image.png",
    "https://127.0.0.1/image.png",
    "https://10.1.2.3/image.png",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/image.png",
    "https://user:pass@cdn.example.com/image.png",
    "https://internal/image.png",
  ]) {
    assert.throws(() => validatedRemoteImageUrl(value), value);
  }
});

test("content path and public URL are canonical and owner scoped", async () => {
  const digest = await sha256Hex(PNG);
  const path = approvedMediaPath(OWNER, digest, "image/png");
  assert.equal(
    path,
    `owners/${OWNER}/sha256/${digest.slice(0, 2)}/${digest}.png`,
  );
  const media = {
    sha256: digest,
    mime: "image/png",
    byteSize: PNG.byteLength,
    path,
    url: approvedMediaUrl(SUPABASE_URL, path),
  };
  assert.doesNotThrow(() => validateApprovedMediaRecord(media, SUPABASE_URL, OWNER));
  assert.throws(() => validateApprovedMediaRecord(
    { ...media, path: media.path.replace(OWNER, "512dfc83-3ee3-4d67-ab2a-48d108e8f75a") },
    SUPABASE_URL,
    OWNER,
  ));
});

test("staging verifies stored bytes and safely reuses identical content", async () => {
  const storage = new MemoryStorage();
  const fetcher = async () => new Response(PNG, {
    status: 200,
    headers: { "Content-Type": "image/png", "Content-Length": String(PNG.byteLength) },
  });
  const first = await stageApprovedMedia(
    storage,
    SUPABASE_URL,
    "https://cdn.example.com/image.png",
    OWNER,
    fetcher,
  );
  const second = await stageApprovedMedia(
    storage,
    SUPABASE_URL,
    "https://cdn.example.com/duplicate.png",
    OWNER,
    fetcher,
  );
  assert.deepEqual(second, first);
  assert.equal(storage.objects.size, 1);
  assert.equal(await verifyApprovedMedia(storage, SUPABASE_URL, first, OWNER), true);

  storage.objects.set(first.path, new Blob([new Uint8Array([...PNG, 0])], { type: "image/png" }));
  await assert.rejects(
    verifyApprovedMedia(storage, SUPABASE_URL, first, OWNER),
    /size no longer matches/,
  );
});

test("bounded response reader rejects an oversized stream without Content-Length", async () => {
  const response = new Response(new Uint8Array(9));
  await assert.rejects(readBoundedBytes(response, 8), /exceeds/);
});

test("staging validates redirects and declared MIME before Storage writes", async () => {
  const storage = new MemoryStorage();
  await assert.rejects(
    stageApprovedMedia(
      storage,
      SUPABASE_URL,
      "https://cdn.example.com/image.png",
      OWNER,
      async () => new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1/private.png" },
      }),
    ),
    /public HTTPS URL/,
  );
  await assert.rejects(
    stageApprovedMedia(
      storage,
      SUPABASE_URL,
      "https://cdn.example.com/image.jpg",
      OWNER,
      async () => new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    ),
    /MIME does not match/,
  );
  assert.equal(storage.objects.size, 0);
});

test("Composer schedules only through the authenticated immutable-media boundary", async () => {
  const [frontend, approvalFunction, config] = await Promise.all([
    readFile(path.join(repoRoot, "MyPersonas.Online_v0/index.html"), "utf8"),
    readFile(path.join(repoRoot, "supabase/functions/approve-post-draft/index.ts"), "utf8"),
    readFile(path.join(repoRoot, "supabase/config.toml"), "utf8"),
  ]);

  assert.match(frontend, /functions\/v1\/approve-post-draft/);
  assert.match(frontend, /Authorization":"Bearer "\+active\.access_token/);
  assert.match(frontend, /button\.textContent="Approving media…"/);
  assert.doesNotMatch(frontend, /sb\.rpc\("approve_and_schedule_post_draft"/);
  assert.match(approvalFunction, /admin\.rpc\("approve_and_schedule_post_draft"/);
  assert.match(config, /\[functions\.approve-post-draft\]\s*verify_jwt\s*=\s*true/);
});
