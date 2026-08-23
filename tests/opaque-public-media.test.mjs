import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  MAX_PUBLIC_MEDIA_BYTES,
  PUBLIC_MEDIA_EDGE_ORIGIN,
  PUBLIC_MEDIA_EDGE_PATH_PREFIX,
  PUBLIC_MEDIA_GATEWAY_HEADER,
  PUBLIC_MEDIA_ORIGIN,
  PUBLIC_MEDIA_PATH_PREFIX,
  publicMediaDeliveryUrl,
  publicMediaIdFromOriginRequestUrl,
  publicMediaIdFromRequestUrl,
  publicMediaResponseHeaders,
  readExactPublicMediaResponse,
  sha256Hex,
  validatePublicMediaResolution,
  verifyResolvedPublicMedia,
} from "../supabase/functions/_shared/public-media.ts";

const root = path.resolve(import.meta.dirname, "..");
const PUBLIC_ID = "a1111111-b111-4c11-8111-d11111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const PERSONA = "33333333-3333-4333-8333-333333333333";

async function fixture(bytes = new TextEncoder().encode("reviewed opaque media")) {
  const digest = await sha256Hex(bytes);
  return {
    bytes,
    resolution: {
      bucket: "persona-media",
      storage_path: `${OWNER}/published/provenance/none/uploaded/${PERSONA}/profile/avatar/${digest}.png`,
      mime_type: "image/png",
      byte_size: bytes.byteLength,
      content_sha256: digest,
    },
  };
}

test("public media parsers separate the one canonical URL from the private Edge origin", () => {
  const valid = `${PUBLIC_MEDIA_ORIGIN}${PUBLIC_MEDIA_PATH_PREFIX}${PUBLIC_ID}`;
  const origin = `${PUBLIC_MEDIA_EDGE_ORIGIN}${PUBLIC_MEDIA_EDGE_PATH_PREFIX}${PUBLIC_ID}`;
  assert.equal(publicMediaIdFromRequestUrl(valid), PUBLIC_ID);
  assert.equal(publicMediaDeliveryUrl(PUBLIC_ID), valid);
  assert.equal(publicMediaIdFromOriginRequestUrl(origin), PUBLIC_ID);
  assert.equal(publicMediaIdFromRequestUrl(origin), null);
  assert.equal(publicMediaIdFromOriginRequestUrl(valid), null);
  for (const value of [
    valid + "?download=1",
    valid + "#fragment",
    valid + "/extra",
    valid.replace("/persona/v1/", "/persona/v1//"),
    valid.replace(PUBLIC_ID, "11111111-1111-1111-8111-111111111111"),
    valid.replace(PUBLIC_ID, "%31" + PUBLIC_ID.slice(1)),
    valid.replace(PUBLIC_MEDIA_ORIGIN, "https://evil.example"),
    valid.replace("https://", "http://"),
    valid.replace("/persona/v1/", "/"),
    valid.replace("/persona/v1/", "/junk/../persona/v1/"),
    valid.replace("/persona/v1/", "/junk/%2e%2e/persona/v1/"),
    valid.replace("/persona/v1/", "/persona/./v1/"),
    valid.replace("/persona/v1/", "/persona/%2e/v1/"),
    valid.replace("media.mypersonas.online", "MEDIA.MYPERSONAS.ONLINE"),
    valid.replace("mypersonas.online/", "mypersonas.online:443/"),
    valid.replace(PUBLIC_ID, PUBLIC_ID.toUpperCase()),
    "not a url",
    "https://user:pass@media.mypersonas.online/persona/v1/" + PUBLIC_ID,
  ]) assert.equal(publicMediaIdFromRequestUrl(value), null, value);
  for (const value of [origin + "?download=1", origin + "/extra", origin.replace("/public-media/", "/public-media//")]) {
    assert.equal(publicMediaIdFromOriginRequestUrl(value), null, value);
  }
  assert.throws(() => publicMediaDeliveryUrl(PUBLIC_ID.toUpperCase()), /Invalid public media id/);
});

test("Storage response reader enforces the reviewed byte bound while streaming", async () => {
  const bytes = new TextEncoder().encode("bounded public media");
  const response = new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength) } });
  assert.deepEqual(await readExactPublicMediaResponse(response, bytes.byteLength), bytes);
  await assert.rejects(
    readExactPublicMediaResponse(
      new Response(bytes, { headers: { "Content-Length": String(bytes.byteLength + 1) } }),
      bytes.byteLength,
    ),
    /length changed/,
  );
  await assert.rejects(
    readExactPublicMediaResponse(new Response(bytes), bytes.byteLength - 1),
    /exceeded its bound/,
  );
});

