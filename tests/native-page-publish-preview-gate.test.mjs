import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const governance = await read("MyPersonas.Online_v0/platform-governance.js");
const canonical = await read("MyPersonas.Online_v0/sql-updates/074-native-page-publish-preview-gate.sql");
const timestamped = await read("supabase/migrations/20260830170000_native_page_publish_preview_gate.sql");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} must exist`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} must follow ${start}`);
  return source.slice(from, to);
}

test("migration 074 mirrors remain byte-identical and transactional", () => {
  assert.equal(timestamped, canonical);
  assert.match(canonical, /^-- 074-native-page-publish-preview-gate\.sql/);
  assert.match(canonical, /begin;[\s\S]*commit;/i);
});

test("durable preview evidence is owner-readable but browser-immutable", () => {
  assert.match(canonical, /create table if not exists public\.persona_page_publish_preview_evidence/);
  for (const field of [
    "preview_version", "preview_hash", "preview_revision", "preview_target_id",
    "manifest_sha256", "preview_payload", "preview_session_id", "expires_at", "acknowledged_at",
    "consumed_at", "invalidated_at", "published_revision", "publish_result",
  ]) assert.match(canonical, new RegExp(`\\b${field}\\b`));
  assert.match(canonical, /foreign key \(persona_id,owner\) references public\.personas\(id,owner\)/);
  assert.match(canonical, /enable row level security/);
  assert.match(canonical, /for select\s+to authenticated\s+using \(\(select auth\.uid\(\)\)=owner\)/);
  assert.match(canonical, /revoke all on public\.persona_page_publish_preview_evidence\s+from public,anon,authenticated,service_role/);
  assert.match(canonical, /grant select on public\.persona_page_publish_preview_evidence to authenticated/);
  assert.doesNotMatch(canonical, /grant (?:insert|update|delete) on public\.persona_page_publish_preview_evidence to authenticated/);
});

test("prepare RPC binds a short-lived exact current revision and target proof", () => {
  const payload = between(canonical, "create or replace function public.native_persona_page_publish_preview_payload(", "create or replace function public.prepare_native_persona_page_publish_preview(");
  const prepare = between(canonical, "create or replace function public.prepare_native_persona_page_publish_preview(", "create or replace function public.invalidate_native_persona_page_previews_after_revision()");
  assert.match(payload, /security definer[\s\S]*set search_path=''/);
  assert.match(payload, /persona_publication_readiness\(p_persona_id\)/);
  assert.match(payload, /review\.reviewed_revision=v_persona\.publication_revision/);
  assert.match(payload, /review\.readiness_snapshot->>'manifest_sha256'=v_snapshot->>'manifest_sha256'/);
  assert.match(payload, /'target_id','aliaspaces:persona:'\|\|v_persona\.id::text/);
  assert.match(payload, /'timing','immediately_after_approval'/);
  assert.match(payload, /'automated',false/);
  assert.match(prepare, /perform public\.require_aal2\(\)/);
  assert.match(prepare, /perform public\.lock_persona_publication_mutation\(p_persona_id\)/);
  assert.match(prepare, /where persona\.id=p_persona_id and persona\.owner=v_owner for update/);
  assert.match(prepare, /native_persona_page_publish_preview_payload\(p_persona_id\)/);
  assert.match(prepare, /extensions\.digest\(convert_to\(v_payload::text,'UTF8'\),'sha256'\)/);
  assert.match(prepare, /v_expires_at:=v_prepared_at\+interval '15 minutes'/);
  assert.match(prepare, /invalidation_reason='superseded_by_new_preview'/);
  assert.match(prepare, /insert into public\.persona_page_publish_preview_evidence/);
});

test("revision and review changes invalidate every unconsumed proof", () => {
  assert.match(canonical, /after update of publication_revision on public\.personas/);
  assert.match(canonical, /invalidation_reason='persona_revision_changed'/);
  assert.match(canonical, /after insert or update or delete on public\.persona_publication_reviews/);
  assert.match(canonical, /invalidation_reason='publication_review_changed'/);
  assert.match(canonical, /evidence\.consumed_at is null and evidence\.invalidated_at is null/g);
});

