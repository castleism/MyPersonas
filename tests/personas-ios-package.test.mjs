import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("iOS companion is a WKWebView scaffold over the real owner command center", async () => {
  const ios = path.join(root, "apps/personas-ios");
  const [readme, plist, app, owner, offline] = await Promise.all([
    read("apps/personas-ios/README.md"),
    read("apps/personas-ios/Info.plist"),
    read("apps/personas-ios/Sources/AppDelegate.swift"),
    read("apps/personas-ios/Sources/OwnerViewController.swift"),
    read("apps/personas-ios/Resources/offline-limitations.html"),
  ]);
  await access(path.join(ios, "Sources/OwnerViewController.swift"));
  assert.match(readme, /cannot produce an IPA|Do not submit to the App Store/i);
  assert.match(readme, /publishing_enabled`? stays \*\*false\*\*/);
  assert.match(plist, /online\.mypersonas\.owner\.debug/);
  assert.match(app, /OwnerViewController/);
  assert.match(owner, /WKWebView/);
  assert.match(owner, /mypersonas\.online\/#\/owner/);
  assert.match(owner, /NWPathMonitor/);
  assert.match(owner, /publishing_enabled stays false/);
  assert.match(owner, /mobile-owner-workflow-export-v1/);
  assert.match(owner, /ownerSurfaces/);
  assert.match(owner, /openSites/);
  assert.match(owner, /openExternalHTTPS/);
  assert.doesNotMatch(owner, /twitter\.com\/i\/api|graph\.facebook\.com|client_secret|SUPABASE_SERVICE/i);
  assert.match(offline, /publishing_enabled=false/);
  assert.match(offline, /cannot create, approve, or send/i);
  assert.match(offline, /Private feed/);
  assert.match(offline, /planning-only/);
});