test("resolution validation is bounded and rejects correlation or path smuggling", async () => {
  const { resolution } = await fixture();
  assert.deepEqual(validatePublicMediaResolution(resolution), resolution);
  for (const value of [
    { ...resolution, owner: OWNER },
    { ...resolution, persona_id: PERSONA },
    { ...resolution, bucket: "other" },
    { ...resolution, storage_path: `../${resolution.storage_path}` },
    { ...resolution, storage_path: resolution.storage_path.replace("/published/", "/private/") },
    { ...resolution, mime_type: "image/svg+xml" },
    { ...resolution, byte_size: MAX_PUBLIC_MEDIA_BYTES + 1 },
    { ...resolution, content_sha256: "0".repeat(63) },
  ]) assert.throws(() => validatePublicMediaResolution(value));
});

test("delivery verifies the exact reviewed bytes and emits no-store metadata only", async () => {
  const { bytes, resolution } = await fixture();
  await assert.doesNotReject(verifyResolvedPublicMedia(bytes, resolution));
  await assert.rejects(
    verifyResolvedPublicMedia(new Uint8Array([...bytes, 0]), resolution),
    /size changed/,
  );
  const changed = new Uint8Array(bytes);changed[0] ^= 1;
  await assert.rejects(verifyResolvedPublicMedia(changed, resolution), /hash changed/);
  const headers = publicMediaResponseHeaders(resolution);
  assert.equal(headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(headers.get("Content-Type"), resolution.mime_type);
  assert.equal(headers.get("Content-Length"), String(resolution.byte_size));
  assert.equal(headers.has("Location"), false);
  assert.equal(headers.has("ETag"), false);
  assert.equal(headers.get("Content-Disposition"), "inline");
});

test("migration 062 hides correlation and resolves only an exact current review", async () => {
  const sql = await readFile(path.join(root, "MyPersonas.Online_v0/sql-updates/062-opaque-public-media-delivery.sql"), "utf8");
  assert.match(sql, /create table if not exists public\.persona_public_media_handles/);
  assert.match(sql, /public_id\s+uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /revoke all on public\.persona_public_media_handles[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(sql, /public\.persona_publication_is_current\(persona\.id\)/);
  assert.match(sql, /review\.review_state='published'/);
  assert.match(sql, /reviewed\.item->>'consumer'=reference\.consumer/);
  assert.match(sql, /reviewed\.item->>'slot'=reference\.slot/);
  assert.match(sql, /reviewed\.item->>'provenance_sha256'=candidate\.provenance_sha256/);
  assert.match(sql, /asset\.status='active'/);
  assert.match(sql, /handle\.state='active'/);
  assert.match(sql, /revoke_public_media_handle_after_asset_status/);
  assert.match(sql, /cutover_persona_public_media_batch_service/);
  assert.match(sql, /consume_public_media_rate_limit_service/);
  assert.match(sql, /handle\.public_id=p_public_id and handle\.state='active'/);
  assert.match(sql, /v_global<=?6000|v_global>6000/);
  assert.match(sql, /stale\.window_started<v_now-interval '10 minutes'/);
  assert.match(sql, /tg_op='INSERT' or \(v_row->>v_key\) is distinct from \(v_old->>v_key\)/);
  assert.match(sql, /lock table public\.post_drafts in share row exclusive mode/);
  assert.match(sql, /from public\.affiliate_products product\s+where public\.is_persona_media_storage_reference_062\(product\.image_url\)/);
  assert.match(sql, /array\['music_url','live_url'\]/);
  assert.match(sql, /Music and live URLs must use an external HTTPS provider/);
  assert.match(sql, /music_external/);
  assert.match(sql, /live_external/);
  assert.match(sql, /create or replace function public\.is_external_reference_url_062/);
  assert.match(sql, /create or replace function public\.is_public_media_reference_url_062/);
  assert.match(sql, /create or replace function public\.persona_public_urls_safe/);
  for (const surface of ["persona_links", "album_items", "persona_page_layouts", "affiliate_products"]) {
    assert.match(sql, new RegExp(`create trigger guard_[\\s\\S]{0,180}on public\\.${surface}`), `missing forward guard for ${surface}`);
  }
  assert.match(sql, /blocked_external_reference_violations/);
  assert.match(sql, /legacy_media_bucket_references/);
  assert.match(sql, /lock table public\.persona_links in share row exclusive mode/);
  assert.match(sql, /lock table public\.persona_page_layouts in share row exclusive mode/);
  assert.match(sql, /resolve_affiliate_redirect_service_legacy_062/);
  assert.match(sql, /jsonb_build_object\('destination_safe',true\)/);
  assert.match(sql, /public\.is_public_media_delivery_reference_062\(reference\.url\)/);
  assert.match(sql, /rich_media_widgets_enabled',false/);
});

test("proxy never redirects and media intake returns opaque public URL", async () => {
  const [proxy, ownerPreview, ingest, gemini, config, html, workflow] = await Promise.all([
    readFile(path.join(root, "supabase/functions/public-media/index.ts"), "utf8"),
    readFile(path.join(root, "supabase/functions/owner-media-preview/index.ts"), "utf8"),
    readFile(path.join(root, "supabase/functions/media-ingest/index.ts"), "utf8"),
    readFile(path.join(root, "supabase/functions/gemini-image/index.ts"), "utf8"),
    readFile(path.join(root, "supabase/config.toml"), "utf8"),
    readFile(path.join(root, "MyPersonas.Online_v0/index.html"), "utf8"),
    readFile(path.join(root, ".github/workflows/supabase-deploy.yml"), "utf8"),
  ]);
  assert.match(proxy, /resolve_public_media_service/);
  assert.match(proxy, /verifyResolvedPublicMedia/);
  assert.match(proxy, /readExactPublicMediaResponse/);
  assert.match(proxy, /redirect: "error"/);
  assert.match(proxy, /Accept-Encoding/);
  assert.match(proxy, /req\.headers\.has\("range"\)/);
  assert.match(proxy, /req\.method !== "GET"/);
  assert.match(proxy, /consume_public_media_rate_limit_service/);
  assert.match(proxy, /PUBLIC_MEDIA_GATEWAY_SECRET/);
  assert.match(proxy, /PUBLIC_MEDIA_GATEWAY_PREVIOUS_SECRET/);
  assert.match(proxy, /PUBLIC_MEDIA_GATEWAY_HEADER/);
  assert.match(proxy, /publicMediaIdFromOriginRequestUrl/);
  assert.match(proxy, /return errorResponse\(503, "Media unavailable"\)/);
  assert.match(proxy, /return errorResponse\(404, "Media not found"\)/);
  assert.doesNotMatch(proxy, /status:\s*30[1278]|Location:/);
  assert.match(config, /\[functions\.public-media\]\s*\r?\nverify_jwt = false/);
  assert.match(ingest, /issue_persona_public_media_handle_service/);
  assert.match(ingest, /publicMediaDeliveryUrl\(String\(issued\.data\)\.toLowerCase\(\)\)/);
  const responseShape = ingest.slice(ingest.lastIndexOf("return json({"));
  assert.match(responseShape, /publicUrl/);
  assert.match(responseShape, /assetId/);
  assert.doesNotMatch(responseShape, /ownerPreviewUrl|createSignedUrl/);
  assert.doesNotMatch(responseShape, /\n\s*path,/);
  assert.doesNotMatch(gemini, /ownerPreviewUrl|createSignedUrl/);
  assert.match(ownerPreview, /resolve_authenticated_media_preview_service/);
  assert.match(ownerPreview, /verifyResolvedPublicMedia/);
  assert.match(html, /renewOwnerMediaPreview\(publicUrl,String\(j\.assetId\)\)/);
  assert.match(html, /ownerMediaAuthGeneration/);
  assert.match(html, /ownerMediaPreviewRequests/);
  assert.match(html, /ownerMediaAuthStillCurrent/);
  assert.match(html, /element\.isConnected/);
  assert.match(html, /data-persona-viewer-media/);
  for (const functionName of ["public-media", "owner-media-preview", "compose-post", "approve-post-draft", "meta-post", "run-post-queue", "gemini-image", "media-ingest"]) {
    assert.match(workflow, new RegExp(`\\b${functionName}\\b`), `opaque deployment stages must include ${functionName}`);
  }
  assert.match(html, /function safePublicMediaUrl/);
  assert.match(html, /media\[\.\]mypersonas\[\.\]online/);
  assert.match(html, /function safeExternalMediaEmbedUrl/);
  assert.match(html, /function safeExternalNavigationUrl/);
  assert.match(html, /offer\?\.destination_safe===true/);
  assert.match(html, /link=safeExternalNavigationUrl\(it\.link_url\)/);
  assert.match(html, /url=safeExternalNavigationUrl\(l\.url\)/);
  assert.match(html, /music_url:safeExternalMediaEmbedUrl\(persona\.music_url\)/);
  assert.match(html, /live_url:safeExternalMediaEmbedUrl\(persona\.live_url\)/);
  assert.match(html, /nwsqyuucwzihruszocge\.supabase\.co/);
  assert.match(html, /\/storage\/v1\//);
  assert.match(html, /New image\/video widgets and video backgrounds remain disabled/);
  const layoutNormalizer = html.slice(html.indexOf("function normalizePersonaPageLayout"), html.indexOf("function personaAssetType"));
  assert.doesNotMatch(layoutNormalizer, /\["text","link","image"\]|\["text","link","video"\]/);
});
