import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sql = await readFile(path.join(
  root,
  "MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql",
), "utf8");

function fn(name) {
  return sql.match(new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
  ))?.[0] || "";
}

test("repost drafts are bounded, owner-scoped, and queue links require AAL2", () => {
  const create = fn("create_repost");
  assert.match(create, /lock_owner_content_creation_quota\(v_owner\)/);
  assert.match(create, /persona\.id=p_persona_id and persona\.owner=v_owner/);
  assert.match(create, /Owned source persona not found/);
  assert.match(create, /is_safe_credential_free_https_url/);
  assert.match(create, /account_ledger_text_has_secret\(p_notes\)/);
  assert.match(create, /v_total>=5000/);
  assert.match(create, /v_day_total>=200/);
  assert.match(create, /v_persona_total>=500/);

  const link = fn("link_repost_to_draft");
  assert.match(link, /perform public\.require_aal2\(\)/);
  assert.match(link, /from public\.persona_reposts repost[\s\S]*for update/);
  assert.match(link, /draft\.persona_id=v_repost\.persona_id/);
  assert.match(fn("delete_persona_repost"), /perform public\.require_aal2\(\)/);
});

test("media library records have canonical safe metadata and bounded quotas", () => {
  const media = fn("add_media_asset");
  assert.match(media, /lock_owner_content_creation_quota\(v_owner\)/);
  assert.match(media, /Owned generation backend not found/);
  assert.match(media, /p_storage_path!~'\^\[A-Za-z0-9\]/);
  assert.match(media, /is_safe_credential_free_https_url/);
  assert.match(media, /jsonb_typeof\(coalesce\(p_metadata,'null'::jsonb\)\)<>'object'/);
  assert.match(media, /coalesce\(array_length\(v_tags,1\),0\)>50/);
  assert.match(media, /v_total>=5000/);
  assert.match(media, /v_day_total>=200/);
  assert.match(media, /v_persona_total>=1000/);
  assert.match(fn("delete_persona_media_asset"), /perform public\.require_aal2\(\)/);
  assert.match(fn("get_persona_media_library"), /limit 500/);
});

test("legacy direct table writers and unbounded calendar helper are closed", () => {
  assert.match(
    sql,
    /revoke insert,update,delete on public\.persona_reposts,[\s\S]*public\.persona_media_assets from authenticated,service_role/,
  );
  assert.match(
    sql,
    /revoke all on function public\.create_repost[\s\S]*public\.get_content_calendar_legacy_043\(integer\)[\s\S]*from public,anon,authenticated,service_role/,
  );
  const calendar = fn("get_content_calendar");
  assert.match(calendar, /p_days_ahead not between 1 and 90/);
  assert.match(calendar, /get_content_calendar_legacy_043\(p_days_ahead\)/);
});
