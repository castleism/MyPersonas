import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const site = path.join(root, "nooyouniverse.com");
const read = (relative) => readFile(path.join(site, relative), "utf8");

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("Noo YouNiverse public PWA shell is installable and never requests push", async () => {
  const [manifest, worker, helper, offline, index] = await Promise.all([
    read("manifest.webmanifest"),
    read("service-worker.js"),
    read("pwa.js"),
    read("offline.html"),
    read("index.html"),
  ]);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.display, "standalone");
  assert.equal(parsed.prefer_related_applications, false);
  assert.ok(parsed.icons.some((icon) => icon.purpose === "maskable"));
  assert.match(index, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(index, /src="\.\/pwa\.js"/);
  assert.match(helper, /beforeinstallprompt/);
  assert.match(helper, /Android Chrome/);
  assert.doesNotMatch(helper, /PushManager|Notification\.requestPermission|subscribe\s*\(/);
  assert.match(worker, /nooyouniverse-public-shell-/);
  assert.doesNotMatch(worker, /skipWaiting\s*\(/);
  assert.doesNotMatch(worker, /cache\.put\s*\(/);
  assert.doesNotMatch(worker, /supabase|noo_waitlist/i);
  assert.match(offline, /cannot publish, approve, or change anything/i);
  assert.doesNotMatch(offline, /https?:\/\//i);

  const list = worker.match(/const PUBLIC_SHELL_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(list);
  const paths = [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(!paths.includes("./index.html"));
  for (const relativePath of paths) {
    await access(path.join(site, relativePath.slice(2)));
  }
  assert.deepEqual(pngDimensions(await readFile(path.join(site, "assets/icon-192.png"))), { width: 192, height: 192 });
  assert.deepEqual(pngDimensions(await readFile(path.join(site, "assets/icon-512.png"))), { width: 512, height: 512 });
});
