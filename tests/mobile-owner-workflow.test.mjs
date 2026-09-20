import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
await import(pathToFileURL(path.join(root, "MyPersonas.Online_v0/mobile-owner-workflow.js")).href);
const workflow = globalThis.MobileOwnerWorkflow;

const owner = "owner-1";
const other = "owner-2";
const personas = [
  { id: "persona-a", owner, name: "Alpha", handle: "alpha" },
  { id: "persona-b", owner, name: "Bravo", handle: "bravo" },
  { id: "persona-x", owner: other, name: "Foreign", handle: "foreign" },
];
const accounts = [
  { id: "acc-x", owner, persona_id: "persona-a", provider: "twitter", username: "alpha_x", suspended: false },
  { id: "acc-ig", owner, persona_id: "persona-a", provider: "instagram", username: "alpha_ig", suspended: false },
  { id: "acc-fb", owner, persona_id: "persona-a", provider: "facebook", username: "alpha_fb", suspended: false },
  { id: "acc-web", owner, persona_id: "persona-a", provider: "wordpress", url: "https://example.invalid", suspended: false },
  { id: "acc-other", owner: other, persona_id: "persona-x", provider: "twitter", username: "foreign_x", suspended: false },
];
const variants = ["x", "instagram", "facebook", "website"].map((channel) => ({
  channel,
  title: `${channel} title`,
  body: `${channel} body`,
  description: "",
  alt_text: "",
  media_plan: [],
}));

function createInput(overrides = {}) {
  return {
    ownerId: owner,
    personaId: "persona-a",
    personas,
    accounts,
    title: "Phone draft",
    guidance: "Stay private",
    timezone: "UTC",
    variants,
    publishingEnabled: false,
    online: true,
    ...overrides,
  };
}

test("workflow helpers expose a permanently disabled publisher", () => {
  assert.equal(workflow.PUBLISHING_ENABLED, false);
  assert.equal(workflow.CREATION_SOURCE, "mobile_private");
  assert.ok(workflow.OFFLINE_LIMITATIONS.some((line) => /never posts/i.test(line)));
});

test("owner isolation rejects another account's persona", () => {
  assert.equal(workflow.ownedPersona(personas, owner, "persona-a")?.id, "persona-a");
  assert.equal(workflow.ownedPersona(personas, owner, "persona-x"), null);
  assert.equal(workflow.ownedPersona(personas, other, "persona-a"), null);
  assert.deepEqual(workflow.ownedAccounts(accounts, owner, "persona-a").map((row) => row.id), [
    "acc-x", "acc-ig", "acc-fb", "acc-web",
  ]);
  assert.deepEqual(workflow.ownedAccounts(accounts, owner, "persona-x"), []);
});

test("exact provider/account binding is required before a private draft is stored", () => {
  const ok = workflow.createPrivateDraftRequest(createInput());
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.publishing_enabled, false);
  assert.equal(ok.payload.rpc, "create_owner_mobile_private_draft");
  assert.equal(ok.payload.p_bindings.x.ledger_id, "acc-x");
  assert.equal(ok.payload.p_bindings.website.provider, "wordpress");

  const foreign = workflow.createPrivateDraftRequest(createInput({ personaId: "persona-x" }));
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /Owned persona not found/);

  const stolen = workflow.createPrivateDraftRequest(createInput({
    requestedBindings: { x: "acc-other", instagram: "acc-ig", facebook: "acc-fb", website: "acc-web" },
  }));
  assert.equal(stolen.ok, false);
  assert.match(stolen.error, /Exact provider\/account binding/);

  const missing = workflow.createPrivateDraftRequest(createInput({
    accounts: accounts.filter((row) => row.provider !== "instagram"),
  }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Exact provider\/account binding/);
});

test("publishing_enabled cannot be flipped and offline work cannot mutate drafts", () => {
  assert.equal(workflow.createPrivateDraftRequest(createInput({ publishingEnabled: true })).ok, false);
  assert.equal(workflow.createPrivateDraftRequest(createInput({ online: false })).ok, false);
  const publish = workflow.approvalDecision({
    ownerId: owner,
    pack: { id: "kit-1", owner, status: "owner_review" },
    action: "publish",
  });
  assert.equal(publish.ok, false);
  assert.match(publish.error, /cannot publish or send/);
});

test("approval stays a private planning record and still requires ownership", () => {
  const pack = { id: "kit-1", owner, status: "owner_review" };
  const approve = workflow.approvalDecision({ ownerId: owner, pack, action: "approve", publishingEnabled: false, online: true });
  assert.equal(approve.ok, true);
  assert.equal(approve.publishes, false);
  assert.equal(approve.rpc, "content_package_preview_snapshot");
  assert.equal(workflow.approvalDecision({ ownerId: other, pack, action: "approve" }).ok, false);
  const schedule = workflow.approvalDecision({
    ownerId: owner,
    pack: { ...pack, status: "approved" },
    action: "manual_schedule",
    bindings: workflow.channelBindings(accounts, owner, "persona-a"),
  });
  assert.equal(schedule.ok, true);
  assert.equal(schedule.publishes, false);
});

test("export/import is owner-scoped and refuses a live publisher flag", () => {
  const bundle = workflow.exportBundle({ ownerId: owner, selectedPersonaId: "persona-a", draftIds: ["kit-1"] });
  assert.equal(bundle.publishing_enabled, false);
  assert.equal(workflow.importBundle(bundle, { ownerId: owner, personas }).ok, true);
  assert.equal(workflow.importBundle(bundle, { ownerId: other, personas }).ok, false);
  assert.equal(workflow.importBundle({ ...bundle, publishing_enabled: true }, { ownerId: owner, personas }).ok, false);
});

test("owner app uses the workflow helpers instead of a local fake publisher", async () => {
  const [source, html] = await Promise.all([
    readFile(path.join(root, "MyPersonas.Online_v0/owner-app.js"), "utf8"),
    readFile(path.join(root, "MyPersonas.Online_v0/index.html"), "utf8"),
  ]);
  assert.match(source, /function ownerAppOpenPersonaSheet/);
  assert.match(source, /function ownerAppOpenPrivateDraft/);
  assert.match(source, /create_owner_mobile_private_draft/);
  assert.match(source, /publishing_enabled=false/);
  assert.match(source, /Private drafts cannot be created while disconnected/);
  assert.doesNotMatch(source, /fake social publisher|localSocialPublish|postToTwitter\(/);
  assert.match(html, /mobile-owner-workflow\.js\?v=20260920-1/);
  assert.match(html, /ownerAppMobilePrivateDraft/);
});
