import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("migration 070 is mirrored and installs a private source bucket", async () => {
  const [sql, mirror] = await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql"),
    read("supabase/migrations/20260823120000_persona_source_library.sql"),
  ]);
  assert.equal(mirror, sql);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/m);
  assert.match(sql, /'persona-source-library','persona-source-library',false,10485760/);
  assert.match(sql, /allowed_mime_types[\s\S]*'image\/png','image\/jpeg','image\/webp'/);
  assert.doesNotMatch(sql, /create policy[^;]+persona-source-library[^;]+storage\.objects/i);
});

test("owner-visible metadata has declarations but never a raw locator", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql");
  const assets = section(
    sql,
    "create table if not exists public.persona_source_assets",
    "comment on table public.persona_source_assets",
  );
  for (const value of [
    "'research','content_later','unsorted','archive'",
    "'managed_private','local_companion','external_reference'",
    "'none','assisted','generated','unknown'",
    "'owner_created','licensed','reference_only','unknown'",
    "'reference_only','derivative_allowed','publish_allowed'",
    "'standard','sensitive','restricted'",
  ]) assert.match(assets, new RegExp(value.replaceAll("'", "'")));
  assert.match(assets, /publication_state[\s\S]*check \(publication_state='private_only'\)/);
  assert.doesNotMatch(assets, /storage_path|storage_locator|bucket_id|public_url/);

  const locations = section(
    sql,
    "create table if not exists private.persona_source_asset_locations",
    "comment on table private.persona_source_asset_locations",
  );
  assert.match(locations, /bucket_id[\s\S]*storage_locator/);
  assert.match(sql, /revoke all on private\.persona_source_asset_locations[\s\S]*from public,anon,authenticated,service_role/);
});

test("source writes are RPC-only and reads remain owner-RLS scoped", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql");
  for (const table of [
    "persona_source_assets",
    "persona_source_notes",
    "persona_source_analysis_jobs",
  ]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(sql, new RegExp(`before insert or update or delete on public\\.${table}`));
  }
  assert.match(sql, /Persona source writes require an approved RPC/);
  assert.match(sql, /grant select on public\.persona_source_assets[\s\S]*to authenticated/);
  assert.match(sql, /using \(owner=auth\.uid\(\)\)/);
  assert.match(sql, /revoke all on public\.persona_source_assets[\s\S]*from public,anon,authenticated,service_role/);
});

test("serialized reservations enforce conservative technical byte ceilings", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql");
  const reserve = section(
    sql,
    "create or replace function public.reserve_persona_source_upload_service",
    "create or replace function public.release_persona_source_upload_service",
  );
  assert.match(reserve, /private\.lock_persona_source_owner\(p_owner\)/);
  assert.match(reserve, /for update/);
  assert.match(reserve, />2147483648/);
  assert.match(reserve, />1073741824/);
  assert.match(reserve, />=10000/);
  assert.match(reserve, />=5000/);
  assert.match(reserve, />=500/);
  assert.match(reserve, /technical safety ceilings, not billing\/product/);
  assert.match(sql, /state in \('reserved','writing','registered','released','expired'\)/);
  assert.match(sql, /persona_source_one_active_exact_upload_idx[\s\S]*where state in \('reserved','writing'\)/);
  assert.match(reserve, /PERSONA_SOURCE_DUPLICATE_UPLOAD_PENDING/);
  assert.match(reserve, /'duplicate',true/);
  assert.match(sql, /create or replace function public\.begin_persona_source_storage_write_service/);
  assert.match(sql, /state='writing',expires_at=now\(\)\+interval '15 minutes'/);
  assert.match(sql, /'status','writing'[\s\S]*'source_sha256',v_reservation\.source_sha256/);
  assert.match(sql, /create or replace function public\.release_persona_source_upload_service/);
  assert.match(sql, /v_reservation\.state not in \('reserved','writing'\)/);
  assert.match(sql, /reserved_managed_bytes=greatest\(0,reserved_managed_bytes-v_reservation\.expected_bytes\)/);
});

