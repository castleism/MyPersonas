import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root=new URL("../",import.meta.url);
const read=path=>readFile(new URL(path,root),"utf8");

test("migration 067 mirrors exactly and adds AAL2, erasure exclusion, and row-version conflicts",async()=>{
  const[canonical,mirror]=await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/067-project-resource-editor-hardening.sql"),
    read("supabase/migrations/20260823090000_project_resource_editor_hardening.sql")
  ]);
  assert.equal(mirror,canonical);
  assert.match(canonical,/perform public\.require_aal2\(\)/);
  assert.match(canonical,/project_resource_locator_safe_067/);
  assert.match(canonical,/is_safe_credential_free_https_url\(v_value,false\)/);
  assert.match(canonical,/project_resource_text_has_secret\(v_(?:value|name|notes)\)/);
  assert.match(canonical,/position\('\?' in v_value\)[\s\S]*position\('#' in v_value\)/);
  assert.match(canonical,/lock_owner_persona_org_creation_quota\(v_owner\)/);
  assert.match(canonical,/assert_owner_erasure_inactive_066\(v_owner\)/);
  assert.match(canonical,/consume_owner_daily_rate\([\s\S]*'project_resources',50,1,v_owner_day/);
  assert.match(canonical,/add column if not exists row_version bigint not null default 1/);
  assert.match(canonical,/v_existing_row_version is distinct from p_expected_row_version/);
  assert.match(canonical,/row_version = resource\.row_version \+ 1/);
  assert.match(canonical,/raise sqlstate '40001'/);
  assert.match(canonical,/update public\.project_resources resource set[\s\S]*connection_state = 'blocked'[\s\S]*not public\.project_resource_locator_safe_067\(resource\.resource_locator\)/);
  assert.match(canonical,/Project resources cannot move between projects/);
  assert.match(canonical,/and not ledger\.suspended/);
  assert.match(canonical,/coalesce\(p_enabled,false\) and p_connection_state <> 'ready'/);
  assert.match(canonical,/p_connection_state = 'ready' and v_locator = ''/);
  assert.match(canonical,/grant execute on function public\.save_project_resource_v2[\s\S]*to authenticated/);
  assert.match(canonical,/revoke all on function public\.save_project_resource\([\s\S]*from public, anon, authenticated, service_role/);
  assert.match(canonical,/revoke all on function public\.delete_project_resource\(uuid\)[\s\S]*from public, anon, authenticated, service_role/);
  assert.doesNotMatch(canonical,/grant execute on function public\.(?:save|delete)_project_resource[^;]*service_role/i);
});

