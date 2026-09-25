import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "MyPersonas.Online_v0");
const publicIconSources = new Map([
  ["favicon.ico", "brand/app-icon/favicon.ico"],
  ["icon.svg", "brand/app-icon/icon.svg"],
  ["icon-180.png", "brand/app-icon/icon-180.png"],
  ["icon-192.png", "brand/app-icon/icon-192.png"],
  ["icon-512.png", "brand/app-icon/icon-512.png"],
  ["icon-maskable-512.png", "brand/app-icon/icon-maskable-512.png"]
]);

async function readSiteFile(relativePath) {
  return readFile(path.join(siteRoot, relativePath), "utf8");
}

function assertRelativeSitePath(value, label) {
  assert.match(value, /^\.\//, `${label} must use a GitHub Pages-safe relative URL`);
  assert.doesNotMatch(value, /^(?:\/|https?:|data:)/i, `${label} must not be root-relative or remote`);
}

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("public icon mirrors are exact, valid copies of the approved brand set", async () => {
  for (const [publicPath, sourcePath] of publicIconSources) {
    const [publicBytes, sourceBytes] = await Promise.all([
      readFile(path.join(siteRoot, publicPath)),
      readFile(path.join(siteRoot, sourcePath))
    ]);
    assert.deepEqual(publicBytes, sourceBytes, `${publicPath} must match ${sourcePath}`);
  }

  assert.deepEqual(
    [...(await readFile(path.join(siteRoot, "favicon.ico"))).subarray(0, 4)],
    [0, 0, 1, 0],
    "favicon.ico must be a Windows icon file"
  );
  const svg = await readSiteFile("icon.svg");
  assert.match(svg, /^<svg\b/);
  assert.doesNotMatch(svg, /<script\b/i);
  assert.doesNotMatch(svg, /(?:href|xlink:href)=["']https?:\/\//i);
});

test("manifest uses scoped relative routes and complete brand icons", async () => {
  const manifest = JSON.parse(await readSiteFile("manifest.webmanifest"));
  assert.equal(manifest.id, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.prefer_related_applications, false);

  const expectedDimensions = new Map([
    ["./icon-192.png", { width: 192, height: 192 }],
    ["./icon-512.png", { width: 512, height: 512 }],
    ["./icon-maskable-512.png", { width: 512, height: 512 }]
  ]);

  for (const icon of manifest.icons) {
    assertRelativeSitePath(icon.src, `manifest icon ${icon.src}`);
    const fullPath = path.join(siteRoot, icon.src.slice(2));
    await access(fullPath);
    assert.deepEqual(pngDimensions(await readFile(fullPath)), expectedDimensions.get(icon.src));
  }

  assert.deepEqual(new Set(manifest.icons.map((icon) => icon.src)), new Set(expectedDimensions.keys()));
  assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
  assert.deepEqual(
    pngDimensions(await readFile(path.join(siteRoot, "icon-180.png"))),
    { width: 180, height: 180 }
  );

  for (const shortcut of manifest.shortcuts) {
    assertRelativeSitePath(shortcut.url, `shortcut ${shortcut.name}`);
    assert.match(shortcut.url, /^\.\/#\//);
    assert.deepEqual(shortcut.icons, [{
      src: "./icon-192.png",
      sizes: "192x192",
      type: "image/png"
    }]);
  }
});

test("service worker precaches only existing public shell files", async () => {
  const source = await readSiteFile("service-worker.js");
  const list = source.match(/const PUBLIC_SHELL_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  assert.ok(list, "PUBLIC_SHELL_PATHS allowlist was not found");

  const paths = [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(paths.includes("./offline.html"));
  assert.ok(paths.includes("./manifest.webmanifest"));
  assert.ok(!paths.includes("./index.html"), "signed-in application HTML must not be precached");
  assert.ok(!paths.includes("./owner-app.js"), "owner workflow must not be in the public offline cache");
  assert.ok(!paths.includes("./mobile-owner-workflow.js"), "owner workflow helpers must not be in the public offline cache");

  for (const relativePath of paths) {
    assertRelativeSitePath(relativePath, `cached file ${relativePath}`);
    assert.doesNotMatch(relativePath, /(?:supabase|api|auth|persona|upload)/i);
    await access(path.join(siteRoot, relativePath.slice(2)));
  }

  assert.doesNotMatch(source, /skipWaiting\s*\(/, "updates must not replace a live app session");
  assert.doesNotMatch(source, /cache\.put\s*\(/, "runtime responses must not enter Cache Storage");
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /requestUrl\.origin !== SCOPE_URL\.origin/);
});

test("offline fallback is public, relative, and explicitly non-mutating", async () => {
  const html = await readSiteFile("offline.html");
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /href="\.\/manifest\.webmanifest"/);
  assert.match(html, /src="\.\/icon\.svg"/);
  assert.match(html, /does not store authenticated API responses or private persona data/i);
  assert.match(html, /cannot publish, approve, or change anything/i);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("install helper registers a path-relative worker without synthetic push state", async () => {
  const source = await readSiteFile("pwa.js");
  assert.match(source, /new URL\("\.\/service-worker\.js", document\.baseURI\)/);
  assert.match(source, /updateViaCache: "none"/);
  assert.match(source, /beforeinstallprompt/);
  assert.match(source, /aria-live/);
  assert.doesNotMatch(source, /PushManager|pushManager|Notification\.requestPermission|subscribe\s*\(/);
  assert.match(source, /Android Chrome/);
  assert.match(source, /Add to Home screen/);
});

test("the app head and Pages artifact include the complete PWA shell", async () => {
  const [html, workflow] = await Promise.all([
    readSiteFile("index.html"),
    readFile(path.join(repoRoot, ".github/workflows/pages.yml"), "utf8")
  ]);

  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="icon" type="image\/x-icon" href="\.\/favicon\.ico" sizes="any">/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\.\/icon\.svg">/);
  assert.match(html, /<meta name="theme-color" content="#1877f2">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\.\/icon-180\.png">/);
  assert.match(html, /<script src="\.\/pwa\.js" defer><\/script>/);

  for (const releasePath of [
    "/assets/",
    "/assets/***",
    "/favicon.ico",
    "/icon.svg",
    "/icon-180.png",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-maskable-512.png",
    "/manifest.webmanifest",
    "/service-worker.js",
    "/pwa.js",
    "/offline.html",
    "/mobile-owner-workflow.js"
  ]) {
    assert.ok(workflow.includes(`--include '${releasePath}'`), `Pages artifact must include ${releasePath}`);
  }

  assert.doesNotMatch(
    workflow,
    /--include '\/brand(?:\/|')/,
    "Pages must publish only the curated root icon mirrors, not brand concepts or previews"
  );
});