test("separate AAL2 acknowledgement precedes one-shot exact page publication", () => {
  const acknowledge = between(canonical, "create or replace function public.acknowledge_native_persona_page_publish_preview(", "create or replace function public.approve_and_publish_previewed_persona_page(");
  const approve = between(canonical, "create or replace function public.approve_and_publish_previewed_persona_page(", "revoke all on function public.native_persona_page_publish_preview_payload(uuid)");
  assert.match(acknowledge, /perform public\.require_aal2\(\)/);
  assert.match(acknowledge, /v_evidence\.acknowledged_at is not null or v_evidence\.consumed_at is not null/);
  assert.match(acknowledge, /v_evidence\.preview_session_id is distinct from v_session_id/);
  assert.match(acknowledge, /native_persona_page_publish_preview_payload\(p_persona_id\)/);
  assert.match(acknowledge, /set acknowledged_at=v_acknowledged_at/);
  assert.doesNotMatch(acknowledge, /public\.publish_persona_page/);
  assert.match(approve, /perform public\.require_aal2\(\)/);
  assert.match(approve, /perform public\.lock_persona_publication_mutation\(p_persona_id\)/);
  assert.match(approve, /where persona\.id=p_persona_id and persona\.owner=v_owner for update/);
  assert.match(approve, /where evidence\.id=p_preview_id[\s\S]*for update/);
  assert.match(approve, /v_evidence\.consumed_at is not null/);
  assert.match(approve, /v_evidence\.acknowledged_at is null/);
  assert.match(approve, /v_evidence\.invalidated_at is not null/);
  assert.match(approve, /v_evidence\.expires_at<=v_consumed_at/);
  assert.match(approve, /native_persona_page_publish_preview_payload\(p_persona_id\)/);
  assert.match(approve, /v_evidence\.preview_payload is distinct from v_payload/);
  assert.match(approve, /set consumed_at=v_consumed_at/);
  assert.match(approve, /v_result:=public\.publish_persona_page\(p_persona_id\)/);
  assert.ok(approve.indexOf("set consumed_at=") < approve.indexOf("v_result:=public.publish_persona_page"));
  assert.match(canonical, /revoke execute on function public\.publish_persona_page\(uuid\)\s+from public,anon,authenticated,service_role/);
  assert.match(canonical, /grant execute on function public\.prepare_native_persona_page_publish_preview\(uuid\),\s+public\.acknowledge_native_persona_page_publish_preview\(uuid,uuid,text,text,integer,text\),\s+public\.approve_and_publish_previewed_persona_page\(uuid,uuid,text,text,integer,text\)\s+to authenticated/);
});

