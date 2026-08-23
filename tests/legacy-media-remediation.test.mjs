import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  detectLegacyMedia,
  legacyMediaPreviewHeaders,
  legacyMediaSha256,
  MAX_LEGACY_MEDIA_BYTES,
  readBoundedLegacyMediaResponse,
  safeLegacyStoragePath,
  validateLegacyMediaResolution,
} from "../supabase/functions/_shared/legacy-media-remediation.ts";

const root = path.resolve(import.meta.dirname, "..");
const OWNER = "a1111111-a111-4111-8111-a11111111111";
const OTHER_OWNER = "b2222222-b222-4222-8222-b22222222222";
const OBJECT_ID = "c3333333-c333-4333-8333-c33333333333";
const PATH = `${OWNER}/1720000000000-avatar.png`;

function mediaFixtures() {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0xff, 0xd9]);
  const webp = new Uint8Array(16);
  webp.set(new TextEncoder().encode("RIFF"), 0);
  webp.set(new TextEncoder().encode("WEBP"), 8);
  const gif = new Uint8Array(13);
  gif.set(new TextEncoder().encode("GIF89a"), 0);
  const mp4 = new Uint8Array(16);
  mp4.set(new TextEncoder().encode("ftyp"), 4);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
  return { png, jpeg, webp, gif, mp4, webm };
}

test("legacy path validation accepts only the exact lowercase owner prefix and safe segments", () => {
  assert.equal(safeLegacyStoragePath(PATH, OWNER), true);
  assert.equal(safeLegacyStoragePath(`${OWNER}/generated/1720000000000-file_name-1.webp`, OWNER), true);
  for (const value of [
    `${OTHER_OWNER}/1720000000000-avatar.png`,
    `${OWNER}/../avatar.png`,
    `${OWNER}/./avatar.png`,
    `${OWNER}/avatar%2epng`,
    `${OWNER}/avatar name.png`,
    `${OWNER}/avatar.png?download=1`,
    `${OWNER}/avatar.png\n`,
    `${OWNER}\\avatar.png`,
    `${OWNER.toUpperCase()}/avatar.png`,
    `${OWNER}/-avatar.png`,
  ]) assert.equal(safeLegacyStoragePath(value, OWNER), false, value);
});

test("preview resolution rejects extra correlation fields and path smuggling", () => {
  const resolution = {
    bucket: "media",
    storage_path: PATH,
    object_id: OBJECT_ID,
    object_updated_at: "2026-08-23T12:00:00.000Z",
    expected_byte_size: 24,
  };
  assert.deepEqual(validateLegacyMediaResolution(resolution, OWNER), resolution);
  for (const value of [
    { ...resolution, owner: OWNER },
    { ...resolution, legacy_url: "https://example.test/private" },
    { ...resolution, bucket: "persona-media" },
    { ...resolution, storage_path: `${OTHER_OWNER}/1720000000000-avatar.png` },
    { ...resolution, storage_path: `${OWNER}/../avatar.png` },
    { ...resolution, object_id: OBJECT_ID.toUpperCase() },
    { ...resolution, object_updated_at: "not-a-time" },
    { ...resolution, expected_byte_size: -1 },
  ]) assert.throws(() => validateLegacyMediaResolution(value, OWNER));
});

test("magic detection accepts only canonical intake media signatures", () => {
  const fixtures = mediaFixtures();
  assert.equal(detectLegacyMedia(fixtures.png).mime, "image/png");
  assert.equal(detectLegacyMedia(fixtures.jpeg).mime, "image/jpeg");
  assert.equal(detectLegacyMedia(fixtures.webp).mime, "image/webp");
  assert.equal(detectLegacyMedia(fixtures.gif).mime, "image/gif");
  assert.equal(detectLegacyMedia(fixtures.mp4).mime, "video/mp4");
  assert.equal(detectLegacyMedia(fixtures.webm).mime, "video/webm");
  assert.throws(() => detectLegacyMedia(new TextEncoder().encode("<svg><script/></svg>")), /Unsupported/);
  assert.throws(() => detectLegacyMedia(new TextEncoder().encode("GIF89a")), /Unsupported/);
});

test("exact-byte reader enforces metadata, streaming, and content-encoding bounds", async () => {
  const bytes = mediaFixtures().png;
  const response = new Response(bytes, {
    headers: { "Content-Length": String(bytes.byteLength) },
  });
  assert.deepEqual(await readBoundedLegacyMediaResponse(response, bytes.byteLength), bytes);
  await assert.rejects(
    readBoundedLegacyMediaResponse(new Response(bytes, {
      headers: { "Content-Length": String(bytes.byteLength + 1) },
    }), bytes.byteLength),
    /length changed/,
  );
  await assert.rejects(
    readBoundedLegacyMediaResponse(new Response(bytes, {
      headers: { "Content-Encoding": "gzip" },
    }), 0),
    /encoding changed/,
  );
  await assert.rejects(
    readBoundedLegacyMediaResponse(new Response(new Uint8Array(), {
      headers: { "Content-Length": String(MAX_LEGACY_MEDIA_BYTES + 1) },
    }), 0),
    /byte limit/,
  );
});

