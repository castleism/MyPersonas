import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("persona view assets are packaged and external scripts parse", async () => {
  const [html, source, css, workflow] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/persona-view.js"),
    read("MyPersonas.Online_v0/persona-view.css"),
    read(".github/workflows/pages.yml"),
  ]);
  new vm.Script(source, { filename: "persona-view.js" });
  assert.match(html, /href="\.\/persona-view\.css\?v=\d{8}-\d+"/);
  assert.match(html, /src="\.\/persona-view\.js\?v=\d{8}-\d+"/);
  assert.match(html, /id="personaViewSwitcher"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(css, /body\.persona-view-mode/);
  assert.match(workflow, /--include '\/persona-view\.css'/);
  assert.match(workflow, /--include '\/persona-view\.js'/);
});

test("UID-scoped restore validates the acting persona and never falls back in persona mode", async () => {
  const source = await read("MyPersonas.Online_v0/owner-app.js");
  const start = source.indexOf("function ownerAppSelectionKey");
  const end = source.indexOf("function ownerAppSelectPersona", start);
  assert.ok(start >= 0 && end > start);
  const storage = new Map();
  const state = { selectedPersonaId: "", viewMode: "overview", perspectiveGeneration: 0 };
  const context = vm.createContext({
    myPersonas: [{ id: "persona-a", handle: "alpha" }, { id: "persona-b", handle: "bravo" }],
    ownerAppState: state,
    session: { user: { id: "owner-1" } },
    localStorage: { getItem: (key) => storage.get(key) || "", setItem: (key, value) => storage.set(key, value) },
    location: { hash: "#/owner" },
  });
  vm.runInContext(source.slice(start, end), context);

  storage.set("aliaspaces_owner_persona_owner-1", "deleted-persona");
  storage.set("aliaspaces_view_mode_owner-1", "persona");
  context.ownerAppRestorePersona("owner-1");
  assert.equal(state.viewMode, "overview");
  assert.equal(context.ownerAppPersonaModeActor(), null);

  storage.set("aliaspaces_owner_persona_owner-1", "persona-a");
  storage.set("aliaspaces_view_mode_owner-1", "persona");
  context.ownerAppRestorePersona("owner-1");
  assert.equal(state.viewMode, "persona");
  assert.equal(context.ownerAppPersonaModeActor().id, "persona-a");
  assert.equal(context.ownerAppSelectRoutePersona("p", "bravo"), "");
  assert.equal(state.selectedPersonaId, "persona-a", "opening an owned sibling must not switch the actor");
});

