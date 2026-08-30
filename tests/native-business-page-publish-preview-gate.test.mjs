import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const governance = await read("MyPersonas.Online_v0/platform-governance.js");
const canonical = await read("MyPersonas.Online_v0/sql-updates/075-native-business-page-publish-preview-gate.sql");
const timestamped = await read("supabase/migrations/20260830180000_native_business_page_publish_preview_gate.sql");
const runtime = await read("tests/sql/075-native-business-page-preview-runtime.sql");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} must exist`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} must follow ${start}`);
  return source.slice(from, to);
}

test("migration 075 mirrors are byte-identical and transactional", () => {
  assert.equal(timestamped, canonical);
  assert.match(canonical, /^-- 075-native-business-page-publish-preview-gate\.sql/);
  assert.match(canonical, /begin;[\s\S]*commit;/i);
});

test("migration 075 has a disposable end-to-end receipt behavior probe", () => {
  assert.match(runtime, /begin;[\s\S]*rollback;/i);
  assert.match(runtime, /AAL1 cannot acknowledge an exact native business-page preview/);
  assert.match(runtime, /acknowledgement consumption and exact-current publication complete atomically/);
  assert.match(runtime, /a consumed native business-page preview cannot publish twice/);
  assert.match(runtime, /editing the business revision automatically invalidates its outstanding preview/);
  assert.match(runtime, /browser callers cannot bypass preview evidence through the legacy publisher/);
});

test("business preview evidence is short-lived, owner-readable, and browser-immutable", () => {
  assert.match(canonical, /create table if not exists public\.business_page_publish_preview_evidence/);
  for (const field of [
    "business_id", "owner", "preview_version", "preview_hash", "preview_revision",
    "preview_target_id", "manifest_sha256", "preview_payload", "preview_session_id",
    "prepared_at", "expires_at", "acknowledged_at", "consumed_at", "invalidated_at",
    "published_revision", "published_at", "publish_result",
  ]) assert.match(canonical, new RegExp(`\\b${field}\\b`));
  assert.match(canonical, /foreign key \(business_id,owner\) references public\.businesses\(id,owner\)/);
  assert.match(canonical, /expires_at>prepared_at and expires_at<=prepared_at\+interval '15 minutes'/);
  assert.match(canonical, /enable row level security/);
  assert.match(canonical, /for select\s+to authenticated\s+using \(\(select auth\.uid\(\)\)=owner\)/);
  assert.match(canonical, /revoke all on public\.business_page_publish_preview_evidence\s+from public,anon,authenticated,service_role/);
  assert.match(canonical, /grant select on public\.business_page_publish_preview_evidence to authenticated/);
  assert.doesNotMatch(canonical, /grant (?:insert|update|delete) on public\.business_page_publish_preview_evidence to authenticated/);
});

test("server preparation freezes the exact ready business revision, target, route, and manifest", () => {
  const payload = between(canonical, "create or replace function public.native_business_page_publish_preview_payload(", "create or replace function public.prepare_native_business_page_publish_preview(");
  const prepare = between(canonical, "create or replace function public.prepare_native_business_page_publish_preview(", "create or replace function public.invalidate_native_business_page_previews_after_revision()");
  assert.match(payload, /security definer[\s\S]*set search_path=''/);
  assert.match(payload, /business_publication_readiness\(p_business_id\)/);
  assert.match(payload, /v_business\.page_status<>'draft'/);
  assert.match(payload, /v_business\.visibility<>'owner_only'/);
  assert.match(payload, /review_manifest_current/);
  assert.match(payload, /review\.reviewed_revision=v_business\.publication_revision/);
  assert.match(payload, /review\.readiness_snapshot->>'manifest_sha256'=v_snapshot->>'manifest_sha256'/);
  assert.match(payload, /review\.readiness_snapshot->'review_manifest'=v_manifest/);
  assert.match(payload, /'target_id','aliaspaces:business:'\|\|v_business\.id::text/);
  assert.match(payload, /'public_route','#\/b\/'\|\|v_business\.slug/);
  assert.match(payload, /'page_status','published'/);
  assert.match(payload, /'visibility','public'/);
  assert.match(payload, /'type','publish_business_page'/);
  assert.match(payload, /'timing','immediately_after_approval'/);
  assert.match(payload, /'automated',false/);
  assert.match(prepare, /perform public\.require_aal2\(\)/);
  assert.match(prepare, /perform public\.lock_business_publication_mutation\(p_business_id\)/);
  assert.match(prepare, /where business\.id=p_business_id and business\.owner=v_owner for update/);
  assert.match(prepare, /native_business_page_publish_preview_payload\(p_business_id\)/);
  assert.match(prepare, /extensions\.digest\(convert_to\(v_payload::text,'UTF8'\),'sha256'\)/);
  assert.match(prepare, /v_expires_at:=v_prepared_at\+interval '15 minutes'/);
  assert.match(prepare, /preview_session_id,expires_at/);
  assert.match(prepare, /invalidation_reason='superseded_by_new_preview'/);
});

