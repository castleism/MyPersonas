import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root=new URL("../",import.meta.url);
const read=path=>readFile(new URL(path,root),"utf8");

test("migration 066 mirrors exactly and keeps custom fields RPC-only",async()=>{
  const[canonical,mirror]=await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/066-custom-persona-field-boxes.sql"),
    read("supabase/migrations/20260823080000_custom_persona_field_boxes.sql")
  ]);
  assert.equal(mirror,canonical);
  assert.match(canonical,/create table if not exists public\.persona_custom_field_boxes/);
  assert.match(canonical,/alter table public\.persona_custom_field_boxes enable row level security/);
  assert.match(canonical,/revoke all on table public\.persona_custom_field_boxes[\s\S]*from public,anon,authenticated,service_role/);
  assert.doesNotMatch(canonical,/grant (?:select|insert|update|delete|all)[\s\S]{0,100}persona_custom_field_boxes/i);
  assert.match(canonical,/field_type in \('text','link'\)/);
  assert.match(canonical,/visibility in \('owner_only','friends','followers','public'\)/);
  assert.match(canonical,/Persona custom field limit reached \(24\)/);
  assert.match(canonical,/Account custom field limit reached \(200\)/);
  assert.match(canonical,/row_version=field\.row_version\+1/);
  assert.match(canonical,/sqlstate '40001'/);
  assert.match(canonical,/credential-free HTTPS URL/);
  assert.match(canonical,/persona_custom_field_link_safe_066/);
  assert.match(canonical,/position\('\?' in coalesce\(p_value,''\)\)=0/);
  assert.match(canonical,/project_resource_text_has_secret/);
  assert.match(canonical,/assert_owner_erasure_inactive_066/);
  assert.doesNotMatch(canonical,/\beval\s*\(|javascript:|field_type[^\n]+html/i);
});

test("custom fields bind exact review, audience projection, and content erasure",async()=>{
  const sql=await read("MyPersonas.Online_v0/sql-updates/066-custom-persona-field-boxes.sql");
  assert.match(sql,/invalidate_persona_custom_field_review[\s\S]*v_old_shared or v_new_shared[\s\S]*invalidate_persona_review_revision/);
  assert.match(sql,/persona_publication_review_manifest_base_066/);
  assert.match(sql,/pg_get_functiondef/);
  assert.doesNotMatch(sql,/alter function public\.persona_publication_review_manifest\(uuid\)\s+rename/i);
  assert.match(sql,/'custom_field_boxes',v_fields/);
  assert.match(sql,/field\.enabled and field\.visibility<>'owner_only'/);
  assert.match(sql,/p_actor_persona_id is not null[\s\S]*Owned acting persona not found/);
  assert.match(sql,/p_actor_persona_id=p_persona_id[\s\S]*v_is_owner:=true/);
  assert.match(sql,/elsif auth\.uid\(\) is not null and auth\.uid\(\)=v_target_owner/);
  assert.match(sql,/field\.visibility='friends' and v_is_friend/);
  assert.match(sql,/field\.visibility='followers' and v_is_follower/);
  assert.match(sql,/delete_persona_page_builder_data_for_account_service[\s\S]*delete from public\.persona_custom_field_boxes/);
});

test("settings and both persona renderers escape data and fail closed without an acting persona",async()=>{
  const[index,governance,personaView]=await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/platform-governance.js"),
    read("MyPersonas.Online_v0/persona-view.js")
  ]);
  assert.match(index,/function normalizePersonaCustomFields/);
  assert.match(index,/function safePersonaCustomFieldUrl/);
  assert.match(index,/parsed\.search\|\|parsed\.hash/);
  assert.match(index,/personaCustomFieldBoxHtml[\s\S]*esc\(field\.title\)[\s\S]*esc\(field\.body\)/);
  assert.match(index,/persona_custom_field_boxes",\{p_persona_id:p\.id,p_actor_persona_id:null\}/);
  assert.match(governance,/Custom persona field boxes/);
  assert.match(governance,/save_persona_custom_field_box/);
  assert.match(governance,/safePersonaCustomFieldUrl\(rawUrl\)/);
  assert.match(governance,/delete_persona_custom_field_box/);
  assert.match(governance,/governanceCustomFieldSnapshotCurrent/);
  assert.match(governance,/Friends\/followers fields are shown only in exact Persona view/);
  assert.match(personaView,/persona_custom_field_boxes",\{p_persona_id:p\.id,p_actor_persona_id:actor\.id\}/);
  assert.match(personaView,/ownerAppPerspectiveSnapshotCurrent\(snapshot\)/);
  assert.doesNotMatch(`${index}\n${governance}\n${personaView}`,/innerHTML\s*=\s*field\.(?:title|body|link_url)/);
});

test("custom fields participate in backup and restore only as disabled owner-only data",async()=>{
  const index=await read("MyPersonas.Online_v0/index.html");
  assert.match(index,/persona_custom_field_boxes:customFields\.data\|\|\[\]/);
  assert.match(index,/persona_custom_field_boxes:200/);
  assert.match(index,/for\(const row of customFields\)[\s\S]*p_visibility:"owner_only",p_enabled:false/);
  assert.match(index,/loadOwnedCustomFieldBoxes[\s\S]*my_persona_custom_field_boxes/);
});
