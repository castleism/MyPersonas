import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const app = await read("MyPersonas.Online_v0/index.html");
const ownerApp = await read("MyPersonas.Online_v0/owner-app.js");
const migrationPath = "MyPersonas.Online_v0/sql-updates/048-persona-backup-relationships.sql";
const mirrorPath = "supabase/migrations/20260822130000_persona_backup_relationships.sql";
const migration = await read(migrationPath);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index++) {
    if (source[index] === "(") parameterDepth++;
    if (source[index] === ")" && --parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf("{", parametersEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`${name} has an unterminated body`);
}

test("both migration paths are identical and define a private same-owner one-level edge", async () => {
  assert.equal(await read(mirrorPath), migration);
  assert.match(migration, /begin;[\s\S]*commit;/i);
  assert.match(migration, /create table if not exists public\.persona_backup_relationships/);
  assert.match(migration, /main_persona_id uuid primary key/);
  assert.match(migration, /backup_persona_id uuid not null unique/);
  assert.match(migration, /check \(main_persona_id <> backup_persona_id\)/);
  assert.equal((migration.match(/foreign key \((?:main|backup)_persona_id, owner\)[\s\S]*?references public\.personas\(id, owner\) on delete cascade/g) || []).length, 2);
  assert.match(migration, /relationship\.main_persona_id in \(new\.main_persona_id, new\.backup_persona_id\)/);
  assert.match(migration, /relationship\.backup_persona_id in \(new\.main_persona_id, new\.backup_persona_id\)/);
  assert.match(migration, /for update;[\s\S]*?insert into public\.persona_backup_relationships/);
});

test("backup rows are owner-readable but browser writes go only through the authenticated RPC", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /for select to authenticated[\s\S]*?owner = auth\.uid\(\)/);
  assert.match(migration, /revoke all on public\.persona_backup_relationships[\s\S]*?from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.persona_backup_relationships to authenticated/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[^;]*persona_backup_relationships[^;]*authenticated/i);
  assert.match(migration, /create or replace function public\.set_persona_backup/);
  assert.match(migration, /security definer[\s\S]*?set search_path = ''/);
  assert.match(migration, /v_owner uuid := auth\.uid\(\)/);
  assert.match(migration, /where persona\.id = p_main_persona_id and persona\.owner = v_owner/);
  assert.match(migration, /where persona\.id = p_backup_persona_id and persona\.owner = v_owner/);
  assert.match(migration, /if p_backup_persona_id is null then[\s\S]*?delete from public\.persona_backup_relationships/);
  assert.match(migration, /grant execute on function public\.set_persona_backup\(uuid, uuid\)[\s\S]*?to authenticated/);
});

test("public persona reads remain independent from private backup organization", async () => {
  const schema = await read("MyPersonas.Online_v0/supabase-schema.sql");
  for (const name of ["discover_personas", "persona_by_handle"]) {
    const start = schema.lastIndexOf(`create or replace function public.${name}`);
    const end = schema.indexOf("$$;", start);
    assert.ok(start >= 0 && end > start, `${name} must exist`);
    assert.doesNotMatch(schema.slice(start, end + 3), /backup/i, `${name} must not expose backup relationships`);
  }
  assert.match(app, /Private roster organization only\. This does not publish, reveal, or publicly link either profile/);
  assert.match(app, /Linked personas \(which of YOUR other personas this page reveals\)/);
});

test("rail grouping nests one backup, avoids duplication, expands on click, and fails flat", () => {
  const start = app.indexOf("function personaBackupGroups");
  const end = app.indexOf("function renderSidebar", start);
  assert.ok(start >= 0 && end > start, "backup rail helpers must remain extractable");
  const routes = [];
  let renders = 0;
  const context = vm.createContext({
    myPersonas: [
      { id: "a", name: "Alpha", handle: "alpha", avatar_url: "" },
      { id: "b", name: "Bravo", handle: "bravo", avatar_url: "" },
      { id: "c", name: "Charlie", handle: "charlie", avatar_url: "" },
    ],
    myPersonaBackups: [{ main_persona_id: "a", backup_persona_id: "b" }],
    personaBackupsReady: true,
    expandedBackupPersonaIds: new Set(),
    esc: (value) => String(value ?? ""),
    safeBgStyle: () => "",
    renderSidebar: () => { renders += 1; },
    go: (route) => routes.push(route),
  });
  vm.runInContext(app.slice(start, end), context);
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(personaBackupGroups().map(g=>[g.main.id,g.backup?.id||null]))", context)),
    [["a", "b"], ["c", null]],
  );
  const collapsed = vm.runInContext("personaRailHtml('a')", context);
  assert.match(collapsed, /aria-expanded="false"/);
  assert.match(collapsed, /class="railpersona railpersona-backup/);
  assert.match(collapsed, /railbackup-badge">Backup/);
  vm.runInContext("openRailMainPersona('a')", context);
  assert.deepEqual(routes, ["edit/a"]);
  assert.equal(renders, 1);
  assert.match(vm.runInContext("personaRailHtml('a')", context), /aria-expanded="true"/);
  const activeBackup = vm.runInContext("personaRailHtml('b')", context);
  assert.match(activeBackup, /id="rail-backup-a"[^>]*role="group"[^>]*>/);
  assert.doesNotMatch(activeBackup, /id="rail-backup-a"[^>]*hidden/);

  context.myPersonaBackups = [{ main_persona_id: "missing", backup_persona_id: "b" }];
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(personaBackupGroups().map(g=>g.main.id))", context)),
    ["a", "b", "c"],
  );
  context.personaBackupsReady = false;
  assert.deepEqual(
    JSON.parse(vm.runInContext("JSON.stringify(personaBackupGroups().map(g=>g.main.id))", context)),
    ["a", "b", "c"],
  );
});

