import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const migrationPath = "MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql";
const mirrorPath = "supabase/migrations/20260822170000_publication_social_security_governance.sql";

test("governance migration and timestamped mirror remain identical", async () => {
  const [migration, mirror] = await Promise.all([read(migrationPath), read(mirrorPath)]);
  assert.equal(mirror, migration);
  assert.match(migration, /^-- 051-publication-social-security-governance\.sql/);
  assert.match(migration, /begin;[\s\S]*commit;/i);
});

test("publication is explicit, reviewed, disclosure-bearing, and edits return live pages to draft", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /publication_state in \('draft','in_review','published','unpublished'\)/);
  assert.match(sql, /update public\.personas[\s\S]*set publication_state = 'unpublished'[\s\S]*published_revision = null[\s\S]*where publication_state is null/);
  assert.match(sql, /alter column publication_state set default 'draft'/);
  assert.match(sql, /create table if not exists public\.persona_publication_reviews/);
  assert.match(sql, /create or replace function public\.persona_publication_readiness/);
  assert.match(sql, /'ai_disclosure','label','Transparent AI disclosure'/);
  assert.match(sql, /'intention','label','Page intention'/);
  assert.match(sql, /create or replace function public\.submit_persona_for_review/);
  assert.match(sql, /create or replace function public\.publish_persona_page/);
  const submitReview = sql.match(/create or replace function public\.submit_persona_for_review[\s\S]*?\n\$\$;/)?.[0] || "";
  const publishPage = sql.match(/create or replace function public\.publish_persona_page[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(submitReview, /perform public\.require_aal2\(\)/);
  assert.match(publishPage, /perform public\.require_aal2\(\)/);
  assert.match(sql, /review\.reviewed_revision = v_revision/);
  assert.match(sql, /Complete the page review for the current revision before publishing/);
  assert.match(sql, /Publication lifecycle fields can only be changed through reviewed publication actions/);
  assert.match(sql, /if tg_op = 'INSERT' then[\s\S]*new\.publication_state := 'draft';[\s\S]*new\.publication_revision := 1;[\s\S]*new\.published_revision := null;/);
  assert.match(sql, /create trigger mark_persona_public_edit_as_draft\s+before insert or update on public\.personas/);
  assert.match(sql, /Persona identity, owner, and creation time are immutable/);
  assert.match(sql, /if old\.publication_state in \('published','in_review'\) then[\s\S]*new\.publication_state := 'draft'/);
  assert.match(sql, /set_config\('app\.persona_publication_transition','publish',true\)/);
  assert.match(sql, /'published_revision',v_revision/);
  assert.match(sql, /update public\.persona_publication_reviews[\s\S]*review_state = 'stale'/);
  assert.match(sql, /create trigger mark_persona_layout_edit_as_draft[\s\S]*after insert or update or delete on public\.persona_page_layouts/);
  assert.match(sql, /create or replace function public\.mark_persona_content_edit_as_draft/);
  assert.match(sql, /after insert or update or delete on public\.(?:posts|persona_links|albums|album_items)/);
  assert.match(sql, /tg_table_name = 'persona_family_relationships'[\s\S]*new\.from_persona_id,new\.to_persona_id,[\s\S]*old\.from_persona_id,old\.to_persona_id/);
  assert.match(sql, /create trigger mark_persona_family_edit_as_draft[\s\S]*after insert or update or delete on public\.persona_family_relationships/);
  assert.match(sql, /array_agg\(distinct persona_id\)/);
  assert.match(sql, /new\.visibility<>'public'/);
  assert.match(sql, /row\(old\.relationship_type,old\.from_persona_id,old\.to_persona_id\)/);
  assert.match(sql, /publication_revision = publication_revision \+ 1/);
  assert.match(sql, /create trigger aa_preserve_persona_links_during_noop_bundle[\s\S]*before insert or delete on public\.persona_links/);
  assert.match(sql, /app\.persona_bundle_preserve_links[\s\S]*v_persona_id::text/);
  assert.match(sql, /except all[\s\S]*except all/);
  assert.match(sql, /v_prior_suppress text:=coalesce\(current_setting\('app\.persona_bundle_suppress_content'/);
  assert.match(sql, /set_config\('app\.persona_bundle_suppress_content',v_prior_suppress,true\)/);
  assert.match(sql, /create policy "personas visible read" on public\.personas for select\s+using \(\s+owner=auth\.uid\(\)\s+or public\.persona_visible\(id\)\s+\);/);
  assert.match(sql, /create function public\.discover_personas[\s\S]*public\.persona_visible\(persona\.id\)/);
  assert.match(sql, /ensure_fan_chat_session_legacy_046/);
  assert.match(sql, /reserve_fan_chat_message_legacy_046/);
  assert.match(sql, /persona\.publication_state = 'published'/);
  assert.match(sql, /create or replace function public\.persona_family_by_handle[\s\S]*relative\.publication_state='published'/);
  assert.match(sql, /create or replace function public\.persona_family_by_handle[\s\S]*public\.persona_visible\(p\.id\)[\s\S]*public\.persona_visible\(relative\.id\)/);
  assert.match(sql, /create or replace function public\.business_page_by_slug[\s\S]*persona\.publication_state='published'/);
  assert.match(sql, /create or replace function public\.business_page_by_slug[\s\S]*public\.persona_visible\(persona\.id\)/);
  assert.match(sql, /update public\.businesses\s+set page_status='draft',visibility='owner_only',published_at=null/);
  assert.match(sql, /revoke all on function public\.save_business_profile\(uuid,text,text,text,text,text,text\)\s+from public, anon, authenticated/);
  assert.match(sql, /create or replace function public\.save_business_draft/);
  assert.match(sql, /create or replace function public\.set_business_persona_membership_draft/);
  assert.match(sql, /create or replace function public\.save_business_mission_item_draft/);
});

test("exact review manifest is bounded, lifecycle-stable, dependency-aware, and fan-config-bound", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /create or replace function public\.persona_publication_review_manifest/);
  assert.match(sql, /create or replace function public\.persona_public_urls_safe/);
  assert.match(sql, /persona_public_urls_safe[\s\S]*persona_links[\s\S]*posts[\s\S]*album_items[\s\S]*persona_page_layouts[\s\S]*persona_affiliate_offers/);
  assert.match(sql, /v_invalid_public_url:=not public\.persona_public_urls_safe/);
  assert.match(sql, /'target_publication_state','published'/);
  assert.doesNotMatch(sql, /'publication_state',v_persona\.publication_state,'complete'/);
  assert.match(sql, /v_payload_bytes>400000/);
  assert.match(sql, /octet_length\(v_result::text\)>500000/);
  assert.match(sql, /v_within_counts := v_link_count<=v_link_limit[\s\S]*v_offer_count<=v_offer_limit/);
  assert.match(sql, /if not v_oversized and v_within_counts then[\s\S]*into v_assets/);
  assert.match(sql, /order by offer\.priority desc,offer\.id limit v_offer_limit\) reviewed/);
  assert.match(sql, /order by candidate\.id limit v_family_limit\) relationship/);
  assert.match(sql, /'review_manifest',v_manifest/);
  assert.match(sql, /review\.readiness_snapshot->>'manifest_sha256' = v_snapshot->>'manifest_sha256'/);
  assert.match(sql, /create table if not exists public\.persona_publication_dependency_sets/);
  assert.match(sql, /create table if not exists public\.persona_publication_dependencies/);
  assert.match(sql, /create or replace function public\.persona_dependency_projection_hash/);
  assert.match(sql, /create or replace function public\.persona_publication_is_current/);
  assert.match(sql, /create or replace function public\.lock_persona_publication_mutation/);
  assert.doesNotMatch(sql, /create trigger serialize_persona_publication_updates/);
  assert.doesNotMatch(sql, /create or replace function public\.invalidate_persona_public_dependents/);
  assert.match(sql, /personas_top8_gin_idx/);
  assert.match(sql, /personas_linked_gin_idx/);
  assert.match(sql, /dependency_kind in \('top8','linked','family'\)/);
  assert.match(sql, /projection_sha256[\s\S]*dependency_revision/);
  assert.match(sql, /public\.persona_dependency_projection_hash\([\s\S]*dependency\.dependency_kind/);
  assert.match(sql, /'avatar_url',left\(coalesce\(avatar_url,''\),2048\)/);
  assert.match(sql, /create trigger invalidate_personas_after_backend_change/);
  assert.match(sql, /create trigger invalidate_persona_after_fan_binding_change/);
  assert.match(sql, /create trigger invalidate_persona_after_fan_binding_change[\s\S]*after insert or update or delete[\s\S]*on public\.agent_bindings/);
  assert.match(sql, /v_persona_id uuid:=case when tg_op='DELETE' then old\.persona_id else new\.persona_id end/);
  assert.match(sql, /backend\.provider,backend\.base_url,[\s\S]*backend\.model/);
  assert.match(sql, /binding\.fan_chat_enabled::text,binding\.fan_daily_message_limit::text/);
  assert.match(sql, /'revenue',v_revenue/);
  assert.match(sql, /'secure_request_intake_configured'/);
  assert.match(sql, /persona_publication_is_current[\s\S]*public\.persona_public_urls_safe\(persona\.id\)/);
  assert.match(sql, /'key','avatar'[\s\S]*is_safe_credential_free_https_url\(v_persona\.avatar_url,false\)/);
  assert.match(sql, /create or replace function public\.persona_modules_are_canonical/);
  assert.match(sql, /create or replace function public\.canonical_persona_modules/);
  assert.match(sql, /Persona modules must contain only known boolean module keys/);
  assert.match(sql, /v_invalid_modules:=not public\.persona_modules_are_canonical\(v_persona\.modules\)/);
  assert.match(sql, /'modules',public\.canonical_persona_modules\(v_persona\.modules\)/);
  assert.match(sql, /persona_publication_is_current[\s\S]*persona_modules_are_canonical\(persona\.modules\)/);
  assert.match(sql, /create function public\.discover_personas[\s\S]*canonical_persona_modules\(persona\.modules\)/);
  assert.match(sql, /create function public\.persona_by_handle[\s\S]*canonical_persona_modules\(persona\.modules\)/);
});