test("owner Settings exposes a credential-free metadata editor without claiming a connection",async()=>{
  const[index,governance]=await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/platform-governance.js")
  ]);
  assert.match(index,/platform-governance\.js\?v=20260823-4/);
  assert.match(governance,/governanceMaybe\("persona_projects"[\s\S]{0,260}\.eq\("owner",owner\)/);
  assert.match(governance,/governanceMaybe\("project_resources"[\s\S]{0,320}\.eq\("owner",owner\)/);
  assert.match(governance,/function governanceSafeProjectResourceUrl/);
  assert.match(governance,/parsed\.protocol!=="https:"/);
  assert.match(governance,/parsed\.username\|\|parsed\.password\|\|parsed\.search\|\|parsed\.hash/);
  assert.match(governance,/host==="localhost"/);
  assert.match(governance,/\^\[0-9\.\]\+\$/);
  assert.match(governance,/Metadata only—never paste a credential/);
  assert.match(governance,/not a tested database, repository, or Drive connection/);
  assert.match(governance,/Read-only provider access still needs its own reviewed OAuth\/API connector and evidence/);
  assert.match(governance,/id="govProjectResourceLocator" type="url"/);
  assert.match(governance,/governanceRequireSensitive\(resourceId\?"edit project resource metadata":"attach project resource metadata"\)/);
  assert.match(governance,/function governanceProjectResourceSnapshot/);
  assert.match(governance,/renderEpoch!==snapshot\.epoch/);
  assert.match(governance,/Number\(current\.row_version\)===snapshot\.rowVersion/);
  assert.match(governance,/p_expected_row_version:resource\?snapshot\.rowVersion:null/);
  assert.match(governance,/sb\.rpc\("save_project_resource_v2"/);
  assert.match(governance,/sb\.rpc\("delete_project_resource_v2"/);
  assert.match(governance,/no external connection was tested/);
  assert.match(governance,/rel="noopener noreferrer"/);
  assert.doesNotMatch(governance,/Project resource editor is not installed/);
});

test("resource rows are persona-project scoped, escaped, and unsafe legacy locators fail closed",async()=>{
  const governance=await read("MyPersonas.Online_v0/platform-governance.js");
  const section=governance.slice(
    governance.indexOf("function governanceSafeProjectResourceUrl"),
    governance.indexOf("function governanceClearFamilyRelationship")
  );
  assert.match(section,/memberIds=new Set\(memberships\.map\(row=>row\.project_id\)\)/);
  assert.match(section,/resources=\(governanceState\.projectResources\|\|\[\]\)\.filter\(resource=>memberIds\.has\(resource\.project_id\)\)/);
  assert.match(section,/esc\(resource\.display_name\)/);
  assert.match(section,/esc\(safeUrl\)/);
  assert.match(section,/unsafe legacy locator — replace before enabling/);
  assert.match(section,/resource\.resource_locator&&!safeLocator[\s\S]*withheld from the form/);
  assert.match(section,/state==="ready"&&!locator[\s\S]*Ready resource needs a reviewed HTTPS locator/);
  assert.match(section,/enabled&&state!=="ready"/);
  assert.match(section,/account\.id===accountId&&!account\.suspended/);
  assert.match(section,/bindingUnavailable=!!resource\.account_ledger_id&&!account/);
  assert.match(section,/Configured account is missing or suspended; resource fails closed/);
  assert.match(section,/effectiveEnabled=resource\.enabled&&resource\.connection_state==="ready"&&!!safeUrl&&!bindingUnavailable/);
});

test("browser project-resource locator validator matches the fail-closed server boundary",async()=>{
  const governance=await read("MyPersonas.Online_v0/platform-governance.js");
  const source=governance.match(/function governanceSafeProjectResourceUrl\(value\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(source,"safe locator helper source");
  const validate=Function(`${source}; return governanceSafeProjectResourceUrl`)();
  for(const value of[
    "https://example.test/path",
    "HTTPS://docs.example.test:443/folder/item",
    "https://example.test:65535/path"
  ]) assert.ok(validate(value),`safe locator rejected: ${value}`);
  for(const value of[
    "http://example.test/path","https://localhost/path","https://127.0.0.1/path",
    "https://169.254.169.254/latest/meta-data","https://db.internal/path","https://printer.lan/path",
    "https://localhost./","https://LOCALHOST.:443/path","https://db.internal./path",
    "https://printer.lan./path","https://example.test:0/path",
    "https://[::1]/path","https://user:pass@example.test/path",
    "https://example.test/path?q=1","https://example.test/path#fragment",
    "https://example.test/api_key=abcdefghijklmnop","https://example.test/path with-space",
    "https://example.test\\path"
  ]) assert.equal(validate(value),"",`unsafe locator accepted: ${value}`);
});

test("project-resource MFA pauses cannot mix a later route, persona, or row revision",async()=>{
  const governance=await read("MyPersonas.Online_v0/platform-governance.js");
  const helpers=governance.match(/function governanceProjectResourceSnapshot\(resource\)\{[^\r\n]+\}\r?\nfunction governanceProjectResourceSnapshotCurrent\(snapshot\)\{[^\r\n]+\}/)?.[0];
  assert.ok(helpers,"project resource snapshot helpers");
  const harness=Function("initialSession","initialPersona","initialEpoch","initialResources",`
    let session=initialSession,governanceState={personaId:initialPersona,projectResources:initialResources},renderEpoch=initialEpoch;
    ${helpers}
    return {governanceProjectResourceSnapshot,governanceProjectResourceSnapshotCurrent,
      setSession(value){session=value},setPersona(value){governanceState.personaId=value},
      setEpoch(value){renderEpoch=value},setResources(value){governanceState.projectResources=value}};
  `)({user:{id:"owner-a"}},"persona-a",7,[{id:"resource-a",row_version:3}]);
  const snapshot=harness.governanceProjectResourceSnapshot({id:"resource-a",row_version:3});
  assert.equal(harness.governanceProjectResourceSnapshotCurrent(snapshot),true);
  harness.setEpoch(8);assert.equal(harness.governanceProjectResourceSnapshotCurrent(snapshot),false);
  harness.setEpoch(7);harness.setPersona("persona-b");assert.equal(harness.governanceProjectResourceSnapshotCurrent(snapshot),false);
  harness.setPersona("persona-a");harness.setResources([{id:"resource-a",row_version:4}]);assert.equal(harness.governanceProjectResourceSnapshotCurrent(snapshot),false);
  harness.setResources([{id:"resource-a",row_version:3}]);harness.setSession({user:{id:"owner-b"}});assert.equal(harness.governanceProjectResourceSnapshotCurrent(snapshot),false);

  const save=governance.slice(governance.indexOf("async function governanceSaveProjectResource"),governance.indexOf("async function governanceDeleteProjectResource"));
  const gate=save.indexOf("await governanceRequireSensitive");
  assert.ok(gate>0,"AAL2 gate");
  assert.doesNotMatch(save.slice(gate),/document\.getElementById/);
  assert.match(save.slice(gate),/governanceProjectResourceSnapshotCurrent\(snapshot\)[\s\S]*sb\.rpc\("save_project_resource_v2",payload\)/);
});
