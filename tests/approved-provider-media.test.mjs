import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  approvedMediaDeliveryIdFromUrl,
  approvedMediaDeliveryUrl,
  approvedMediaProviderUrl,
} from "../supabase/functions/_shared/approved-media.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const ID = "06300000-0000-4000-8000-000000000001";
const OWNER = "1e8b9288-a938-4c98-8988-8e0cc9835123";

test("approved provider URLs are exact opaque v4 URLs with legacy expansion fallback", () => {
  const canonical = approvedMediaDeliveryUrl(ID);
  assert.equal(canonical, `https://media.mypersonas.online/approved/v1/${ID}`);
  assert.equal(approvedMediaDeliveryIdFromUrl(canonical), ID);
  assert.equal(approvedMediaDeliveryIdFromUrl(`${canonical}?download=1`), null);
  assert.equal(approvedMediaDeliveryIdFromUrl(`${canonical}/`), null);
  assert.equal(approvedMediaDeliveryIdFromUrl(canonical.toUpperCase()), null);
  assert.doesNotMatch(canonical, new RegExp(OWNER, "i"));
  assert.equal(approvedMediaProviderUrl({ deliveryUrl: canonical, url: "legacy" }), canonical);
  assert.equal(approvedMediaProviderUrl({ deliveryUrl: "", url: "legacy" }), "legacy");
});

test("migration 063 is expansion-only and preserves the ledgered approval hash", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/063-opaque-approved-media-delivery.sql");
  assert.match(sql, /create table if not exists public\.post_approved_media_handles/);
  assert.match(sql, /public_id uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /approved_fb_delivery_id uuid/);
  assert.match(sql, /approved_ig_delivery_id uuid/);
  assert.match(sql, /create or replace function public\.issue_post_approved_media_handle_service/);
  assert.match(sql, /create or replace function public\.resolve_post_approved_media_service/);
  assert.match(sql, /create or replace function public\.resolve_post_approved_media_delivery_service/);
  assert.match(sql, /create or replace function public\.revoke_post_approved_media_owner_service/);
  assert.match(sql, /create or replace function public\.approve_and_schedule_post_draft_opaque/);
  assert.match(sql, /v_draft:=public\.approve_and_schedule_post_draft\(/);
  assert.doesNotMatch(sql, /create or replace function public\.post_draft_hash/);

  const beforeFinalizer = sql.slice(0, sql.indexOf(
    "create or replace function public.finalize_post_approved_media_bucket_service",
  ));
  assert.doesNotMatch(beforeFinalizer, /update storage\.buckets set public=false/);
  assert.match(sql, /post_approved_media_release_readiness_service/);
  assert.match(sql, /update storage\.buckets set public=false where id='post-approved-media'/);
  assert.match(sql, /lock table public\.post_drafts in share row exclusive mode/);
  assert.match(sql, /draft\.fb_post_id is null[\s\S]*draft\.approved_fb_delivery_id is null/);
});

test("provider consumers verify immutable bytes and pass only opaque delivery URLs", async () => {
  const [shared, approval, meta, queue] = await Promise.all([
    read("supabase/functions/_shared/approved-media.ts"),
    read("supabase/functions/approve-post-draft/index.ts"),
    read("supabase/functions/meta-post/index.ts"),
    read("supabase/functions/run-post-queue/index.ts"),
  ]);
  assert.match(shared, /return media\.deliveryUrl \|\| media\.url/);
  assert.match(shared, /issue_post_approved_media_handle_service/);
  assert.match(shared, /resolve_post_approved_media_service/);
  assert.match(approval, /approve_and_schedule_post_draft_opaque/);
  assert.match(approval, /\[`p_\$\{prefix\}_delivery_id`\]: media\?\.deliveryId/);
  for (const consumer of [meta, queue]) {
    assert.match(consumer, /approved_fb_delivery_id/);
    assert.match(consumer, /approved_ig_delivery_id/);
    assert.match(consumer, /verifyApprovedMedia\(\s*admin,/);
    assert.match(consumer, /approvedMediaProviderUrl\(approvedMediaFor\(/);
  }
});

test("approved-media Edge origin is secret-gated and returns verified bytes, never a Storage redirect", async () => {
  const edge = await read("supabase/functions/approved-media/index.ts");
  assert.match(edge, /PUBLIC_MEDIA_GATEWAY_SECRET/);
  assert.match(edge, /PUBLIC_MEDIA_GATEWAY_PREVIOUS_SECRET/);
  assert.match(edge, /PUBLIC_MEDIA_GATEWAY_HEADER/);
  assert.match(edge, /GATEWAY_SECRET\.test\(MEDIA_GATEWAY_SECRET\)/);
  assert.match(edge, /constantTimeSecretMatch\(supplied, MEDIA_GATEWAY_PREVIOUS_SECRET\)/);
  assert.match(edge, /resolve_post_approved_media_delivery_service/);
  assert.match(edge, /redirect: "error"/);
  assert.match(edge, /await sha256Hex\(bytes\) !== media\.sha256/);
  assert.match(edge, /req\.method !== "GET" && req\.method !== "HEAD"/);
  assert.doesNotMatch(edge, /Location["']/);
  assert.doesNotMatch(edge, /X-[^\n]*(Owner|Storage-Path|Sha256)/i);
});

test("backend social rendition contract requires exact registered crop bytes for every raster AI state", async () => {
  const [ingest, compose, sql] = await Promise.all([
    read("supabase/functions/media-ingest/index.ts"),
    read("supabase/functions/compose-post/index.ts"),
    read("MyPersonas.Online_v0/sql-updates/063-opaque-approved-media-delivery.sql"),
  ]);
  assert.match(ingest, /facebook: Object\.freeze\(\{ width: 1200, height: 628 \}\)/);
  assert.match(ingest, /instagram: Object\.freeze\(\{ width: 1080, height: 1080 \}\)/);
  assert.match(ingest, /x: Object\.freeze\(\{ width: 1080, height: 1350 \}\)/);
  assert.match(ingest, /A social rendition requires its exact server crop dimensions/);
  assert.match(ingest, /outputDimensions\.width !== crop\.width/);
  assert.match(ingest, /renderRasterDerivative\(bytes, detected\.mime, crop, aiUse !== "none"\)/);
  assert.match(compose, /Every image requires three distinct registered final social crops/);
  assert.match(compose, /resolve_owned_persona_media_reference_service/);
  assert.doesNotMatch(compose, /render\/image\/public|transformUrl/);
  assert.match(sql, /No-AI media may differ only as an exact server social rendition/);
  assert.match(sql, /p_rendition not in \('facebook','instagram','x'\)/);
});

test("account erasure revokes opaque delivery before bytes and removes retry state", async () => {
  const source = await read("supabase/functions/delete-account/index.ts");
  const flow = source.slice(source.indexOf("const eraseClaimedOwner"));
  assert.ok(
    flow.indexOf("revokeApprovedMediaDelivery(admin, uid)") <
      flow.indexOf("eraseOwnedStorage(admin, uid)"),
  );
  assert.match(source, /revoke_post_approved_media_owner_service/);
  assert.match(source, /admin\.from\("post_drafts"\)\.delete\(\)\.eq\("owner", uid\)/);
  assert.match(source, /admin\.from\("post_approved_media_handles"\)\.delete\(\)\.eq\("owner", uid\)/);
});
