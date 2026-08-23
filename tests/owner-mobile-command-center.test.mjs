import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.join(root, "MyPersonas.Online_v0");
const read = (value) => readFile(path.join(root, value), "utf8");

test("owner command center is packaged and its external script parses", async () => {
  const [html, source, css, workflow] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/owner-app.js"),
    read("MyPersonas.Online_v0/owner-app.css"),
    read(".github/workflows/pages.yml"),
  ]);
  assert.match(html, /href="\.\/owner-app\.css\?v=\d{8}-\d+"/);
  assert.match(html, /src="\.\/owner-app\.js\?v=\d{8}-\d+"/);
  for (const route of ["owner", "briefs", "schedule", "fan-inbox", "activity", "notifications"]) {
    assert.match(html, new RegExp(`view===\\"${route}\\"`));
  }
  assert.match(html, /id="ownerMobileNav"/);
  assert.match(html, /id="ownerMobileMore"/);
  assert.match(html, /id="ownerPersonaCompanion"/);
  assert.doesNotMatch(html, /id="(?:bugBtnMobile|pageChatBtnMobile)"/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.oa-mobile-nav\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.oa-companion-dialogue/);
  assert.match(css, /@media\(max-width:520px\)/);
  assert.match(source, /function ownerAppSyncChrome\(\)/);
  assert.match(source, /function ownerAppRememberPersona\(/);
  assert.match(source, /function ownerAppSelectRoutePersona\(/);
  assert.match(source, /function ownerAppToggleMore\(/);
  assert.match(source, /function ownerAppOpenCompanionNotice\(\)/);
  assert.ok(workflow.includes("--include '/owner-app.css'"));
  assert.ok(workflow.includes("--include '/owner-app.js'"));
  new vm.Script(source, { filename: "owner-app.js" });
});

test("route and dropdown persona changes update the companion selection", async () => {
  const [html, source] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/owner-app.js"),
  ]);
  const start = source.indexOf("function ownerAppSelectionKey");
  const end = source.indexOf("function ownerAppSelectPersona", start);
  assert.ok(start >= 0 && end > start, "selection helpers must remain extractable");
  const writes = [];
  let syncs = 0;
  const context = vm.createContext({
    myPersonas: [
      { id: "persona-a", handle: "alpha" },
      { id: "persona-b", handle: "bravo" },
    ],
    ownerAppState: { selectedPersonaId: "persona-a" },
    session: { user: { id: "owner-1" } },
    localStorage: { getItem: () => "", setItem: (key, value) => writes.push([key, value]) },
    ownerAppSyncCompanion() { syncs += 1; },
  });
  vm.runInContext(source.slice(start, end), context);

  assert.equal(vm.runInContext('ownerAppSelectRoutePersona("edit", "persona-b")', context), "persona-b");
  assert.equal(context.ownerAppState.selectedPersonaId, "persona-b");
  assert.deepEqual(writes.at(-1), ["aliaspaces_owner_persona_owner-1", "persona-b"]);
  assert.equal(syncs, 1);
  assert.equal(vm.runInContext('ownerAppSelectRoutePersona("p", "alpha")', context), "persona-a");
  assert.equal(context.ownerAppState.selectedPersonaId, "persona-a");
  assert.equal(syncs, 2);
  assert.match(source, /function ownerAppSelectPersona[\s\S]*?ownerAppRememberPersona\(personaId\)/);
  assert.match(html, /ownerAppSelectRoutePersona\(view,arg\)/);
  assert.match(html, /owner-app\.js\?v=20260822-6/);
});

test("briefing workflow keeps four channels and truthful manual boundaries", async () => {
  const source = await read("MyPersonas.Online_v0/owner-app.js");
  for (const channel of ["x", "instagram", "facebook", "website"]) {
    assert.match(source, new RegExp(`key: \\"${channel}\\"`));
  }
  assert.match(source, /Planning only · no auto-post/);
  assert.match(source, /Material edits clear approval/);
  assert.match(source, /Siloed window · bridge pending/);
  assert.match(source, /No password, cookie, or API key is included/);
  assert.match(source, /Highlight selected text/);
  assert.match(source, /owner_comment/);
  assert.match(source, /routeKey/);
  assert.match(source, /persona_voice_draft/);
});

test("migration 045 adds owner-only annotations, kits, notifications, and activity", async () => {
  const [researchSql, sql] = await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/044-persona-research-briefs.sql"),
    read("MyPersonas.Online_v0/sql-updates/045-owner-mobile-command-center.sql"),
  ]);
  for (const table of [
    "research_brief_annotations",
    "persona_content_packages",
    "persona_content_variants",
    "owner_notifications",
    "persona_activity_events",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /channel in \('x','instagram','facebook','website'\)/);
  assert.match(sql, /invalidate_content_package_approval/);
  assert.match(sql, /approve_content_package/);
  assert.match(sql, /schedule_content_package/);
  assert.match(sql, /guard_content_package_material_edit/);
  assert.match(sql, /foreign key \(brief_id, owner\)/);
  assert.match(sql, /This does not auto-post|No external provider write/i);
  assert.doesNotMatch(sql, /ab285482-91cc-48ea-b67f-956179dea432/i);
  assert.doesNotMatch(researchSql, /ab285482-91cc-48ea-b67f-956179dea432/i);
});

test("research endpoints require an owned bearer session and bounded reviewed hosts", async () => {
  const [runner, importer] = await Promise.all([
    read("supabase/functions/research-brief-run/index.ts"),
    read("supabase/functions/import-research-brief/index.ts"),
  ]);
  for (const source of [runner, importer]) {
    assert.match(source, /admin\.auth\.getUser\(token\)/);
    assert.match(source, /\.eq\("owner", owner\)/);
    assert.match(source, /Missing bearer session/);
    assert.match(source, /Origin not allowed/);
    assert.doesNotMatch(source, /Access-Control-Allow-Origin"\s*:\s*"\*"/);
    assert.doesNotMatch(source, /ab285482-91cc-48ea-b67f-956179dea432/i);
  }
  assert.match(runner, /resolveAiProviderEndpoint/);
  assert.match(runner, /ai_backend_get_key/);
  assert.doesNotMatch(runner, /legacyKey/);
});

test("retired standalone console contains no private roster or unauthenticated import client", async () => {
  const html = await read("gemini-research-console.html");
  assert.match(html, /old console embedded a fixed persona roster/i);
  assert.match(html, /signed-in owner app/i);
  assert.doesNotMatch(html, /const personas\s*=/);
  assert.doesNotMatch(html, /functions\/v1\/import-research-brief/);
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
});

test("public offline shell does not cache owner application code", async () => {
  const worker = await read("MyPersonas.Online_v0/service-worker.js");
  const allowlist = worker.match(/const PUBLIC_SHELL_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || "";
  assert.doesNotMatch(allowlist, /owner-app\.(?:js|css)/);
  assert.doesNotMatch(allowlist, /index\.html/);
});
