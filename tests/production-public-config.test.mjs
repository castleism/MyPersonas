import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/inject-production-public-config.mjs");
const sourceIndex = path.join(root, "MyPersonas.Online_v0/index.html");
const workflowPath = path.join(root, ".github/workflows/pages.yml");
const reviewedExampleSiteKey = "0x4AAAAAA-production-site-key-example";

async function makeArtifact() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mypersonas-production-artifact-"));
  await cp(sourceIndex, path.join(directory, "index.html"));
  return directory;
}

function inject(directory, siteKey) {
  const env = { ...process.env };
  if (siteKey === undefined) delete env.MP_PRODUCTION_TURNSTILE_SITE_KEY;
  else env.MP_PRODUCTION_TURNSTILE_SITE_KEY = siteKey;
  return execFileSync(process.execPath, [script, "--artifact", directory], {
    encoding: "utf8",
    env,
    stdio: "pipe",
  });
}

test("production artifact receives one reviewed Turnstile site key without modifying source", async () => {
  const directory = await makeArtifact();
  try {
    const before = await readFile(sourceIndex, "utf8");
    assert.match(inject(directory, reviewedExampleSiteKey), /Injected one reviewed production Turnstile/);
    const rendered = await readFile(path.join(directory, "index.html"), "utf8");
    assert.match(rendered, new RegExp(`TURNSTILE_SITE_KEY:\"${reviewedExampleSiteKey}\"`));
    assert.doesNotMatch(rendered, /TURNSTILE_SITE_KEY:""/);
    assert.equal(await readFile(sourceIndex, "utf8"), before);
    assert.throws(() => inject(directory, reviewedExampleSiteKey));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production injection rejects absent, malformed, and published test keys", async () => {
  for (const siteKey of [undefined, "bad key", "1x00000000000000000000AA"]) {
    const directory = await makeArtifact();
    try {
      assert.throws(() => inject(directory, siteKey));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("Pages injects only the protected production environment variable after packaging", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /environment:\s*\n\s*name: github-pages/);
  assert.match(workflow, /MP_PRODUCTION_TURNSTILE_SITE_KEY: \$\{\{ vars\.PRODUCTION_TURNSTILE_SITE_KEY \}\}/);
  assert.match(workflow, /node scripts\/inject-production-public-config\.mjs --artifact \.pages-artifact/);
  assert.doesNotMatch(workflow, /secrets\.PRODUCTION_TURNSTILE_SITE_KEY/);
  const prepare = workflow.indexOf("- name: Prepare public site artifact");
  const injectStep = workflow.indexOf("- name: Inject reviewed production Turnstile site key");
  const upload = workflow.indexOf("actions/upload-pages-artifact@");
  assert.ok(prepare >= 0 && injectStep > prepare && upload > injectStep);
  assert.match(workflow, /OPERATIONS-069-VERIFIED/);
});
