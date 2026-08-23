import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVED_MEDIA_BUCKET,
  approvedMediaDeliveryIdFromUrl,
  approvedMediaDeliveryUrl,
  approvedMediaPath,
  approvedMediaProviderUrl,
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
// Approved-media sources must be owner-scoped persona-media URLs on this project.
const src = (name) =>
  `${SUPABASE_URL}/storage/v1/object/public/persona-media/${OWNER}/${name}`;

const DELIVERY_ID = "06300000-0000-4000-8000-000000000001";

class MemoryAdmin {
  objects = new Map();
  handles = new Map();
  storage = this;

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

  async rpc(name, args) {
    if (name === "issue_post_approved_media_handle_service") {
      const existing = this.handles.get(args.p_storage_path);
      if (existing) return { data: existing.publicId, error: null };
      const handle = {
        publicId: DELIVERY_ID,
        bucket: APPROVED_MEDIA_BUCKET,
        storage_path: args.p_storage_path,
        mime_type: args.p_mime_type,
        byte_size: args.p_byte_size,
        content_sha256: args.p_sha256,
      };
      this.handles.set(args.p_storage_path, handle);
      return { data: handle.publicId, error: null };
    }
    if (name === "resolve_post_approved_media_service") {
      const handle = [...this.handles.values()].find((row) =>
        row.publicId === args.p_public_id
      );
      if (!handle) return { data: null, error: null };
      const { publicId: _publicId, ...resolution } = handle;
      return { data: resolution, error: null };
    }
    return { data: null, error: { message: "unknown RPC" } };
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

test("remote source URL validation requires an owner-scoped persona-media URL", () => {
  // A valid owner-scoped persona-media URL passes; the fragment is stripped.
  assert.equal(
    validatedRemoteImageUrl(src("image.png") + "#fragment", SUPABASE_URL, OWNER).toString(),
    src("image.png"),
  );
  // The render-image transform variant is also allowed.
  assert.doesNotThrow(() => validatedRemoteImageUrl(
    `${SUPABASE_URL}/storage/v1/render/image/public/persona-media/${OWNER}/image.png`,
    SUPABASE_URL,
    OWNER,
  ));
  // Everything else is rejected: wrong scheme/host, local/private/metadata hosts,
  // embedded creds, wrong bucket, another owner's prefix, and path traversal.
  for (const value of [
    src("image.png").replace("https://", "http://"),
    "https://cdn.example.com/image.png",
    src("image.png").replace(SUPABASE_URL, "https://localhost"),
    src("image.png").replace(SUPABASE_URL, "https://127.0.0.1"),
    src("image.png").replace(SUPABASE_URL, "https://169.254.169.254"),
    src("image.png").replace("//nws", "//user:pass@nws"),
    `${SUPABASE_URL}/storage/v1/object/public/media/${OWNER}/image.png`,
    `${SUPABASE_URL}/storage/v1/object/public/persona-media/512dfc83-3ee3-4d67-ab2a-48d108e8f75a/image.png`,
    `${SUPABASE_URL}/storage/v1/object/public/persona-media/${OWNER}/%2e%2e/secret.png`,
  ]) {
    assert.throws(() => validatedRemoteImageUrl(value, SUPABASE_URL, OWNER), value);
  }
  // An invalid owner is rejected explicitly.
  assert.throws(
    () => validatedRemoteImageUrl(src("image.png"), SUPABASE_URL, "not-a-uuid"),
    /Invalid approved-media owner/,
  );
});

test("internal path stays owner scoped while public provider delivery is opaque", async () => {
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
    deliveryId: DELIVERY_ID,
    deliveryUrl: approvedMediaDeliveryUrl(DELIVERY_ID),
  };
  assert.doesNotThrow(() => validateApprovedMediaRecord(media, SUPABASE_URL, OWNER));
  assert.equal(approvedMediaDeliveryIdFromUrl(media.deliveryUrl), DELIVERY_ID);
  assert.equal(approvedMediaProviderUrl(media), media.deliveryUrl);
  assert.doesNotMatch(media.deliveryUrl, new RegExp(OWNER, "i"));
  assert.throws(() => validateApprovedMediaRecord(
    { ...media, path: media.path.replace(OWNER, "512dfc83-3ee3-4d67-ab2a-48d108e8f75a") },
    SUPABASE_URL,
    OWNER,
  ));
});

test("staging verifies stored bytes and safely reuses identical content", async () => {
  const admin = new MemoryAdmin();
  const fetcher = async () => new Response(PNG, {
    status: 200,
    headers: { "Content-Type": "image/png", "Content-Length": String(PNG.byteLength) },
  });
  const first = await stageApprovedMedia(
    admin,
    SUPABASE_URL,
    src("image.png"),
    OWNER,
    fetcher,
  );
  const second = await stageApprovedMedia(
    admin,
    SUPABASE_URL,
    src("duplicate.png"),
    OWNER,
    fetcher,
  );
  assert.deepEqual(second, first);
  assert.equal(admin.objects.size, 1);
  assert.equal(admin.handles.size, 1);
  assert.equal(await verifyApprovedMedia(admin, SUPABASE_URL, first, OWNER), true);
  assert.equal(first.deliveryUrl, approvedMediaDeliveryUrl(DELIVERY_ID));

  admin.objects.set(first.path, new Blob([new Uint8Array([...PNG, 0])], { type: "image/png" }));
  await assert.rejects(
    verifyApprovedMedia(admin, SUPABASE_URL, first, OWNER),
    /size no longer matches/,
  );
});

test("bounded response reader rejects an oversized stream without Content-Length", async () => {
  const response = new Response(new Uint8Array(9));
  await assert.rejects(readBoundedBytes(response, 8), /exceeds/);
});

test("staging validates redirects and declared MIME before Storage writes", async () => {
  const admin = new MemoryAdmin();
  await assert.rejects(
    stageApprovedMedia(
      admin,
      SUPABASE_URL,
      src("image.png"),
      OWNER,
      async () => new Response(null, {
        status: 302,
        headers: { Location: "https://127.0.0.1/private.png" },
      }),
    ),
    /must not redirect/,
  );
  await assert.rejects(
    stageApprovedMedia(
      admin,
      SUPABASE_URL,
      src("image.jpg"),
      OWNER,
      async () => new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    ),
    /MIME does not match/,
  );
  assert.equal(admin.objects.size, 0);
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
  assert.match(approvalFunction, /admin\.rpc\("approve_and_schedule_post_draft_opaque"/);
  assert.match(config, /\[functions\.approve-post-draft\]\s*verify_jwt\s*=\s*true/);
});

test("browser public uploads use the authenticated provenance intake", async () => {
  const frontend = await readFile(
    path.join(repoRoot, "MyPersonas.Online_v0/index.html"),
    "utf8",
  );
  const immutableUpload = frontend.slice(
    frontend.indexOf("async function uploadImmutablePersonaMedia"),
    frontend.indexOf("async function sdUse"),
  );
  const uploadPolicy = frontend.slice(
    frontend.indexOf("const PUBLIC_PERSONA_MEDIA_EXTENSIONS"),
    frontend.indexOf("async function sdUse"),
  );
  const generatedUpload = frontend.slice(
    frontend.indexOf("async function sdUse"),
    frontend.indexOf("// ---------- session timeout warning"),
  );
  const pickerUpload = frontend.slice(
    frontend.indexOf("function uploadTo"),
    frontend.indexOf("// ================= ACCOUNT:"),
  );
  const composerUpload = frontend.slice(
    frontend.indexOf("async function composerUploadSource"),
    frontend.indexOf("async function openComposer"),
  );

  assert.match(frontend, /PUBLIC_PERSONA_MEDIA_EXTENSIONS=Object\.freeze\(\{"image\/png":"png","image\/jpeg":"jpg","image\/webp":"webp","image\/gif":"gif","video\/mp4":"mp4","video\/webm":"webm"\}\)/);
  assert.doesNotMatch(uploadPolicy, /image\/svg\+xml/);
  assert.doesNotMatch(frontend, /accept="image\/\*/);
  assert.match(immutableUpload, /sb\.auth\.getSession\(\)/);
  assert.match(immutableUpload, /new FormData\(\)/);
  assert.match(immutableUpload, /form\.append\("personaId",personaId\)/);
  assert.match(immutableUpload, /form\.append\("aiUse",aiUse\)/);
  assert.match(immutableUpload, /functions\/v1\/media-ingest/);
  assert.doesNotMatch(immutableUpload, /storage\.from|bucket\.upload/);
  assert.match(generatedUpload, /out\.dataset\.publicUrl/);
  assert.match(generatedUpload, /out\.dataset\.assetId/);
  assert.doesNotMatch(generatedUpload, /watermarkRaster|uploadImmutablePersonaMedia/);
  assert.match(pickerUpload, /f\.accept="image\/png,image\/jpeg,image\/webp,image\/gif,video\/mp4,video\/webm"/);
  assert.match(pickerUpload, /if\(profileSlot\)f\.accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(pickerUpload, /MyPersonasProfileCrop\.open\(\{file:source,slot:inputId\.slice\(2\)\}\)/);
  assert.match(pickerUpload, /MyPersonasAiProvenance\.askAiUse/);
  assert.match(pickerUpload, /MyPersonasAiProvenance\.sha256Hex\(prepared\)/);
  assert.doesNotMatch(pickerUpload, /MyPersonasAiProvenance\.sha256Hex\(source\)/);
  assert.doesNotMatch(pickerUpload, /MyPersonasAiProvenance\.watermarkRaster\(source\)/);
  assert.match(pickerUpload, /uploadImmutablePersonaMedia\(prepared,ownerId,uploadPurpose\(inputId\)/);
  assert.doesNotMatch(pickerUpload, /storage\.from|bucket\.upload|watermarkImage/);
  assert.ok(
    pickerUpload.indexOf("MyPersonasAiProvenance.sha256Hex(prepared)") <
      pickerUpload.indexOf("uploadImmutablePersonaMedia(prepared"),
    "approved crop integrity hashing must finish before trusted server intake",
  );
  assert.match(composerUpload, /MyPersonasAiProvenance\.askAiUse/);
  assert.match(composerUpload, /crop:\{width:1200,height:628\}/);
  assert.match(composerUpload, /crop:\{width:1080,height:1080\}/);
  assert.match(composerUpload, /crop:\{width:1080,height:1350\}/);
  assert.match(composerUpload, /rendition:"facebook"/);
  assert.match(composerUpload, /rendition:"instagram"/);
  assert.match(composerUpload, /rendition:"x"/);
  assert.doesNotMatch(composerUpload, /storage\.from|bucket\.upload|watermarkRaster/);
});