test("native page publish UI fails closed and uses only the proof-gated RPC", () => {
  const publish = between(governance, "async function governancePublish(){", "async function governanceUnpublish(){");
  const commit = between(governance, "async function governancePublishPreviewed(", "async function governancePublish(){");
  assert.match(publish, /typeof openPlatformPreviewDialog!=="function"/);
  assert.match(publish, /typeof platformPreviewRequirementsReady!=="function"/);
  assert.match(publish, /typeof confirmPlatformPreviewDialog!=="function"/);
  assert.match(publish, /governanceReviewIsDirty\(\)/);
  assert.match(publish, /prepare_native_persona_page_publish_preview/);
  assert.match(publish, /openPlatformPreviewDialog/);
  assert.match(publish, /onConfirm:\(\)=>governancePublishPreviewed\(persona\.id,proof,owner\)/);
  assert.ok(publish.indexOf('rpc("prepare_native_persona_page_publish_preview"') < publish.indexOf("openPlatformPreviewDialog({"));
  assert.match(commit, /session\?\.user\?\.id!==owner/);
  assert.match(commit, /governanceReviewIsDirty\(\)/);
  assert.match(commit, /Date\.parse\(proof\.expiresAt\)<=Date\.now\(\)/);
  assert.match(commit, /acknowledge_native_persona_page_publish_preview/);
  assert.match(commit, /approve_and_publish_previewed_persona_page/);
  assert.ok(commit.indexOf('rpc("acknowledge_native_persona_page_publish_preview"') < commit.indexOf('rpc("approve_and_publish_previewed_persona_page"'));
  assert.match(commit, /p_preview_hash:proof\.hash/);
  assert.match(commit, /p_preview_revision:proof\.revision/);
  assert.match(commit, /p_preview_target_id:proof\.targetId/);
  assert.doesNotMatch(governance, /sb\.rpc\("publish_persona_page"/);
  assert.match(governance, /Preview &amp; publish reviewed page/);
});

test("proof validation rejects stale or mismatched server evidence", () => {
  const proofFunction = between(governance, "function governanceNativePagePreviewProof(", "function governanceNativePagePreviewItems(");
  const context = vm.createContext({ Date, Error, Number, String, result: null });
  const persona = { id: "11111111-1111-4111-8111-111111111111" };
  const manifest = { complete: true, revision: 7, assets: [{ label: "Avatar", kind: "image", url: "https://example.com/avatar.png" }] };
  const payload = {
    preview_version: "native-persona-page-preview-v1",
    target: { persona_id: persona.id, target_id: `aliaspaces:persona:${persona.id}` },
    revision: 7,
    manifest_sha256: "a".repeat(64),
    manifest,
  };
  const data = {
    preview_id: "22222222-2222-4222-8222-222222222222",
    preview_version: payload.preview_version,
    preview_hash: "b".repeat(64),
    preview_revision: 7,
    preview_target_id: payload.target.target_id,
    manifest_sha256: payload.manifest_sha256,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview_payload: payload,
  };
  context.data = data;
  context.persona = persona;
  new vm.Script(`const NATIVE_PERSONA_PAGE_PREVIEW_VERSION="native-persona-page-preview-v1";${proofFunction};result=governanceNativePagePreviewProof(data,persona);`).runInContext(context);
  assert.equal(context.result.revision, 7);
  context.data = { ...data, expires_at: new Date(Date.now() - 1_000).toISOString() };
  assert.throws(() => new vm.Script("governanceNativePagePreviewProof(data,persona)").runInContext(context), /current exact native-page preview proof/);
  context.data = { ...data, preview_target_id: "aliaspaces:persona:wrong" };
  assert.throws(() => new vm.Script("governanceNativePagePreviewProof(data,persona)").runInContext(context), /current exact native-page preview proof/);
});

test("preview cards expose exact profile copy, layout, nested content, media, target, and immediate timing", () => {
  const itemFunction = between(governance, "function governanceNativePagePreviewItems(", "async function governancePublishPreviewed(");
  const targetId = "aliaspaces:persona:11111111-1111-4111-8111-111111111111";
  const manifest = {
    profile: { name: "Ada", title: "Researcher", tagline: "Evidence first", bio: "Long bio", focus: "Focus", pet_project: "Project", ai_disclosure: "AI-assisted", topics: "science", hashtags: "#evidence", modules: { feed: true }, theme: "light" },
    layout: { version: 1, order: ["about", "feed"], cards: { feed: "wide" }, widgets: [{ type: "text" }] },
    counts: { links: 1, posts: 1, albums: 1, album_items: 1 },
    assets: [
      { label: "Profile image", kind: "image", url: "https://example.com/avatar.png" },
      { label: "Profile song", kind: "audio", url: "https://example.com/song.mp3" },
    ],
    links: [{ platform: "Website", handle: "Ada", url: "https://example.com" }],
    posts: [{ kind: "video", title: "Post title", body: "Post body", tags: "#post", media_url: "https://example.com/post.mp4", created_at: "2026-08-30T00:00:00Z" }],
    albums: [{ title: "Album", kind: "gallery", items: [{ caption: "Album caption", thumb_url: "https://example.com/album.jpg", link_url: "https://example.com/album" }] }],
    top8: [{ name: "Top", handle: "top", avatar_url: "https://example.com/top.jpg" }],
    linked_personas: [{ name: "Linked", handle: "linked", tagline: "Linked tagline", avatar_url: "https://example.com/linked.jpg" }],
    family: [{ name: "Family", handle: "family", relationship: "partner", avatar_url: "https://example.com/family.jpg" }],
    revenue: { settings: { affiliate_enabled: true }, offers: [{ title: "Offer", merchant: "Merchant", disclosure: "Affiliate", cta_label: "See it", category: "Tools", image_url: "https://example.com/offer.jpg", placement: "feed", affiliate_destination: "https://example.com/buy" }] },
  };
  const proof = { manifest, target: { handle: "ada", name: "Ada", visibility: "public" }, targetId, revision: 7, manifestHash: "a".repeat(64) };
  const context = vm.createContext({ JSON, String, Number, Array, Object, proof, result: null, autoTz: () => "America/Anchorage" });
  new vm.Script(`${itemFunction};result=governanceNativePagePreviewItems(proof);`).runInContext(context);
  const items = Array.from(context.result);
  assert.equal(items.length, 9);
  assert.ok(items.every((item) => item.accountId === targetId));
  assert.ok(items.every((item) => item.timingLabel === "Immediately after approval"));
  assert.match(items[0].text, /Researcher[\s\S]*Evidence first[\s\S]*Long bio[\s\S]*AI-assisted/);
  assert.match(items[0].tags, /science[\s\S]*#evidence/);
  assert.ok(items[0].platformDetails.some((detail) => detail.includes('Exact layout JSON: {"version":1')));
  assert.ok(items.some((item) => item.title === "Post title" && item.text === "Post body" && item.tags === "#post"));
  assert.ok(items.some((item) => item.title === "Album" && item.text === "Album caption"));
  assert.ok(items.some((item) => item.title === "Exact public page links" && item.platformDetails.some((detail) => detail.includes("https://example.com"))));
  const urls = new Set(items.map((item) => item.mediaUrl).filter(Boolean));
  for (const url of [
    "https://example.com/avatar.png", "https://example.com/song.mp3",
    "https://example.com/post.mp4", "https://example.com/album.jpg",
    "https://example.com/top.jpg", "https://example.com/linked.jpg",
    "https://example.com/family.jpg", "https://example.com/offer.jpg",
  ]) assert.ok(urls.has(url), `${url} must be previewed`);
});