test("business revision and review drift invalidate every unconsumed preview", () => {
  assert.match(canonical, /after update of publication_revision on public\.businesses/);
  assert.match(canonical, /invalidation_reason='business_revision_changed'/);
  assert.match(canonical, /after insert or update or delete on public\.business_publication_reviews/);
  assert.match(canonical, /invalidation_reason='business_publication_review_changed'/);
  assert.match(canonical, /evidence\.consumed_at is null and evidence\.invalidated_at is null/g);
});

test("separate AAL2 acknowledgement rejects raw, expired, replayed, drifted, and cross-session proofs", () => {
  const acknowledge = between(canonical, "create or replace function public.acknowledge_native_business_page_publish_preview(", "create or replace function public.approve_and_publish_previewed_business_page(");
  assert.match(acknowledge, /perform public\.require_aal2\(\)/);
  assert.doesNotMatch(acknowledge, /\bboolean\b/i);
  assert.match(acknowledge, /p_preview_id is null/);
  assert.match(acknowledge, /p_preview_version,'?'\)?<>|'native-business-page-preview-v1'/);
  assert.match(acknowledge, /v_evidence\.acknowledged_at is not null or v_evidence\.consumed_at is not null/);
  assert.match(acknowledge, /v_evidence\.invalidated_at is not null/);
  assert.match(acknowledge, /v_evidence\.expires_at<=v_acknowledged_at/);
  assert.match(acknowledge, /v_evidence\.preview_session_id is distinct from v_session_id/);
  assert.match(acknowledge, /is distinct from row\(v_evidence\.preview_version,v_evidence\.preview_hash/);
  assert.match(acknowledge, /native_business_page_publish_preview_payload\(p_business_id\)/);
  assert.match(acknowledge, /v_evidence\.preview_payload is distinct from v_payload/);
  assert.match(acknowledge, /set acknowledged_at=v_acknowledged_at/);
  assert.doesNotMatch(acknowledge, /public\.publish_business_page/);
});

test("one-shot consume and business publication are atomic, with no direct API bypass", () => {
  const approve = between(canonical, "create or replace function public.approve_and_publish_previewed_business_page(", "revoke all on function public.native_business_page_publish_preview_payload(uuid)");
  assert.match(approve, /perform public\.require_aal2\(\)/);
  assert.match(approve, /perform public\.lock_business_publication_mutation\(p_business_id\)/);
  assert.match(approve, /where evidence\.id=p_preview_id[\s\S]*for update/);
  assert.match(approve, /v_evidence\.consumed_at is not null/);
  assert.match(approve, /v_evidence\.acknowledged_at is null/);
  assert.match(approve, /v_evidence\.invalidated_at is not null/);
  assert.match(approve, /v_evidence\.expires_at<=v_consumed_at/);
  assert.match(approve, /v_evidence\.preview_session_id is distinct from coalesce\(auth\.jwt\(\)->>'session_id',''\)/);
  assert.match(approve, /native_business_page_publish_preview_payload\(p_business_id\)/);
  assert.match(approve, /v_evidence\.preview_payload is distinct from v_payload/);
  assert.match(approve, /set consumed_at=v_consumed_at/);
  assert.match(approve, /v_result:=public\.publish_business_page\(p_business_id\)/);
  assert.match(approve, /'publication_current',public\.business_publication_is_current\(p_business_id\)/);
  assert.match(approve, /Published business failed the exact-current receipt check/);
  assert.ok(approve.indexOf("set consumed_at=") < approve.indexOf("v_result:=public.publish_business_page"));
  assert.match(canonical, /revoke execute on function public\.publish_business_page\(uuid\)\s+from public,anon,authenticated,service_role/);
  assert.match(canonical, /grant execute on function public\.prepare_native_business_page_publish_preview\(uuid\),\s+public\.acknowledge_native_business_page_publish_preview\(uuid,uuid,text,text,integer,text\),\s+public\.approve_and_publish_previewed_business_page\(uuid,uuid,text,text,integer,text\)\s+to authenticated/);
});

