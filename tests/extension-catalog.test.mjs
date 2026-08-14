import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "MyPersonas.Online_v0");
const frontend = await readFile(path.join(siteRoot, "index.html"), "utf8");
const registry = JSON.parse(await readFile(path.join(siteRoot, "assets/Extensions/registry.json"), "utf8"));

test("extension registry includes Concept and the Personas desktop companion", () => {
  assert.deepEqual(new Set(registry.map((entry) => entry.id)), new Set(["concept", "personas"]));
  const personas = registry.find((entry) => entry.id === "personas");
  assert.equal(personas.githubRepo, "castleism/Personas_v0");
  assert.equal(personas.currentUrl, "assets/Downloads/Personas/current.json");
  assert.equal(personas.downloadBase, "assets/Downloads/Personas/");
});

test("every checked-in release fallback exists and parses", async () => {
  for (const entry of registry) {
    for (const field of ["releasesUrl", "currentUrl"]) {
      if (!entry[field]) continue;
      const fullPath = path.join(siteRoot, entry[field].replaceAll("/", path.sep));
      await access(fullPath);
      JSON.parse(await readFile(fullPath, "utf8"));
    }
  }
  const current = JSON.parse(await readFile(path.join(siteRoot, "assets/Downloads/Personas/current.json"), "utf8"));
  await access(path.join(siteRoot, "assets/Downloads/Personas", current.release.zip));
});

test("catalog renders bounded escaped release history with safe links", () => {
  assert.match(frontend, /releases\?per_page=10/);
  assert.match(frontend, /filter\(release=>!release\.draft/);
  assert.match(frontend, /String\(release\.notes\|\|""\)\.trim\(\)\.slice\(0,3000\)/);
  assert.match(frontend, /Release history \(\$\{releases\.length\}\)/);
  assert.match(frontend, /function catalogRelativeResource/);
  assert.match(frontend, /!value\.includes\("\.\."\)/);
  assert.match(frontend, /rel="noopener noreferrer"/);
  assert.doesNotMatch(frontend, /\$\{notes\}<\/p>/);
});
