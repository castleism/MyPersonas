import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "MyPersonas.Online_v0");
const paths = {
  asset: path.join(siteRoot, "assets/MyPersonas-AI-Watermark.png"),
  module: path.join(siteRoot, "ai-content-provenance.js"),
  css: path.join(siteRoot, "ai-content-provenance.css"),
  html: path.join(siteRoot, "index.html"),
  ingest: path.join(repoRoot, "supabase/functions/media-ingest/index.ts"),
  generator: path.join(repoRoot, "supabase/functions/gemini-image/index.ts"),
  composer: path.join(repoRoot, "supabase/functions/compose-post/index.ts"),
  sql: path.join(siteRoot, "sql-updates/059-ai-content-provenance-watermark.sql"),
  mirror: path.join(repoRoot, "supabase/migrations/20260823010000_ai_content_provenance_watermark.sql"),
  config: path.join(repoRoot, "supabase/config.toml"),
};

const [asset, moduleSource, css, html, ingest, generator, composer, sql, mirror, config] = await Promise.all([
  readFile(paths.asset), readFile(paths.module, "utf8"), readFile(paths.css, "utf8"),
  readFile(paths.html, "utf8"), readFile(paths.ingest, "utf8"), readFile(paths.generator, "utf8"),
  readFile(paths.composer, "utf8"), readFile(paths.sql, "utf8"), readFile(paths.mirror, "utf8"),
  readFile(paths.config, "utf8"),
]);

