import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(root, "MyPersonas.Online_v0", "index.html");

async function editorSections() {
  const html = await readFile(htmlPath, "utf8");
  const renderStart = html.indexOf("async function renderEdit(");
  const renderEnd = html.indexOf("// ----- album manager -----", renderStart);
  const saveStart = html.indexOf("async function savePersona(", renderEnd);
  const saveEnd = html.indexOf("async function deletePersona(", saveStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, "renderEdit must remain extractable");
  assert.ok(saveStart >= 0 && saveEnd > saveStart, "savePersona must remain extractable");
  return {
    html,
    renderEdit: html.slice(renderStart, renderEnd),
    savePersona: html.slice(saveStart, saveEnd),
  };
}

test("existing persona editor has a responsive top Save and view page action", async () => {
  const { html, renderEdit } = await editorSections();
  assert.match(renderEdit, /class="matrix-head"/);
  assert.match(renderEdit, /class="matrix-actions"/);
  assert.match(renderEdit, /\$\{editId\?`[\s\S]*id="personaEditViewPage"[\s\S]*`:""\}/);
  assert.match(renderEdit, /id="personaEditViewPage"[^>]*type="button"/);
  assert.match(renderEdit, /onclick="savePersona\('view'\)"/);
  assert.match(renderEdit, />Save &amp; view page<\/button>/);
  assert.match(html, /@media\(max-width:600px\)[\s\S]*\.matrix-actions>\.btn\{flex:1 1 140px/);
});

test("Save and view waits for the completed save and routes with the refreshed persisted handle", async () => {
  const { savePersona } = await editorSections();
  assert.match(savePersona, /async function savePersona\(destination="default"\)/);
  assert.match(savePersona, /const savedPersona=_pid\?myPersonas\.find\(p=>p\.id===_pid\):null/);
  assert.match(savePersona, /if\(destination==="view"&&savedPersona\?\.handle\)\{go\("p\/"\+savedPersona\.handle\);return\}/);
  assert.match(savePersona, /go\(requiresReview\?"review\/"\+_pid:"p\/"\+\(savedPersona\?\.handle\|\|handle\)\)/);

  const finalRefresh = savePersona.lastIndexOf("await loadMine(uid,authLoadGeneration)");
  const viewRoute = savePersona.indexOf('if(destination==="view"');
  assert.ok(finalRefresh >= 0 && viewRoute > finalRefresh, "page navigation must wait for the final owner-data refresh");
  assert.doesNotMatch(
    savePersona.slice(viewRoute, savePersona.indexOf("go(requiresReview", viewRoute)),
    /document\.getElementById\("eHandle"\)|\+handle/,
    "the view destination must not use an unsaved or stale handle",
  );
});
