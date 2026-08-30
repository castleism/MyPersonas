import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("Facebook setup separates the app dashboard from API reference material", async () => {
  const [page, guide, checklist] = await Promise.all([
    read("MyPersonas.Online_v0/provider-setup.html"),
    read("MyPersonas.Online_v0/PROVIDER-SETUP-GUIDE.md"),
    read("MyPersonas.Online_v0/DEVELOPER-ACCESS-CHECKLIST.md"),
  ]);

  const facebookCard = page.match(/<article class="provider" data-provider="facebook"[\s\S]*?<\/article>/)?.[0] || "";
  const guideSection = guide.match(/### Facebook Pages \+ Instagram[^\n]*[\s\S]*?(?=\n### )/)?.[0] || "";
  assert.ok(facebookCard, "Facebook provider card must remain extractable");
  assert.ok(guideSection, "Facebook and Instagram setup section must remain extractable");

  for (const source of [facebookCard, guideSection]) {
    assert.match(source, /https:\/\/developers\.facebook\.com\/apps\//);
    assert.match(source, /https:\/\/developers\.facebook\.com\/docs\/pages-api\/getting-started\//);
    assert.match(source, /https:\/\/developers\.facebook\.com\/docs\/pages-api\/posts\//);
  }

  for (const source of [page, guide, checklist]) {
    assert.match(source, /https:\/\/business\.facebook\.com\/settings\//);
    assert.doesNotMatch(source, /Official Facebook API workspace/);
    assert.doesNotMatch(source, /https:\/\/www\.postman\.com\/meta\/facebook\/overview/);
  }

  assert.match(page, /Meta App Dashboard/);
  assert.match(page, /app configuration happens in the dashboard above/i);
  assert.match(page, /Pages API reference/);
  assert.match(page, /developers\.facebook\.com\/apps\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /developers\.facebook\.com\/docs\/pages-api\/getting-started\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /developers\.facebook\.com\/docs\/pages-api\/posts\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /developers\.facebook\.com\/docs\/instagram-platform\/instagram-api-with-facebook-login\//);
  assert.doesNotMatch(page, /Official Instagram API requirements/);
});
