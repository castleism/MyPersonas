import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const paths = {
  page: "MyPersonas.Online_v0/provider-setup.html",
  guide: "MyPersonas.Online_v0/PROVIDER-SETUP-GUIDE.md",
  status: "MyPersonas.Online_v0/CONNECTORS-STATUS.md",
};

const focusCard = (page, provider) =>
  page.match(new RegExp(`<article class="focuscard"[^>]*data-focus-provider="${provider}"[\\s\\S]*?<\\/article>`))?.[0] || "";

test("readiness center keeps all seven gates separate and ordered", async () => {
  const page = await read(paths.page);
  const gates = [...page.matchAll(/data-readiness-gate="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(gates, [
    "inventory",
    "credentials",
    "oauth",
    "write-scope",
    "target",
    "adapter",
    "verification",
  ]);

  for (const provider of ["youtube", "tiktok", "twitch", "patreon", "wix", "wordpress"]) {
    const rows = page.match(new RegExp(`data-readiness-provider="${provider}"`, "g")) || [];
    assert.equal(rows.length, 1, `${provider} must have exactly one readiness row`);
    assert.ok(focusCard(page, provider), `${provider} must have a focused setup card`);
  }

  assert.match(page, /A saved account is only step 1 of 7/);
  assert.match(page, /These are separate checks, not one combined “connected” badge/);
});

test("approval, scheduling, and immediate actions are fail-closed until previewed", async () => {
  const [page, guide, status] = await Promise.all(Object.values(paths).map(read));
  for (const source of [page, guide, status]) {
    assert.match(source, /No preview, no (?:approval, no )?schedule/i);
    assert.match(source, /time zone/i);
    assert.match(source, /exact\s+(platform|provider)/i);
    assert.match(source, /(change|edit).*(invalidates|cancels).*(approval|receipt)/i);
  }

  assert.match(page, /every approve, schedule, and immediate-action control must stay disabled/i);
  assert.match(page, /data-scheduling-rule="platform-preview-required"/);
  assert.match(page, /Platform layout/);
  assert.match(page, /aspect ratio/);
  assert.match(page, /For Wix and WordPress[\s\S]*provider's own draft preview/);
});

test("YouTube and TikTok first proofs cannot be mistaken for public-post verification", async () => {
  const page = await read(paths.page);
  const youtube = focusCard(page, "youtube");
  const tiktok = focusCard(page, "tiktok");

  assert.match(youtube, /youtube\.upload/);
  assert.match(youtube, /upload one clearly labeled test video as <em>Private<\/em>/);
  assert.match(youtube, /returned video ID and status/);
  assert.match(youtube, /developers\.google\.com\/youtube\/v3\/docs\/videos\/insert/);

  assert.match(tiktok, /Upload-to-inbox/);
  assert.match(tiktok, /video\.upload/);
  assert.match(tiktok, /privacy and interaction settings/);
  assert.match(tiktok, /Direct Post is disabled/);
  assert.match(tiktok, /content-posting-api-reference-upload-video/);
  assert.doesNotMatch(tiktok, /safe proof:[\s\S]*public post/i);
});

test("Twitch and Patreon limitations remain explicit", async () => {
  const page = await read(paths.page);
  const twitch = focusCard(page, "twitch");
  const patreon = focusCard(page, "patreon");

  assert.match(twitch, /channel information, stream schedule segments/);
  assert.match(twitch, /does not provide a general social-feed or uploaded-video publisher/);
  assert.match(twitch, /schedule segment, channel change, or chat announcement/);

  assert.match(patreon, /eligible early-access integration/);
  assert.match(patreon, /does not offer a general create-post permission/);
  assert.match(patreon, /native scheduled-post flow/);
  assert.match(patreon, /create a Patreon draft/);
});

test("Wix and WordPress verification is draft-first and target-specific", async () => {
  const page = await read(paths.page);
  const wix = focusCard(page, "wix");
  const wordpress = focusCard(page, "wordpress");

  assert.match(wix, /exact site ID/);
  assert.match(wix, /author\/member ID/);
  assert.match(wix, /publishing explicitly off/);
  assert.match(wix, /read it back from the exact site/);
  assert.match(wix, /blog\/skills\/how-to-create-blog-posts/);
  assert.match(wix, /blog\/draft-posts\/introduction/);

  assert.match(wordpress, /WordPress\.com or self-hosted/);
  assert.match(wordpress, /WordPress\.com Applications/);
  assert.match(wordpress, /Create provider draft/);
  assert.match(wordpress, /<em>Draft<\/em>/);
  assert.match(wordpress, /developer\.wordpress\.com\/docs\/api\/oauth2/);
});

test("target-number help distinguishes public identifiers from secrets and counts", async () => {
  const [page, guide, status] = await Promise.all(Object.values(paths).map(read));
  assert.match(page, /What are the numbers and IDs next to “Save target”/);
  assert.match(page, /Client ID[\s\S]*not an account count/);
  assert.match(page, /Client secret[\s\S]*app's password/);
  assert.match(page, /Target ID[\s\S]*exact Page, channel, creator, campaign, or site/);
  assert.match(page, /3 \/ 0 means three inventory records and zero authorized connections/);
  assert.match(guide, /provider's permanent ID/);
  assert.match(status, /number beside \*\*Save target\*\*/);
});

test("focused external links use isolated browser contexts", async () => {
  const page = await read(paths.page);
  const focusSection = page.match(/<div class="focuscards">[\s\S]*?<\/div>\s*<\/section>/)?.[0] || "";
  assert.ok(focusSection, "focused provider section must remain extractable");
  const externalLinks = [...focusSection.matchAll(/<a href="https:[^"]+"([^>]*)>/g)];
  assert.ok(externalLinks.length >= 15, "expected official links across all focused providers");
  for (const [, attributes] of externalLinks) {
    assert.match(attributes, /target="_blank"/);
    assert.match(attributes, /rel="noopener noreferrer"/);
  }
});

test("focused setup anchors resolve and document IDs remain unique", async () => {
  const page = await read(paths.page);
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "every HTML id must be unique");

  for (const provider of ["youtube", "tiktok", "twitch", "patreon", "wix", "wordpress"]) {
    assert.match(page, new RegExp(`id="${provider}-readiness"`));
    assert.match(page, new RegExp(`href="#${provider}-readiness"`));
  }
});