test("service intake is idempotent, exact, private, and storage-first on delete", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql");
  const register = section(
    sql,
    "create or replace function public.register_persona_source_asset_service",
    "create or replace function public.resolve_persona_source_asset_service",
  );
  assert.match(register, /p_owner uuid,p_persona_id uuid,p_storage_path text/);
  assert.match(register, /p_idempotency_key uuid/);
  assert.match(register, /p_owner::text\|\|'\/personas\/'\|\|p_persona_id::text[\s\S]*'\/source\/'\|\|p_idempotency_key::text\|\|'-'/);
  assert.match(register, /object\.metadata->>'size'/);
  assert.match(register, /v_storage_size::bigint<>p_byte_size/);
  assert.match(register, /v_reservation\.state<>'writing'/);
  assert.match(register, /PERSONA_SOURCE_ACCOUNT_DELETING/);
  assert.match(register, /request_sha256,receipt_scope,duplicate[\s\S]*'register'/);
  assert.match(register, /'cleanup_required',true/);
  assert.match(register, /reserved_asset_count=greatest\(0,reserved_asset_count-1\)/);
  assert.match(sql, /returns table\(\s*storage_path text,source_sha256 text,mime_type text,byte_size bigint/);

  const deletePreflight = section(
    sql,
    "create or replace function public.begin_persona_source_asset_deletion_service",
    "create or replace function public.delete_persona_source_asset_metadata_service",
  );
  assert.match(deletePreflight, /private\.lock_persona_source_owner\(p_owner\)/);
  assert.match(deletePreflight, /PERSONA_SOURCE_ACCOUNT_DELETING/);
  assert.match(deletePreflight, /PERSONA_SOURCE_PERSONA_DELETING/);
  assert.match(deletePreflight, /status='cancelled',cancel_requested=true/);
  assert.match(deletePreflight, /job\.status='claimed'/);
  assert.match(deletePreflight, /lifecycle_state='deleting'/);
  assert.match(deletePreflight, /'status','deleting','asset_id',p_asset_id,'active_studies',v_active_studies/);

  const deletion = section(
    sql,
    "create or replace function public.delete_persona_source_asset_metadata_service",
    "create or replace function public.update_persona_source_asset",
  );
  assert.match(deletion, /v_asset\.lifecycle_state<>'deleting'/);
  assert.match(deletion, /Delete private Storage bytes before metadata/);
  assert.match(deletion, /object\.name=v_location\.storage_locator/);
  assert.match(deletion, /PERSONA_SOURCE_ACTIVE_STUDIES_RETRY/);
  assert.match(deletion, /'deleted',true,'status','deleted'/);
  assert.match(sql, /begin_persona_source_asset_deletion_service\(uuid,uuid\)[\s\S]*to service_role/);
});

test("study jobs require review, consent, MFA, and a fresh entitlement check", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql");
  const updateAsset = section(
    sql,
    "create or replace function public.update_persona_source_asset",
    "create or replace function public.add_persona_source_note",
  );
  assert.match(updateAsset, /v_asset\.lifecycle_state='deleting'[\s\S]*Persona source asset deletion is in progress/);
  const queue = section(
    sql,
    "create or replace function public.queue_persona_source_study",
    "create or replace function public.cancel_persona_source_study",
  );
  assert.match(queue, /v_asset\.lifecycle_state<>'ready'/);
  assert.match(queue, /not v_asset\.hosted_analysis_consent/);
  assert.match(queue, /v_asset\.sensitivity='restricted'/);
  assert.match(queue, /auth\.jwt\(\)->>'aal'.*<>'aal2'/);
  assert.match(queue, /PERSONA_SOURCE_DELETION_IN_PROGRESS/);
  assert.match(queue, /return v_active_job\.id/);
  assert.match(sql, /auto_publish[\s\S]*check \(not auto_publish\)/);
  assert.match(sql, /worker_entitlement_recheck_required[\s\S]*check \(worker_entitlement_recheck_required\)/);
  assert.match(sql, /and public\.account_has_billing_access\(job\.owner\)/);
  const claim = section(
    sql,
    "create or replace function public.claim_persona_source_study_service",
    "create or replace function public.finalize_persona_source_study_service",
  );
  assert.match(claim, /job\.execution_mode='hosted'/);
  assert.match(claim, /persona_source_account_deletion_guards/);
  assert.match(claim, /persona_source_deletion_guards/);
  const cancel = section(
    sql,
    "create or replace function public.cancel_persona_source_study",
    "-- Claiming is deliberately separate from queueing",
  );
  assert.match(cancel, /return case when v_job\.status='queued' then 'cancelled' else 'cancel_requested' end/);
  const finalize = section(
    sql,
    "create or replace function public.finalize_persona_source_study_service",
    "create or replace function public.purge_persona_source_library_retention_batch_service",
  );
  assert.match(finalize, /not v_asset\.hosted_analysis_consent or v_asset\.sensitivity='restricted'/);
  assert.match(finalize, /if v_forced_cancel then v_outcome:='cancelled'/);
  assert.match(finalize, /when v_asset\.lifecycle_state='deleting' then 'deleting'/);
  assert.doesNotMatch(sql, /p_entitlement_active/);
  assert.match(sql, /a worker[\s\S]*cannot attest to access with a caller-controlled flag/);
  assert.match(sql, /SQL performs no[\s\S]*provider call and a queued row is never execution evidence/);
  assert.match(sql, /'suggested_notes',v_note_count,'auto_publish',false/);
  for (const kind of ["description", "research", "content_idea", "visual_reference", "warning"]) {
    assert.match(sql, new RegExp(`'${kind}'`));
  }
  assert.doesNotMatch(sql, /http_post|net\.http|pg_net/);
});