test("preview response is no-store, nosniff, inline, and exposes no integrity identifier", async () => {
  const bytes = mediaFixtures().png;
  const digest = await legacyMediaSha256(bytes);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const headers = legacyMediaPreviewHeaders("image/png", bytes.byteLength);
  assert.equal(headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(headers.get("Content-Security-Policy"), "default-src 'none'");
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("Content-Disposition"), "inline");
  assert.equal(headers.get("Content-Length"), String(bytes.byteLength));
  assert.equal(headers.has("ETag"), false);
  assert.equal(headers.has("Location"), false);
  assert.equal(headers.has("Digest"), false);
});

test("migration 064 is service-only, idempotent, owner-scoped, and exact-host only", async () => {
  const canonicalPath = path.join(root, "MyPersonas.Online_v0/sql-updates/064-legacy-media-remediation.sql");
  const mirrorPath = path.join(root, "supabase/migrations/20260823060000_legacy_media_remediation.sql");
  const [sql, mirror] = await Promise.all([
    readFile(canonicalPath, "utf8"),
    readFile(mirrorPath, "utf8"),
  ]);
  assert.equal(mirror, sql);
  assert.match(sql, /create table if not exists public\.legacy_media_sources/);
  assert.match(sql, /create table if not exists public\.legacy_media_references/);
  assert.match(sql, /alter table public\.legacy_media_sources enable row level security/);
  assert.match(sql, /alter table public\.legacy_media_references enable row level security/);
  assert.match(sql, /revoke all on public\.legacy_media_sources,[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql, /grant select,insert,update,delete on public\.legacy_media_sources,[\s\S]*to service_role/);
  assert.match(sql, /https:\/\/nwsqyuucwzihruszocge\.supabase\.co\/storage\/v1\/object\/public\/media\//);
  assert.doesNotMatch(sql, /render\/image\/public\/media|object\/sign\/media|object\/authenticated\/media/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /on conflict\(owner,storage_path_sha256\) do update/);
  assert.match(sql, /on conflict\(owner,consumer,row_id,slot\) do update/);
  assert.match(sql, /when v_path_owner<>p_owner then 'blocked_cross_owner'/);
  assert.match(sql, /v_path_owner=p_owner/);
  assert.match(sql, /reference\.owner=p_owner/);
  assert.match(sql, /source\.owner=p_owner/);
  for (const slot of ["avatar", "banner", "background", "feed_header", "thumbnail"]) {
    assert.match(sql, new RegExp(`'${slot}'`));
  }
  for (const operation of [
    "inventory_legacy_media_references_service",
    "list_legacy_media_references_service",
    "resolve_legacy_media_preview_service",
    "record_legacy_media_preview_service",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${operation}`));
  }
  assert.match(sql, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(sql, /returns table\(\s*item_id uuid,source_item_id uuid,persona_id uuid,persona_label text/);
  const safeList = sql.slice(sql.indexOf("create or replace function public.list_legacy_media_references_service"), sql.indexOf("-- Internal resolution"));
  assert.doesNotMatch(safeList, /storage_path|legacy_url|sha256|object_id/);
});

test("Edge endpoint is exact-origin AAL2 POST-only and never projects a raw record", async () => {
  const edge = await readFile(path.join(root, "supabase/functions/legacy-media-remediation/index.ts"), "utf8");
  assert.match(edge, /requireAal2\(req, admin\)/);
  assert.match(edge, /ALLOWED_ORIGINS\.has\(origin\)/);
  assert.match(edge, /req\.method !== "POST"/);
  assert.match(edge, /total > 4096/);
  assert.match(edge, /consume_legacy_media_remediation_rate_service/);
  assert.match(edge, /inventory_legacy_media_references_service/);
  assert.match(edge, /list_legacy_media_references_service/);
  assert.match(edge, /resolve_legacy_media_preview_service/);
  assert.match(edge, /record_legacy_media_preview_service/);
  assert.match(edge, /readBoundedLegacyMediaResponse/);
  assert.match(edge, /detectLegacyMedia/);
  assert.match(edge, /legacyMediaSha256/);
  assert.doesNotMatch(edge, /console\.(?:log|error|warn)/);
  assert.doesNotMatch(edge, /\.from\("media"\)\.getPublicUrl|createSignedUrl/);
  assert.doesNotMatch(edge, /\.\.\.row|\.\.\.raw|JSON\.stringify\(listed\.data\)/);
  const listResponse = edge.slice(edge.indexOf("const items ="), edge.indexOf("if (!exactKeys(body, [\"action\", \"itemId\"])"));
  assert.doesNotMatch(listResponse, /storage_path|legacy_url|sha256|object_id/);
});

test("content-only erasure removes every retained legacy-remediation owner row", async () => {
  const erasure = await readFile(path.join(root, "supabase/functions/delete-account/index.ts"), "utf8");
  for (const table of [
    "legacy_media_references",
    "legacy_media_sources",
    "legacy_media_remediation_rate_limits_064",
  ]) {
    assert.match(
      erasure,
      new RegExp(`admin\\.from\\(\"${table}\"\\)\\.delete\\(\\)\\.eq\\([\\s\\S]{0,80}\"owner\",[\\s\\n ]*uid`),
      `${table} must be erased even when the profile is retained`,
    );
  }
});
