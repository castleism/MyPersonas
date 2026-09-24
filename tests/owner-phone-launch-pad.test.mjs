import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

test("owner phone launch pad is public, installable, and catalog-driven", async () => {
  const [html, manifest, catalogSource, workflow, pwa, ownerApp] = await Promise.all([
    read("MyPersonas.Online_v0/owner-phone.html"),
    read("MyPersonas.Online_v0/owner-phone.webmanifest"),
    read("MyPersonas.Online_v0/owner-sites-catalog.js"),
    read(".github/workflows/pages.yml"),
    read("MyPersonas.Online_v0/pwa.js"),
    read("MyPersonas.Online_v0/owner-app.js")
  ]);

  assert.match(html, /href="\.\/owner-phone\.webmanifest"/);
  assert.match(html, /src="\.\/owner-sites-catalog\.js"/);
  assert.match(html, /src="\.\/pwa\.js"/);
  assert.doesNotMatch(html, /bookshop|checkout|affiliate/i);

  const manifestJson = JSON.parse(manifest);
  assert.equal(manifestJson.start_url, "./owner-phone.html");
  assert.equal(manifestJson.display, "standalone");
  assert.equal(manifestJson.short_name, "Owner check");

  const context = { window: {} };
  vm.runInNewContext(catalogSource, context);
  const catalog = context.window.OWNER_SITES_CATALOG;
  assert.ok(catalog.websites.some((item) => item.id === "beingteaco"));
  assert.ok(catalog.websites.some((item) => /Akiko/.test(item.note)));
  assert.ok(catalog.apps.some((item) => item.id === "workroom-bridge" && !item.url));
  assert.doesNotMatch(JSON.stringify(catalog), /brother_karunya|BrotherKarunya/i);

  assert.ok(workflow.includes("--include '/owner-phone.html'"));
  assert.match(pwa, /isAndroid/);
  assert.match(pwa, /Add to Home screen/);
  assert.match(ownerApp, /function renderOwnerSites\(/);
  assert.match(ownerApp, /function ownerAppRenderSitesLoaded\(/);
});