function pngChunks(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const chunks = [];
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

function provenanceApi() {
  const context = {
    window: { location: { href: "https://mypersonas.online/index.html" } },
    URL,
  };
  vm.runInNewContext(moduleSource, context, { filename: "ai-content-provenance.js" });
  return context.window.MyPersonasAiProvenance;
}

test("the exact owner-supplied watermark master is preserved with its provenance container", () => {
  assert.equal(asset.length, 168751);
  assert.equal(createHash("sha256").update(asset).digest("hex"), "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2");
  const chunks = pngChunks(asset), header = chunks.find((chunk) => chunk.type === "IHDR");
  assert.ok(header);
  assert.equal(header.data.readUInt32BE(0), 2172);
  assert.equal(header.data.readUInt32BE(4), 724);
  const c2pa = chunks.find((chunk) => chunk.type === "caBX");
  assert.ok(c2pa, "the source caBX/JUMBF container must not be stripped from the master");
  assert.ok(c2pa.data.includes(Buffer.from("trainedAlgorithmicMedia")));
});

test("URL markers disclose canonical AI media without inventing legacy provenance", () => {
  const api = provenanceApi();
  assert.equal(api.config.version, "mypersonas-ai-watermark-v1");
  assert.equal(api.config.opacity, 0.22);
  const generated = api.provenanceFromUrl("https://x.test/storage/v1/object/public/persona-media/u/published/provenance/generated/generated/profile/avatar/hash.png");
  assert.equal(generated.aiUse, "generated");
  assert.equal(generated.source, "generated");
  assert.equal(generated.embedded, true);
  assert.equal(generated.legacy, false);
  assert.equal(api.publicMarkerHtml("https://x.test/storage/v1/object/public/persona-media/u/published/provenance/none/uploaded/profile/avatar/hash.png"), "");
  assert.match(api.publicMarkerHtml("https://x.test/storage/v1/object/public/persona-media/u/published/provenance/assisted/uploaded/profile/avatar/hash.png"), /AI-assisted content/);
  const legacy = api.provenanceFromUrl("https://x.test/storage/v1/object/public/persona-media/u/published/generated/avatar/hash.png");
  assert.equal(legacy.aiUse, "generated");
  assert.equal(legacy.embedded, false);
  assert.equal(legacy.legacy, true);
  assert.equal(api.provenanceFromUrl("https://example.com/unverified.png"), null);
});

test("raster watermarking is integrity-pinned, subtle, bottom-right, crop-last, and fail-closed", () => {
  assert.match(moduleSource, /assetSha256: "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2"/);
  assert.match(moduleSource, /sourceCrop: Object\.freeze\(\{ x: 345, y: 204, width: 1481, height: 306 \}\)/);
  assert.match(moduleSource, /opacity: 0\.22/);
  assert.match(moduleSource, /haloOpacity: 0\.10/);
  assert.match(moduleSource, /if \(requestedCrop\) drawCover\([\s\S]*drawWatermark\(/);
  assert.match(moduleSource, /const x = width - margin - markWidth/);
  assert.match(moduleSource, /const y = height - margin - markHeight/);
  assert.match(moduleSource, /AI-used animated GIFs need frame-by-frame watermarking/);
  assert.doesNotMatch(moduleSource, /catch\s*\([^)]*\)\s*\{\s*return file/);
  assert.match(css, /\.albitem img\.ai-content-image\{object-fit:contain/);
});

test("every browser intake asks once, while site generation is automatically declared", () => {
  assert.match(moduleSource, /Was generative AI used\?/);
  for (const value of ["none", "assisted", "generated", "unknown"]) {
    assert.match(moduleSource, new RegExp(`data-ai-use="${value}"`));
  }
  assert.match(html, /function uploadTo\(inputId\)[\s\S]*MyPersonasAiProvenance\.askAiUse/);
  assert.match(html, /async function composerUploadSource\(\)[\s\S]*MyPersonasAiProvenance\.askAiUse/);
  assert.match(html, /body:JSON\.stringify\(\{prompt,target:sdTarget,baseImage,personaId:editId\}\)/);
  assert.match(html, /aiUse:"generated",origin:"site_generated"/);
  assert.match(html, /generationEventId/);
  assert.doesNotMatch(html, /function watermarkImage\(/);
  assert.doesNotMatch(html, /storage\.from\("persona-media"\)/);
});

test("secure intake validates caller, ownership, bytes, provenance, and final derivative before storage", () => {
  assert.match(ingest, /admin\.auth\.getUser/);
  assert.match(ingest, /\.eq\("id", personaId\)\.eq\("owner", user\.id\)/);
  assert.match(ingest, /detectedMedia\(bytes\)/);
  assert.match(ingest, /declared media type does not match the file bytes/);
  assert.match(ingest, /aiUse === "none" && sourceSha256 !== contentSha256/);
  assert.match(ingest, /aiUse !== "none" && sourceSha256 === contentSha256/);
  assert.match(ingest, /use_ai_media_generation_event_service/);
  assert.match(ingest, /published\/provenance\/\$\{aiUse\}\/\$\{source\}/);
  assert.match(ingest, /register_persona_media_asset_service/);
  assert.ok(ingest.indexOf("detectedMedia(bytes)") < ingest.indexOf(".upload(path, bytes"));
  assert.ok(ingest.indexOf("use_ai_media_generation_event_service") < ingest.indexOf(".upload(path, bytes"));
  assert.match(config, /\[functions\.media-ingest\]\s*\r?\nverify_jwt = true/);
});

test("Gemini generation records short-lived server evidence before returning usable bytes", () => {
  assert.match(generator, /const personaId = typeof body\.personaId === "string"/);
  assert.match(generator, /\.eq\("id", personaId\)\.eq\("owner", guard\.user\.id\)/);
  assert.match(generator, /ai_media_generation_events/);
  assert.match(generator, /provider: "google"/);
  assert.match(generator, /output_sha256: outputSha256/);
  assert.ok(generator.indexOf('from("ai_media_generation_events").insert') < generator.indexOf("image: `data:${mime};base64,${imageData}`"));
  assert.match(generator, /generationEventId: generation\.data\.id/);
});

test("social composer requires registered final AI crops after each crop operation", () => {
  for (const crop of ["width:1200,height:628", "width:1080,height:1080", "width:1080,height:1350"]) {
    assert.match(html, new RegExp(crop.replace(/[{}]/g, "\\$&")));
  }
  assert.match(composer, /from\("persona_media_assets"\)/);
  assert.match(composer, /AI-used media requires three distinct registered final crops/);
  assert.match(composer, /asset\.watermark_state !== "system_applied"/);
  assert.match(composer, /asset\.source_sha256 !== sourceAsset\.source_sha256/);
  assert.match(composer, /media_provenance_required: true/);
  assert.match(html, /id="cmpImg" readonly/);
});

test("migration and release mirror bind immutable provenance into every media consumer", () => {
  assert.equal(sql, mirror);
  assert.match(sql, /^begin;/m);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /guard_persona_media_asset_provenance/);
  assert.match(sql, /revoke all on function public\.add_media_asset/);
  assert.match(sql, /persona media service insert/);
  assert.match(sql, /avatar_media_asset_id/);
  assert.match(sql, /media_asset_id/);
  assert.match(sql, /source_media_asset_id/);
  assert.match(sql, /guard_post_draft_media_provenance/);
  assert.match(sql, /schema_version',2/);
  assert.match(sql, /invalid_new_assets/);
  assert.match(sql, /legacy_unverified_assets/);
});
