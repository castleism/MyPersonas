import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("private source endpoint authenticates, origin-binds, and never issues public media", async () => {
  const [edge, config] = await Promise.all([
    read("supabase/functions/persona-source-library/index.ts"),
    read("supabase/config.toml"),
  ]);
  assert.match(config, /\[functions\.persona-source-library\]\s*\nverify_jwt = true/);
  assert.match(edge, /admin\.auth\.getUser\(bearer\)/);
  assert.match(edge, /origin && !ALLOWED_ORIGINS\.has\(origin\)/);
  assert.match(edge, /const BUCKET = "persona-source-library"/);
  assert.doesNotMatch(edge, /issue_persona_public_media_handle_service|publicMediaDeliveryUrl|getPublicUrl|createSignedUrl/);
  assert.doesNotMatch(edge, /return json\(\{[^}]*storage_path|return json\(\{[^}]*source_sha256/s);
});

test("upload validates exact image bytes, reserves quota, and registers only after storage", async () => {
  const edge = await read("supabase/functions/persona-source-library/index.ts");
  for (const signature of [
    "0x89, 0x50, 0x4e, 0x47",
    "0xff, 0xd8, 0xff",
    'ascii(bytes, 8, 4) === "WEBP"',
  ]) assert.ok(edge.includes(signature), `missing byte signature ${signature}`);
  assert.match(edge, /MAX_IMAGE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(edge, /MAX_SOURCE_PIXELS = 40_000_000/);
  assert.match(edge, /declared !== detected\.mime/);
  assert.match(edge, /await sha256Hex\(bytes\)/);
  assert.match(edge, /`\$\{owner\.toLowerCase\(\)\}\/personas\/\$\{personaId\}\/source\/\$\{idempotencyKey\}-\$\{digest\}\.\$\{detected\.extension\}`/);
  const reserve = edge.indexOf('admin.rpc("reserve_persona_source_upload_service"');
  const beginWrite = edge.indexOf('admin.rpc("begin_persona_source_storage_write_service"');
  const upload = edge.indexOf("admin.storage.from(BUCKET).upload(path, bytes");
  const register = edge.indexOf('admin.rpc("register_persona_source_asset_service"');
  assert.ok(reserve > 0 && beginWrite > reserve && upload > beginWrite && register > upload);
  assert.match(edge, /writeReceipt\.persona_id !== personaId/);
  assert.match(edge, /PERSONA_SOURCE_\(\?:PERSONA\|ACCOUNT\)_DELETING/);
  assert.match(edge, /writeStatus !== "writing"[\s\S]*releaseReservation\(\)[\s\S]*409/);
  assert.match(edge, /release_persona_source_upload_service/);
  assert.match(edge, /if \(createdObject\) \{[\s\S]*?admin\.storage\.from\(BUCKET\)\.remove\(\[path\]\)/);
  assert.match(edge, /if \(reservation\.duplicate === true && !await removeUnregisteredDuplicate\(\)\)/);
  assert.match(edge, /if \(duplicate && !await removeUnregisteredDuplicate\(\)\)/);
  assert.match(edge, /upsert: false/);
});

test("persona deletion is MFA-bound, guarded, prefix-first, and precedes persona metadata deletion", async () => {
  const [edge, index] = await Promise.all([
    read("supabase/functions/persona-source-library/index.ts"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  const handler = edge.slice(edge.indexOf("async function handlePersonaLibraryDelete"));
  const begin = handler.indexOf('admin.rpc("begin_persona_source_deletion_service"');
  const activeWriteGate = handler.indexOf("if (activeWrites > 0 || activeStudies > 0)");
  const bytes = handler.indexOf("erasePrivatePrefix(expectedPrefix)");
  const metadata = handler.indexOf('admin.rpc("delete_persona_source_library_for_persona_service"');
  assert.ok(begin > 0 && activeWriteGate > begin && bytes > activeWriteGate && metadata > bytes);
  assert.match(handler, /expectedPrefix = `\$\{owner\.toLowerCase\(\)\}\/personas\/\$\{personaId\}\//);
  assert.match(handler, /\["active", "metadata_deleted"\]/);
  assert.match(handler, /typeof receipt\?\.active_studies === "number"/);
  assert.match(handler, /activeWrites,[\s\S]*activeStudies,[\s\S]*retryable: true,[\s\S]*\}, 409, origin\)/);
  assert.match(handler, /action === "delete" \|\| action === "deletePersonaLibrary"[\s\S]*requireAal2\(req, admin\)/);
  const personaDelete = index.slice(index.indexOf("async function deletePersona()"), index.indexOf("// ---------- AI:"));
  const sourceDelete = personaDelete.indexOf("sourceLibraryDeleteForPersona(targetId)");
  const personaMetadataDelete = personaDelete.indexOf('sb.rpc("delete_owned_persona"');
  assert.ok(sourceDelete > 0 && personaMetadataDelete > sourceDelete);
  assert.match(personaDelete, /requireAal2ForSensitiveAction\("delete this persona and its private source library"\)/);
});

test("private preview and download are hash verified and explicitly non-cacheable", async () => {
  const edge = await read("supabase/functions/persona-source-library/index.ts");
  assert.match(edge, /resolve_persona_source_asset_service/);
  assert.match(edge, /bytes\.byteLength !== source\.byte_size \|\| await sha256Hex\(bytes\) !== source\.source_sha256/);
  assert.match(edge, /detectPersonaSourceImage\(bytes\)/);
  assert.match(edge, /"Cache-Control": "no-store, max-age=0"/);
  assert.match(edge, /"Cross-Origin-Resource-Policy": "same-origin"/);
  assert.match(edge, /"Content-Disposition": `\$\{download \? "attachment" : "inline"\}/);
});

test("single-item and account erasure remove private bytes before metadata", async () => {
  const [edge, deletion] = await Promise.all([
    read("supabase/functions/persona-source-library/index.ts"),
    read("supabase/functions/delete-account/index.ts"),
  ]);
  const single = edge.slice(edge.indexOf("async function handleDelete"));
  const beginAssetDelete = single.indexOf('admin.rpc("begin_persona_source_asset_deletion_service"');
  const resolveAsset = single.indexOf("resolveSource(owner, assetId)");
  const removeAsset = single.indexOf("admin.storage.from(BUCKET).remove");
  const finalizeAsset = single.indexOf('admin.rpc("delete_persona_source_asset_metadata_service"');
  assert.ok(beginAssetDelete > 0 && resolveAsset > beginAssetDelete && removeAsset > resolveAsset && finalizeAsset > removeAsset);
  assert.match(single, /receipt\.status !== "deleting" \|\| receipt\.asset_id !== assetId/);
  assert.match(single, /typeof receipt\?\.active_studies === "number"/);
  assert.match(single, /if \(activeStudies > 0\)[\s\S]*activeStudies,[\s\S]*retryable: true,[\s\S]*409/);
  assert.match(single, /PERSONA_SOURCE_\(\?:PERSONA\|ACCOUNT\)_DELETING[\s\S]*bulkGuardConflict[\s\S]*409/);
  assert.match(single, /requireAal2\(req, admin\)/);
  assert.match(single, /deletion\?\.deleted !== true \|\| deletion\.status !== "deleted"/);
  assert.match(deletion, /bucket: "persona-source-library", prefix: normalizedOwner/);
  const full = deletion.slice(deletion.indexOf("const eraseClaimedOwner"));
  const accountGuard = full.indexOf("beginPersonaSourceAccountDeletion(");
  const storageErase = full.indexOf("eraseOwnedStorage(admin, uid)");
  const metadataErase = full.indexOf("eraseOwnedRows(admin, uid, personaIds)");
  assert.ok(accountGuard > 0 && storageErase > accountGuard && metadataErase > storageErase);
  assert.match(deletion, /begin_persona_source_account_deletion_service/);
  assert.match(deletion, /PERSONA_SOURCE_ACTIVE_WORK:[\s\S]*sourceUploadsInProgress:[\s\S]*sourceStudiesInProgress:[\s\S]*409/);
  assert.match(deletion, /typeof receipt\?\.active_studies === "number"/);
  assert.match(deletion, /release_persona_source_account_deletion_guard_service[\s\S]*p_guard_token: guardToken/);
  assert.ok(full.indexOf("releasePersonaSourceAccountDeletionGuard(") > metadataErase);
  assert.match(full, /sourceDeletionTombstoneRetained: true/);
  assert.match(deletion, /delete_persona_source_library_for_account_service/);
});

test("deployment is an explicit protected scope and the frontend package includes matching modules", async () => {
  const [deploy, workflow, pages, staging, maintenance] = await Promise.all([
    read("scripts/deploy-supabase-functions.sh"),
    read(".github/workflows/supabase-deploy.yml"),
    read(".github/workflows/pages.yml"),
    read("scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1"),
    read("supabase/functions/run-operations-maintenance/index.ts"),
  ]);
  assert.match(deploy, /staging:persona-source-library/);
  assert.match(deploy, /production:persona-source-library/);
  assert.match(deploy, /functions=\(persona-source-library delete-account erase-content run-operations-maintenance\)/);
  assert.match(workflow, /- persona-source-library/);
  assert.match(pages, /persona-library\.css/);
  assert.match(pages, /persona-library\.js/);
  assert.match(pages, /SOURCE-LIBRARY-070-VERIFIED/);
  assert.match(staging, /'persona-library\.css','persona-library\.js'/);
  assert.match(maintenance, /name: "persona_source_library_retention"/);
  assert.match(maintenance, /rpc: "purge_persona_source_library_retention_batch_service"/);
});
