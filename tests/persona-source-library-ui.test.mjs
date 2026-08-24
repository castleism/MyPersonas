import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const [source, css, html, ownerApp, pages, staging, docs, privacy, deletionGuide] = await Promise.all([
  read("MyPersonas.Online_v0/persona-library.js"),
  read("MyPersonas.Online_v0/persona-library.css"),
  read("MyPersonas.Online_v0/index.html"),
  read("MyPersonas.Online_v0/owner-app.js"),
  read(".github/workflows/pages.yml"),
  read("scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1"),
  read("MyPersonas.Online_v0/PERSONA-SOURCE-LIBRARY.md"),
  read("MyPersonas.Online_v0/privacy.html"),
  read("MyPersonas.Online_v0/data-deletion.html"),
]);

test("source library module parses and its bounded normalizers fail closed", () => {
  new vm.Script(source, { filename: "persona-library.js" });
  const sandbox = {
    AbortController,
    Blob,
    DOMException,
    FormData,
    URL,
    crypto: webcrypto,
    document: { addEventListener() {} },
    window: { addEventListener() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "persona-library.js" });
  const api = sandbox.window.MyPersonasSourceLibrary;

  assert.equal(api.normalizeIntent("research"), "research");
  assert.equal(api.normalizeIntent("public"), "unsorted");
  assert.equal(api.normalizeAiUse(""), "unknown");
  assert.equal(api.normalizeRights(""), "unknown");
  assert.equal(api.normalizeReuse("publish_now"), "reference_only");
  assert.equal(api.normalizeSensitivity("private"), "standard");
  assert.deepEqual(
    [...api.parseTags(" Meal,meal, <script>, pasta  night,\u0000warning ")],
    ["Meal", "meal", "script", "pasta night", "warning"],
  );
  assert.equal(api.parseTags(Array.from({ length: 30 }, (_, index) => `tag${index}`).join(",")).length, 20);

  assert.equal(api.validateFile(new Blob(["png"], { type: "image/png" })).ok, true);
  assert.equal(api.validateFile(new Blob(["svg"], { type: "image/svg+xml" })).ok, false);
  assert.equal(api.validateFile(new Blob(["gif"], { type: "image/gif" })).ok, false);
  assert.equal(api.limits.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(api.limits.maxBlobUrls, 24);
  assert.equal(api.safeFilename({ original_filename: "../../meal<script>.png" }, "image/png"), ".._.._meal_script_.png");
});

test("bulk intake captures exact server fields without claiming provenance or publication", () => {
  assert.match(source, /type="file" accept="image\/png,image\/jpeg,image\/webp" multiple/);
  assert.match(source, /capture="environment"/);
  assert.match(source, /addEventListener\("drop"/);
  assert.match(source, /document\.addEventListener\("paste"/);
  assert.match(source, /SOURCE_LIBRARY_UPLOAD_CONCURRENCY = 2/);
  assert.match(source, /xhr\.upload\.onprogress/);
  assert.match(source, /sourceLibraryRetryUpload/);
  assert.match(source, /form\.append\("idempotencyKey", item\.id\)/);
  assert.match(source, /typeof crypto === "undefined" \|\| typeof crypto\.getRandomValues !== "function"/);
  assert.match(source, /form\.append\("rightsBasis", item\.options\.rights\)/);
  assert.match(source, /form\.append\("reusePolicy", item\.options\.reusePolicy\)/);
  assert.match(source, /form\.append\("analysisConsent", String\(item\.options\.analysisConsent\)\)/);
  assert.match(source, /form\.append\("tags", JSON\.stringify\(item\.options\.ownerTags\)\)/);
  assert.match(source, /research.+content_later.+unsorted.+archive/);
  assert.match(source, /Originals are owner-only and never become profile media, AI training data, or published posts/);
  assert.doesNotMatch(source, /function sourceLibraryPublish|sourceLibraryAutoPublish/);
});

test("private reads omit locators and hashes and all byte reads are authenticated no-store", () => {
  const assetSelect = source.match(/\.select\("id,owner,persona_id,intent,storage_mode[^"]+"\)/)?.[0] || "";
  assert.ok(assetSelect);
  assert.doesNotMatch(assetSelect, /source_sha256|storage_path|public_url|bucket/);
  assert.match(assetSelect, /rights_basis/);
  assert.match(assetSelect, /owner_tags/);
  assert.match(assetSelect, /hosted_analysis_consent/);
  assert.match(source, /SOURCE_LIBRARY_ENDPOINT = "\/functions\/v1\/persona-source-library"/);
  assert.ok((source.match(/credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store"/g) || []).length >= 2);
  assert.match(source, /Authorization: `Bearer \$\{token\}`/);
  assert.match(source, /sourceLibraryBoundedImageBlob/);
  assert.match(source, /sourceLibraryImageMagicMatches/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /SOURCE_LIBRARY_MAX_BLOB_BYTES/);
  assert.match(source, /SOURCE_LIBRARY_MAX_BLOB_URLS/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|caches\.|CacheStorage/);
});

test("account, persona, route, and generation guards abort stale private work", () => {
  assert.match(source, /snapshot\.authGeneration !== authLoadGeneration/);
  assert.match(source, /snapshot\.routeGeneration !== sourceLibraryState\.routeGeneration/);
  assert.match(source, /route\.view === "library" && route\.personaId === snapshot\.personaId/);
  assert.match(source, /sourceLibraryState\.controllers/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /xhr\.abort\(\)/);
  assert.match(source, /window\.addEventListener\("pagehide"/);

  const resetMine = html.slice(html.indexOf("function resetMineState()"), html.indexOf("function resetPrivateUiState()"));
  const resetPrivate = html.slice(html.indexOf("function resetPrivateUiState()"), html.indexOf("function mineLoadCurrent"));
  assert.match(resetMine, /sourceLibraryReset/);
  assert.match(resetPrivate, /sourceLibraryReset/);
});

test("study UI queues real work, keeps AI notes reviewable, and never simulates completion", () => {
  assert.match(source, /queue_persona_source_study", \{ p_asset_id: assetId, p_execution_mode: "hosted" \}/);
  assert.match(source, /cancel_persona_source_study", \{ p_asset_id: assetId \}/);
  assert.match(source, /review_persona_source_note", \{ p_note_id: noteId, p_review_state: decision \}/);
  assert.match(source, /author_kind,note_kind,body,review_state,provider_label,model_label/);
  assert.match(source, /AI notes remain suggestions until you accept them/);
  assert.match(source, /only shows analysis after a real worker writes a reviewable note/);
  assert.match(source, /No active study job/);
  assert.doesNotMatch(source, /setTimeout\([^)]*(?:completed|review_required)|fake|simulat(?:e|ed).*analysis/i);
  assert.match(source, /<option value="analysis_failed">Failed<\/option>/);
  assert.match(source, /<option value="cancellation_requested">Cancellation requested<\/option>/);
  assert.match(source, /job\?\.cancel_requested === true[\s\S]*return "cancellation_requested"/);
  assert.match(source, /job remains active until a real worker records it as cancelled/);
  assert.match(css, /\.psl-pill\.cancellation_requested/);
});

test("detail view is uncropped, owner-authenticated, downloadable, tag-editable, and destructive actions step up", () => {
  assert.match(css, /\.psl-thumb img\{[^}]*object-fit:contain/);
  assert.match(css, /\.psl-detail-stage img\{[^}]*object-fit:contain/);
  assert.match(source, /Save original/);
  assert.match(source, /sourceLibraryBlobRequest\("download"/);
  assert.match(source, /sourceLibraryEditTags/);
  assert.match(source, /owner_tags: sourceLibraryParseTags/);
  assert.match(source, /p_patch: sourceLibraryNormalizeIntent[\s\S]*archived: false[\s\S]*archived: true/);
  assert.match(source, /requireAal2ForSensitiveAction\("delete this private persona source"\)/);
  assert.match(source, /sourceLibraryJsonRequest\("delete", \{ assetId \}/);
  assert.match(source, /result\?\.error\?\.message \|\| result\?\.error/);
  assert.match(source, /await sourceLibraryJsonRequest\("delete", \{ assetId \}[\s\S]*Private source and its retained notes were deleted/);
  assert.match(source, /Promoting this source to public content is intentionally outside this private library/);
});

test("desktop, menu, mobile More, route, and Owner Home all reach a persona-scoped library", () => {
  assert.match(html, /persona-library\.css\?v=20260823-1/);
  assert.match(html, /persona-library\.js\?v=20260823-1/);
  assert.match(html, /openPersonaSourceLibrary\(\)">Persona source library/);
  assert.match(html, /<b>Source library<\/b><small>Offload private images for a persona<\/small>/);
  assert.match(html, /nav\(view==="library",`library\/\$\{governancePid\}`,"image","Source library"\)/);
  assert.match(html, /if\(view==="library"\)return renderPersonaSourceLibrary\(arg\)/);
  assert.match(html, /sourceLibraryRouteChanged\(view,arg\)/);
  assert.match(ownerApp, /\["review", "persona-settings", "library"\]/);
  assert.match(ownerApp, /go\('library\/\$\{persona\.id\}'\)">Offload source images/);
  assert.match(ownerApp, /\["activity", "notifications", "library"\]/);
});

test("owner export excludes raw source hashes and package builders ship matching assets", () => {
  const ownedSpecs = html.slice(html.indexOf("const ownedSpecs=["), html.indexOf("const names=ownedSpecs"));
  assert.match(ownedSpecs, /persona_source_assets/);
  assert.match(ownedSpecs, /persona_source_notes/);
  assert.match(ownedSpecs, /persona_source_analysis_jobs/);
  assert.doesNotMatch(ownedSpecs, /source_sha256|storage_path|lease_token/);
  assert.match(html, /add\("Private Source Assets",g\.persona_source_assets\)/);
  assert.match(html, /add\("Private Source Notes",g\.persona_source_notes\)/);
  assert.match(html, /add\("Private Source Study Jobs",g\.persona_source_analysis_jobs\)/);
  for (const file of ["persona-library.css", "persona-library.js"]) {
    assert.match(pages, new RegExp(`--include '/${file.replace(".", "\\.")}'`));
    assert.ok(staging.includes(`'${file}'`));
  }
});

test("responsive UI and architecture documentation stay honest about the release boundary", () => {
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /\.psl-lanes\{grid-template-columns:1fr\}/);
  assert.match(css, /min-height:100dvh/);
  assert.match(docs, /Managed private cloud is the default/);
  assert.match(docs, /local desktop companion is the high-volume option/);
  assert.match(docs, /Bring-your-own S3-compatible storage is an advanced adapter/);
  assert.match(docs, /does \*\*not\*\* claim[\s\S]{0,30}queued images have been[\s\S]{0,20}analyzed/);
  assert.match(docs, /Nothing in this document is evidence[\s\S]*deployed/);
  assert.match(docs, /A reservation does not authorize a Storage write/);
  assert.match(docs, /nonzero[\s\S]*without erasing bytes or[\s\S]{0,8}finalizing metadata/);
  assert.match(docs, /active_writes` or `active_studies`/);
  assert.match(docs, /Single-item deletion first enters a service-only asset deletion guard/);
  assert.match(docs, /before the service[\s\S]{0,40}resolves a private locator or touches Storage/);
  assert.match(docs, /successful[\s\S]{0,8}content-only erasure releases the exact guard token/);
  assert.match(privacy, /an owner deletion guard blocks new source writes and studies/);
  assert.match(privacy, /before resolving the private locator or touching Storage/);
  assert.match(deletionGuide, /either count remains nonzero[\s\S]*retryable conflict without erasing that private prefix or claiming completion/);
});
