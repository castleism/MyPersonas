import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("Expo companion is a WebView scaffold over the real owner command center", async () => {
  const [readme, app, json, manifest] = await Promise.all([
    read("apps/personas-expo/README.md"),
    read("apps/personas-expo/App.js"),
    read("apps/personas-expo/package.json"),
    read("apps/personas-expo/app.json"),
  ]);
  await access(path.join(root, "apps/personas-expo/App.js"));
  assert.match(readme, /cannot produce an IPA or Play AAB|Do not submit to a store/i);
  assert.match(readme, /publishing_enabled`? stays \*\*false\*\*/);
  assert.match(app, /mypersonas\.online\/#\/owner/);
  assert.match(app, /publishing_enabled=false/);
  assert.match(app, /allowedOwnerUrl/);
  assert.match(app, /OWNER_SURFACES/);
  assert.match(app, /setReloadKey/);
  assert.match(app, /#\/feed/);
  assert.match(app, /Linking\.addEventListener/);
  assert.doesNotMatch(app, /twitter\.com\/i\/api|graph\.facebook\.com|client_secret|SUPABASE_SERVICE/i);
  assert.match(json, /react-native-webview/);
  assert.equal(JSON.parse(manifest).expo.extra.publishingEnabled, false);
});