test("persona and account erasure enumerate bytes before deleting metadata", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql");
  assert.match(sql, /create table if not exists private\.persona_source_deletion_guards/);
  assert.match(sql, /create table if not exists private\.persona_source_account_deletion_guards/);
  assert.match(sql, /create or replace function public\.begin_persona_source_deletion_service/);
  assert.match(sql, /create or replace function public\.begin_persona_source_account_deletion_service/);
  assert.match(sql, /create or replace function public\.release_persona_source_account_deletion_guard_service/);
  assert.match(sql, /PERSONA_SOURCE_PERSONA_DELETING/);
  assert.match(sql, /'active_writes',v_active_writes,'active_studies',v_active_studies/);
  assert.match(sql, /'persona_prefix',p_owner::text\|\|'\/personas\/'\|\|p_persona_id::text\|\|'\/'/);
  assert.match(sql, /create or replace function public\.list_persona_source_paths_for_persona_service/);
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit,100\),1\),200\)/);
  const personaDelete = section(
    sql,
    "create or replace function public.delete_persona_source_library_for_persona_service",
    "create or replace function public.delete_persona_source_library_for_account_service",
  );
  assert.match(personaDelete, /Delete persona private Storage bytes before metadata/);
  assert.match(personaDelete, /Active persona source deletion guard required/);
  assert.match(personaDelete, /object\.name like[\s\S]*p_owner::text\|\|'\/personas\/'\|\|p_persona_id::text\|\|'\/%'/);
  assert.match(personaDelete, /PERSONA_SOURCE_ACTIVE_WRITES_RETRY/);
  assert.match(personaDelete, /PERSONA_SOURCE_ACTIVE_STUDIES_RETRY/);
  assert.match(personaDelete, /active_managed_bytes=greatest\(0,active_managed_bytes-v_managed_bytes\)/);
  assert.match(personaDelete, /reserved_managed_bytes=greatest\(0,reserved_managed_bytes-v_reserved_bytes\)/);
  assert.match(sql, /Delete all private Storage bytes before account metadata/);
  assert.match(sql, /'expired_deletion_guards',v_deletion_guards/);
  assert.match(sql, /'expired_account_deletion_guards',v_account_deletion_guards/);
  assert.match(sql, /state='metadata_deleted',expires_at=now\(\)\+interval '1 hour'/);
  assert.match(sql, /delete_persona_source_library_for_persona_service\(uuid,uuid\)[\s\S]*to service_role/);
});

test("runtime harness replays migration and exercises role-switched boundaries", async () => {
  const [script, runtime] = await Promise.all([
    read("scripts/test-persona-source-library-sql.ps1"),
    read("tests/sql/070-persona-source-library-runtime.sql"),
  ]);
  assert.equal((script.match(/070-persona-source-library\.sql/g) || []).length, 2);
  assert.match(runtime, /persona-source-library-070-runtime-ok/);
  assert.match(runtime, /Persona deletion guard failed a write\/delete race gate/);
  assert.match(runtime, /Account orphan Storage object was ignored/);
  assert.match(runtime, /Owner RLS leaked another account source library/);
  assert.match(runtime, /Database claimed a job without active owner entitlement/);
  assert.match(runtime, /Hosted service worker consumed a local companion job/);
  assert.match(runtime, /Consent revocation did not discard provider notes/);
  assert.match(runtime, /Stale cancel_requested lease became failed instead of cancelled/);
  assert.match(runtime, /Non-service caller entered asset deletion preflight/);
  assert.match(runtime, /Claimed study did not block single byte phase/);
  assert.match(runtime, /Single deletion finalization retained notes or reset lifecycle/);
  assert.match(runtime, /Single byte-first metadata deletion failed/);
  assert.match(runtime, /Deleting asset accepted an owner archive or metadata update/);
});
