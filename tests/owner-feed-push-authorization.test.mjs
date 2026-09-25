import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
await import(pathToFileURL(path.join(root, "MyPersonas.Online_v0/mobile-owner-workflow.js")).href);
const workflow = globalThis.MobileOwnerWorkflow;
const read = (relative) => readFile(path.join(root, relative), "utf8");

const owner = "owner-1";
const other = "owner-2";
const personas = [
  { id: "persona-a", owner, name: "Alpha", handle: "alpha" },
  { id: "persona-x", owner: other, name: "Foreign", handle: "foreign" },
];

test("two-account isolation denies a foreign owner's private records", () => {
  const mine = { id: "item-1", owner, persona_id: "persona-a", headline: "Mine" };
  const theirs = { id: "item-2", owner: other, persona_id: "persona-x", headline: "Theirs" };
  assert.equal(workflow.twoAccountIsolation({ ownerA: owner, ownerB: other, record: mine }).isolated, true);
  assert.equal(workflow.twoAccountIsolation({ ownerA: owner, ownerB: other, record: mine }).visibleToB, false);
  assert.equal(workflow.twoAccountIsolation({ ownerA: owner, ownerB: other, record: theirs }).visibleToA, false);
  assert.equal(workflow.feedItemVisible(mine, owner), true);
  assert.equal(workflow.feedItemVisible(theirs, owner), false);
  assert.equal(workflow.feedItemVisible({ ...mine, publishing_enabled: true }, owner), false);
});

test("feed research stays fail-closed until rules are approved and ai/research exists", () => {
  const unapproved = workflow.feedResearchRequest({
    ownerId: owner, personaId: "persona-a", personas, rulesApproved: false, online: true,
  });
  assert.equal(unapproved.ok, false);
  assert.match(unapproved.error, /not owner-approved/);
  const approved = workflow.feedResearchRequest({
    ownerId: owner, personaId: "persona-a", personas, rulesApproved: true, online: true,
  });
  assert.equal(approved.ok, false);
  assert.match(approved.error, /not deployed/);
  assert.equal(workflow.feedResearchRequest({
    ownerId: owner, personaId: "persona-x", personas, rulesApproved: true, online: true,
  }).ok, false);
});

test("push registration never enables delivery", () => {
  const status = workflow.pushDeliveryStatus({ ownerId: owner, subscriptions: [{ owner, endpoint: "https://push.example" }] });
  assert.equal(status.deliveryEnabled, false);
  assert.equal(status.permissionRequested, false);
  const ok = workflow.registerPushSubscription({
    ownerId: owner, endpoint: "https://push.example/sub", platform: "web",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.delivery_enabled, false);
  assert.equal(workflow.registerPushSubscription({
    ownerId: owner, endpoint: "https://push.example/sub", deliveryEnabled: true,
  }).ok, false);
});

test("078/079 SQL never grants a publisher or foreign-owner write", async () => {
  const [feed, push] = await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/078-owner-private-news-feed.sql"),
    read("MyPersonas.Online_v0/sql-updates/079-owner-push-subscription-foundation.sql"),
  ]);
  assert.match(feed, /check \(publishing_enabled = false\)/);
  assert.match(feed, /check \(social_published = false\)/);
  assert.match(feed, /using \(owner = auth\.uid\(\)\)/);
  assert.match(feed, /Owned persona not found/);
  assert.match(feed, /ai\/research is not deployed/);
  assert.doesNotMatch(feed, /grant insert on table public\.persona_feed_items/i);
  assert.doesNotMatch(feed, /http_post|pg_net|oauth|client_secret/i);
  assert.match(push, /check \(delivery_enabled = false\)/);
  assert.match(push, /using \(owner = auth\.uid\(\)\)/);
  assert.match(push, /never sends notifications/);
  assert.doesNotMatch(push, /VAPID_PRIVATE|FCM_SERVER|APNS_KEY|client_secret/i);
});

test("companion shells only open owner surfaces and treat share as planning-only", () => {
  assert.deepEqual(workflow.OWNER_SURFACES, [
    "owner", "feed", "push", "sites", "briefs", "schedule", "activity", "notifications",
  ]);
  assert.equal(workflow.allowedOwnerSurface("https://mypersonas.online/#/feed"), true);
  assert.equal(workflow.allowedOwnerSurface("https://mypersonas.online/#/push"), true);
  assert.equal(workflow.allowedOwnerSurface("https://mypersonas.online/#/persona/alpha"), false);
  assert.equal(workflow.allowedOwnerSurface("https://evil.example/#/owner"), false);
  const intake = workflow.shareIntake({ text: "https://mypersonas.online/#/feed" });
  assert.equal(intake.ok, true);
  assert.equal(intake.publishing_enabled, false);
  assert.equal(intake.destination, "https://mypersonas.online/#/feed");
  assert.equal(workflow.shareIntake({ publishingEnabled: true, text: "hello" }).ok, false);
});

test("sites-to-check lists owned HTTPS portals and keeps foreign accounts out", () => {
  const list = workflow.sitesToCheck({
    ownerId: owner,
    personaId: "persona-a",
    accounts: [
      { id: "acc-1", owner, persona_id: "persona-a", provider: "twitter", url: "https://x.com/alpha", suspended: false },
      { id: "acc-x", owner: other, persona_id: "persona-x", provider: "twitter", url: "https://x.com/foreign", suspended: false },
    ],
    officialPortals: { twitter: "https://x.com/home" },
    origin: "https://mypersonas.online/",
  });
  assert.equal(list.ok, true);
  assert.equal(list.publishing_enabled, false);
  const portals = list.groups.find((group) => group.id === "portals").items;
  assert.equal(portals.some((item) => item.url === "https://x.com/alpha"), true);
  assert.equal(portals.some((item) => /foreign/.test(item.url)), false);
  const install = list.groups.find((group) => group.id === "install").items;
  assert.equal(install.some((item) => item.url === "https://nooyouniverse.com/"), true);
  assert.equal(workflow.sitesToCheck({ ownerId: owner, publishingEnabled: true }).ok, false);
  assert.equal(workflow.allowedOwnerSurface("https://mypersonas.online/#/sites"), true);
});

test("owner app exposes private feed and default-off push without a fake publisher", async () => {
  const [source, html] = await Promise.all([
    read("MyPersonas.Online_v0/owner-app.js"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  assert.match(source, /function ownerAppRenderFeedLoaded/);
  assert.match(source, /function ownerAppRenderPushLoaded/);
  assert.match(source, /request_research/);
  assert.match(source, /request_owner_feed_research/);
  assert.match(source, /revoke_owner_push_subscription/);
  assert.doesNotMatch(source, /Notification\.requestPermission|new Notification\(/);
  assert.match(html, /ownerAppMobileGo\('feed'\)/);
  assert.match(html, /ownerAppMobileGo\('sites'\)/);
  assert.match(html, /ownerAppMobileGo\('push'\)/);
  assert.match(html, /view==="feed"/);
  assert.match(html, /view==="sites"/);
  assert.match(source, /function ownerAppRenderSitesLoaded/);
  assert.match(source, /function ownerAppOpenCheckSite/);
});