test("business publication UI fails closed, renders server proof, then acknowledges before publish", () => {
  const publish = between(governance, "async function governancePublishBusiness(businessId){", "async function governanceUnpublishBusiness(businessId)");
  const commit = between(governance, "async function governancePublishPreviewedBusiness(", "async function governancePublishBusiness(businessId){");
  assert.match(publish, /typeof openPlatformPreviewDialog!=="function"/);
  assert.match(publish, /typeof platformPreviewRequirementsReady!=="function"/);
  assert.match(publish, /typeof confirmPlatformPreviewDialog!=="function"/);
  assert.match(publish, /governanceRequireSensitive\("prepare the exact business revision for publication"\)/);
  assert.match(publish, /prepare_native_business_page_publish_preview/);
  assert.match(publish, /governanceNativeBusinessPreviewProof\(data,businessId\)/);
  assert.match(publish, /governanceNativeBusinessPreviewItems\(proof\)/);
  assert.match(publish, /openPlatformPreviewDialog/);
  assert.match(publish, /onConfirm:\(\)=>governancePublishPreviewedBusiness\(businessId,proof,owner\)/);
  assert.ok(publish.indexOf('rpc("prepare_native_business_page_publish_preview"') < publish.indexOf("openPlatformPreviewDialog({"));
  assert.doesNotMatch(publish, /\bconfirm\(/);
  assert.match(commit, /session\?\.user\?\.id!==owner/);
  assert.match(commit, /governanceState\.businessReviewBusinessId!==businessId/);
  assert.match(commit, /Date\.parse\(proof\.expiresAt\)<=Date\.now\(\)/);
  assert.match(commit, /acknowledge_native_business_page_publish_preview/);
  assert.match(commit, /approve_and_publish_previewed_business_page/);
  assert.ok(commit.indexOf('rpc("acknowledge_native_business_page_publish_preview"') < commit.indexOf('rpc("approve_and_publish_previewed_business_page"'));
  assert.match(commit, /p_preview_hash:proof\.hash/);
  assert.match(commit, /p_preview_revision:proof\.revision/);
  assert.match(commit, /p_preview_target_id:proof\.targetId/);
  assert.doesNotMatch(governance, /sb\.rpc\("publish_business_page"/);
  assert.match(governance, /Preview &amp; publish reviewed revision/);
});

test("proof validation rejects target, route, action, revision, and expiry drift", () => {
  const proofFunction = between(governance, "function governanceNativeBusinessPreviewProof(", "function governanceNativeBusinessPreviewItems(");
  const businessId = "11111111-1111-4111-8111-111111111111";
  const targetId = `aliaspaces:business:${businessId}`;
  const manifest = {
    business_id: businessId,
    revision: 4,
    complete: true,
    publication_target: { page_status: "published", visibility: "public" },
    profile: { slug: "exact-business", display_name: "Exact Business" },
  };
  const payload = {
    preview_version: "native-business-page-preview-v1",
    target: { provider: "aliaspaces", target_id: targetId, business_id: businessId, slug: "exact-business", display_name: "Exact Business", public_route: "#/b/exact-business", page_status: "published", visibility: "public" },
    action: { type: "publish_business_page", timing: "immediately_after_approval", automated: false },
    revision: 4,
    manifest_sha256: "a".repeat(64),
    manifest,
  };
  const data = {
    preview_id: "22222222-2222-4222-8222-222222222222",
    preview_version: payload.preview_version,
    preview_hash: "b".repeat(64),
    preview_revision: 4,
    preview_target_id: targetId,
    manifest_sha256: payload.manifest_sha256,
    prepared_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    preview_payload: payload,
  };
  const context = vm.createContext({ Date, Error, Number, String, businessId, data, result: null });
  new vm.Script(`const NATIVE_BUSINESS_PAGE_PREVIEW_VERSION="native-business-page-preview-v1";${proofFunction};result=governanceNativeBusinessPreviewProof(data,businessId);`).runInContext(context);
  assert.equal(context.result.revision, 4);
  for (const drift of [
    { preview_target_id: "aliaspaces:business:wrong" },
    { preview_revision: 5 },
    { expires_at: new Date(Date.now() - 1_000).toISOString() },
    { preview_payload: { ...payload, target: { ...payload.target, public_route: "#/b/wrong" } } },
    { preview_payload: { ...payload, action: { ...payload.action, automated: true } } },
  ]) {
    context.data = { ...data, ...drift };
    assert.throws(() => new vm.Script("governanceNativeBusinessPreviewProof(data,businessId)").runInContext(context), /current exact native business-page preview proof/);
  }
});

test("preview cards expose only the exact public projection, target, media, and immediate timing", () => {
  const itemFunction = between(governance, "function governanceNativeBusinessPreviewItems(", "async function governancePublishPreviewedBusiness(");
  const targetId = "aliaspaces:business:11111111-1111-4111-8111-111111111111";
  const manifest = {
    profile: { slug: "exact-business", display_name: "Exact Business", short_bio: "Public bio", mission: "Public mission" },
    counts: { mission_items: 2, persona_memberships: 3 },
    mission_items: [
      { title: "Public work", body: "Public body", enabled: true, visibility: "public", sort_order: 1 },
      { title: "Private work", body: "Private body", enabled: true, visibility: "owner_only", sort_order: 2 },
    ],
    persona_memberships: [
      { membership_role: "representative", public_title: "Spokesperson", enabled: true, membership_visibility: "public", title_visibility: "public", persona_card: { handle: "ada", name: "Ada", avatar_url: "https://example.com/ada.jpg", publication_revision: 7, published_revision: 7, public_eligible: true } },
      { membership_role: "member", public_title: "Private title", enabled: true, membership_visibility: "owner_only", title_visibility: "owner_only", persona_card: { handle: "private", name: "Private", avatar_url: "https://example.com/private.jpg", publication_revision: 2, published_revision: 2, public_eligible: true } },
      { membership_role: "member", public_title: "Stale", enabled: true, membership_visibility: "public", title_visibility: "public", persona_card: { handle: "stale", name: "Stale", avatar_url: "https://example.com/stale.jpg", publication_revision: 3, published_revision: 2, public_eligible: false } },
    ],
  };
  const proof = { manifest, target: { display_name: "Exact Business", public_route: "#/b/exact-business" }, targetId, revision: 4, manifestHash: "a".repeat(64) };
  const context = vm.createContext({ String, Number, Array, Object, proof, result: null, autoTz: () => "America/Anchorage" });
  new vm.Script(`${itemFunction};result=governanceNativeBusinessPreviewItems(proof);`).runInContext(context);
  const items = Array.from(context.result);
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.accountId === targetId));
  assert.ok(items.every((item) => item.requiresExactTarget === true && item.exactTargetReady === true));
  assert.ok(items.every((item) => item.timingLabel === "Immediately after approval"));
  assert.match(items[0].text, /Public bio[\s\S]*Public mission/);
  assert.ok(items.some((item) => item.title === "Public work" && item.text === "Public body"));
  assert.ok(items.some((item) => item.title === "Ada" && item.text.includes("Spokesperson") && item.mediaUrl === "https://example.com/ada.jpg"));
  assert.ok(!items.some((item) => /Private work|Private body|Private title|Stale/.test(`${item.title}\n${item.text}`)));
  assert.ok(!items.some((item) => ["https://example.com/private.jpg", "https://example.com/stale.jpg"].includes(item.mediaUrl)));
  assert.ok(items.every((item) => item.platformDetails.some((detail) => detail.includes("Exact public route: #/b/exact-business"))));
});
