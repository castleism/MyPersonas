import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const migrationPath = "MyPersonas.Online_v0/sql-updates/052-reviewed-business-publication.sql";
const mirrorPath = "supabase/migrations/20260822180000_reviewed_business_publication.sql";
const migration = await read(migrationPath);
const governanceMigration = await read("MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql");

const functionBody = (name) => migration.match(
  new RegExp(`create or replace function public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`, "i")
)?.[0] || "";

test("migration 052 and its timestamped mirror are byte-identical and transactional", async () => {
  assert.equal(await read(mirrorPath), migration);
  assert.match(migration, /^-- 052-reviewed-business-publication\.sql/);
  assert.match(migration, /begin;[\s\S]*commit;/i);
  assert.match(migration, /Apply it[\s\S]*only after migrations 049, 050, and 051/i);
});

test("legacy rows are normalized once and every public business edit invalidates exact review", () => {
  assert.match(migration, /where publication_revision is null/);
  assert.match(migration, /set publication_revision=1,[\s\S]*page_status='draft',[\s\S]*visibility='owner_only',[\s\S]*published_at=null/);
  assert.match(migration, /create table if not exists public\.business_publication_reviews/);
  assert.match(migration, /create trigger guard_business_publication_lifecycle[\s\S]*before insert or update on public\.businesses/);
  assert.match(migration, /new\.publication_revision:=old\.publication_revision\+1/);
  assert.match(migration, /new\.page_status:='draft';[\s\S]*new\.visibility:='owner_only';[\s\S]*new\.published_revision:=null/);
  assert.match(migration, /create trigger invalidate_business_after_mission_edit[\s\S]*after insert or update or delete on public\.business_mission_items/);
  assert.match(migration, /create trigger invalidate_business_after_membership_edit[\s\S]*after insert or update or delete on public\.business_persona_memberships/);
  assert.match(migration, /review_state='stale',[\s\S]*readiness_snapshot='\{\}'::jsonb/);
  assert.match(migration, /create or replace function public\.lock_business_publication_mutation/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test("browser writes are locked RPC-only and presentation titles confer no authority", () => {
  assert.match(migration, /revoke all on function public\.save_business_profile[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration, /revoke insert,update,delete on public\.businesses,public\.business_mission_items,[\s\S]*from public,anon,authenticated,service_role/);
  const browserGrant = migration.slice(migration.lastIndexOf("grant execute on function public.save_business_draft"))
    .match(/^[\s\S]*?to authenticated;/)?.[0] || "";
  assert.doesNotMatch(browserGrant, /business_publication_review_manifest/);
  for (const name of [
    "save_business_draft", "save_business_mission_item_draft",
    "delete_business_mission_item_draft", "set_business_persona_membership_draft",
  ]) {
    const body = functionBody(name);
    assert.match(body, /auth\.uid\(\)/);
    assert.match(body, /lock_business_publication_mutation/);
  }
  assert.match(functionBody("save_business_draft"), /if v_status='published' then perform public\.require_aal2\(\)/);
  assert.match(functionBody("save_business_mission_item_draft"), /if v_status='published' then perform public\.require_aal2\(\)/);
  assert.match(functionBody("set_business_persona_membership_draft"), /if v_status='published' then perform public\.require_aal2\(\)/);
  assert.match(migration, /membership_role[\s\S]*never grants authentication, staff, provider, or database authority/i);
  assert.match(migration, /An account can have at most 100 businesses/);
  assert.match(migration, /A business can have at most 100 mission items/);
  assert.match(migration, /A business can have at most 200 persona memberships/);
  assert.doesNotMatch(migration, /business_persona_memberships[\s\S]{0,300}(?:platform_role_assignments|grant_staff|auth\.admin)/i);
});

test("persona deletion prelocks attached businesses before its cascading membership delete", () => {
  const deletion = governanceMigration.match(
    /create or replace function public\.delete_owned_persona\b[\s\S]*?\n\$\$;/i
  )?.[0] || "";
  assert.match(deletion, /from public\.business_persona_memberships membership/);
  assert.match(deletion, /order by membership\.business_id/);
  const businessLock = deletion.indexOf("hashtextextended(v_business_id::text,52052052)");
  const personaLock = deletion.indexOf("lock_persona_publication_mutation(p_persona_id)");
  const personaDelete = deletion.indexOf("delete from public.personas persona");
  assert.ok(businessLock >= 0, "business publication advisory lock");
  assert.ok(businessLock < personaLock, "business locks must precede the persona lock");
  assert.ok(personaLock < personaDelete, "all advisory locks must precede the cascading delete");
});

test("review manifest is deterministic, bounded, and binds all public projections", () => {
  const manifest = functionBody("business_publication_review_manifest");
  assert.match(manifest, /v_mission_count>100/);
  assert.match(manifest, /v_membership_count>200/);
  assert.match(manifest, /business_mission_items[\s\S]*limit 101[\s\S]*business_persona_memberships[\s\S]*limit 201/);
  assert.match(manifest, /octet_length\(v_result::text\)>250000/);
  assert.match(manifest, /order by item\.sort_order,item\.id/);
  assert.match(manifest, /order by membership\.sort_order,membership\.persona_id/);
  assert.match(manifest, /'publication_target',[\s\S]*'page_status','published','visibility','public'/);
  assert.match(manifest, /'mission_items',v_mission_items/);
  assert.match(manifest, /'membership_role',membership\.membership_role/);
  assert.match(manifest, /'public_title',membership\.public_title/);
  assert.match(manifest, /'membership_visibility',membership\.membership_visibility/);
  assert.match(manifest, /'title_visibility',membership\.title_visibility/);
  assert.match(manifest, /'persona_card',[\s\S]*'handle',persona\.handle[\s\S]*'name',persona\.name[\s\S]*'avatar_url'/);
  assert.match(manifest, /'exact_current',public\.persona_publication_is_current\(persona\.id\)/);
  assert.match(manifest, /'public_eligible',persona\.visibility='public'[\s\S]*persona_publication_is_current/);
  assert.match(manifest, /not \(persona\.visibility='public'[\s\S]*persona_publication_is_current/);
  assert.match(manifest, /'ineligible_public_personas',v_ineligible_public_persona_count/);
});

test("AAL2 review and publication are separate exact-current transitions", () => {
  const submit = functionBody("submit_business_for_review");
  const publish = functionBody("publish_business_page");
  const unpublish = functionBody("unpublish_business_page");
  for (const body of [submit, publish, unpublish]) assert.match(body, /perform public\.require_aal2\(\)/);
  assert.match(submit, /review_state=case when v_missing=0 then 'ready' else 'changes_requested' end/);
  assert.doesNotMatch(submit, /page_status='published'/);
  assert.match(publish, /review\.review_state='ready'/);
  assert.match(publish, /review\.reviewed_revision=v_revision/);
  assert.match(publish, /review\.readiness_snapshot->>'manifest_sha256'=v_snapshot->>'manifest_sha256'/);
  assert.match(publish, /set_config\('app\.business_publication_transition','publish',true\)/);
  assert.match(unpublish, /set_config\('app\.business_publication_transition','unpublish',true\)/);
  assert.match(migration, /A ready review never publishes automatically/i);
  assert.match(functionBody("business_publication_readiness"), /'review_manifest_current',v_review_manifest_current/);
  assert.match(functionBody("business_publication_readiness"), /'publication_current',v_publication_current/);
});

test("public business reads fail closed on exact drift and filter mission/member visibility", () => {
  const current = functionBody("business_publication_is_current");
  const publicPage = functionBody("business_page_by_slug");
  assert.match(current, /business\.published_revision=business\.publication_revision/);
  assert.match(current, /review\.review_state='published'/);
  assert.match(current, /review\.reviewed_revision=business\.publication_revision/);
  assert.match(current, /review\.readiness_snapshot->'review_manifest'=current_review\.manifest/);
  assert.match(current, /manifest_sha256'[\s\S]*extensions\.digest/);
  assert.match(publicPage, /public\.business_publication_is_current\(business\.id\)/);
  assert.match(publicPage, /item\.enabled and item\.visibility='public'/);
  assert.match(publicPage, /membership\.enabled and membership\.membership_visibility='public'/);
  assert.match(publicPage, /persona\.visibility='public'/);
  assert.match(publicPage, /public\.persona_publication_is_current\(persona\.id\)/);
  assert.match(publicPage, /public\.persona_visible\(persona\.id\)/);
  assert.match(publicPage, /case when membership\.title_visibility='public'/);
});

test("owner UI exposes review, explicit publish/unpublish, public mission visibility, and no auto-publish copy", async () => {
  const source = await read("MyPersonas.Online_v0/platform-governance.js");
  const html = await read("MyPersonas.Online_v0/index.html");
  assert.match(source, /business_publication_reviews/);
  assert.match(source, /business_publication_readiness/);
  assert.match(source, /save_business_review_draft/);
  assert.match(source, /submit_business_for_review/);
  assert.match(source, /publish_business_page/);
  assert.match(source, /unpublish_business_page/);
  assert.match(source, /A ready review never publishes automatically/);
  assert.match(source, /Copy public-intended AI review packet/);
  assert.match(source, /review_manifest_current===true/);
  assert.match(source, /publication_current===true/);
  assert.match(source, /Published record · public gate offline/);
  assert.match(source, /id="govMissionVisibility"[\s\S]*value="public"/);
  assert.match(source, /Business roles and titles never grant permissions/);
  assert.match(html, /\["business_publication_reviews","\*","created_at"\]/);
  assert.match(html, /add\("Business Publication Review",g\.business_publication_reviews\)/);
  assert.match(html, /business publication review evidence is export-only/);
});

test("external browser-AI packet omits nonpublic rows, UUIDs, asset URLs, and private notes", async () => {
  const source = await read("MyPersonas.Online_v0/platform-governance.js");
  const packetFunction = source.match(/function governanceBusinessExternalReviewPacket\([\s\S]*?\nfunction governanceCopyBusinessReview/)?.[0]
    .replace(/\nfunction governanceCopyBusinessReview$/, "") || "";
  assert.ok(packetFunction, "business external-review packet function");
  const context = vm.createContext({
    governanceState: {
      businessReviewBusinessId: "business-a",
      businessReviewReadiness: { review_manifest: {
        profile: { slug: "public-slug", display_name: "Public name", short_bio: "Public bio", mission: "Public mission" },
        mission_items: [
          { title: "PUBLIC PIECE", body: "PUBLIC BODY", enabled: true, visibility: "public" },
          { title: "PRIVATE PIECE", body: "PRIVATE BODY", enabled: true, visibility: "owner_only" },
        ],
        persona_memberships: [
          { enabled: true, membership_visibility: "public", title_visibility: "public", public_title: "PUBLIC TITLE", persona_id: "11111111-1111-4111-8111-111111111111", persona_card: { handle: "public.handle", name: "Public Persona", avatar_url: "https://secret-path.test/owner-uuid.png", public_eligible: true } },
          { enabled: true, membership_visibility: "owner_only", title_visibility: "owner_only", public_title: "PRIVATE TITLE", persona_id: "22222222-2222-4222-8222-222222222222", persona_card: { handle: "private.handle", name: "Private Persona", avatar_url: "https://private.test/asset.png", public_eligible: true } },
        ],
      } },
    },
    document: { getElementById: () => ({ value: "Owner-entered intention" }) },
    result: "",
  });
  new vm.Script(`${packetFunction};result=governanceBusinessExternalReviewPacket("business-a")`).runInContext(context);
  assert.match(context.result, /PUBLIC PIECE|PUBLIC TITLE|public\.handle|Owner-entered intention/);
  assert.doesNotMatch(context.result, /PRIVATE PIECE|PRIVATE BODY|PRIVATE TITLE|private\.handle/);
  assert.doesNotMatch(context.result, /11111111|22222222|https:\/\//);
});

test("programmer handoff documents local-only release and security boundaries", async () => {
  const doc = await read("MyPersonas.Online_v0/BUSINESS-PUBLICATION-WORKFLOW.md");
  assert.match(doc, /Implemented and tested locally/i);
  assert.match(doc, /not pushed, applied to the linked database,[\s\S]*deployed,[\s\S]*or verified live/i);
  assert.match(doc, /No production SQL, deployment, role grant, provider action, or public page change is performed[\s\S]*by the repository source alone/i);
  assert.match(doc, /A ready review is evidence, not publication/);
  assert.match(doc, /at most 100 businesses[\s\S]*100 mission[\s\S]*200 persona memberships[\s\S]*250,000-byte/);
  assert.match(doc, /grants no account, staff, provider, database, or authentication authority/);
});
