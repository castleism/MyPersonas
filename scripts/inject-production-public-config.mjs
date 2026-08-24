#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function stop(message) {
  console.error(`Production artifact blocked: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--artifact" || !args[1]) {
  stop("use --artifact with the prepared GitHub Pages directory.");
}

const siteKey = String(process.env.MP_PRODUCTION_TURNSTILE_SITE_KEY || "").trim();
const publishedTestKeys = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "3x00000000000000000000FF",
]);
if (!/^[A-Za-z0-9_-]{10,200}$/.test(siteKey)) {
  stop("the protected production Turnstile site-key variable is missing or malformed.");
}
if (publishedTestKeys.has(siteKey)) {
  stop("a Cloudflare test site key cannot be released to production.");
}

const artifactDirectory = path.resolve(args[1]);
const indexPath = path.join(artifactDirectory, "index.html");
let html;
try {
  html = await readFile(indexPath, "utf8");
} catch {
  stop("the prepared artifact does not contain index.html.");
}

const requiredProductionMarkers = [
  'SUPABASE_URL:"https://nwsqyuucwzihruszocge.supabase.co"',
  'PUBLIC_MEDIA_ORIGIN:"https://media.mypersonas.online"',
];
for (const marker of requiredProductionMarkers) {
  if (!html.includes(marker)) {
    stop("the artifact does not contain the reviewed production configuration.");
  }
}
if (html.includes("STAGING ARTIFACT GUARD") || html.includes("STAGING_RUNTIME_ORIGIN")) {
  stop("a staging artifact cannot be promoted as the production artifact.");
}

const emptyMarker = 'TURNSTILE_SITE_KEY:""';
const markerCount = html.split(emptyMarker).length - 1;
if (markerCount !== 1) {
  stop(`expected exactly one empty Turnstile marker; found ${markerCount}.`);
}
const rendered = html.replace(emptyMarker, `TURNSTILE_SITE_KEY:"${siteKey}"`);
if (rendered.includes(emptyMarker) || rendered.split(siteKey).length - 1 !== 1) {
  stop("Turnstile injection did not produce one exact public site-key binding.");
}

await writeFile(indexPath, rendered, "utf8");
console.log("Injected one reviewed production Turnstile site-key binding into the Pages artifact.");
