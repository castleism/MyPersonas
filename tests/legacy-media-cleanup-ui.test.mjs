import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../MyPersonas.Online_v0/index.html", import.meta.url), "utf8");
const block = html.slice(
  html.indexOf("// ---------- owner-only legacy media inventory"),
  html.indexOf("// ---------- network feed pagination"),
);

test("owner navigation exposes a bounded legacy-media cleanup route", () => {
  assert.match(html, /siteGo\('legacy-media'\)/);
  assert.match(html, /nav\(view==="legacy-media","legacy-media","image","Media cleanup"\)/);
  assert.match(html, /if\(view==="legacy-media"\)return renderLegacyMediaCleanup\(\)/);
});

test("cleanup calls only opaque inventory, list, and exact-preview actions behind AAL2", () => {
  assert.match(block, /requireAal2ForSensitiveAction\("review legacy media"\)/);
  assert.match(block, /\{action:"inventory",limit:250\}/);
  assert.match(block, /\{action:"list",after:[\s\S]*limit:50\}/);
  assert.match(block, /\{action:"preview",itemId\}/);
  assert.match(block, /boundedAssetBlob\(response,15\*1024\*1024\)/);
  assert.match(block, /credentials:"omit",referrerPolicy:"no-referrer",cache:"no-store"/);
});

test("cleanup UI does not request or render raw paths, URLs, or hashes", () => {
  assert.doesNotMatch(block, /item\.(?:path|raw_path|raw_url|url_sha256|path_sha256|source_sha256)/);
  assert.doesNotMatch(block, /data-legacy-(?:path|url|hash)/);
  assert.match(block, /filenames and old <code>-sd<\/code> markers are never treated as proof/);
  assert.match(block, /Preview-only first release slice/);
  assert.match(block, /Save a copy/);
});
