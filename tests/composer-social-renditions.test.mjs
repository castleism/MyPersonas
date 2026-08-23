import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(
  new URL("../MyPersonas.Online_v0/index.html", import.meta.url),
  "utf8",
);

const composer = html.slice(
  html.indexOf("async function composerUploadSource()"),
  html.indexOf("async function openComposer()"),
);

test("composer prepares every exact social rendition for every AI declaration", () => {
  assert.match(composer, /rendition:"facebook",crop:\{width:1200,height:628\}/);
  assert.match(composer, /rendition:"instagram",crop:\{width:1080,height:1080\}/);
  assert.match(composer, /rendition:"x",crop:\{width:1080,height:1350\}/);
  assert.doesNotMatch(composer, /if\s*\(\s*mark\s*\)[\s\S]*rendition:"facebook"/);
  assert.match(composer, /source plus 3 \$\{mark\?"final watermarked":"exact social"\} crops/);
});
