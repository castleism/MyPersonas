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
  functionAsset: path.join(repoRoot, "supabase/functions/media-ingest/MyPersonas-AI-Watermark.png"),
  module: path.join(siteRoot, "ai-content-provenance.js"),
  css: path.join(siteRoot, "ai-content-provenance.css"),
  html: path.join(siteRoot, "index.html"),
  ingest: path.join(repoRoot, "supabase/functions/media-ingest/index.ts"),
  generator: path.join(repoRoot, "supabase/functions/gemini-image/index.ts"),
  composer: path.join(repoRoot, "supabase/functions/compose-post/index.ts"),
  frozenSql: path.join(siteRoot, "sql-updates/059-ai-content-provenance-watermark.sql"),
  frozenMirror: path.join(repoRoot, "supabase/migrations/20260823010000_ai_content_provenance_watermark.sql"),
  sql: path.join(siteRoot, "sql-updates/060-ai-content-provenance-hardening.sql"),
  mirror: path.join(repoRoot, "supabase/migrations/20260823020000_ai_content_provenance_hardening.sql"),
  config: path.join(repoRoot, "supabase/config.toml"),
};

const [asset, functionAsset, moduleSource, css, html, ingest, generator, composer, frozenSql, frozenMirror, sql, mirror, config] = await Promise.all([
  readFile(paths.asset), readFile(paths.functionAsset), readFile(paths.module, "utf8"), readFile(paths.css, "utf8"),
  readFile(paths.html, "utf8"), readFile(paths.ingest, "utf8"), readFile(paths.generator, "utf8"),
  readFile(paths.composer, "utf8"), readFile(paths.frozenSql, "utf8"), readFile(paths.frozenMirror, "utf8"),
  readFile(paths.sql, "utf8"), readFile(paths.mirror, "utf8"),
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
  assert.deepEqual(functionAsset, asset, "the trusted Edge function must bundle the exact owner-supplied master");
});

test("URL markers disclose canonical AI media without inventing legacy provenance", () => {
  const api = provenanceApi();
  assert.equal(api.config.version, "mypersonas-ai-watermark-v1");
  assert.equal(api.config.opacity, 0.22);
  const generated = api.provenanceFromUrl("https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/u/published/provenance/generated/generated/persona/profile/avatar/hash.png");
  assert.equal(generated.aiUse, "generated");
  assert.equal(generated.source, "generated");
  assert.equal(generated.embedded, true);
  assert.equal(generated.legacy, false);
  assert.equal(api.publicMarkerHtml("https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/u/published/provenance/none/uploaded/persona/profile/avatar/hash.png"), "");
  assert.match(api.publicMarkerHtml("https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/u/published/provenance/assisted/uploaded/persona/profile/avatar/hash.png"), /AI-assisted content/);
  const spoofed = api.provenanceFromUrl("https://evil.example/storage/v1/object/public/persona-media/u/published/provenance/generated/generated/persona/profile/avatar/hash.png");
  assert.equal(spoofed.aiUse, "unknown");
  assert.equal(spoofed.external, true);
  assert.equal(spoofed.embedded, false);
  assert.match(api.publicMarkerHtml("https://cdn.example.test/legacy-image.png"), /AI use not known/);
  const legacy = api.provenanceFromUrl("https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/persona-media/u/published/generated/avatar/hash.png");
  assert.equal(legacy.aiUse, "unknown");
  assert.equal(legacy.embedded, false);
  assert.equal(legacy.legacy, true);
  const external = api.provenanceFromUrl("https://example.com/unverified.png");
  assert.equal(external.aiUse, "unknown");
  assert.equal(external.external, true);
});