test("persona mode uses exact-actor projections and fails closed when migration 058 is absent", async () => {
  const [source, html] = await Promise.all([
    read("MyPersonas.Online_v0/persona-view.js"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  const clientSource = source + "\n" + html;
  for (const rpc of [
    "my_persona_mode_status",
    "my_persona_mode_connections",
    "my_persona_mode_feed",
    "my_persona_mode_profile_posts",
    "my_persona_mode_profile",
    "my_persona_mode_post_panel",
    "persona_mode_follow_persona",
    "persona_mode_unfollow_persona",
    "persona_mode_request_friendship",
    "persona_mode_respond_friendship",
    "persona_mode_cancel_friendship_request",
    "persona_mode_remove_friendship",
    "persona_mode_add_comment",
    "persona_mode_toggle_reaction",
    "persona_mode_delete_comment",
  ]) assert.match(clientSource, new RegExp(`\\"${rpc}\\"`));
  assert.match(source, /will not fall back to account-wide reads/);
  assert.match(source, /ownerAppPerspectiveSnapshotCurrent/);
  assert.match(source, /if \(!socialActionSnapshotCurrent\(actor\)\) return/);
  assert.match(html, /ownerAppIsPersonaMode\(\)\)return renderPersonaModeProfile/);
  assert.match(source, /Block for all my personas/);
  assert.match(source, /Mute for all my personas/);
  assert.doesNotMatch(source, /ownerAppPersona\(/, "acting authority must never use the display helper that falls back");
});

test("migration 058 is mirrored and private visibility is bound to one exact actor", async () => {
  const [sql, mirror] = await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/058-persona-view-mode.sql"),
    read("supabase/migrations/20260823000000_persona_view_mode.sql"),
  ]);
  assert.equal(mirror, sql);
  const canView = sql.slice(sql.indexOf("create or replace function public.persona_mode_can_view"), sql.indexOf("create or replace function public.my_persona_mode_status"));
  assert.doesNotMatch(canView, /persona_visible\s*\(/);
  assert.match(canView, /actor\.owner=auth\.uid\(\)/);
  assert.match(canView, /least\(friendship\.follower,friendship\.target\)=least\(actor\.id,target\.id\)/);
  assert.match(canView, /blocked_identity\.owner=actor\.owner/);
  assert.match(canView, /hidden_dependency\.kind in \('block','mute'\)/);
  assert.match(canView, /dependency_blocked_viewer\.blocker=relative\.owner/);
  assert.match(sql, /v_target is distinct from p_actor_persona_id/);
  assert.match(sql, /comment\.persona_id=p_actor_persona_id/);
  assert.match(sql, /my_persona_mode_post_panel/);
  assert.match(sql, /persona_mode_actor_can_interact\(p_actor_persona_id\)/);
  assert.match(sql, /Both feed cursor fields are required together/);
  assert.match(sql, /least\(greatest\(coalesce\(p_limit,30\),1\),50\)/);
  assert.match(sql, /limit 200/);
  assert.match(sql, /limit 101/);
  assert.match(sql, /limit 501/);
  assert.match(sql, /case when access\.allowed then target\.id else null end/);
  assert.match(sql, /'Private persona'/);
  assert.match(sql, /persona_mode_cancel_friendship_request/);
  assert.match(sql, /persona_mode_lock_exact_scope/);
  assert.match(sql, /v_dependency_ids uuid\[\]/);
  assert.match(sql, /not \(dependency\.dependency_persona_id=any\(v_dependency_ids\)\)/);
  assert.match(sql, /raise sqlstate '40001'/);
  assert.match(sql, /pg_catalog\.hashtextextended\(v_owner::text,51051060\)/);
  assert.match(sql, /pg_catalog\.hashtextextended\(v_owner::text,51051\)/);
  assert.match(sql, /pg_catalog\.hashtextextended\(v_owner::text,51051052\)/);
  assert.match(sql, /to authenticated/);
  assert.match(sql, /from public,anon,authenticated/);
});

test("comments and reactions resolve one actor and ignore sibling reaction state in persona mode", async () => {
  const [html, source] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/persona-view.js"),
  ]);
  assert.match(html, /const acting=typeof ownerAppPersonaModeActor/);
  assert.match(html, /new Set\(acting\?\[acting\.id\]:myPersonas\.map/);
  assert.match(html, /resolveSocialActor\(publicInteractionPersonas\(\),"react"\)/);
  assert.match(html, /resolveSocialActor\(publicInteractionPersonas\(\),"comment"\)/);
  assert.match(html, /persona_mode_toggle_reaction/);
  assert.match(html, /persona_mode_add_comment/);
  assert.match(source, /my_persona_mode_post_panel/);
  assert.match(source, /if \(ownerAppIsPersonaMode\(\)\)/);
  const exactBranch = source.slice(source.indexOf("if (ownerAppIsPersonaMode())"), source.indexOf("const id = await pickMine"));
  assert.match(exactBranch, /ownerAppPersonaModeActor\(\)/);
  assert.doesNotMatch(exactBranch, /pool\.some|pickMine/);
  assert.doesNotMatch(source.slice(source.indexOf("async function resolveSocialActor"), source.indexOf("function socialActionSnapshotCurrent")), /pool\[0\]/);
});

test("persona home uses server capabilities, redacts private requests, and keeps exact persona actions", async () => {
  const [source, governance, owner] = await Promise.all([
    read("MyPersonas.Online_v0/persona-view.js"),
    read("MyPersonas.Online_v0/platform-governance.js"),
    read("MyPersonas.Online_v0/owner-app.js"),
  ]);
  assert.match(source, /Promise\.all\(\[\s*sb\.rpc\("my_persona_mode_status"/);
  assert.match(source, /capabilities\.can_interact === true/);
  assert.match(source, /Profile details are unavailable/);
  assert.match(source, /personaModeCancelFriendRequest\('\$\{row\.relationship_id\}'\)/);
  assert.match(source, /Connection cards are bounded to 200/);
  assert.match(source, /comments_truncated \|\| result\.data\.reactions_truncated/);
  assert.match(source, /\["public", "unlisted"\]\.includes\(target\.visibility\)/);
  assert.match(source, /!sameOwner \? `<button class="btn danger sm"/);
  assert.match(governance, /governanceFriendInvitePersonas/);
  assert.match(governance, /ownerAppPersonaModeActor\(\)/);
  assert.match(owner, /const personaMode = typeof ownerAppIsPersonaMode === "function" && ownerAppIsPersonaMode\(\)/);
  assert.match(owner, /if \(nav\) nav\.hidden = !authenticated \|\| personaMode/);
  assert.match(owner, /if \(companion\) companion\.hidden = !authenticated \|\| mobile \|\| personaMode/);
});

test("persona profile renders configured modules and generic metadata is restored before authorization", async () => {
  const [source, html] = await Promise.all([
    read("MyPersonas.Online_v0/persona-view.js"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  for (const moduleName of ["live", "music", "about", "fan_chat", "links", "top8", "linked", "family", "revenue", "albums", "feed"]) {
    assert.match(source, new RegExp(`M\\(\"${moduleName}\"\\)`));
  }
  assert.match(source, /normalizePersonaPageLayout\(payload\.layout\)/);
  assert.match(source, /pageLayout\.widgets\.map\(personaLayoutWidgetHtml\)/);
  assert.match(source, /isSelf && canAct \? composerHtml\(p\)/);
  const route = html.slice(html.indexOf("async function route()"), html.indexOf("// ---------- sign in ----------"));
  assert.match(route, /setMeta\("AliaSpaces — every persona, one home"/);
  assert.ok(route.indexOf("setMeta(") < route.indexOf("personaViewRouteGuard"));
});

test("persona-view SQL harness covers reapply, API roles, RLS, redaction, and runtime execution", async () => {
  const [seed, runtime, script, pkg] = await Promise.all([
    read("tests/sql/058-persona-view-mode-seed.sql"),
    read("tests/sql/058-persona-view-mode-runtime.sql"),
    read("scripts/test-persona-view-sql.ps1"),
    read("package.json"),
  ]);
  assert.match(seed, /alter table public\.personas enable row level security/);
  assert.match(seed, /lock_persona_publication_mutation/);
  assert.match(runtime, /set role anon/);
  assert.match(runtime, /set role authenticated/);
  assert.match(runtime, /Private outgoing request identity was not safely redacted/);
  assert.match(runtime, /persona_mode_cancel_friendship_request/);
  assert.match(runtime, /dblink_send_query\('dependency_race'/);
  assert.match(runtime, /exception when serialization_failure/);
  assert.match(script, /058-persona-view-mode\.sql[\s\S]*058-persona-view-mode\.sql/);
  assert.match(script, /docker rm --force \$taskContainer/);
  assert.equal(JSON.parse(pkg).scripts["test:persona-view-sql"], "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-persona-view-sql.ps1");
});

test("Page looks renders semantic full images instead of cropped background previews", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  const css = html.slice(html.indexOf(".lookgrid"), html.indexOf("#sdPanel"));
  assert.match(css, /\.lookprev img\{[^}]*object-fit:contain/);
  assert.doesNotMatch(css, /cover/);
  assert.doesNotMatch(css, /\.lookprev img\{[^}]*border-radius/);
  const editor = html.slice(html.indexOf("<h3>${ico(\"image\")}Page looks"), html.indexOf("<label>Profile song", html.indexOf("Page looks")));
  assert.match(editor, /personaLookPreviewHtml\(p\[k\],lbl,targetId,personaProfileMediaAssetId\(p,k\)\)/);
  assert.doesNotMatch(editor, /safeBgStyle\(p\[k\]\)/);
  assert.match(html, /full uncropped preview/);
  assert.match(html, /data-owner-persona-id/);
  assert.match(html, /data-persona-editor-asset="true"/);
  assert.match(html, /onerror="hydrateOwnerMediaElement\(this\)\.catch\(\(\)=>personaLookPreviewFailed\(this\)\)"/);
  assert.match(html, /Preview unavailable — choose another file or clear this field/);
  assert.match(html, /ownsEditorAsset/);
  assert.match(editor, /aria-label="Choose \$\{esc\(lbl\)\} file"/);
  const setPrev = html.slice(html.indexOf("function setPrev"), html.indexOf("const SD_SIZES"));
  assert.match(setPrev, /personaLookPreviewHtml/);
  assert.doesNotMatch(setPrev, /backgroundImage|cover/);
});
