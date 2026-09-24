import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflows = ["ci.yml", "pages.yml", "supabase-deploy.yml"];

test("every third-party workflow action is pinned to an immutable commit", async () => {
  for (const filename of workflows) {
    const source = await readFile(path.join(repoRoot, ".github", "workflows", filename), "utf8");
    const actionLines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- uses:") || line.startsWith("uses:"));

    assert.ok(actionLines.length > 0, `${filename} must contain at least one action`);
    for (const line of actionLines) {
      assert.match(
        line,
        /^(?:- )?uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}(?:\s+#\s+.+)?$/,
        `${filename} contains a mutable or malformed action reference: ${line}`,
      );
    }
  }
});

test("Supabase deployments use the reviewed CLI version instead of latest", async () => {
  const source = await readFile(
    path.join(repoRoot, ".github", "workflows", "supabase-deploy.yml"),
    "utf8",
  );
  assert.match(source, /supabase\/setup-cli@[0-9a-f]{40}\s+# v3\.0\.0/);
  assert.match(source, /version:\s*2\.115\.0\b/);
  assert.doesNotMatch(source, /version:\s*latest\b/);
});
