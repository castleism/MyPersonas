import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("phone header keeps the complete menu and compacts duplicate overview routes", async () => {
  const html = await readFile(path.join(root, "MyPersonas.Online_v0", "index.html"), "utf8");

  assert.match(html, /<span class="menuwrap" data-overview-nav>/);
  assert.match(html, /<button onclick="siteGo\('persona-settings'\)">Persona settings<\/button>/);
  assert.match(html, /@media\(max-width:600px\)\{[\s\S]*?header\{display:grid;grid-template-columns:auto minmax\(0,1fr\)/);
  assert.match(html, /header>nav\{grid-column:1\/-1;grid-row:2;[\s\S]*?flex-wrap:nowrap/);
  assert.match(html, /header>#personaViewSwitcher\{grid-column:1\/-1;grid-row:3/);
  assert.match(html, /#gsearch\{display:block;[\s\S]*?max-width:none\}/);
  assert.match(html, /body:not\(\.persona-view-mode\) header>nav>\.menuwrap\{display:inline-block\}/);
  assert.match(html, /body:not\(\.persona-view-mode\) #siteMenu\{max-height:calc\(100dvh - 180px - env\(safe-area-inset-bottom\)\);overflow-y:auto/);
  assert.match(html, /body:not\(\.persona-view-mode\) header>nav>button:not\(#authBtn\)\{display:none\}/);
  assert.match(html, /body\.persona-view-mode header>nav>button\[data-persona-nav\]:not\(\[hidden\]\),body\.persona-view-mode header>nav>#primaryHomeBtn\{display:inline-block!important\}/);
  assert.match(html, /body\.persona-view-mode header>nav>#authBtn\{margin-left:auto\}/);
});