test("fan-chat completion and binding mutations share a deadlock-safe lock order", async () => {
  const [sql, html, deleteAccount] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/index.html"),
    read("supabase/functions/delete-account/index.ts"),
  ]);
  const completion = sql.match(/create or replace function public\.complete_fan_chat_reply\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(completion, /lock_persona_publication_mutation\(v_session\.persona_id\)/);
  assert.match(completion, /agent_owner_settings[\s\S]*for share/);
  assert.match(completion, /agent_bindings[\s\S]*for share/);
  assert.match(completion, /from public\.personas persona[\s\S]*for share/);
  for (const reason of [
    "lease_expired",
    "owner_settings_unavailable",
    "automation_paused",
    "binding_unavailable",
    "binding_inactive",
    "claim_inactive",
    "fan_chat_disabled",
    "persona_unavailable",
    "persona_not_public",
    "persona_ineligible",
    "publication_closed",
  ]) {
    assert.match(completion, new RegExp(`'${reason}'`));
  }
  assert.match(completion, /cardinality\(coalesce\(p_categories,array\[\]::text\[\]\)\) > 8/);
  assert.match(completion, /response_pending=false,[\s\S]*response_lease_token=null/);
  assert.match(completion, /fan_chat\.response_suppressed/);
  assert.match(completion, /complete_fan_chat_reply_legacy_011/);
  const ownerBinding = sql.match(/create or replace function public\.save_my_agent_binding_controls[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(ownerBinding, /perform public\.require_aal2\(\)/);
  assert.match(ownerBinding, /lock_persona_publication_mutation\(p_persona_id\)[\s\S]*agent_bindings[\s\S]*for update/);
  const serviceBinding = sql.match(/create or replace function public\.save_agent_binding_controls_service[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(serviceBinding, /Service role required/);
  assert.match(serviceBinding, /lock_persona_publication_mutation\(p_persona_id\)[\s\S]*agent_bindings[\s\S]*for update/);
  assert.match(sql, /revoke update\(status,autonomy_level,fan_chat_enabled,fan_daily_message_limit\)[\s\S]*on public\.agent_bindings from authenticated/);
  assert.match(sql, /revoke update,delete on public\.agent_bindings from service_role/);
  assert.doesNotMatch(html, /from\("agent_bindings"\)\.update/);
  assert.match(html, /rpc\("save_my_agent_binding_controls"/);
  assert.match(deleteAccount, /rpc\("delete_agent_bindings_for_account_service"/);
});

test("revenue rails are AAL2-edited, exact-review-bound, and public-gated", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /create or replace function public\.mark_persona_revenue_edit_as_draft/);
  assert.match(sql, /after insert or update or delete on public\.persona_revenue_settings/);
  assert.match(sql, /after insert or update or delete on public\.persona_affiliate_offers/);
  assert.match(sql, /after insert or update or delete on public\.affiliate_products/);
  assert.match(sql, /after insert or update or delete on public\.product_review_settings/);
  for (const signature of [
    "save_persona_revenue_settings",
    "save_affiliate_product",
    "delete_affiliate_product",
    "save_persona_affiliate_offer",
    "delete_persona_affiliate_offer",
  ]) {
    const fn = sql.match(new RegExp(`create or replace function public\\.${signature}[\\s\\S]*?\\n\\$\\$;`))?.[0] || "";
    assert.match(fn, /perform public\.require_aal2\(\)/, `${signature} must require AAL2`);
    assert.match(fn, /lock_persona_publication_mutation/, `${signature} must share the persona publication lock`);
  }
  const savePartner = sql.match(/create or replace function public\.save_affiliate_partner[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(savePartner, /perform public\.require_aal2\(\)/);
  assert.match(savePartner, /lock_owner_content_creation_quota\(v_owner\)/);
  assert.match(savePartner, /v_total>=100/);
  assert.match(savePartner, /v_day_total>=10/);
  assert.match(savePartner, /is_safe_credential_free_https_url/);
  assert.match(savePartner, /account_ledger_text_has_secret/);
  const deletePartner = sql.match(/create or replace function public\.delete_affiliate_partner[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(deletePartner, /perform public\.require_aal2\(\)/);
  assert.ok(deletePartner.indexOf("lock_owner_content_creation_quota") < deletePartner.indexOf("lock_persona_publication_mutation"));
  const eraseRevenue = sql.match(/create or replace function public\.delete_revenue_review_data_for_account_service[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(eraseRevenue, /Service role required/);
  assert.match(eraseRevenue, /hashtextextended\(p_owner::text,51051056\)/);
  assert.match(eraseRevenue, /order by persona\.id[\s\S]*lock_persona_publication_mutation/);
  for (const table of [
    "product_review_notifications", "product_review_events",
    "product_review_requests", "product_review_settings",
    "persona_review_requests", "affiliate_click_events",
    "persona_affiliate_offers", "affiliate_products",
    "affiliate_partners", "persona_revenue_settings",
  ]) assert.match(eraseRevenue, new RegExp(`delete from public\\.${table}`));
  assert.match(sql, /revoke insert,update,delete on public\.persona_revenue_settings,[\s\S]*public\.affiliate_partners,public\.affiliate_products,[\s\S]*public\.persona_affiliate_offers,public\.affiliate_click_events,[\s\S]*public\.persona_review_requests from authenticated/);
  assert.match(sql, /revoke insert,update on public\.affiliate_partners from service_role/);
  assert.match(sql, /revoke insert,update,delete on public\.persona_revenue_settings,[\s\S]*public\.product_review_notifications from service_role/);
  const publicRevenue = sql.match(/create or replace function public\.get_public_persona_revenue_rails[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(publicRevenue, /public\.persona_publication_is_current/);
  assert.match(publicRevenue, /p\.visibility='public'/);
  assert.match(publicRevenue, /is_safe_credential_free_https_url\(product\.affiliate_url,false\)/);
  assert.match(sql, /create table if not exists public\.affiliate_click_rate_limits/);
  assert.match(sql, /scope text not null check \(scope in \('global_day','offer_hour','fingerprint_offer_day'\)\)/);
  const redirect = sql.match(/create or replace function public\.resolve_affiliate_redirect_service[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(redirect, /public\.persona_publication_is_current/);
  assert.match(redirect, /v_global_hits>5000/);
  assert.match(redirect, /v_offer_hits>500/);
  assert.match(redirect, /v_fingerprint_hits>1/);
  assert.match(sql, /create trigger bound_product_review_rate_event[\s\S]*before insert on public\.product_review_events/);
  assert.match(sql, /revoke all on function public\.get_public_affiliate_destination\(uuid\),[\s\S]*public\.record_affiliate_click[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql, /grant execute on function public\.resolve_affiliate_redirect_service[\s\S]*to service_role/);
  assert.match(sql, /revoke all on function public\.create_review_request\(text,text,text,text,text,text\)[\s\S]*from public,anon,authenticated,service_role/);
});

test("legacy affiliate review owner RPCs are explicit and NULL-safe", async () => {
  const [sql, legacy] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/sql-updates/041-affiliate-request-review-rails.sql"),
  ]);
  const link = sql.match(/create or replace function public\.link_review_request_to_draft[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(link, /from public\.persona_review_requests request[\s\S]*where request\.id=p_request_id[\s\S]*for update/);
  assert.match(link, /if auth\.uid\(\) is null or v_owner is distinct from auth\.uid\(\) then[\s\S]*sqlstate '42501'/);
  assert.match(link, /from public\.post_drafts draft[\s\S]*where draft\.id=p_draft_id[\s\S]*for update/);
  assert.match(link, /v_draft_owner is distinct from v_owner/);
  assert.ok(link.indexOf("persona_review_requests request") < link.indexOf("post_drafts draft"));

  const acl = /revoke all on function public\.owner_review_request_queue\(\),[\s\S]*public\.link_review_request_to_draft\(uuid,uuid\),[\s\S]*public\.update_review_request_status\(uuid,text\),[\s\S]*public\.get_affiliate_analytics\(\)[\s\S]*from public,anon,authenticated,service_role;[\s\S]*grant execute on function public\.owner_review_request_queue\(\),[\s\S]*public\.link_review_request_to_draft\(uuid,uuid\),[\s\S]*public\.update_review_request_status\(uuid,text\),[\s\S]*public\.get_affiliate_analytics\(\)[\s\S]*to authenticated;/;
  assert.match(sql, acl);
  assert.match(sql, /grant execute on function public\.get_public_persona_revenue_rails\(text\) to anon,authenticated/);
  assert.match(sql, /revoke all on function public\.create_review_request\(text,text,text,text,text,text\)[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql, /revoke all on function public\.get_public_affiliate_destination[\s\S]*public\.record_affiliate_click[\s\S]*from public,anon,authenticated,service_role/);

  const legacyOwnerFunctions = [
    "owner_review_request_queue", "link_review_request_to_draft",
    "update_review_request_status", "get_affiliate_analytics",
  ];
  for (const name of legacyOwnerFunctions) {
    assert.match(legacy, new RegExp(`grant execute on function public\\.${name}\\(`));
  }
  assert.deepEqual(
    [...legacy.matchAll(/<>\s*auth\.uid\(\)/g)].map(match => match[0]),
    ["<> auth.uid()"],
    "the complete 041 owner-RPC family has one legacy NULL-comparison shape, replaced by 051",
  );
});

test("owner-authored creation RPCs serialize bounded insert quotas without blocking edits or deletes", async () => {
  const [sql, layoutSql] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/sql-updates/050-persona-page-layout-builder.sql"),
  ]);
  const extract = (name) => sql.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
  ))?.[0] || "";

  const ownerLock = extract("lock_owner_content_creation_quota");
  assert.match(ownerLock, /hashtextextended\(p_owner::text,51051056\)/);
  assert.match(ownerLock, /p_owner is distinct from auth\.uid\(\)/);
  assert.match(sql, /revoke all on function public\.lock_owner_content_creation_quota\(uuid\)[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql, /revoke insert,update,delete on public\.personas from authenticated/);
  for (const index of [
    "personas_owner_created_quota_idx",
    "albums_persona_created_quota_idx",
    "album_items_album_created_quota_idx",
    "affiliate_products_owner_created_quota_idx",
    "persona_affiliate_offers_owner_created_quota_idx",
    "persona_page_code_snippets_owner_created_quota_idx",
  ]) assert.match(sql, new RegExp(`create index if not exists ${index}`));

  const cases = [
    ["save_persona_post", "p_post_id", /v_owner_total>=5000/, /v_owner_day>=200/, /v_persona_total>=500/, /update public\.posts/],
    ["save_persona_album", "p_album_id", /v_owner_total>=1000/, /v_owner_day>=50/, /v_persona_total>=100/, /update public\.albums/],
    ["save_persona_album_item", "p_item_id", /v_owner_total>=10000/, /v_owner_day>=500/, /v_persona_total>=1000/, /update public\.album_items/],
    ["save_affiliate_product", "p_product_id", /v_owner_total>=500/, /v_owner_day>=20/, null, /update public\.affiliate_products/],
    ["save_persona_affiliate_offer", "p_offer_id", /v_owner_total>=2000/, /v_owner_day>=100/, /v_persona_total>=100/, /update public\.persona_affiliate_offers/],
  ];
  for (const [name, idParam, total, daily, persona, update] of cases) {
    const fn = extract(name);
    if (name === "save_affiliate_product") {
      assert.match(fn, /perform public\.lock_owner_content_creation_quota\(v_owner\)/, `${name} must serialize product-to-partner identity changes`);
    } else {
      assert.match(fn, new RegExp(`if ${idParam} is null then\\s+perform public\\.lock_owner_content_creation_quota`), `${name} must lock only its insert path`);
    }
    assert.match(fn, total, `${name} must cap owner aggregate inserts`);
    assert.match(fn, daily, `${name} must cap owner daily inserts`);
    assert.match(fn, /created_at>=v_day[\s\S]*created_at<v_day\+interval '1 day'/, `${name} must use a bounded UTC-day window`);
    if (persona) assert.match(fn, persona, `${name} must cap per-persona inserts`);
    assert.match(fn, update, `${name} must preserve existing-row updates`);
    const ownerLockAt = fn.indexOf("lock_owner_content_creation_quota");
    const personaLockAt = fn.indexOf("lock_persona_publication_mutation");
    assert.ok(ownerLockAt >= 0 && (personaLockAt < 0 || ownerLockAt < personaLockAt), `${name} must acquire the owner lock before persona locks`);
  }

  const bundle = extract("save_persona_bundle");
  assert.match(bundle, /Links must be an array of at most 100 items/);
  assert.match(bundle, /Linked personas must be an array of at most 100 items/);
  assert.match(bundle, /if p_persona_id is null then[\s\S]*lock_owner_content_creation_quota\(v_uid\)[\s\S]*v_owner_total>=100[\s\S]*v_owner_day>=20/);
  assert.match(bundle, /persona\.created_at>=v_day[\s\S]*persona\.created_at<v_day\+interval '1 day'/);
  assert.ok(bundle.indexOf("lock_owner_content_creation_quota") < bundle.indexOf("lock_persona_publication_mutation"));
  assert.match(bundle, /save_persona_bundle_legacy_014\(p_persona_id,p_persona,p_links,p_note\)/);

  const snippets = extract("save_persona_page_code_snippet");
  assert.match(snippets, /perform public\.lock_owner_content_creation_quota\(v_owner\)/);
  assert.match(snippets, /v_owner_total>=100/);
  assert.match(snippets, /v_owner_day>=20/);
  assert.match(snippets, /snippet\.created_at>=v_day[\s\S]*snippet\.created_at<v_day\+interval '1 day'/);
  assert.match(snippets, /v_stored_bytes-v_old_bytes\+v_new_bytes>1000000 and v_new_bytes>v_old_bytes/);
  assert.match(snippets, /if v_is_new then[\s\S]*insert into public\.persona_page_code_snippets[\s\S]*else[\s\S]*update public\.persona_page_code_snippets/);
  assert.match(layoutSql, /create or replace function public\.delete_persona_page_code_snippet[\s\S]*delete from public\.persona_page_code_snippets/);
  assert.match(sql, /revoke insert,update,delete on public\.persona_page_layouts,[\s\S]*public\.persona_page_code_snippets from service_role/);
  const pageBuilderErase = extract("delete_persona_page_builder_data_for_account_service");
  assert.match(pageBuilderErase, /auth\.role\(\)[\s\S]*<>'service_role'/);
  assert.match(pageBuilderErase, /hashtextextended\(p_owner::text,51051056\)/);
  assert.ok(pageBuilderErase.indexOf("hashtextextended") < pageBuilderErase.indexOf("lock_persona_publication_mutation"));
  assert.match(pageBuilderErase, /order by layout\.persona_id/);
  assert.match(pageBuilderErase, /delete from public\.persona_page_code_snippets[\s\S]*delete from public\.persona_page_layouts/);

  for (const name of [
    "delete_persona_post",
    "delete_persona_album",
    "delete_persona_album_item",
    "delete_affiliate_product",
    "delete_persona_affiliate_offer",
    "delete_owned_persona",
  ]) {
    const fn = extract(name);
    assert.match(fn, /delete from public\./, `${name} must remain available`);
    assert.doesNotMatch(fn, /lock_owner_content_creation_quota|limit reached/, `${name} must not be quota-blocked`);
  }
});

test("owner-private family and project mutations are serialized, bounded, and deletable", async () => {
  const [sql, index, deleteAccount] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/index.html"),
    read("supabase/functions/delete-account/index.ts"),
  ]);
  const extract = (name) => sql.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
  ))?.[0] || "";

  const ownerLock = extract("lock_owner_persona_org_creation_quota");
  assert.match(ownerLock, /hashtextextended\(p_owner::text,51051058\)/);
  assert.match(ownerLock, /p_owner is distinct from auth\.uid\(\)/);
  assert.match(sql, /revoke all on function public\.lock_owner_persona_org_creation_quota\(uuid\)[\s\S]*from public,anon,authenticated,service_role/);
  const resourceSecret = extract("project_resource_text_has_secret");
  assert.match(resourceSecret, /password\|passcode\|api\[ _-\]\?key/);
  assert.match(resourceSecret, /PRIVATE KEY/);
  assert.ok(resourceSecret.includes("*://[^/?#[:space:]]+@"));
  assert.match(sql, /revoke all on function public\.project_resource_text_has_secret\(text\)[\s\S]*from public,anon,authenticated,service_role/);
  for (const name of [
    "persona_family_owner_created_quota_idx",
    "persona_projects_owner_created_quota_idx",
    "persona_project_memberships_owner_created_quota_idx",
    "persona_project_memberships_project_count_idx",
    "project_resources_owner_created_quota_idx",
    "project_resources_project_count_idx",
  ]) assert.match(sql, new RegExp(`create index if not exists ${name}`));

  assert.match(sql, /revoke insert,update,delete on public\.persona_family_relationships,[\s\S]*public\.project_resources from authenticated/);
  assert.match(sql, /revoke insert,update,delete on public\.persona_family_relationships,[\s\S]*public\.project_resources from service_role/);

  const backupService = extract("set_persona_backup_service");
  assert.match(sql, /revoke insert,update,delete on public\.persona_backup_relationships\s+from service_role/);
  assert.match(backupService, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(backupService, /from public\.profiles profile[\s\S]*for update/);
  assert.match(backupService, /delete from public\.persona_backup_relationships/);
  assert.match(backupService, /insert into public\.persona_backup_relationships/);
  assert.ok(
    backupService.indexOf("from public.profiles profile") <
      backupService.indexOf("insert into public.persona_backup_relationships"),
    "service backup writes must lock the owner before the relationship row",
  );
  assert.match(sql, /grant execute on function public\.set_persona_backup_service\(uuid,uuid,uuid\)\s+to service_role/);

  const family = extract("set_persona_family_relationship");
  assert.match(family, /perform public\.lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.match(family, /where relationship\.id=p_relationship_id and relationship\.owner=v_owner\s+for update/);
  assert.match(family, /v_owner_total>=1000/);
  assert.match(family, /v_owner_day>=100/);
  assert.match(family, /relationship\.created_at>=v_day[\s\S]*relationship\.created_at<v_day\+interval '1 day' limit 100/);
  assert.match(family, /v_from_total>=100/);
  assert.match(family, /v_to_total>=100/);
  assert.match(family, /relationship\.id is distinct from p_relationship_id/);
  assert.match(family, /select not exists\([\s\S]*relationship_type=p_relationship_type/);
  assert.match(family, /on conflict\(owner,relationship_type,from_persona_id,to_persona_id\)[\s\S]*do update/);
  assert.match(family, /else\s+update public\.persona_family_relationships/);
  assert.ok(
    family.indexOf("lock_owner_persona_org_creation_quota") <
      family.indexOf("for update") &&
      family.indexOf("for update") <
      family.indexOf("lock_persona_publication_mutation") &&
      family.indexOf("lock_persona_publication_mutation") <
      family.indexOf("select not exists("),
    "family saves must lock owner, existing row, and endpoints before capacity rechecks",
  );

  const familyBulk = extract("bulk_manage_persona_family_relationships");
  assert.match(familyBulk, /least\(greatest\(coalesce\(p_limit,100\),1\),100\)/);
  assert.match(familyBulk, /coalesce\(p_action,''\) not in \('delete','retire'\)/);
  assert.match(familyBulk, /order by relationship\.id limit v_limit/);
  assert.match(familyBulk, /order by endpoint\.id/);
  assert.match(familyBulk, /set canon_status='retired',visibility='owner_only'/);
  assert.match(familyBulk, /delete from public\.persona_family_relationships/);
  assert.match(familyBulk, /perform public\.lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.ok(
    familyBulk.indexOf("lock_persona_publication_mutation") <
      familyBulk.indexOf("set canon_status='retired'"),
    "bulk family mutations must lock affected personas first",
  );

  const project = extract("save_persona_project");
  assert.match(project, /if p_project_id is null then\s+perform public\.lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.match(project, /v_owner_total>=100/);
  assert.match(project, /v_owner_day>=20/);
  assert.match(project, /project\.created_at>=v_day[\s\S]*project\.created_at<v_day\+interval '1 day' limit 20/);
  assert.match(project, /else\s+update public\.persona_projects/);

  const membership = extract("set_persona_project_membership");
  assert.match(membership, /v_remove boolean:=coalesce\(p_remove,false\)/);
  assert.match(membership, /if not v_remove then\s+perform public\.lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.ok(
    membership.indexOf("lock_owner_persona_org_creation_quota") <
      membership.indexOf("from public.persona_projects project"),
    "membership upserts must take the owner lock before the project row",
  );
  assert.match(membership, /if v_remove then\s+delete from public\.persona_project_memberships/);
  assert.match(membership, /if v_is_new then[\s\S]*v_owner_total>=5000[\s\S]*v_owner_day>=200[\s\S]*v_project_total>=100/);
  assert.match(membership, /membership\.created_at>=v_day[\s\S]*membership\.created_at<v_day\+interval '1 day' limit 200/);
  assert.match(membership, /on conflict\(project_id,persona_id\) do update/);

  const resource = extract("save_project_resource");
  assert.match(resource, /if p_resource_id is null then\s+perform public\.lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.ok(
    resource.indexOf("lock_owner_persona_org_creation_quota") <
      resource.indexOf("from public.persona_projects project"),
    "new resources must take the owner lock before the project row",
  );
  assert.match(resource, /v_owner_total>=1000/);
  assert.match(resource, /v_owner_day>=50/);
  assert.match(resource, /v_project_total>=100/);
  assert.match(resource, /resource\.created_at>=v_day[\s\S]*resource\.created_at<v_day\+interval '1 day' limit 50/);
  assert.match(resource, /Project resources cannot move between projects; delete and recreate the resource/);
  assert.match(resource, /char_length\(v_locator\)>2048 or char_length\(v_notes\)>4000/);
  assert.match(resource, /project_resource_text_has_secret\(v_locator\)[\s\S]*project_resource_text_has_secret\(v_notes\)/);
  assert.match(resource, /is_safe_credential_free_https_url\(v_locator,false\)/);
  assert.match(resource, /position\('\?' in v_locator\)>0 or position\('#' in v_locator\)>0/);
  assert.match(resource, /v_locator!~'\^\[A-Za-z0-9\]\[A-Za-z0-9\._:\/-\]\*\$'/);
  assert.match(resource, /resource_locator=v_locator/);
  assert.match(resource, /owner_notes=v_notes/);
  assert.match(resource, /else\s+update public\.project_resources/);

  for (const [name, table] of [
    ["delete_persona_family_relationship", "persona_family_relationships"],
    ["delete_persona_project", "persona_projects"],
    ["delete_project_resource", "project_resources"],
  ]) {
    const fn = extract(name);
    assert.match(fn, new RegExp(`delete from public\\.${table}`));
    assert.doesNotMatch(fn, /limit reached/);
  }
  assert.match(extract("delete_persona_family_relationship"), /lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.match(sql, /grant execute on function public\.set_persona_family_relationship[\s\S]*public\.delete_project_resource\(uuid\)\s+to authenticated/);

  const serviceCleanup = extract("delete_persona_org_data_for_account_service");
  assert.match(serviceCleanup, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(serviceCleanup, /hashtextextended\(p_owner::text,51051058\)/);
  assert.match(serviceCleanup, /order by project\.id for update/);
  assert.match(serviceCleanup, /order by endpoint\.id/);
  assert.match(serviceCleanup, /delete from public\.project_resources[\s\S]*delete from public\.persona_projects[\s\S]*delete from public\.persona_family_relationships/);
  assert.ok(
    serviceCleanup.indexOf("hashtextextended(p_owner::text,51051058)") <
      serviceCleanup.indexOf("for update") &&
      serviceCleanup.indexOf("for update") <
      serviceCleanup.indexOf("lock_persona_publication_mutation") &&
      serviceCleanup.indexOf("lock_persona_publication_mutation") <
      serviceCleanup.indexOf("delete from public.project_resources"),
    "service erasure must take owner, project, and persona locks before organization deletes",
  );
  assert.match(sql, /grant execute on function public\.delete_persona_org_data_for_account_service\(uuid\)\s+to service_role/);
  assert.match(deleteAccount, /rpc\("delete_persona_org_data_for_account_service",\s*\{\s*p_owner:\s*uid/);
  assert.doesNotMatch(deleteAccount, /from\("(?:project_resources|persona_projects|persona_family_relationships)"\)\.delete/);

  // Restore continues to use the unchanged creation signatures and therefore
  // inherits the same quotas without receiving direct table mutation rights.
  assert.match(index, /restoreRpc\(context,"set_persona_family_relationship",\{p_relationship_id:null/);
  assert.match(index, /restoreRpc\(context,"save_persona_project",\{p_project_id:null/);
  assert.match(index, /restoreRpc\(context,"set_persona_project_membership",\{p_project_id:projectId/);
  assert.match(index, /restoreRpc\(context,"save_project_resource_v2",\{p_resource_id:null,p_expected_row_version:null/);
});

test("review-request owner inbox exposes bounded evidence and cannot publish content", async () => {
  const [sql, source, html] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/platform-governance.js"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  const evidence = sql.match(/create or replace function public\.my_product_review_notification_evidence[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(evidence, /notification\.owner=auth\.uid\(\)/);
  assert.match(evidence, /provider_message_id_hash is not null/);
  assert.doesNotMatch(evidence, /provider_message_id_hash\s*(?:,|from)/);
  assert.match(evidence, /p_before_updated_at timestamptz default null/);
  assert.match(evidence, /\(notification\.updated_at,notification\.request_id\)[\s\S]*< \(p_before_updated_at,p_before_request_id\)/);
  assert.match(evidence, /limit least\(greatest\(coalesce\(p_limit,500\),1\),500\)/);
  const status = sql.match(/create or replace function public\.update_product_review_request_status[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(status, /perform public\.require_aal2\(\)/);
  assert.match(status, /Invalid review request status transition/);
  assert.match(status, /when 'owner_approved' then array\['persona_draft','corrected_or_withdrawn'\]/);
  assert.doesNotMatch(status, /when 'owner_approved' then[^\n]*published/);
  const erase = sql.match(/create or replace function public\.erase_product_review_request_pii[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(erase, /perform public\.require_aal2\(\)/);
  assert.match(erase, /v_request\.requester_email is null[\s\S]*return true/);
  assert.match(erase, /requester_email=null,requester_name=null,reason=null/);
  assert.match(erase, /notification\.status in \('queued','claimed','failed'\)/);
  assert.match(erase, /'pii_erased','owner'/);
  assert.match(source, /function governanceReviewInboxCard/);
  assert.match(source, /A queued notification is not a sent email/);
  assert.match(source, /Marked sent; provider evidence missing/);
  assert.match(source, /delivery\.provider_message_recorded/);
  assert.match(source, /retention target[\s\S]*production purge schedule must be verified/);
  assert.match(source, /Owner-approved does not publish anything/);
  assert.match(source, /update_product_review_request_status/);
  assert.match(source, /erase_product_review_request_pii/);
  assert.match(html, /my_product_review_notification_evidence/);
  assert.match(html, /Review Notification Evidence/);
});

test("native feed drafts stage privately and reconcile only with exact page publication", async () => {
  const sql = await read(migrationPath);
  const publishPage = sql.match(/create or replace function public\.publish_persona_page[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(sql, /publish_native_agent_draft_legacy_012/);
  const legacyAcl = sql.match(/revoke all on function public\.publish_native_agent_draft_legacy_012[\s\S]*?;/)?.[0] || "";
  assert.match(legacyAcl, /service_role/);
  const blockedPublisher = sql.match(/create or replace function public\.publish_native_agent_draft\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(blockedPublisher, /Native automatic publication is paused/);
  assert.doesNotMatch(blockedPublisher, /insert into public\.posts/);
  const stage = sql.match(/create or replace function public\.stage_native_agent_draft_for_review[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(stage, /Exact owner approval is required/);
  assert.match(stage, /insert into public\.posts/);
  assert.match(stage, /perform public\.lock_owner_content_creation_quota\(v_uid\)/);
  assert.ok(
    stage.indexOf("lock_owner_content_creation_quota") <
      stage.indexOf("lock_persona_publication_mutation"),
    "native staging must acquire the owner quota lock before the persona lock",
  );
  assert.match(stage, /char_length\(coalesce\(v_draft\.title,''\)\)>1000/);
  assert.match(stage, /char_length\(coalesce\(v_draft\.body,''\)\)>30000/);
  assert.match(stage, /char_length\(coalesce\(v_draft\.tags,''\)\)>4000/);
  assert.match(stage, /char_length\(coalesce\(v_draft\.media_url,''\)\)>2048/);
  assert.match(stage, /is_safe_credential_free_https_url\(v_draft\.media_url,true\)/);
  assert.match(stage, /else\s+select count\(\*\) into v_owner_total[\s\S]*v_owner_total>=5000/);
  assert.match(stage, /post\.created_at>=v_day[\s\S]*post\.created_at<v_day\+interval '1 day' limit 200/);
  assert.match(stage, /v_persona_total>=500/);
  assert.match(stage, /publish_state='blocked'/);
  assert.match(stage, /'published',false/);
  assert.match(publishPage, /with finalized as \([\s\S]*set status='posted',publish_state='published'[\s\S]*where draft\.owner=v_owner[\s\S]*draft\.publish_state='blocked'[\s\S]*and v_dependency_gate_current/);
  assert.match(publishPage, /publish\.completed_after_page_review/);
  const reconcile = sql.match(/create or replace function public\.reconcile_staged_native_page_publications[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(reconcile, /public\.persona_publication_is_current\(v_persona_id\)/);
  assert.match(reconcile, /set status='posted',publish_state='published'/);
  assert.match(sql, /where account_id is null and publish_state='queued'/);
  assert.match(sql, /set mode='approval'/);
});

test("platform roles and queues cannot be self-granted or auto-submitted", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /platform_role_assignments/);
  assert.match(sql, /role_key in \('global_administrator','technician','security_auditor'\)/);
  assert.match(sql, /create policy "platform roles self read"/);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|all)[^;]*platform_role_assignments[^;]*authenticated/i);
  assert.match(sql, /create_feature_request_draft/);
  assert.match(sql, /submit_feature_request/);
  assert.match(sql, /where request\.id=p_request_id and request\.owner=v_owner and request\.status='draft'/);
  assert.match(sql, /Staff role required/);
  assert.match(sql, /perform public\.require_aal2\(\)/);
  assert.match(sql, /Assignee must be an active administrator or technician/);
  assert.match(sql, /when p_status='planned'[\s\S]*then 'planned'/);
  assert.match(sql, /status not in \('draft','withdrawn'\)/);
  const createFeature = sql.match(/create or replace function public\.create_feature_request_draft[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(createFeature, /hashtextextended\(v_owner::text,51051053\)/);
  assert.match(createFeature, /v_total>=500/);
  assert.match(createFeature, /v_created_day>=10/);
  assert.match(createFeature, /v_active>=50/);
  const submitFeature = sql.match(/create or replace function public\.submit_feature_request[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(submitFeature, /perform public\.require_aal2\(\)/);
  assert.match(submitFeature, /v_submitted_day>=5/);
  assert.match(submitFeature, /v_active_queue>=20/);
  assert.match(sql, /create or replace function public\.withdraw_feature_request/);
  assert.match(sql, /create or replace function public\.delete_feature_request/);
});

test("follow and friend use different tables and friend requests honor policy and proof", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /create table if not exists public\.persona_follows/);
  assert.match(sql, /create table if not exists public\.persona_friend_settings/);
  assert.match(sql, /request_mode in \('open','invite_proof','contact_proof','closed'\)/);
  assert.match(sql, /create table if not exists public\.persona_friend_invites/);
  assert.match(sql, /token_hash\s+text not null unique/);
  assert.match(sql, /extensions\.digest\(convert_to\(trim\(p_invite_token\),'UTF8'\),'sha256'\)/);
  assert.match(sql, /create or replace function public\.follow_persona/);
  assert.match(sql, /create index if not exists persona_follows_follower_created_quota_idx/);
  const follow = sql.match(/create or replace function public\.follow_persona\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(follow, /select relationship\.visibility into v_existing_visibility[\s\S]*for update/);
  assert.ok(follow.indexOf("if found then") < follow.indexOf("lock_persona_publication_mutation"), "existing follows must not lock the target publication path");
  assert.match(follow, /hashtextextended\(v_owner::text,51051060\)/);
  assert.match(follow, /v_owner_total>=5000/);
  assert.match(follow, /v_owner_day>=200/);
  assert.match(follow, /v_persona_total>=2000/);
  assert.match(follow, /relationship\.created_at>=v_day[\s\S]*relationship\.created_at<v_day\+interval '1 day'/);
  assert.match(follow, /on conflict \(follower_persona_id,target_persona_id\) do nothing/);
  assert.match(sql, /revoke insert,update on public\.persona_follows from service_role/);
  assert.match(sql, /create or replace function public\.request_persona_friendship/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /order by profile\.id[\s\S]*for update/);
  assert.match(sql, /target\.visibility='private'[\s\S]*'invite_proof','contact_proof'/);
  assert.match(sql, /returns jsonb[\s\S]*'contact_proof_unavailable'/);
  assert.match(sql, /'code','rate_limited'/);
  assert.match(sql, /'code','request_created'/);
  assert.doesNotMatch(sql, /outcome\) values\([^;]*'accepted'\)/);
  assert.match(sql, /revoke insert, update on public\.follows from authenticated/);
  assert.match(sql, /create policy "follows read"[\s\S]*public\.owns_persona\(follower\)/);
  assert.match(sql, /create policy "persona follows visible read"[\s\S]*public\.persona_visible\(follower\.id\)[\s\S]*public\.persona_visible\(target\.id\)/);
  assert.match(sql, /join public\.personas blocked_identity[\s\S]*blocked_identity\.owner=auth\.uid\(\)/);
  assert.match(sql, /follows_unordered_persona_pair_uidx/);
  const pairRemoval = sql.match(/create or replace function public\.remove_persona_friendship\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(pairRemoval, /delete from public\.follows relationship/);
  assert.doesNotMatch(pairRemoval, /persona_follows/);
  const visibilityRule = sql.match(/create or replace function public\.set_persona_visibility_rule[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(visibilityRule, /order by id/);
  assert.match(visibilityRule, /delete from public\.persona_follows/);
  assert.match(visibilityRule, /delete from public\.follows/);
  assert.match(sql, /revoke insert,update,delete on public\.blocks from authenticated/);
  assert.match(sql, /revoke all on function public\.remove_persona_social_relationships\(uuid\)[\s\S]*from public,anon,authenticated,service_role/);
  const respond = sql.match(/create or replace function public\.respond_persona_friendship[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(respond, /if p_accept and \([\s\S]*rule\.kind='block'/);
  assert.match(sql, /Friend request limit reached/);
  const issueInvite = sql.match(/create or replace function public\.issue_persona_friend_invite[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(issueInvite, /perform public\.require_aal2\(\)/);
  assert.match(issueInvite, /hashtextextended\(v_owner::text,51051054\)/);
  assert.match(issueInvite, /v_issued_day>=10/);
  assert.match(issueInvite, /v_active_owner>=50/);
  assert.match(issueInvite, /v_active_persona>=10/);
  assert.match(sql, /create or replace function public\.revoke_persona_friend_invites/);
});

test("comments and reactions require visible target and exact-current public actors", async () => {
  const [sql,index] = await Promise.all([read(migrationPath),read("MyPersonas.Online_v0/index.html")]);
  assert.match(sql, /create policy "comments read"[\s\S]*persona_visible\(persona_id\)[\s\S]*persona_visible\(post\.persona_id\)/);
  assert.match(sql, /create policy "reactions read"[\s\S]*persona_visible\(persona_id\)[\s\S]*persona_visible\(post\.persona_id\)/);
  assert.match(sql, /create or replace function public\.add_persona_comment/);
  assert.match(sql, /create or replace function public\.toggle_persona_reaction/);
  assert.match(sql, /actor\.visibility in \('public','unlisted'\)[\s\S]*persona_publication_is_current\(actor\.id\)/);
  assert.match(sql, /v_hour_count>=60/);
  assert.match(sql, /hashtextextended\(v_uid::text,51051052\)/);
  assert.match(sql, /revoke insert,update,delete on public\.comments,public\.reactions[\s\S]*from public,anon,authenticated/);
  assert.match(index, /function publicInteractionPersonas/);
  assert.match(index, /"persona_mode_toggle_reaction":"toggle_persona_reaction"/);
  assert.match(index, /"persona_mode_add_comment":"add_persona_comment"/);
  assert.match(index, /rpc\("persona_mode_delete_comment"/);
  assert.match(index, /rpc\("delete_persona_comment"/);
  assert.doesNotMatch(index, /from\("(?:comments|reactions)"\)\.(?:insert|update|delete|upsert)/);
});

test("reviewed relation cards still honor viewer blocks, mutes, and current visibility", async () => {
  const sql = await read(migrationPath);
  const cards = sql.match(/create or replace function public\.persona_relation_cards[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(cards, /card\.reviewed_dependency is not null[\s\S]*persona_publication_is_current\(card\.id\)[\s\S]*persona_visible\(card\.id\)/);
  assert.doesNotMatch(cards, /\) or card\.reviewed_dependency is not null\s+order by/);
});

test("sync preferences require an assigned persona and never claim a provider worker", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /create table if not exists public\.persona_account_sync_settings/);
  assert.match(sql, /publication_policy in \('draft_only','review_required','mirror_public'\)/);
  assert.match(sql, /from public\.account_persona_links link/);
  assert.match(sql, /This account is not assigned to that persona/);
  assert.match(sql, /create or replace function public\.remove_stale_persona_account_sync/);
  assert.match(sql, /after delete or update of ledger_id,persona_id on public\.account_persona_links/);
  assert.match(sql, /Owner preferences only\. A provider-specific import\/export worker/);
});

test("custom source remains inert and security state stores hashes instead of raw IPs", async () => {
  const sql = await read(migrationPath);
  assert.match(sql, /create table if not exists public\.persona_extension_submissions/);
  assert.match(sql, /Never execute source_code directly/);
  assert.match(sql, /source_type in \('component_json','html_css','typescript'\)/);
  assert.match(sql, /create table if not exists public\.platform_security_events/);
  assert.match(sql, /user_id\s+uuid primary key references auth\.users\(id\) on delete cascade/);
  assert.match(sql, /identifier_hash[\s\S]*\^\[0-9a-f\]\{64\}\$/);
  assert.match(sql, /create table if not exists public\.security_network_blocks/);
  assert.doesNotMatch(sql, /\bip_address\b|\braw_ip\b/i);
  assert.match(sql, /hook_password_verification_attempt/);
  assert.match(sql, /hook_mfa_verification_attempt/);
  assert.match(sql, /to supabase_auth_admin/);
  assert.match(sql, /create policy "account security auth hook"/);
  assert.match(sql, /create policy "security events auth hook insert"/);
  assert.match(sql, /create or replace function public\.staff_update_extension_submission/);
  const createExtension = sql.match(/create or replace function public\.create_extension_submission[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(createExtension, /hashtextextended\(v_owner::text,51051055\)/);
  assert.match(createExtension, /v_total>=100/);
  assert.match(createExtension, /v_created_day>=5/);
  assert.match(createExtension, /v_stored_bytes\+v_source_bytes>1000000/);
  const submitExtension = sql.match(/create or replace function public\.submit_extension_for_review[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(submitExtension, /perform public\.require_aal2\(\)/);
  assert.match(submitExtension, /v_submitted_day>=3/);
  assert.match(submitExtension, /v_active_queue>=10/);
  assert.match(sql, /create or replace function public\.withdraw_extension_submission/);
  assert.match(sql, /create or replace function public\.delete_extension_submission/);
  assert.match(sql, /create or replace function public\.my_friend_request_security_events/);
  assert.match(sql, /create or replace function public\.my_platform_security_events/);
  assert.match(sql, /subject_account_id uuid references auth\.users\(id\) on delete cascade/);
  assert.match(sql, /create or replace function public\.purge_governance_security_retention/);
  assert.match(sql, /created_at < now\(\) - interval '90 days'/);
  assert.match(sql, /created_at < now\(\) - interval '400 days'/);
  assert.match(sql, /delete from public\.product_review_requests[\s\S]*retention_expires_at<=now\(\)/);
  assert.match(sql, /delete from public\.platform_feature_requests[\s\S]*status='draft'[\s\S]*90 days/);
  assert.match(sql, /delete from public\.persona_extension_submissions[\s\S]*status in \('draft','withdrawn'\)[\s\S]*90 days/);
  assert.match(sql, /grant execute on function public\.purge_governance_security_retention\(\) to service_role/);
  assert.doesNotMatch(sql, /grant execute on function public\.purge_governance_security_retention\(\)[^;]*authenticated/i);
  assert.doesNotMatch(sql, /grant execute on function public\.hook_(?:password|mfa)_verification_attempt[^;]*authenticated/i);
  assert.match(sql, /drop policy if exists "error logs insert"/);
  assert.match(sql, /revoke insert,update,delete on public\.error_logs from public,anon,authenticated/);
  const telemetry = sql.match(/create or replace function public\.report_client_error[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(telemetry, /if v_uid is null then raise exception 'Authentication required'/);
  assert.match(telemetry, /v_count>=30/);
  assert.match(telemetry, /'error',now\(\)/);
  assert.doesNotMatch(telemetry, /p_severity|p_created_at|p_user_id/);
  assert.match(sql, /create or replace function public\.redact_client_error_text/);
});

test("owner governance UI parses and keeps browser AI handoff and submission confirmation explicit", async () => {
  const [source, css, workflow, index] = await Promise.all([
    read("MyPersonas.Online_v0/platform-governance.js"),
    read("MyPersonas.Online_v0/platform-governance.css"),
    read(".github/workflows/pages.yml"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  new vm.Script(source, { filename: "platform-governance.js" });
  assert.match(source, /function renderPublicationReview/);
  assert.match(source, /function renderPersonaSettings/);
  assert.match(source, /function renderBusinessSettings/);
  assert.match(source, /function renderBusinessPage/);
  assert.match(source, /function renderPlatformQueue/);
  assert.match(source, /Draft detected setup gaps/);
  assert.match(source, /function governanceBuildIntentionPlan/);
  assert.match(source, /purpose:"capability_explain"/);
  assert.match(source, /const stillCurrent=\(\)=>session\?\.user\?\.id===uid&&renderEpoch===epoch/);
  assert.match(source, /function governanceIntentionChanged\(\)[\s\S]*intentionAiExplanation=""/);
  assert.doesNotMatch(source, /governanceExplainIntentionWithAi[\s\S]{0,3000}\{role:"system"/);
  assert.match(source, /governanceRpc\("my_persona_family"/);
  assert.match(source, /Copy sanitized review packet/);
  assert.match(source, /generated copy omits account\/provider fields/);
  assert.match(source, /profile\.modules\?\.\[key\]!==false/);
  assert.match(source, /widget\?\.kind==="link"/);
  assert.match(source, /destination_host:governanceReviewHost\(widget\.url\)/);
  assert.match(source, /requireAal2ForSensitiveAction\("approve this persona page review"\)/);
  assert.match(source, /requireAal2ForSensitiveAction\("publish this reviewed persona page"\)/);
  assert.match(source, /confirm\(`Submit this exact feature request/);
  assert.match(source, /Source stays inert and cannot execute on a public page/);
  assert.match(source, /Email and phone values are never exposed or compared in the browser/);
  assert.match(source, /function renderFriendInvite/);
  assert.match(source, /staff_update_extension_submission/);
  assert.match(source, /save_business_draft/);
  assert.match(source, /save_business_mission_item_draft/);
  assert.match(css, /\.gov-checklist/);
  assert.match(workflow, /--include '\/platform-governance\.css'/);
  assert.match(workflow, /--include '\/platform-governance\.js'/);
  assert.match(index, /platform-governance\.css/);
  assert.match(index, /platform-governance\.js/);
  assert.match(index, /if\(context\.purpose\)requestBody\.purpose=context\.purpose/);
  assert.match(index, /if\(context\.personaId\)requestBody\.personaId=context\.personaId/);
  assert.match(index, /if\(view==="review"\)return renderPublicationReview\(arg\)/);
  assert.match(index, /if\(view==="persona-settings"\)return renderPersonaSettings\(arg\)/);
  assert.match(index, /if\(view==="business-settings"\)return renderBusinessSettings\(arg\)/);
  assert.match(index, /if\(view==="platform-queue"\)return renderPlatformQueue\(\)/);
  assert.match(index, /if\(view==="friend-invite"\)return renderFriendInvite\(arg\)/);
  assert.match(index, /if\(view==="b"\)return renderBusinessPage\(arg\)/);
  assert.match(index, /requestPersonaFollow\('\$\{p\.id\}'\)/);
  assert.match(index, /return requestPersonaFriendship\(targetId\)/);
  assert.match(index, /respond_persona_friendship/);
  assert.match(index, /async function unfriend\(ownedPersonaId,targetId\)[\s\S]*remove_persona_friendship/);
  assert.match(index, /async function blockPersona\(pid,kind\)[\s\S]*set_persona_visibility_rule/);
  assert.match(index, /async function removeBlock\(id\)[\s\S]*set_persona_visibility_rule/);
  assert.doesNotMatch(index, /from\("blocks"\)\.(?:insert|update|delete|upsert)/);
  assert.match(index, /friendship\$\{friends\.length===1\?"":"s"\} visible to you/);
  assert.match(source, /save_persona_revenue_settings/);
  assert.match(source, /save_affiliate_product/);
  assert.match(source, /save_persona_affiliate_offer/);
  assert.match(source, /governanceReviewInboxCard\(persona\)/);
  assert.match(source, /my_product_review_notification_evidence/);
  assert.match(source, /governanceSaveReviewRequestStatus/);
  assert.match(source, /governanceEraseReviewRequestPii/);
  assert.match(source, /governanceWithdrawFeature/);
  assert.match(source, /governanceDeleteFeature/);
  assert.match(source, /governanceRevokeInvites/);
  assert.match(source, /governanceWithdrawExtension/);
  assert.match(source, /governanceDeleteExtension/);
  assert.match(index, /AI transparency/);
  assert.match(index, /Save to page draft/);
  assert.match(index, /stage_native_agent_draft_for_review/);
  assert.match(index, /Stage in page review/);
  assert.match(index, /report_client_error/);
  assert.doesNotMatch(index, /from\("error_logs"\)\.insert/);
});

test("persona content and lifecycle UI mutations use the locked owner RPCs", async () => {
  const index = await read("MyPersonas.Online_v0/index.html");

  assert.match(index, /async function publishPost\(\)[\s\S]*?rpc\("save_persona_post",\{p_post_id:null,p_persona_id:d\.persona_id,p_kind:d\.kind,p_title:d\.title,p_body:d\.body,p_tags:d\.tags,p_media_url:d\.media_url\}\)/);
  assert.match(index, /async function deletePost\(id\)[\s\S]*?rpc\("delete_persona_post",\{p_post_id:id\}\)/);
  assert.match(index, /async function saveAgentSafety\(\)[\s\S]*?rpc\("set_persona_backend",\{p_persona_id:p\.id,p_backend_id:fanBackend\.id\}\)/);
  assert.match(index, /async function createAlbum\(\)[\s\S]*?rpc\("save_persona_album",\{p_album_id:null,p_persona_id:editId,p_title:title,p_kind:[\s\S]*?p_sort:editAlbums\.length\}\)/);
  assert.match(index, /async function deleteAlbum\(id\)[\s\S]*?rpc\("delete_persona_album",\{p_album_id:id\}\)/);
  assert.match(index, /async function addAlbumItem\(aid\)[\s\S]*?rpc\("save_persona_album_item",\{p_item_id:null,p_album_id:aid,p_thumb_url:thumb,[\s\S]*?p_sort:\(a\.items\|\|\[\]\)\.length\}\)/);
  assert.match(index, /async function deleteAlbumItem\(id\)[\s\S]*?rpc\("delete_persona_album_item",\{p_item_id:id\}\)/);
  assert.match(index, /async function savePersona\(\)[\s\S]*?rpc\("set_persona_pet_project",\{p_persona_id:_pid,p_pet_project:_pet\}\)/);
  assert.match(index, /async function deletePersona\(\)[\s\S]*?rpc\("delete_owned_persona",\{p_persona_id:targetId\}\)/);
  assert.match(index, /async function createPrivatePersona\(name,handle\)[\s\S]*?rpc\("save_persona_bundle",\{p_persona_id:null[\s\S]*?visibility:"private"/);
  assert.match(index, /async function createAndAssignLedgerPersona\(id\)[\s\S]*?if\(assigned\.error\)[\s\S]*?rpc\("delete_owned_persona",\{p_persona_id:data\.id\}\)/);

  assert.doesNotMatch(index, /from\("personas"\)\s*\.(?:insert|update|delete|upsert)\(/);
  for (const table of ["posts", "albums", "album_items"]) {
    assert.doesNotMatch(index, new RegExp(`from\\("${table}"\\)\\s*\\.(?:insert|update|delete|upsert)\\(`));
  }
});

test("private notes and account preferences have bounded RPC-only mutation", async () => {
  const [sql, html] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  const profile = sql.match(/create or replace function public\.update_my_profile[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(profile, /char_length\(trim\(coalesce\(p_display_name,''\)\)\)>120/);
  assert.match(profile, /jsonb_typeof\(coalesce\(p_prefs,'null'::jsonb\)\)<>'object'/);
  assert.match(profile, /octet_length\(p_prefs::text\)>100000/);
  assert.doesNotMatch(profile, /email\s*=/);
  assert.match(sql, /revoke insert,update,delete on public\.private_notes from authenticated/);
  assert.match(sql, /revoke update on public\.profiles from authenticated/);
  assert.doesNotMatch(html, /from\("profiles"\)\.update/);
  assert.match(html, /rpc\("update_my_profile"/);
});

test("account inventory is credential-free, quota-bounded, AAL2-only, and RPC-mutated", async () => {
  const [sql, html] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  const extract = (name) => sql.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
  ))?.[0] || "";
  const save = extract("save_account_ledger_entry");
  assert.match(save, /perform public\.require_aal2\(\)/);
  assert.match(save, /hashtextextended\(v_owner::text,51051059\)/);
  assert.match(save, /char_length\(v_username\)>500[\s\S]*char_length\(v_email\)>320[\s\S]*char_length\(v_url\)>2048[\s\S]*char_length\(v_notes\)>4000[\s\S]*char_length\(v_aliases\)>4000/);
  assert.match(save, /is_safe_credential_free_https_url\(v_url,false\)[\s\S]*position\('\?' in v_url\)>0[\s\S]*position\('#' in v_url\)>0/);
  assert.match(save, /account_ledger_text_has_secret\(v_username\)[\s\S]*account_ledger_text_has_secret\(v_email\)[\s\S]*account_ledger_text_has_secret\(v_notes\)[\s\S]*account_ledger_text_has_secret\(v_aliases\)/);
  assert.match(save, /select ledger\.\* into v_existing[\s\S]*for update/);
  assert.match(save, /from public\.account_connections connection[\s\S]*for update/);
  assert.match(save, /v_connection_state in \('connected','error'\)[\s\S]*Disconnect or reset the provider connection/);
  assert.match(save, /delete from public\.account_connections connection/);
  assert.match(save, /v_total>=500/);
  assert.match(save, /v_day_total>=50/);
  assert.match(save, /ledger\.created_at>=v_day[\s\S]*ledger\.created_at<v_day\+interval '1 day'/);
  for (const name of [
    "assign_account_ledger_persona",
    "set_primary_account_ledger_entry",
    "delete_account_ledger_entry",
  ]) {
    const fn = extract(name);
    assert.match(fn, /perform public\.require_aal2\(\)/, `${name} must require AAL2`);
    assert.match(fn, /hashtextextended\(v_owner::text,51051059\)/, `${name} must share the owner ledger lock`);
  }
  assert.match(sql, /revoke insert,update,delete on public\.account_ledger from authenticated/);
  assert.match(sql, /revoke insert,update,delete on public\.account_ledger from service_role/);
  const serviceErase = extract("delete_account_ledger_for_account_service");
  assert.match(serviceErase, /Service role required/);
  assert.match(serviceErase, /hashtextextended\(p_owner::text,51051059\)/);
  assert.match(serviceErase, /order by ledger\.id for update/);
  assert.match(serviceErase, /delete from public\.account_ledger ledger where ledger\.owner=p_owner/);
  const sharedManager = extract("set_account_persona_link");
  assert.match(sharedManager, /perform public\.require_aal2\(\)/);
  assert.match(sharedManager, /hashtextextended\(v_owner::text,51051059\)/);
  assert.match(sharedManager, /from public\.account_ledger ledger[\s\S]*for update/);
  assert.match(sharedManager, /v_total>=5000/);
  assert.match(sharedManager, /v_day_total>=200/);
  assert.match(sharedManager, /v_ledger_total>=100/);
  assert.match(sql, /revoke insert,update,delete on public\.account_persona_links\s+from authenticated,service_role/);
  const verify = extract("verify_account_ledger_email");
  assert.match(verify, /hashtextextended\(v_owner::text,51051059\)/);
  assert.match(verify, /from public\.account_ledger ledger[\s\S]*for update/);
  assert.match(verify, /verify_account_ledger_email_legacy_009\(p_ledger_id\)/);
  assert.match(sql, /revoke all on function public\.verify_account_ledger_email_legacy_009\(uuid\)[\s\S]*from public,anon,authenticated,service_role/);
  assert.doesNotMatch(html, /from\("account_ledger"\)\.(?:insert|update|delete|upsert)/);
  for (const name of [
    "save_account_ledger_entry",
    "assign_account_ledger_persona",
    "set_primary_account_ledger_entry",
    "delete_account_ledger_entry",
  ]) assert.match(html, new RegExp(`rpc\\("${name}"`));
  assert.match(html, /function validLedgerUrl[\s\S]*parsed\.protocol==="https:"[\s\S]*!parsed\.username[\s\S]*!parsed\.password[\s\S]*!parsed\.search[\s\S]*!parsed\.hash/);
  assert.match(html, /async function deleteLedgerAccount[\s\S]*requireAal2ForSensitiveAction\("disconnect and remove this account record"\)[\s\S]*gmailOAuthAction/);
});

test("legacy persona groups are bounded and mutate only through owner RPCs", async () => {
  const [sql, html] = await Promise.all([
    read(migrationPath),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  const group = sql.match(/create or replace function public\.save_persona_group\([\s\S]*?\n\$\$;/)?.[0] || "";
  const member = sql.match(/create or replace function public\.set_persona_group_member\([\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(sql, /create index if not exists persona_groups_owner_created_quota_idx/);
  assert.match(sql, /create index if not exists persona_group_members_owner_created_quota_idx/);
  assert.match(group, /lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.match(group, /v_total>=100/);
  assert.match(group, /v_day_total>=20/);
  assert.match(member, /lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.match(member, /v_total>=5000/);
  assert.match(member, /v_day_total>=200/);
  assert.match(member, /v_group_total>=100/);
  assert.match(sql, /revoke insert,update,delete on public\.persona_groups,[\s\S]*public\.persona_group_members from authenticated/);
  assert.match(sql, /revoke insert,update on public\.persona_groups,[\s\S]*public\.persona_group_members from service_role/);
  assert.doesNotMatch(html, /from\("persona_(?:groups|group_members)"\)\.(?:insert|update|delete|upsert)/);
  assert.match(html, /rpc\("save_persona_group"/);
  assert.match(html, /rpc\("delete_persona_group"/);
  assert.match(html, /rpc\("set_persona_group_member"/);
});

test("page publish reconciles staged native drafts only after the publish RPC commits", async () => {
  const source = await read("MyPersonas.Online_v0/platform-governance.js");
  const publish = source.match(/async function governancePublish\(\)[\s\S]*?\n}/)?.[0] || "";

  assert.match(publish, /await sb\.rpc\("publish_persona_page",\{p_persona_id:persona\.id\}\);if\(error\)\{toast\(error\.message\);return\}/);
  assert.match(publish, /const publishMessage=data\?\.activation_state==="waiting_for_reviewed_dependencies"\?"Reviewed revision saved; public activation is waiting for its reviewed related personas":"Page published"/);
  assert.match(publish, /await sb\.rpc\("reconcile_staged_native_page_publications",\{p_persona_id:null\}\)/);
  assert.match(publish, /await loadMine\(\);toast\(publishMessage\)/);
  assert.match(publish, /if\(reconciliation\.error\)[\s\S]*Page publication succeeded, but staged native draft reconciliation needs review/);
  assert.ok(
    publish.indexOf('rpc("publish_persona_page"') <
      publish.indexOf('rpc("reconcile_staged_native_page_publications"'),
    "staged native reconciliation must be a second RPC after page publication",
  );
});