test("preview rendering and trusted rendering share the pinned, subtle, crop-last watermark contract", () => {
  assert.match(moduleSource, /const WATERMARK_SHA256 = "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2"/);
  assert.match(moduleSource, /assetSha256: WATERMARK_SHA256/);
  assert.match(moduleSource, /sourceCrop: Object\.freeze\(\{ x: 345, y: 204, width: 1481, height: 306 \}\)/);
  assert.match(moduleSource, /opacity: 0\.22/);
  assert.match(moduleSource, /haloOpacity: 0\.10/);
  assert.match(moduleSource, /if \(requestedCrop\) drawCover\([\s\S]*drawWatermark\(/);
  assert.match(moduleSource, /Math\.sqrt\(CONFIG\.maxOutputPixels/);
  assert.match(moduleSource, /const x = width - margin - markWidth/);
  assert.match(moduleSource, /const y = height - margin - markHeight/);
  assert.match(moduleSource, /AI-used animated GIFs need frame-by-frame watermarking/);
  assert.doesNotMatch(moduleSource, /catch\s*\([^)]*\)\s*\{\s*return file/);
  assert.match(css, /\.albitem img\.ai-content-image\{object-fit:contain/);
  assert.match(css, /MyPersonas-AI-Watermark\.png\?sha256=c8ff9543/);
  assert.match(css, /needs-logo-overlay\{[^}]*width:42%;min-width:88px/);
  assert.match(css, /needs-logo-overlay \.ai-content-watermark\{display:block;width:100%/);
});

test("every browser intake asks once, while site generation is automatically declared", () => {
  assert.match(moduleSource, /Was generative AI used\?/);
  for (const value of ["none", "assisted", "generated", "unknown"]) {
    assert.match(moduleSource, new RegExp(`data-ai-use="${value}"`));
  }
  assert.match(html, /function uploadTo\(inputId\)[\s\S]*MyPersonasAiProvenance\.askAiUse/);
  assert.match(html, /async function composerUploadSource\(\)[\s\S]*MyPersonasAiProvenance\.askAiUse/);
  assert.match(html, /body:JSON\.stringify\(\{prompt,target:sdTarget,baseImage,personaId:editId\}\)/);
  assert.match(generator, /intakeForm\.append\("aiUse", "generated"\)/);
  assert.match(generator, /functions\/v1\/media-ingest/);
  assert.doesNotMatch(generator, /image: `data:\$\{mime\};base64/);
  assert.match(html, /j\.watermarkState!=="system_applied"/);
  assert.doesNotMatch(html, /function watermarkImage\(/);
  assert.doesNotMatch(html, /storage\.from\("persona-media"\)/);
});

test("secure intake validates source bytes and creates the final derivative server-side before storage", () => {
  assert.match(ingest, /admin\.auth\.getUser/);
  assert.match(ingest, /\.eq\("id", personaId\)\.eq\("owner", user\.id\)/);
  assert.match(ingest, /detectedMedia\(bytes\)/);
  assert.match(ingest, /declared media type does not match the file bytes/);
  assert.match(ingest, /sourceSha256 !== actualSourceSha256/);
  assert.ok(ingest.indexOf("validatedDimensions(bytes, detected.mime)") < ingest.indexOf('if (aiUse !== "none" && !["image/png"'));
  assert.match(ingest, /renderWatermarkedRaster\(bytes, detected\.mime, crop\)/);
  assert.match(ingest, /npm:@imagemagick\/magick-wasm@0\.0\.42/);
  assert.match(ingest, /Deno\.readFile\(new URL\("\.\/MyPersonas-AI-Watermark\.png"/);
  assert.match(ingest, /await sha256Hex\(master\) !== WATERMARK_SHA256/);
  assert.match(ingest, /watermark\.evaluate\(Channels\.Alpha, EvaluateOperator\.Multiply, WATERMARK_OPACITY\)/);
  assert.match(ingest, /image\.composite\(watermark, CompositeOperator\.Over/);
  assert.ok(ingest.indexOf("renderWatermarkedRaster(bytes, detected.mime, crop)") < ingest.indexOf(".upload(path, finalBytes"));
  assert.doesNotMatch(ingest, /AI-used imagery must provide a distinct final watermarked derivative/);
  assert.doesNotMatch(ingest, /use_ai_media_generation_event_service/);
  assert.match(ingest, /published\/provenance\/\$\{aiUse\}\/\$\{source\}\/\$\{personaId\}\/\$\{purpose\}/);
  assert.ok(ingest.indexOf("finalBytes.byteLength > MAX_IMAGE_BYTES") < ingest.indexOf(".upload(path, finalBytes"));
  assert.match(ingest, /register_persona_media_asset_service/);
  assert.ok(ingest.indexOf("detectedMedia(bytes)") < ingest.indexOf(".upload(path, finalBytes"));
  assert.match(config, /\[functions\.media-ingest\]\s*\r?\nverify_jwt = true/);
  assert.match(config, /static_files = \["\.\/functions\/media-ingest\/MyPersonas-AI-Watermark\.png"\]/);
  assert.match(ingest, /hasUnsupportedAnimation/);
  assert.match(ingest, /MAX_SOURCE_PIXELS = 12_000_000/);
  assert.match(ingest, /MAX_OUTPUT_PIXELS = 2_000_000/);
  assert.match(ingest, /storage\.from\(BUCKET\)\.remove\(\[path\]\)/);
});

test("Gemini generation records evidence, honors budgets, and returns only a registered marked URL", () => {
  assert.match(generator, /const personaId = typeof body\.personaId === "string"/);
  assert.match(generator, /\.eq\("id", personaId\)\.eq\("owner", guard\.user\.id\)/);
  assert.match(generator, /ai_media_generation_events/);
  assert.match(generator, /provider: "google"/);
  assert.match(generator, /output_sha256: outputSha256/);
  assert.match(generator, /claim_ai_backend_budget/);
  assert.match(generator, /finalize_ai_backend_budget/);
  assert.ok(generator.indexOf('from("ai_media_generation_events").insert') < generator.indexOf("intakeForm.append"));
  assert.ok(generator.indexOf("intakeForm.append") < generator.indexOf("publicUrl: intake.publicUrl"));
  assert.match(generator, /watermarkState: intake\.watermarkState/);
  assert.doesNotMatch(generator, /image: `data:/);
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
  assert.match(html, /form\.append\("cropWidth"/);
  assert.doesNotMatch(html.match(/async function composerUploadSource\(\)[\s\S]*?\n\}/)?.[0] || "", /watermarkRaster/);
});

test("cover-cropped persona surfaces retain a separate accessible AI disclosure", () => {
  assert.match(html, /banner ai-asset-shell/);
  assert.match(html, /pp-av ai-asset-shell/);
  assert.match(html, /page-background-provenance/);
  assert.match(html, /personaRelationAvatarHtml/);
  assert.match(css, /\.media\.reel\.has-ai-provenance img\{object-fit:contain/);
  assert.match(css, /\.page-background-provenance/);
});

test("ledgered migration 059 is frozen and hardening ships only as forward migration 060", () => {
  const normalized = value => value.replaceAll("\r\n", "\n");
  assert.equal(normalized(frozenSql), normalized(frozenMirror));
  assert.equal(createHash("sha256").update(normalized(frozenSql)).digest("hex"), "208259258c163f44e17e76a1b82cc8ad38949fe6c01e976a3b30b0492f54b3a6");
  assert.match(sql, /Forward-only hardening for the immutable, already-ledgered migration 059/);
  assert.match(sql, /Never replace or re-run ledgered 059/);
});

test("migration 060 and its release mirror bind immutable provenance into every media consumer", () => {
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
  assert.match(sql, /persona_media_reference_grandfathers/);
  assert.match(sql, /blocked_external_assets/);
  assert.match(sql, /v_daily_count>=200/);
  assert.match(sql, /v_asset_count>=5000/);
  assert.match(sql, /v_persona_count>=1000/);
  assert.match(sql, /set derivative_count=event\.derivative_count\+1[\s\S]*event\.expires_at>now\(\)/);
  assert.match(sql, /asset\.status='active'/);
});

test("Pages deployment ships both provenance assets only after migration 060 release evidence", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8");
  const artifactStep = workflow.slice(
    workflow.indexOf("- name: Prepare public site artifact"),
    workflow.indexOf("- uses: actions/upload-pages-artifact@v3"),
  );
  assert.match(workflow, /release_confirmation:[\s\S]{0,240}migration 060/i);
  assert.match(workflow, /verify migration 060 in the linked ledger/i);
  assert.match(artifactStep, /--include '\/ai-content-provenance\.css'/);
  assert.match(artifactStep, /--include '\/ai-content-provenance\.js'/);
  assert.ok(artifactStep.indexOf("/ai-content-provenance.css") < artifactStep.indexOf("--exclude '*'"));
  assert.ok(artifactStep.indexOf("/ai-content-provenance.js") < artifactStep.indexOf("--exclude '*'"));
});

test("the provenance release deploys only its reviewed function set by default", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/supabase-deploy.yml"), "utf8");
  assert.match(workflow, /release_scope:[\s\S]*default: "ai-provenance"/);
  assert.match(workflow, /if: \$\{\{ inputs\.release_scope == 'ai-provenance' \}\}/);
  assert.match(workflow, /for function_name in media-ingest gemini-image compose-post ai-proxy/);
  assert.match(workflow, /inputs\.release_scope == 'all-reviewed'/);
});
