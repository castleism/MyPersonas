import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(root, ".github", "workflows");

test("every remote GitHub Action is pinned to a full commit SHA", () => {
  const workflows = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  assert.ok(workflows.length > 0);

  for (const name of workflows) {
    const source = readFileSync(path.join(workflowDirectory, name), "utf8");
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const match = line.match(/^\s*-?\s*uses:\s*([^#\s]+)/);
      if (!match || match[1].startsWith("./")) continue;
      const separator = match[1].lastIndexOf("@");
      const reference = separator >= 0 ? match[1].slice(separator + 1) : "";
      assert.match(
        reference,
        /^[0-9a-f]{40}$/,
        `${name}:${index + 1} must pin ${match[1]} to a full commit SHA`,
      );
    }
  }
});

test("workflows use least-privilege top-level permissions", () => {
  for (
    const name of readdirSync(workflowDirectory).filter((entry) =>
      /\.ya?ml$/i.test(entry)
    )
  ) {
    const source = readFileSync(path.join(workflowDirectory, name), "utf8");
    assert.doesNotMatch(source, /^\s*permissions:\s*write-all\s*$/m);
    assert.doesNotMatch(source, /^\s*pull_request_target\s*:/m);
  }
});