test("editor, save, mobile picker, and deletion copy honor the private backup contract", () => {
  const save = functionBlock(app, "savePersona");
  assert.match(app, /id="eBackupPersona"/);
  assert.match(app, /migration 048 is applied/);
  assert.match(save, /backupChanged/);
  assert.match(save, /rpc\("set_persona_backup"/);
  assert.match(save, /backup assignment could not be verified after refresh/);
  assert.match(app, /the other persona stays and becomes standalone/);
  assert.match(ownerApp, /personaBackupGroups\(myPersonas/);
  assert.match(ownerApp, /↳ Backup for \$\{esc\(main\.name\)\} — \$\{esc\(backup\.name\)\}/);
});

test("mobile picker keeps a selectable backup immediately after its main", () => {
  const helperStart = app.indexOf("function personaBackupGroups");
  const helperEnd = app.indexOf("function renderSidebar", helperStart);
  const context = vm.createContext({
    myPersonas: [
      { id: "a", name: "Alpha", handle: "alpha" },
      { id: "b", name: "Bravo", handle: "bravo" },
      { id: "c", name: "Charlie", handle: "charlie" },
    ],
    myPersonaBackups: [{ main_persona_id: "a", backup_persona_id: "b" }],
    personaBackupsReady: true,
    expandedBackupPersonaIds: new Set(),
    ownerAppState: { selectedPersonaId: "b", briefPersonaFilter: "", schedulePersonaFilter: "", fanPersonaFilter: "", activityPersonaFilter: "" },
    ownerAppPersona: (id) => ({ id: id || "b", avatar_url: "" }),
    esc: (value) => String(value ?? ""), safeBgStyle: () => "", renderSidebar: () => {}, go: () => {},
  });
  vm.runInContext(app.slice(helperStart, helperEnd), context);
  vm.runInContext(functionBlock(ownerApp, "ownerAppPickerHtml"), context);
  const html = vm.runInContext('ownerAppPickerHtml("briefs",true)', context);
  assert.ok(html.indexOf("All personas") < html.indexOf("Alpha · @alpha"));
  assert.ok(html.indexOf("Alpha · @alpha") < html.indexOf("↳ Backup for Alpha — Bravo · @bravo"));
  assert.ok(html.indexOf("↳ Backup for Alpha — Bravo · @bravo") < html.indexOf("Charlie · @charlie"));
  assert.match(vm.runInContext('ownerAppPickerHtml("owner")', context), /value="b" selected>↳ Backup for Alpha/);
});

test("quick and full exports include backup and shared-account relationships without an undeclared state", () => {
  assert.match(app, /let sb=null[^;]*myAccountPersonaLinks=\[\][^;]*myPersonaBackups=\[\]/);
  const collect = functionBlock(app, "collectMyData");
  const context = vm.createContext({
    myProfile: { id: "owner" }, session: { user: { id: "owner", email: "owner@example.test" } },
    myPersonas: [], myContentPlans: [], myAccounts: [], myAccountConnections: [], myAccountPersonaLinks: [],
    myPersonaBackups: [{ main_persona_id: "a", backup_persona_id: "b" }], myDrafts: [], myAgentBindings: [],
    myAgentDestinations: [], myAgentSettings: null, myDiscovery: [], myKnowledge: [], myFanSessions: [],
    myFanMessages: [], myBackends: [],
  });
  vm.runInContext(collect, context);
  const output = JSON.parse(vm.runInContext("JSON.stringify(collectMyData())", context));
  assert.equal(output.version, 2);
  assert.deepEqual(output.account_persona_links, []);
  assert.deepEqual(output.persona_backup_relationships, [{ main_persona_id: "a", backup_persona_id: "b" }]);

  const full = functionBlock(app, "exportMyData");
  assert.match(full, /loadOwnedPages\("account_persona_links"/);
  assert.match(full, /loadOwnedPages\("persona_backup_relationships"/);
  assert.match(full, /account_persona_links:accountPersonaLinks\.data\|\|\[\]/);
  assert.match(full, /persona_backup_relationships:backupRelationships\.data\|\|\[\]/);
  assert.match(app, /"Backup Persona":backup/);
  assert.match(app, /add\("Backup Relationships"/);
});

test("restore remaps only newly created persona ids before assigning backup pairs", () => {
  const restore = functionBlock(app, "restoreImport");
  assert.match(restore, /restoredIds=new Map\(\)/);
  assert.match(restore, /restoredIds\.set\(p\.id,personaId\)/);
  assert.match(restore, /restoredIds\.get\(relationship\?\.main_persona_id\)/);
  assert.match(restore, /restoredIds\.get\(relationship\?\.backup_persona_id\)/);
  assert.match(restore, /restoreRpc\(context,"set_persona_backup"/);
  assert.doesNotMatch(restore, /owner:relationship/);
});
